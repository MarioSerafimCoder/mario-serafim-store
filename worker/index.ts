import { createRemoteOrder, getRemoteOrder, hex, hmacKey, paymentState, validProviderId, validWebhook, verifyHmac, verifyOrder } from './mercado-pago.ts';
import type { Env, Order, Product } from './types.ts';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const skuPattern = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
const encoder = new TextEncoder();
const now = () => Math.floor(Date.now() / 1000);
const headers = { 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' };

function json(data: unknown, status = 200, extra: HeadersInit = {}) {
  return Response.json(data, { status, headers: { ...headers, ...extra } });
}

function error(message: string, status: number) {
  return json({ error: message }, status);
}

type Ready = Env & Required<Pick<Env, 'DB' | 'MP_MODE' | 'MP_ACCESS_TOKEN' | 'MP_SELLER_ID' | 'STORE_ORIGIN' | 'STORE_SESSION_SECRET'>>;
function ready(env: Env): env is Ready {
  return Boolean(env.DB && env.MP_ACCESS_TOKEN && /^\d+$/.test(env.MP_SELLER_ID ?? '') &&
    /^https:\/\/[a-z0-9.-]+$/.test(env.STORE_ORIGIN ?? '') && (env.STORE_SESSION_SECRET?.length ?? 0) >= 32 &&
    (env.MP_MODE === 'test' || env.MP_MODE === 'production'));
}

async function readBody(request: Request, form = false): Promise<Record<string, unknown> | null> {
  const contentType = form ? 'application/x-www-form-urlencoded' : 'application/json';
  if (request.headers.get('content-type')?.split(';')[0] !== contentType || !request.body) return null;
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2048) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    if (form) return Object.fromEntries(new URLSearchParams(text));
    const data = JSON.parse(text);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

async function hash(code: string) {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(code)));
}

async function signature(secret: string, data: string) {
  return hex(await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(data)));
}

async function cookie(env: Ready, order: Order) {
  const data = `${order.id}.${now() + 86400}`;
  const mac = await signature(env.STORE_SESSION_SECRET, `session:${data}`);
  return `store_session=${data}.${mac}; Path=/compras/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`;
}

function findOrder(env: Ready, id: string) {
  return env.DB.prepare('SELECT * FROM orders WHERE id = ? AND mode = ? AND seller = ?')
    .bind(id, env.MP_MODE, env.MP_SELLER_ID).first<Order>();
}

async function session(request: Request, env: Ready) {
  const value = request.headers.get('cookie')?.split(/;\s*/).find((part) => part.startsWith('store_session='))?.slice(14);
  const [id = '', expiry = '', mac = ''] = value?.split('.') ?? [];
  if (!uuid.test(id) || !/^\d{10}$/.test(expiry) || Number(expiry) <= now()) return null;
  if (!await verifyHmac(env.STORE_SESSION_SECRET, `session:${id}.${expiry}`, mac)) return null;
  return findOrder(env, id);
}

async function available(env: Ready, sku: string) {
  if (env.CHECKOUT_ENABLED !== 'true' || !env.MP_WEBHOOK_SECRET || !env.FILES || sku.startsWith('DEMO-')) return null;
  const res = await env.ASSETS.fetch(new Request(`${env.STORE_ORIGIN}/catalogo-compras.json`));
  if (!res.ok) return null;
  const catalog = await res.json() as Product[];
  const product = catalog.find((entry) => entry.sku === sku);
  if (!product || !Number.isSafeInteger(product.priceCents) || product.priceCents <= 0 || product.currency !== 'BRL') return null;
  const file = await env.DB.prepare('SELECT object_key, filename FROM fulfillment WHERE sku = ? AND version = ? AND enabled = 1')
    .bind(sku, product.version).first<{ object_key: string; filename: string }>();
  if (!file || !await env.FILES.head(file.object_key)) return null;
  return { product, file };
}

async function checkout(request: Request, env: Ready) {
  const body = await readBody(request);
  if (!body || Object.keys(body).length !== 2 || typeof body.sku !== 'string' || !skuPattern.test(body.sku)
      || body.sku.length > 80 || typeof body.code !== 'string' || !uuid.test(body.code)) {
    return error('Dados de compra inválidos.', 400);
  }
  if (env.CHECKOUT_ENABLED !== 'true' || !env.MP_WEBHOOK_SECRET || !env.FILES) return error('Compra indisponível.', 503);
  const recoveryHash = await hash(body.code);
  const find = () => env.DB.prepare('SELECT * FROM orders WHERE recovery_hash = ?')
    .bind(recoveryHash).first<Order>();
  let order = await find();
  if (!order) {
    const offer = await available(env, body.sku);
    if (!offer) return error('Produto indisponível para compra.', 404);
    const { product, file } = offer;
    await env.DB.prepare(`
      INSERT INTO orders(id, recovery_hash, sku, title, price_cents, currency, object_key, filename, mode, seller, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(recovery_hash) DO NOTHING
    `).bind(crypto.randomUUID(), recoveryHash, product.sku, product.name.slice(0, 127), product.priceCents, product.currency,
      file.object_key, file.filename, env.MP_MODE, env.MP_SELLER_ID, now()).run();
    order = await find();
  }
  if (!order || order.sku !== body.sku || order.mode !== env.MP_MODE || order.seller !== env.MP_SELLER_ID) {
    return error('Essa tentativa de compra pertence a outro pedido.', 409);
  }
  if (order.created_at + 86400 <= now() || !['created', 'pending'].includes(order.status)) {
    return error('Acesse seu pedido para consultar o pagamento.', 409);
  }
  if (!order.checkout_url) {
    // The provider idempotency key is the persisted order ID, even after a timeout or concurrent retry.
    const remote = await createRemoteOrder(env, order);
    await env.DB.prepare('UPDATE orders SET remote_id = ?, checkout_url = ? WHERE id = ? AND (remote_id IS NULL OR remote_id = ?)')
      .bind(remote.id, remote.url, order.id, remote.id).run();
    order = await find();
  }
  if (!order?.checkout_url) return error('Não foi possível iniciar o checkout. Tente novamente.', 503);
  return json({ id: order.id, checkoutUrl: order.checkout_url }, 200, { 'set-cookie': await cookie(env, order) });
}

async function reconcile(env: Ready, order: Order, remoteId: string) {
  const remote = await getRemoteOrder(env, remoteId);
  if (!verifyOrder(remote, order) || remote.id.toUpperCase() !== remoteId.toUpperCase()) {
    await env.DB.prepare("INSERT INTO order_events(order_id, kind, status) VALUES (?, 'verification_failed', ?)")
      .bind(order.id, order.status).run();
    return false;
  }

  const updated = Date.parse(remote.last_updated_date);
  if (!Number.isFinite(updated)) return false;
  const { status, payment } = paymentState(remote, order);
  await env.DB.prepare(`
    UPDATE orders SET status = ?, payment_id = COALESCE(?, payment_id), provider_updated = ?, last_check = ?
    WHERE id = ? AND remote_id = ? AND (
      provider_updated < ? OR (provider_updated = ? AND (
        status = ? OR (status IN ('created','pending') AND ? NOT IN ('created','pending'))
        OR (status = 'approved' AND ? IN ('review','canceled','refunded','disputed'))
      ))
    ) AND (status NOT IN ('refunded','disputed') OR ? <> 'approved')
  `).bind(status, payment, updated, now(), order.id, order.remote_id, updated, updated, status, status, status, status).run();
  return true;
}

async function webhook(request: Request, env: Ready, url: URL) {
  const values = url.searchParams.getAll('data.id');
  const id = values[0];
  if (values.length !== 1 || !validProviderId(id) || !env.MP_WEBHOOK_SECRET ||
      !await validWebhook(request, env.MP_WEBHOOK_SECRET, id)) return error('Notificação inválida.', 401);
  const order = await env.DB.prepare('SELECT * FROM orders WHERE remote_id = ? COLLATE NOCASE AND mode = ? AND seller = ?')
    .bind(id, env.MP_MODE, env.MP_SELLER_ID).first<Order>();
  // Early notifications may arrive before the create response was stored. Scheduled reconciliation covers these.
  if (order?.remote_id) await reconcile(env, order, order.remote_id);
  return json({ received: true });
}

async function recover(request: Request, env: Ready) {
  const body = await readBody(request);
  if (!body || typeof body.code !== 'string' || !uuid.test(body.code)) return error('Código inválido.', 400);
  const order = await env.DB.prepare('SELECT * FROM orders WHERE recovery_hash = ? AND mode = ? AND seller = ?')
    .bind(await hash(body.code), env.MP_MODE, env.MP_SELLER_ID).first<Order>();
  if (!order) return error('Compra não encontrada para esse código.', 404);
  return json({ id: order.id }, 200, { 'set-cookie': await cookie(env, order) });
}

async function download(request: Request, env: Ready, order: Order) {
  const body = await readBody(request, true);
  const [expiry = '', mac = ''] = typeof body?.grant === 'string' ? body.grant.split('.') : [];
  if (order.status !== 'approved' || !order.remote_id || !env.FILES ||
      !/^\d{10}$/.test(expiry) || Number(expiry) <= now() ||
      !await verifyHmac(env.STORE_SESSION_SECRET, `download:${order.id}.${expiry}`, mac)) {
    return error('Download indisponível para este pedido.', 403);
  }
  if (!await reconcile(env, order, order.remote_id) || (await findOrder(env, order.id))?.status !== 'approved') {
    return error('Não foi possível confirmar o acesso ao arquivo.', 403);
  }
  const file = await env.FILES.get(order.object_key);
  if (!file) return error('Arquivo temporariamente indisponível.', 503);
  await env.DB.prepare(`
    INSERT INTO order_events(order_id, kind, status)
    SELECT id, 'download_started', status FROM orders WHERE id = ? AND status = 'approved'
    RETURNING id
  `).bind(order.id).first<number>().then((record) => {
    if (!record) throw new Error('Acesso revogado');
  });
  const filename = order.filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'produto.zip';
  return new Response(file.body, { headers: {
    ...headers, 'content-type': 'application/octet-stream', 'content-length': String(file.size),
    'content-disposition': `attachment; filename="${filename}"`,
  } });
}

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const route = url.pathname;
  if (request.method === 'GET' && /^\/compras\/retorno\/[^/]+\/(sucesso|pendente|falha)\/?$/.test(route)) {
    const id = route.split('/')[3];
    const path = uuid.test(id) ? `/compras/?pedido=${id}` : '/compras/';
    return new Response(null, { status: 303, headers: { ...headers, location: path } });
  }
  if (!route.startsWith('/compras/api/')) return env.ASSETS.fetch(request);
  if (!ready(env)) return error('Serviço de compras indisponível.', 503);
  if (url.origin !== env.STORE_ORIGIN) return error('Endereço inválido.', 403);
  if (route === '/compras/api/webhook' && request.method === 'POST') return webhook(request, env, url);
  if (request.method === 'POST' && request.headers.get('origin') !== env.STORE_ORIGIN) return error('Origem inválida.', 403);
  if (route === '/compras/api/disponibilidade' && request.method === 'GET') {
    const sku = url.searchParams.get('sku') ?? '';
    return json({ available: sku.length <= 80 && skuPattern.test(sku) && Boolean(await available(env, sku)) });
  }
  if (route === '/compras/api/checkout' && request.method === 'POST') return checkout(request, env);
  if (route === '/compras/api/recuperar' && request.method === 'POST') return recover(request, env);
  const order = await session(request, env);
  if (!order) return error('Recupere a compra com seu código de acesso.', 401);
  if (route === '/compras/api/pedido' && request.method === 'GET') {
    const expected = url.searchParams.get('pedido');
    if (expected && expected !== order.id) return error('Recupere a compra com seu código de acesso.', 401);
    const expiry = now() + 300;
    const grant = order.status === 'approved' ? `${expiry}.${await signature(env.STORE_SESSION_SECRET, `download:${order.id}.${expiry}`)}` : null;
    return json({ id: order.id, title: order.title, status: order.status, grant });
  }
  if (route === '/compras/api/atualizar' && request.method === 'POST') {
    if (order.remote_id) await refresh(env, order);
    return json({ updated: true });
  }
  if (route === '/compras/api/download' && request.method === 'POST') return download(request, env, order);
  return error('Rota de compras inválida.', 404);
}

async function refresh(env: Ready, order: Order) {
  if (!order.remote_id) return;
  const claimed = await env.DB.prepare('UPDATE orders SET last_check = ? WHERE id = ? AND last_check < ? RETURNING id')
    .bind(now(), order.id, now() - 30).first<{ id: string }>();
  if (claimed) await reconcile(env, order, order.remote_id);
}

export default {
  async fetch(request: Request, env: Env) {
    try {
      return await handle(request, env);
    } catch (failure) {
      const message = failure instanceof Error && /^Mercado Pago HTTP \d{3}$/.test(failure.message)
        ? failure.message : 'Falha de processamento do checkout';
      console.error(message);
      return error('Serviço temporariamente indisponível. Tente novamente.', 503);
    }
  },

  async scheduled(_event: unknown, env: Env) {
    if (!ready(env)) return;
    const { results } = await env.DB.prepare(`
      SELECT * FROM orders WHERE mode = ? AND seller = ? AND remote_id IS NOT NULL
      AND status NOT IN ('refunded','canceled') AND created_at > ? AND last_check < ?
      ORDER BY last_check LIMIT 8
    `).bind(env.MP_MODE, env.MP_SELLER_ID, now() - 90 * 86400, now() - 900).all<Order>();
    const outcomes = await Promise.allSettled(results.map((order) => refresh(env, order)));
    if (outcomes.some((result) => result.status === 'rejected')) console.error('Reconciliação de compras incompleta');
  },
};
