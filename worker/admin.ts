import { accessConfigured, verifyAccess } from './access.ts';
import { AdminError, audit, findProduct, httpsUrl, imageMime, productAction, publicImage, saveProduct } from './admin-data.ts';
import { dashboard, editor, filePage, html, orderDetail, orderTable, page, productsTable, settingsPage, type OrderSummary } from './admin-ui.ts';
import { getSettings, skuPattern, statuses, versionPattern, type ProductRow, type Settings, type StoreDB } from './catalog.ts';
import { richText } from './rich-text.ts';
import type { Env } from './types.ts';

const privacy = {
  'cache-control': 'private, no-store', 'x-robots-tag': 'noindex, nofollow', 'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin',
  'content-security-policy': "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' https: blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

const orderId = /^[a-f0-9-]{36}$/;
const orderColumns = `o.id,o.sku,o.title,o.price_cents,o.remote_id,o.payment_id,o.status,o.created_at,
  EXISTS(SELECT 1 FROM order_events e WHERE e.order_id=o.id AND e.kind='download_started') AS delivered`;

function result(data: unknown, status = 200) {
  return Response.json(data, { status, headers: privacy });
}

async function payload(request: Request, max: number) {
  if (!request.body || Number(request.headers.get('content-length')) > max) throw new AdminError('Envio excede o tamanho permitido.', 413);
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new AdminError('Envio excede o tamanho permitido.', 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes.buffer;
}

async function body(request: Request) {
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') throw new AdminError('Envie dados em JSON.', 415);
  try {
    const value = JSON.parse(new TextDecoder().decode(await payload(request, 40_000)));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch (error) { if (error instanceof AdminError) throw error; }
  throw new AdminError('Dados inválidos.');
}

function text(request: Request, name: string) {
  try { return decodeURIComponent(request.headers.get(name) ?? ''); } catch { throw new AdminError('Nome de arquivo inválido.'); }
}

function validPrivateFile(filename: string, mime: string, bytes: ArrayBuffer) {
  const extension = filename.split('.').at(-1)?.toLowerCase();
  const start = new TextDecoder('latin1').decode(bytes.slice(0, 32));
  const generic = mime === 'application/octet-stream' || !mime;
  const zip = ['PK\u0003\u0004', 'PK\u0005\u0006'].some((signature) => start.startsWith(signature));
  if (extension === 'zip') return zip && (generic || ['application/zip','application/x-zip-compressed'].includes(mime));
  if (extension === 'pdf') return start.startsWith('%PDF-') && (generic || mime === 'application/pdf');
  if (extension === 'psd') return start.startsWith('8BPS') && (generic || mime === 'image/vnd.adobe.photoshop');
  if (extension === 'ai') return /^%PDF-|^%!PS/.test(start) && (generic || ['application/pdf','application/postscript','application/illustrator'].includes(mime));
  return extension === 'fig' && (zip || start.startsWith('fig-kiwi')) && generic;
}

async function write(request: Request, env: Env, db: StoreDB, actor: string, path: string) {
  if (request.headers.get('origin') !== env.STORE_ORIGIN || new URL(request.url).origin !== env.STORE_ORIGIN ||
      ['cross-site','same-site'].includes(request.headers.get('sec-fetch-site') ?? '')) {
    throw new AdminError('Origem não autorizada.', 403);
  }
  if (request.method !== 'POST') throw new AdminError('Método não permitido.', 405);
  const bucket = Math.floor(Date.now() / 60_000);
  const limit = await db.prepare(`
    INSERT INTO admin_rate VALUES (?,1) ON CONFLICT(bucket) DO UPDATE SET hits=hits+1 WHERE hits<60 RETURNING hits
  `).bind(bucket).first();
  if (!limit) throw new AdminError('Muitas operações. Aguarde um minuto.', 429);
  if (path === '/admin/api/imagens') {
    const bytes = await payload(request, 900 * 1024);
    const mime = imageMime(bytes);
    if (!mime || request.headers.get('content-type') !== mime) throw new AdminError('Envie uma imagem JPEG, PNG ou WebP válida.');
    const id = crypto.randomUUID();
    await db.batch([db.prepare('INSERT INTO product_images(id,mime,bytes) VALUES(?,?,?)').bind(id,mime,bytes), audit(db,actor,'imagem.enviada',id)]);
    return result({ src: '/midia/' + id }, 201);
  }
  if (path === '/admin/api/arquivos/upload') {
    const storage = env.FILES;
    if (!storage?.put) throw new AdminError('O armazenamento privado R2 está indisponível.', 503);
    const sku = text(request, 'x-sku'), version = text(request, 'x-version');
    const filename = text(request, 'x-filename').normalize('NFC');
    if (!skuPattern.test(sku) || sku.length > 80 || !versionPattern.test(version) || !/^[\p{L}\p{N}][\p{L}\p{N} ._()\-]{0,139}$/u.test(filename)) {
      throw new AdminError('SKU, versão ou nome de arquivo inválidos.');
    }
    const product = await findProduct(db, sku);
    if (!product || product.status === 'archived' || product.version !== version) throw new AdminError('Salve esta versão no produto ativo antes de enviar o arquivo.', 409);
    const key = 'private/' + sku + '/' + version + '/' + crypto.randomUUID();
    const bytes = await payload(request, 25 * 1024 * 1024);
    if (!validPrivateFile(filename, request.headers.get('content-type') ?? '', bytes)) throw new AdminError('O tipo do arquivo não corresponde à extensão permitida.');
    const existing = await db.prepare('SELECT sku FROM fulfillment WHERE sku=? AND version=?').bind(sku,version).first();
    if (existing) throw new AdminError('Já existe um arquivo para esta versão. Cadastre uma nova versão.', 409);
    await storage.put(key, bytes);
    try {
      await db.batch([db.prepare('INSERT INTO fulfillment(sku,version,object_key,filename) VALUES(?,?,?,?)').bind(sku,version,key,filename),
        audit(db,actor,'arquivo.enviado',sku + '/' + version)]);
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) throw new AdminError('Esta versão já recebeu outro arquivo.', 409);
      throw error;
    }
    return result({ saved: true }, 201);
  }
  const data = await body(request);
  if (path === '/admin/api/previa') {
    if (typeof data.description !== 'string' || data.description.length > 16000) throw new AdminError('Descrição inválida.');
    return result({ html: richText(data.description) });
  }
  if (path === '/admin/api/configuracoes') {
    if (typeof data.announcement !== 'string' || data.announcement.length > 180 || typeof data.support !== 'string' ||
        data.support.length > 400 || typeof data.period !== 'number' || ![7,30,90].includes(data.period)) throw new AdminError('Configuração inválida.');
    await db.batch([db.prepare('UPDATE store_settings SET announcement=?,support_url=?,period=? WHERE id=1')
      .bind(data.announcement.trim(),data.support.trim() ? httpsUrl(data.support,'Atendimento') : '',data.period),audit(db,actor,'loja.configurada','loja')]);
    return result({ saved: true });
  }
  if (path === '/admin/api/arquivos/permissao') {
    if (!env.FILES) throw new AdminError('O armazenamento privado R2 está indisponível.', 503);
    const { sku, version, enabled } = data;
    if (typeof sku !== 'string' || !skuPattern.test(sku) || sku.length>80 || typeof version !== 'string' || !versionPattern.test(version) ||
      typeof enabled !== 'boolean') throw new AdminError('Permissão inválida.');
    const file = await db.prepare('SELECT object_key FROM fulfillment WHERE sku=? AND version=?').bind(sku,version).first<{object_key:string}>();
    if (!file || (enabled && !await env.FILES.head(file.object_key))) throw new AdminError('Arquivo indisponível.', 404);
    await db.batch([db.prepare('UPDATE fulfillment SET enabled=? WHERE sku=? AND version=?').bind(Number(enabled),sku,version),
      audit(db,actor,enabled?'arquivo.permitido':'arquivo.bloqueado',sku + '/' + version)]);
    return result({ saved: true });
  }
  if (path === '/admin/api/produtos') return result({ sku: await saveProduct(db,actor,data) }, 201);
  const product = /^\/admin\/api\/produtos\/([A-Z0-9-]{1,80})(?:\/(publicar|despublicar|arquivar|restaurar|duplicar))?$/.exec(path);
  if (!product || !skuPattern.test(product[1])) throw new AdminError('Rota inválida.', 404);
  const [, sku, action] = product;
  return result({ sku: action ? await productAction(db,actor,sku,action,data) : await saveProduct(db,actor,data,sku) });
}

async function adminPage(env: Env, db: StoreDB, url: URL, path: string) {
  const mode = env.MP_MODE ?? 'production';
  const query = (url.searchParams.get('q') ?? '').trim().slice(0, 80);
  const offset = Number(url.searchParams.get('offset') ?? '0');
  if (!Number.isInteger(offset) || offset < 0 || offset > 30_000) throw new AdminError('Página inválida.');
  if (path === '/admin') {
    const setting = await getSettings(db);
    const requested = Number(url.searchParams.get('period'));
    const period = [7,30,90].includes(requested) ? requested : setting?.period ?? 30;
    const since = Math.floor(Date.now()/1000) - period * 86400;
    const [stats, products, orders, sales] = await Promise.all([
      db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN status='approved' THEN price_cents ELSE 0 END),0) AS revenue,
        COUNT(CASE WHEN status IN ('created','pending') THEN 1 END) AS pending,
        COUNT(CASE WHEN status IN ('review','refunded','disputed') THEN 1 END) AS alerts FROM orders WHERE mode=? AND created_at>=?`).bind(mode,since)
        .first<{total:number;revenue:number;pending:number;alerts:number}>(),
      db.prepare("SELECT COUNT(CASE WHEN status='published' THEN 1 END) AS published,COUNT(CASE WHEN status='draft' THEN 1 END) AS draft FROM products").first<{published:number;draft:number}>(),
      db.prepare('SELECT '+orderColumns+' FROM orders o WHERE mode=? AND created_at>=? ORDER BY created_at DESC LIMIT 8').bind(mode,since).all<OrderSummary>(),
      db.prepare("SELECT MAX(title) AS title, COUNT(*) AS qty, SUM(price_cents) AS revenue FROM orders WHERE mode=? AND created_at>=? AND status='approved' GROUP BY sku ORDER BY revenue DESC LIMIT 10").bind(mode,since).all<{title:string;qty:number;revenue:number}>(),
    ]);
    return ['Visão geral',dashboard(stats!,products!,orders.results,sales.results,period),'/admin'];
  }
  if (path === '/admin/produtos') {
    const filter = url.searchParams.get('status') ?? '';
    const status = Object.hasOwn(statuses, filter) ? filter : '';
    const rows = await db.prepare(`SELECT sku,slug,name,price_cents,status,revision FROM products WHERE (?='' OR status=?)
      AND (instr(lower(name),lower(?))>0 OR instr(lower(sku),lower(?))>0 OR instr(slug,lower(?))>0)
      ORDER BY updated_at DESC,name LIMIT 31 OFFSET ?`).bind(status,status,query,query,query,offset).all<ProductRow>();
    return ['Produtos',productsTable(rows.results,query,status,offset),path];
  }
  if (path === '/admin/produtos/novo') return ['Novo produto',editor(),'/admin/produtos'];
  if (path.startsWith('/admin/produtos/')) {
    const sku = path.slice('/admin/produtos/'.length);
    const row = sku.length<=80 && skuPattern.test(sku) ? await findProduct(db,sku) : null;
    if (row) return ['Editar produto',editor(row),'/admin/produtos'];
  }
  if (path === '/admin/pedidos') {
    const orders = await db.prepare(`SELECT ${orderColumns} FROM orders o WHERE mode=? AND
      (?='' OR instr(lower(title),lower(?))>0 OR instr(lower(sku),lower(?))>0 OR instr(id,?)>0 OR instr(remote_id,?)>0 OR instr(payment_id,?)>0)
      ORDER BY created_at DESC LIMIT 31 OFFSET ?`).bind(mode,query,query,query,query,query,query,offset).all<OrderSummary>();
    const pager = (n: number, label: string) => `<a href="?q=${encodeURIComponent(query)}&amp;offset=${n}">${label}</a>`;
    return ['Pedidos',`<form class="filters" method="get"><label>Buscar <input type="search" name="q" maxlength="80" value="${html(query)}" placeholder="Pedido, SKU ou referência"></label><button>Buscar</button></form>
      ${orderTable(orders.results.slice(0,30))}<nav class="pager" aria-label="Paginação">${offset?pager(Math.max(0,offset-30),'← Anteriores'):''}${orders.results.length>30?pager(offset+30,'Próximos →'):''}</nav>`,path];
  }
  if (path.startsWith('/admin/pedidos/')) {
    const id = path.slice('/admin/pedidos/'.length);
    const order = orderId.test(id) ? await db.prepare('SELECT '+orderColumns+' FROM orders o WHERE id=? AND mode=?').bind(id,mode).first<OrderSummary>() : null;
    if (order) {
      const events = await db.prepare('SELECT kind,status,recorded_at FROM order_events WHERE order_id=? ORDER BY id DESC LIMIT 100').bind(id)
        .all<{kind:string;status:string;recorded_at:number}>();
      return ['Pedido',orderDetail(order,events.results),'/admin/pedidos'];
    }
  }
  if (path === '/admin/arquivos') {
    const sku = url.searchParams.get('sku') ?? '';
    if (sku && (!skuPattern.test(sku) || sku.length > 80)) throw new AdminError('SKU inválido.');
    const [rows, product] = await Promise.all([
      db.prepare("SELECT sku,version,object_key,filename,enabled FROM fulfillment WHERE (?='' OR sku=?) ORDER BY sku,version DESC LIMIT 31 OFFSET ?")
        .bind(sku,sku,offset).all<{sku:string;version:string;object_key:string;filename:string;enabled:number}>(),
      sku ? findProduct(db,sku) : null,
    ]);
    const files = await Promise.all(rows.results.slice(0,30).map(async row=>({ ...row, available: Boolean(await env.FILES?.head(row.object_key)) })));
    const pager = (n: number, label: string) => `<a href="?sku=${encodeURIComponent(sku)}&amp;offset=${n}">${label}</a>`;
    return ['Arquivos digitais',filePage(files,Boolean(env.FILES?.put),sku,product?.version ?? '')+
      `<nav class="pager" aria-label="Paginação">${offset?pager(Math.max(0,offset-30),'← Anteriores'):''}${rows.results.length>30?pager(offset+30,'Próximos →'):''}</nav>`,path];
  }
  if (path === '/admin/configuracoes') {
    const settings = await getSettings(db) as Settings;
    return ['Configurações',settingsPage(settings,env.CHECKOUT_ENABLED==='true',Boolean(env.MP_ACCESS_TOKEN && env.MP_WEBHOOK_SECRET),Boolean(env.FILES)),path];
  }
  throw new AdminError('Página não encontrada.', 404);
}

export function isAdminPath(path: string) {
  return path === '/admin' || path.startsWith('/admin/');
}

export async function admin(request: Request, env: Env, renderPreview: () => Promise<Response>) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');
  const api = path.startsWith('/admin/api/');
  if (!env.DB || !accessConfigured(env)) return result({ error: 'Administração temporariamente indisponível.' }, 503);
  if (url.origin !== env.STORE_ORIGIN) return result({ error: 'Acesso não autorizado.' }, 403);
  const actor = await verifyAccess(request, env);
  if (!actor) return result({ error: 'Acesso não autorizado.' }, 403);
  try {
    if (api) return await write(request, env, env.DB, actor, path);
    if (request.method !== 'GET' && request.method !== 'HEAD') return result({error:'Método não permitido.'},405);
    if (path.startsWith('/admin/midia/')) return publicImage(env.DB,path.slice('/admin/midia/'.length),true);
    if (path.startsWith('/admin/previa/')) {
      const response = await renderPreview();
      const headers = new Headers(response.headers);
      for (const [key,value] of Object.entries(privacy)) if (key !== 'content-security-policy') headers.set(key,value);
      return new Response(response.body,{status:response.status,headers});
    }
    const [title,content,active] = await adminPage(env,env.DB,url,path);
    return new Response(request.method==='HEAD' ? null : page(title,content,active,'/cdn-cgi/access/logout'),{headers:{...privacy,'content-type':'text/html; charset=utf-8'}});
  } catch (error) {
    if (error instanceof AdminError) return result({error:error.message},error.status);
    console.error('Falha de processamento administrativo');
    return result({error:'Não foi possível concluir a operação. Tente novamente.'},503);
  }
}
