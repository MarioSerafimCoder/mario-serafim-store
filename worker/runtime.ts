import { handle } from '@astrojs/cloudflare/handler';
import commerce from './index.ts';
import { admin, isAdminPath } from './admin.ts';
import { publicImage } from './admin-data.ts';
import type { Env } from './types.ts';

type Context = Parameters<typeof handle>[2];
const site = 'https://loja.marioserafim.com.br';
const storefront = /^\/(?:produtos(?:\/[a-z0-9-]+)?\/|sitemap-(?:index|0)\.xml)?$/;
const sitemapIndex = '<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>' + site + '/sitemap-0.xml</loc></sitemap></sitemapindex>';

async function renderSitemap(env: Env, path: string) {
  if (path === '/sitemap-index.xml') return new Response(sitemapIndex, { headers: { 'content-type':'application/xml; charset=utf-8' } });
  const rows = await env.DB!.prepare("SELECT slug,updated_at FROM products WHERE status IN ('published','coming_soon') ORDER BY slug")
    .all<{slug:string;updated_at:string}>();
  const pages = ['/', '/produtos/', '/sobre/', '/licencas/'].map(path => '<url><loc>' + site + path + '</loc></url>');
  for (const { slug, updated_at } of rows.results) pages.push('<url><loc>' + site + '/produtos/' + encodeURIComponent(slug) + '/</loc><lastmod>' + updated_at + '</lastmod></url>');
  return new Response('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + pages.join('') + '</urlset>', {
    headers: { 'content-type':'application/xml; charset=utf-8' },
  });
}

async function cacheStorefront(url: URL, request: Request, env: Env, context: Context, render: () => Promise<Response>) {
  const revision = await env.DB!.prepare('SELECT revision FROM catalog_revision WHERE id=1').first<{revision:number}>();
  const key = new URL(url.pathname, url.origin);
  key.searchParams.set('catalog-revision', String(revision?.revision ?? 0));
  key.searchParams.set('worker-release', env.RELEASE?.id ?? 'local');
  const cacheRequest = new Request(key);
  const cache = (caches as CacheStorage & { default: Cache }).default;
  const cached = await cache.match(cacheRequest);
  if (cached) return cached;
  const raw = url.pathname.startsWith('/sitemap-') ? await renderSitemap(env,url.pathname) : await render();
  if (raw.status !== 200 || raw.headers.has('set-cookie')) return raw;
  const headers = new Headers(raw.headers);
  headers.set('cache-control','public, max-age=0, s-maxage=300');
  if (env.MP_MODE === 'test') headers.set('x-robots-tag','noindex, nofollow');
  const response = new Response(raw.body,{status:raw.status,headers});
  if (request.method === 'GET') context.waitUntil(cache.put(cacheRequest,response.clone()).catch(() => undefined));
  return response;
}

export default {
  async fetch(request: Request, env: Env, context: Context) {
    const url = new URL(request.url);
    const path = url.pathname;
    const render = () => handle(request, env, context);
    if (isAdminPath(path)) return admin(request,env,render);
    if (path.startsWith('/compras/api/') || path.startsWith('/compras/retorno/')) return commerce.fetch(request,env);
    if (path.startsWith('/midia/')) {
      if (!env.DB || !['GET','HEAD'].includes(request.method)) return new Response(null,{status:404});
      const response = await publicImage(env.DB,path.slice('/midia/'.length));
      return request.method === 'HEAD' ? new Response(null,{status:response.status,headers:response.headers}) : response;
    }
    if (env.DYNAMIC_CATALOG === 'true' && storefront.test(path) && ['GET','HEAD'].includes(request.method)) {
      if (!env.DB) return new Response('Catálogo temporariamente indisponível.',{status:503});
      try {
        const response = await cacheStorefront(url,request,env,context,render);
        return request.method === 'HEAD' ? new Response(null,{status:response.status,headers:response.headers}) : response;
      } catch {
        console.error('Falha ao consultar catálogo');
        return new Response('Catálogo temporariamente indisponível.',{status:503,headers:{'cache-control':'no-store'}});
      }
    }
    const response = await render();
    if (env.MP_MODE !== 'test') return response;
    const headers = new Headers(response.headers);
    headers.set('x-robots-tag','noindex, nofollow');
    return new Response(response.body,{status:response.status,headers});
  },
  scheduled: commerce.scheduled,
  queue: commerce.queue,
};
