import { integrationPage, operations, salesChannels } from './admin-operations.ts';
import { couponsPage, saveCoupon } from './admin-coupons.ts';
import { activity, customerHistory, customers, insights, reports, salesChart } from './admin-insights.ts';
import { csv, orderColumns, orderFilters, orderRows, orderStatuses, productCategories, type OrderSummary } from './admin-orders.ts';
import { accessConfigured, verifyAccess } from './access.ts';
import { AdminError, audit, findProduct, httpsUrl, imageMime, productAction, publicImage, saveProduct } from './admin-data.ts';
import { dashboard, editor, filePage, html, orderDetail, orderTable, page, productsTable, settingsPage, paymentLabel } from './admin-ui.ts';
import { getSettings, skuPattern, statuses, versionPattern, type ProductRow, type Settings, type StoreDB } from './catalog.ts';
import { richText } from './rich-text.ts';
import type { Env } from './types.ts';

const privacy = {
  'cache-control': 'private, no-store', 'x-robots-tag': 'noindex, nofollow', 'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin',
  'content-security-policy': "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' https: blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

const orderId = /^[a-f0-9-]{36}$/;

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
  if (path === '/admin/api/cupons') {
    if (env.COUPONS_ENABLED !== 'true') throw new AdminError('Cupons indisponíveis neste ambiente.',404);
    return result(await saveCoupon(db,actor,data));
  }
  if (path === '/admin/api/categorias') {
    const { from, name } = data;
    if (typeof from !== 'string' || !from || from.length > 80 || typeof name !== 'string' ||
      !name.trim() || name.length > 80 || /[\p{Cc}\p{Cf}]/u.test(name)) throw new AdminError('Informe uma categoria válida.');
    const next = name.trim();
    if (from === next) throw new AdminError('Escolha um nome diferente.');
    const [updated] = await db.batch([
      db.prepare("UPDATE products SET category=?,updated_at=date('now'),revision=revision+1 WHERE category=?").bind(next,from),
      audit(db,actor,'categoria.renomeada',from + ' → ' + next),
    ]);
    return result({saved:true, changed:updated.meta?.changes});
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
    const data = await insights(db,mode,period);
    const count = (...states:string[]) => data.status.filter(r=>states.includes(r.label)).reduce((n,r)=>n+r.qty,0);
    const stats = {total:data.status.reduce((n,r)=>n+r.qty,0),revenue:data.status.find(r=>r.label==='approved')?.revenue ?? 0,
      pending:count('created','pending'),alerts:count('review','refunded','disputed')};
    const [products,orders] = await Promise.all([
      db.prepare("SELECT COUNT(CASE WHEN status='published' THEN 1 END) AS published,COUNT(CASE WHEN status='draft' THEN 1 END) AS draft FROM products").first<{published:number;draft:number}>(),
      db.prepare('SELECT '+orderColumns+' FROM orders o WHERE mode=? AND created_at>=? ORDER BY created_at DESC LIMIT 8').bind(mode,data.since).all<OrderSummary>(),
    ]);
    const deliveryAlert = env.FILES ? '' : '<p class="helper">Armazenamento privado indisponível. Confira as integrações antes de abrir vendas.</p>';
    return ['Início',dashboard(stats,products!,orders.results,data.products.slice(0,5).map(r=>({...r,title:r.label})),period,salesChart(data.series),deliveryAlert+activity(data.events.slice(0,5))),'/admin'];
  }
  if (path === '/admin/produtos') {
    const filter = url.searchParams.get('status') ?? '';
    const status = Object.hasOwn(statuses, filter) ? filter : '';
    const category = (url.searchParams.get('category') ?? '').slice(0,80);
    const [rows, categories] = await Promise.all([
      db.prepare(`SELECT sku,slug,name,category,updated_at,price_cents,status,revision,json_extract(details,'$.images[0].src') AS cover
        FROM products WHERE (?='' OR status=?) AND (?='' OR category=?)
        AND (instr(lower(name),lower(?))>0 OR instr(lower(sku),lower(?))>0 OR instr(slug,lower(?))>0)
        ORDER BY updated_at DESC,name,sku LIMIT 31 OFFSET ?`).bind(status,status,category,category,query,query,query,offset)
        .all<ProductRow & {cover:string|null}>(),
      productCategories(db),
    ]);
    return ['Produtos',productsTable(rows.results,query,status,category,categories.results.map(c=>c.category),offset),path];
  }
  const categories = async () => (await productCategories(db)).results.map(c=>c.category);
  if (path === '/admin/produtos/categorias') {
    const rows = await categories();
    return ['Categorias',`<section class="panel"><h2>Categorias do catálogo</h2><p>Cadastre uma nova categoria ao preencher o campo no editor de produto. Para reunir duas categorias, use o nome de uma categoria existente.</p>
      ${rows.length ? '<ul class="rank">'+rows.map(category=>`<li><a href="/admin/produtos?category=${encodeURIComponent(category)}">${html(category)}</a>
        <details><summary>Renomear</summary><form method="post" data-category><input type="hidden" name="from" value="${html(category)}">
        <label>Novo nome <input name="name" maxlength="80" required></label><button>Aplicar aos produtos</button></form></details></li>`).join('')+'</ul>'
      : '<p class="empty">As categorias aparecem após cadastrar o primeiro produto.</p>'}</section>`,path];
  }
  if (path === '/admin/produtos/novo') return ['Novo produto',editor(undefined,await categories()),path];
  if (path.startsWith('/admin/produtos/')) {
    const sku = path.slice('/admin/produtos/'.length);
    const row = sku.length<=80 && skuPattern.test(sku) ? await findProduct(db,sku) : null;
    if (row) return ['Editar produto',editor(row,await categories()),'/admin/produtos'];
  }
  if (path === '/admin/pedidos') {
    const filters = orderFilters(url.searchParams);
    const orders = await orderRows(db,mode,filters,31,offset);
    const search = new URLSearchParams({q:filters.q,status:filters.status,period:String(filters.period)});
    const pageLink = (next:number) => '?' + new URLSearchParams({...Object.fromEntries(search),offset:String(next)});
    const pager = (n: number, label: string) => `<a href="${html(pageLink(n))}">${label}</a>`;
    return ['Pedidos',`<form class="filters" method="get"><label>Buscar <input type="search" name="q" maxlength="80" value="${html(query)}" placeholder="Pedido, produto ou referência"></label>
      <label>Pagamento <select name="status"><option value="">Todos</option>${Object.entries(orderStatuses).map(([key,label])=>`<option value="${key}"${key===filters.status?' selected':''}>${label}</option>`).join('')}</select></label>
      <label>Período <select name="period">${[0,7,30,90].map(n=>`<option value="${n}"${n===filters.period?' selected':''}>${n ? 'Últimos '+n+' dias' : 'Todo o histórico'}</option>`).join('')}</select></label>
      <button>Filtrar</button><a class="button" href="/admin/pedidos/exportar?${html(search.toString())}">Exportar CSV</a></form>
      ${orderTable(orders.results.slice(0,30),pageLink(offset).slice(1))}<nav class="pager" aria-label="Paginação">${offset?pager(Math.max(0,offset-30),'← Anteriores'):''}${orders.results.length>30?pager(offset+30,'Próximos →'):''}</nav>`,path];
  }
  if (path.startsWith('/admin/pedidos/')) {
    const id = path.slice('/admin/pedidos/'.length);
    const order = orderId.test(id) ? await db.prepare('SELECT '+orderColumns+' FROM orders o WHERE id=? AND mode=?').bind(id,mode).first<OrderSummary>() : null;
    if (order) {
      const events = await db.prepare('SELECT kind,status,recorded_at FROM order_events WHERE order_id=? ORDER BY id DESC LIMIT 100').bind(id)
        .all<{kind:string;status:string;recorded_at:number}>();
      return ['Pedido',orderDetail(order,events.results,'/admin/pedidos' + (url.searchParams.has('voltar') ? '?' + new URLSearchParams(url.searchParams.get('voltar')!.slice(0,400)).toString() : '')),'/admin/pedidos'];
    }
  }
  if (path === '/admin/descontos') return ['Descontos',await couponsPage(db,env.COUPONS_ENABLED==='true',env.CHECKOUT_ENABLED==='true',offset),path];
  if (path === '/admin/clientes') return ['Clientes',await customers(db,mode,query,offset),path];
  if (path.startsWith('/admin/clientes/')) {
    const id = path.slice('/admin/clientes/'.length);
    const history = orderId.test(id) ? await customerHistory(db,mode,id,offset) : null;
    if (history) return ['Histórico do cliente',history,'/admin/clientes'];
  }
  if (path === '/admin/relatorios') {
    const period = orderFilters(url.searchParams).period || 30;
    return ['Relatórios',reports(await insights(db,mode,period),period),path];
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
  if (path === '/admin/integracoes') return ['Apps e integrações',integrationPage(await operations(env,db),mode),path];
  if (path === '/admin/loja-online') return ['Canais de venda',salesChannels(await operations(env,db),env.STORE_ORIGIN ?? ''),path];
  if (path === '/admin/configuracoes') {
    const settings = await getSettings(db) as Settings;
    return ['Configurações',settingsPage(settings),path];
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
    if (path === '/admin/relatorios/exportar') {
      const period = orderFilters(url.searchParams).period || 30;
      const data = await insights(env.DB,env.MP_MODE ?? 'production',period);
      const rows = [['Seção','Referência','Quantidade','Centavos (BRL)','Detalhe'],
        ...data.series.map(r=>['Receita diária',r.day,null,r.revenue,null]),
        ...data.status.map(r=>['Pedidos por estado',paymentLabel(r.label),r.qty,r.revenue,null]),
        ...data.products.map(r=>['Vendas por produto',r.label,r.qty,r.revenue,null]),
        ...data.categories.map(r=>['Vendas por categoria',r.label,r.qty,r.revenue,null]),
        ...data.events.map(r=>['Atividade',r.id,null,null,new Date(r.recorded_at*1000).toISOString()+' '+(r.kind==='verification_failed'?'Verificação divergente':paymentLabel(r.status))])];
      return new Response(request.method==='HEAD'?null:csv(rows),{headers:{...privacy,'content-type':'text/csv; charset=utf-8','content-disposition':'attachment; filename="relatorios.csv"'}});
    }
    if (path === '/admin/pedidos/exportar') {
      const { results } = await orderRows(env.DB,env.MP_MODE ?? 'production',orderFilters(url.searchParams),5001,0);
      if (results.length > 5000) return result({error:'Mais de 5.000 pedidos. Restrinja o período ou o filtro.'},422);
      const rows = [['Pedido','SKU','Produto','Centavos (BRL)','Desconto em centavos','Cupom','Estado','Order Mercado Pago','Pagamento Mercado Pago','Criado (UTC)'],
        ...results.map(o=>[o.id,o.sku,o.title,o.price_cents,o.discount_cents,o.coupon_code,paymentLabel(o.status),o.remote_id,o.payment_id,new Date(o.created_at*1000).toISOString()])];
      return new Response(request.method==='HEAD'?null:csv(rows),{headers:{...privacy,'content-type':'text/csv; charset=utf-8','content-disposition':'attachment; filename="pedidos.csv"'}});
    }
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
