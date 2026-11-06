import { createRemoteOrder, getRemoteOrder, hex, hmacKey, paymentState, validProviderId, validWebhook, verifyHmac, verifyOrder } from './mercado-pago.ts';
import type { CartLine, CheckoutCart, Env, Order, Product } from './types.ts';
import { couponDiscount, couponPattern, eligibleCoupon, minimumCharged } from './coupons.ts';
import { catalogOffer } from './catalog.ts';
import { blockDelivery, deliveryAddress, deliveryConfigured, deliveryEnabled, dispatchDelivery, registerDelivery, safeFilename, sendDelivery } from './email-delivery.ts';

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
      if (size > 4096) {
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

async function cookie(env: Ready, id: string) {
  const data = `${id}.${now() + 86400}`;
  const mac = await signature(env.STORE_SESSION_SECRET, `session:${data}`);
  return `store_session=${data}.${mac}; Path=/compras/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`;
}

function findOrder(env: Ready, id: string) {
  return env.DB.prepare('SELECT * FROM orders WHERE id = ? AND mode = ? AND seller = ?')
    .bind(id, env.MP_MODE, env.MP_SELLER_ID).first<Order>();
}

function findCart(env: Ready, id: string) {
  return env.DB.prepare('SELECT * FROM checkout_carts WHERE id = ? AND mode = ? AND seller = ?')
    .bind(id, env.MP_MODE, env.MP_SELLER_ID).first<CheckoutCart>();
}

type PurchaseSession = { kind: 'cart'; cart: CheckoutCart } | { kind: 'order'; order: Order };

async function session(request: Request, env: Ready) {
  const value = request.headers.get('cookie')?.split(/;\s*/).find((part) => part.startsWith('store_session='))?.slice(14);
  const [id = '', expiry = '', mac = ''] = value?.split('.') ?? [];
  if (!uuid.test(id) || !/^\d{10}$/.test(expiry) || Number(expiry) <= now()) return null;
  if (!await verifyHmac(env.STORE_SESSION_SECRET, `session:${id}.${expiry}`, mac)) return null;
  const cart = await findCart(env, id);
  if (cart) return { kind: 'cart', cart } satisfies PurchaseSession;
  const order = await findOrder(env, id);
  return order ? { kind: 'order', order } satisfies PurchaseSession : null;
}

async function staticCatalog(env: Ready): Promise<Product[]> {
  const response = await env.ASSETS.fetch(new Request(`${env.STORE_ORIGIN}/catalogo-compras.json`));
  return response.ok ? await response.json() as Product[] : [];
}

async function orderImages(env: Ready, skus: string[]) {
  if (!skus.length) return new Map<string, string>();
  if (env.DYNAMIC_CATALOG === 'true') {
    const { results } = await env.DB.prepare(`
      SELECT sku, json_extract(details, '$.images[0].src') AS image
      FROM products WHERE status IN ('published', 'coming_soon')
      AND sku IN (${skus.map(() => '?').join(',')})
    `).bind(...skus).all<{ sku: string; image: string | null }>();
    return new Map(results.flatMap(({ sku, image }) => image ? [[sku, image] as const] : []));
  }
  const catalog = await staticCatalog(env);
  return new Map(catalog.flatMap(({ sku, image }) => image && skus.includes(sku) ? [[sku, image] as const] : []));
}

async function available(env: Ready, sku: string) {
  if (env.CHECKOUT_ENABLED !== 'true' || !env.MP_WEBHOOK_SECRET || !env.FILES || sku.startsWith('DEMO-')) return null;
  if (env.DYNAMIC_CATALOG === 'true') {
    const offer = await catalogOffer(env.DB, sku);
    if (!offer || !await env.FILES.head(offer.object_key)) return null;
    const { object_key, filename, ...product } = offer;
    return { product, file: { object_key, filename } };
  }
  const catalog = await staticCatalog(env);
  const product = catalog.find((entry) => entry.sku === sku);
  if (!product || !Number.isSafeInteger(product.priceCents) || product.priceCents <= 0 || product.currency !== 'BRL') return null;
  const file = await env.DB.prepare('SELECT object_key, filename FROM fulfillment WHERE sku = ? AND version = ? AND enabled = 1')
    .bind(sku, product.version).first<{ object_key: string; filename: string }>();
  if (!file || !await env.FILES.head(file.object_key)) return null;
  return { product, file };
}

function couponInput(value: unknown) {
  const code = typeof value === 'string' && value.length <= 24 ? value.trim().toUpperCase() : '';
  return couponPattern.test(code) ? code : null;
}

async function quote(request: Request, env: Ready) {
  if (env.COUPONS_ENABLED !== 'true' || env.DYNAMIC_CATALOG !== 'true') return error('Cupons indisponíveis.',404);
  const body = await readBody(request);
  const code = couponInput(body?.coupon);
  if (!body || typeof body.sku !== 'string' || body.sku.length > 80 || !skuPattern.test(body.sku) || !code) {
    return error('Informe um cupom válido.',400);
  }
  const offer = await available(env,body.sku);
  if (!offer) return error('Produto indisponível.',404);
  const price = offer.product.priceCents;
  if (body.expectedPriceCents !== price) return error('O preço mudou. Recarregue a página.',412);
  const discount = await couponDiscount(env.DB,code,body.sku,price);
  if (discount === null) return error('Cupom indisponível para este produto.',422);
  return json({coupon:code,discountCents:discount,totalCents:price-discount});
}

async function checkout(request: Request, env: Ready) {
  const body = await readBody(request);
  const dynamic = env.DYNAMIC_CATALOG === 'true';
  const couponRequested = body && (Object.hasOwn(body,'coupon') || Object.hasOwn(body,'expectedTotalCents'));
  const coupon = couponRequested ? couponInput(body?.coupon) : null;
  const allowed = dynamic ? ['sku','code','expectedPriceCents',...(couponRequested ? ['coupon','expectedTotalCents'] : [])] : ['sku','code'];
  const email = deliveryEnabled(env) ? deliveryAddress(body?.email) : null;
  if (deliveryEnabled(env)) {
    if (!email) return error('Informe um e-mail válido para receber sua compra.',400);
    if (!deliveryConfigured(env)) return error('Entrega por e-mail indisponível.',503);
    allowed.push('email');
  }
  if (!body || Object.keys(body).length !== allowed.length || Object.keys(body).some(key=>!allowed.includes(key)) ||
      (couponRequested && (!dynamic || env.COUPONS_ENABLED !== 'true' || !coupon || !Number.isSafeInteger(body.expectedTotalCents))) ||
      (dynamic && !Number.isSafeInteger(body.expectedPriceCents))
      || typeof body.sku !== 'string' || !skuPattern.test(body.sku)
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
    if (dynamic && body.expectedPriceCents !== product.priceCents) return error('O preço mudou. Recarregue a página.', 412);
    const snapshot = [crypto.randomUUID(), recoveryHash, product.sku, product.name.slice(0, 127), product.priceCents,
      product.currency, file.object_key, file.filename, env.MP_MODE, env.MP_SELLER_ID, now()];
    if (coupon) {
      await env.DB.prepare(`
        WITH offer AS (${eligibleCoupon})
        INSERT INTO orders(id,recovery_hash,sku,title,price_cents,currency,object_key,filename,mode,seller,created_at,category_at_purchase,coupon_code,discount_cents)
        SELECT ?,?,?,?,p.price_cents-offer.discount,?,?,?,?,?,?,p.category,offer.code,offer.discount FROM products p
        JOIN fulfillment f ON f.sku=p.sku AND f.version=p.version AND f.enabled=1 CROSS JOIN offer
        WHERE p.sku=? AND p.status='published' AND p.price_cents=? AND p.version=? AND p.name=? AND f.object_key=?
          AND offer.discount>0 AND p.price_cents-offer.discount>=? AND p.price_cents-offer.discount=?
        ON CONFLICT(recovery_hash) DO NOTHING
      `).bind(coupon,product.sku,...snapshot.slice(0,4),...snapshot.slice(5),
        product.sku,product.priceCents,product.version,product.name,file.object_key,minimumCharged,Number(body.expectedTotalCents)).run();
    } else if (dynamic) {
      await env.DB.prepare(`
        INSERT INTO orders(id, recovery_hash, sku, title, price_cents, currency, object_key, filename, mode, seller, created_at, category_at_purchase)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, p.category FROM products p
        JOIN fulfillment f ON f.sku=p.sku AND f.version=p.version AND f.enabled=1
        WHERE p.sku=? AND p.status='published' AND p.price_cents=? AND p.version=? AND p.name=? AND f.object_key=?
        ON CONFLICT(recovery_hash) DO NOTHING
      `).bind(...snapshot,product.sku,product.priceCents,product.version,product.name,file.object_key).run();
    } else await env.DB.prepare(`
      INSERT INTO orders(id, recovery_hash, sku, title, price_cents, currency, object_key, filename, mode, seller, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(recovery_hash) DO NOTHING
    `).bind(...snapshot).run();
    order = await find();
    if (dynamic && !order) return error(coupon ? 'Cupom, preço ou disponibilidade mudou. Confira novamente.' : 'O produto mudou. Recarregue a página.', 412);
  }
  if (!order || order.sku !== body.sku || order.mode !== env.MP_MODE || order.seller !== env.MP_SELLER_ID) {
    return error('Essa tentativa de compra pertence a outro pedido.', 409);
  }
  if (dynamic && ((order.coupon_code ?? null) !== coupon || order.price_cents + (order.discount_cents ?? 0) !== body.expectedPriceCents ||
    (coupon && order.price_cents !== body.expectedTotalCents))) {
    return error('Há um pedido anterior com outro preço ou cupom. Consulte-o antes de continuar.',409);
  }
  if (order.created_at + 86400 <= now() || !['created', 'pending'].includes(order.status)) {
    return error('Acesse seu pedido para consultar o pagamento.', 409);
  }
  if (email && !await registerDelivery(env.DB,order.id,email)) return error('E-mail diferente da tentativa anterior.',409);
  if (!order.checkout_url) {
    // The provider idempotency key is the persisted order ID, even after a timeout or concurrent retry.
    const remote = await createRemoteOrder(env, order);
    await env.DB.prepare('UPDATE orders SET remote_id = ?, checkout_url = ? WHERE id = ? AND (remote_id IS NULL OR remote_id = ?)')
      .bind(remote.id, remote.url, order.id, remote.id).run();
    order = await find();
  }
  if (!order?.checkout_url) return error('Não foi possível iniciar o checkout. Tente novamente.', 503);
  return json({ id: order.id, checkoutUrl: order.checkout_url }, 200, { 'set-cookie': await cookie(env, order.id) });
}

interface CartRequestItem {
  sku: string;
  expectedPriceCents: number;
  coupon?: string;
  expectedTotalCents?: number;
}

async function continueCartCheckout(env: Ready, cart: CheckoutCart, email: string | null) {
  if (cart.mode !== env.MP_MODE || cart.seller !== env.MP_SELLER_ID || cart.created_at + 86400 <= now() ||
      !['created','pending'].includes(cart.status)) return error('Acesse sua compra para consultar o pagamento.', 409);
  if (email && !await registerDelivery(env.DB,cart.id,email)) return error('E-mail diferente da tentativa anterior.',409);
  if (!cart.checkout_url) {
    const lines = await env.DB.prepare('SELECT * FROM orders WHERE cart_id=? ORDER BY cart_position').bind(cart.id).all<CartLine>();
    const remote = await createRemoteOrder(env, cart, lines.results);
    await env.DB.prepare('UPDATE checkout_carts SET remote_id=?,checkout_url=? WHERE id=? AND (remote_id IS NULL OR remote_id=?)')
      .bind(remote.id,remote.url,cart.id,remote.id).run();
    const updatedCart = await findCart(env, cart.id);
    if (!updatedCart) return error('Não foi possível iniciar o checkout. Tente novamente.',503);
    cart = updatedCart;
  }
  if (!cart?.checkout_url) return error('Não foi possível iniciar o checkout. Tente novamente.', 503);
  return json({id:cart.id,checkoutUrl:cart.checkout_url},200,{'set-cookie':await cookie(env,cart.id)});
}

async function checkoutCart(request: Request, env: Ready) {
  const body = await readBody(request);
  const enabled = deliveryEnabled(env);
  const email = enabled ? deliveryAddress(body?.email) : null;
  if (enabled && !email) return error('Informe um e-mail válido para receber sua compra.',400);
  if (enabled && !deliveryConfigured(env)) return error('Entrega por e-mail indisponível.',503);
  if (!body || Object.keys(body).length !== (enabled ? 3 : 2) || !Array.isArray(body.items) || body.items.length < 1 || body.items.length > 10 ||
      typeof body.code !== 'string' || !uuid.test(body.code) || body.items.some((value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return true;
        const item = value as Record<string, unknown>;
        const hasCoupon = Object.hasOwn(item, 'coupon') || Object.hasOwn(item, 'expectedTotalCents');
        const keys = Object.keys(item);
        return keys.some((key) => !['sku', 'expectedPriceCents', ...(hasCoupon ? ['coupon', 'expectedTotalCents'] : [])].includes(key)) ||
          typeof item.sku !== 'string' || item.sku.length > 80 || !skuPattern.test(item.sku) ||
          !Number.isSafeInteger(item.expectedPriceCents) || (hasCoupon && (!Number.isSafeInteger(item.expectedTotalCents) ||
            typeof item.coupon !== 'string' || !couponInput(item.coupon)));
      })) return error('Dados do carrinho inválidos.', 400);
  if (env.CHECKOUT_ENABLED !== 'true' || !env.MP_WEBHOOK_SECRET || !env.FILES) {
    return error('Compra indisponível.', 503);
  }

  const requested = body.items as CartRequestItem[];
  if (new Set(requested.map((item) => item.sku)).size !== requested.length) return error('Remova os produtos repetidos do carrinho.', 400);
  const recoveryHash = await hash(body.code);
  const previous = await env.DB.prepare('SELECT * FROM checkout_carts WHERE recovery_hash=? AND mode=? AND seller=?')
    .bind(recoveryHash,env.MP_MODE,env.MP_SELLER_ID).first<CheckoutCart>();
  if (previous) {
    const sql = env.DYNAMIC_CATALOG === 'true'
      ? 'SELECT sku,price_cents,coupon_code,discount_cents FROM orders WHERE cart_id=? ORDER BY cart_position'
      : 'SELECT sku,price_cents,NULL AS coupon_code,0 AS discount_cents FROM orders WHERE cart_id=? ORDER BY cart_position';
    const { results } = await env.DB.prepare(sql).bind(previous.id)
      .all<{sku:string;price_cents:number;coupon_code:string|null;discount_cents:number}>();
    const matches = results.length === requested.length && results.every((line,index) => {
      const item = requested[index];
      const coupon = typeof item.coupon === 'string' ? couponInput(item.coupon) : null;
      return line.sku === item.sku && line.price_cents + line.discount_cents === item.expectedPriceCents &&
        line.coupon_code === coupon && (!coupon || line.price_cents === item.expectedTotalCents);
    });
    if (!matches || previous.total_cents !== results.reduce((sum,line)=>sum+line.price_cents,0)) {
      return error('Este código já está vinculado a outro carrinho.',409);
    }
    return continueCartCheckout(env,previous,email);
  }
  const enriched: { input: CartRequestItem; sku: string; title: string; price: number; version: string; object_key: string; filename: string; discount: number; coupon: string | null }[] = [];
  for (const input of requested) {
    const offer = await available(env, input.sku);
    if (!offer) return error('Um dos produtos do carrinho não está mais disponível.', 404);
    const product = offer.product;
    if (input.expectedPriceCents !== product.priceCents) return error('O preço de um produto mudou. Atualize o carrinho.', 412);
    let coupon: string | null = null;
    let discount = 0;
    if (Object.hasOwn(input, 'coupon') || Object.hasOwn(input, 'expectedTotalCents')) {
      coupon = env.DYNAMIC_CATALOG === 'true' && env.COUPONS_ENABLED === 'true' && typeof input.coupon === 'string' ? couponInput(input.coupon) : null;
      if (!coupon || !Number.isSafeInteger(input.expectedTotalCents)) return error('Confira novamente os cupons do carrinho.', 400);
      const current = await couponDiscount(env.DB, coupon, input.sku, product.priceCents);
      if (current === null || product.priceCents - current !== input.expectedTotalCents) return error('Um cupom ou preço mudou. Confira o carrinho.', 412);
      discount = current;
    }
    enriched.push({ input, sku: product.sku, title: product.name, price: product.priceCents, version: product.version,
      object_key: offer.file.object_key, filename: offer.file.filename, discount, coupon });
  }
  const total = enriched.reduce((sum, line) => sum + line.price - line.discount, 0);
  if (!Number.isSafeInteger(total) || total <= 0 || total > 99999999) return error('Total do carrinho inválido.', 400);

  const matches = async (candidate: CheckoutCart) => {
    const sql = env.DYNAMIC_CATALOG === 'true'
      ? 'SELECT sku,price_cents,coupon_code,discount_cents FROM orders WHERE cart_id=? ORDER BY cart_position'
      : 'SELECT sku,price_cents,NULL AS coupon_code,0 AS discount_cents FROM orders WHERE cart_id=? ORDER BY cart_position';
    const { results } = await env.DB.prepare(sql).bind(candidate.id)
      .all<{sku:string;price_cents:number;coupon_code:string|null;discount_cents:number}>();
    const expected = enriched.map(({sku,price,discount,coupon})=>({sku,price_cents:price-discount,coupon_code:coupon,discount_cents:discount}));
    return candidate.total_cents === total && JSON.stringify(results) === JSON.stringify(expected);
  };
  let cart = await env.DB.prepare('SELECT * FROM checkout_carts WHERE recovery_hash = ?').bind(recoveryHash).first<CheckoutCart>();
  if (cart) {
    if (!await matches(cart)) return error('Este código já está vinculado a outro carrinho.', 409);
  } else {
    const cartId = crypto.randomUUID();
    const statements = [env.DB.prepare(`INSERT INTO checkout_carts(id,recovery_hash,total_cents,currency,mode,seller,created_at)
      VALUES(?,?,?,'BRL',?,?,?)`).bind(cartId,recoveryHash,total,env.MP_MODE,env.MP_SELLER_ID,now())];
    for (const [cartPosition,line] of enriched.entries()) {
      const orderId = crypto.randomUUID();
      const hiddenRecovery = await hash('cart-line:' + orderId);
      if (line.coupon && env.DYNAMIC_CATALOG === 'true') {
        statements.push(env.DB.prepare(`WITH offer AS (${eligibleCoupon})
          INSERT INTO orders(id,recovery_hash,sku,title,price_cents,currency,object_key,filename,mode,seller,created_at,category_at_purchase,coupon_code,discount_cents,cart_id,cart_position)
          SELECT ?,?,?,?,p.price_cents-offer.discount,'BRL',?,?,?, ?,?,p.category,offer.code,offer.discount,?,?
          FROM products p JOIN fulfillment f ON f.sku=p.sku AND f.version=p.version AND f.enabled=1 CROSS JOIN offer
          WHERE p.sku=? AND p.status='published' AND p.price_cents=? AND p.version=? AND p.name=? AND f.object_key=?
            AND offer.discount=? AND p.price_cents-offer.discount=?
        ON CONFLICT(recovery_hash) DO NOTHING`).bind(line.coupon,line.sku,orderId,hiddenRecovery,line.sku,line.title,
          line.object_key,line.filename,env.MP_MODE,env.MP_SELLER_ID,now(),cartId,cartPosition,line.sku,line.price,line.version,line.title,line.object_key,
          line.discount,line.price-line.discount));
      } else if (env.DYNAMIC_CATALOG === 'true') {
        statements.push(env.DB.prepare(`INSERT INTO orders(id,recovery_hash,sku,title,price_cents,currency,object_key,filename,mode,seller,created_at,category_at_purchase,cart_id,cart_position)
          SELECT ?,?,?,?,?, 'BRL',?,?,?,?,?,p.category,?,? FROM products p JOIN fulfillment f ON f.sku=p.sku AND f.version=p.version AND f.enabled=1
          WHERE p.sku=? AND p.status='published' AND p.price_cents=? AND p.version=? AND p.name=? AND f.object_key=?
          ON CONFLICT(recovery_hash) DO NOTHING`).bind(orderId,hiddenRecovery,line.sku,line.title,line.price,line.object_key,line.filename,
          env.MP_MODE,env.MP_SELLER_ID,now(),cartId,cartPosition,line.sku,line.price,line.version,line.title,line.object_key));
      } else {
        statements.push(env.DB.prepare(`INSERT INTO orders(id,recovery_hash,sku,title,price_cents,currency,object_key,filename,mode,seller,created_at,cart_id,cart_position)
          SELECT ?,?,?,?,?, 'BRL',?,?,?,?,?,?,? FROM fulfillment
          WHERE sku=? AND version=? AND enabled=1 AND object_key=?
          ON CONFLICT(recovery_hash) DO NOTHING`).bind(orderId,hiddenRecovery,line.sku,line.title,line.price,line.object_key,line.filename,
          env.MP_MODE,env.MP_SELLER_ID,now(),cartId,cartPosition,line.sku,line.version,line.object_key));
      }
    }
    try {
      await env.DB.batch(statements);
    } catch (failure) {
      cart = await env.DB.prepare('SELECT * FROM checkout_carts WHERE recovery_hash=?').bind(recoveryHash).first<CheckoutCart>();
      if (!cart) throw failure;
    }
    if (!cart) cart = await findCart(env, cartId);
    if (!cart || !await matches(cart)) {
      if (cart?.id === cartId) await env.DB.batch([env.DB.prepare("UPDATE checkout_carts SET status='canceled' WHERE id=?").bind(cartId),
        env.DB.prepare("UPDATE orders SET status='canceled' WHERE cart_id=?").bind(cartId)]);
      return error('Um produto mudou durante a criação do carrinho. Atualize e tente novamente.', 412);
    }
  }
  return cart ? continueCartCheckout(env,cart,email) : error('Não foi possível criar o carrinho. Tente novamente.',503);
}

async function afterPayment(env: Ready, id: string, status: string, dispatch: boolean) {
  if (status === 'refunded' || status === 'disputed') await blockDelivery(env,id);
  if (status === 'approved' && dispatch) await dispatchDelivery(env,id);
}

async function reconcile(env: Ready, order: Order, remoteId: string, dispatch = true) {
  const remote = await getRemoteOrder(env, remoteId);
  if (!verifyOrder(remote, order) || remote.id.toUpperCase() !== remoteId.toUpperCase()) {
    await env.DB.prepare("INSERT INTO order_events(order_id, kind, status) VALUES (?, 'verification_failed', ?)")
      .bind(order.id, order.status).run();
    return false;
  }

  const updated = Date.parse(remote.last_updated_date);
  if (!Number.isFinite(updated)) return false;
  const { status, payment } = paymentState(remote, order);
  const dynamic = env.DYNAMIC_CATALOG === 'true';
  const email = status === 'approved' && typeof remote.payer?.email === 'string' ? remote.payer.email.trim().toLowerCase() : '';
  const buyer = email.length <= 254 &&
    /^[a-z0-9.!#$%&'+/=?^_`{|}~-]{1,64}@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(email) ? email : null;
  await env.DB.prepare(`
    UPDATE orders SET status = ?, payment_id = COALESCE(?, payment_id), provider_updated = ?, last_check = ?
    ${dynamic ? ', buyer_email = COALESCE(buyer_email, ?)' : ''}
    WHERE id = ? AND remote_id = ? AND (
      provider_updated < ? OR (provider_updated = ? AND (
        status = ? OR (status IN ('created','pending') AND ? NOT IN ('created','pending'))
        OR (status = 'approved' AND ? IN ('review','canceled','refunded','disputed'))
      ))
    ) AND (status NOT IN ('refunded','disputed') OR ? <> 'approved')
  `).bind(status, payment, updated, now(), ...(dynamic ? [buyer] : []), order.id, order.remote_id, updated, updated, status, status, status, status).run();
  await afterPayment(env,order.id,status,dispatch);
  return dispatch || status === 'approved';
}

async function reconcileCart(env: Ready, cart: CheckoutCart, remoteId: string, dispatch = true) {
  const remote = await getRemoteOrder(env, remoteId);
  if (!verifyOrder(remote, cart) || remote.id.toUpperCase() !== remoteId.toUpperCase()) {
    const lines = await env.DB.prepare('SELECT id FROM orders WHERE cart_id=?').bind(cart.id).all<{id:string}>();
    await env.DB.batch(lines.results.map(({id})=>env.DB.prepare("INSERT INTO order_events(order_id,kind,status) VALUES(?,'verification_failed',?)").bind(id,cart.status)));
    return false;
  }
  const updated = Date.parse(remote.last_updated_date);
  if (!Number.isFinite(updated)) return false;
  const { status, payment } = paymentState(remote,cart);
  const dynamic = env.DYNAMIC_CATALOG === 'true';
  const email = status === 'approved' && typeof remote.payer?.email === 'string' ? remote.payer.email.trim().toLowerCase() : '';
  const buyer = email.length <= 254 &&
    /^[a-z0-9.!#$%&'+/=?^_`{|}~-]{1,64}@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(email) ? email : null;
  const groupUpdate=env.DB.prepare(`
    UPDATE checkout_carts SET status=?,payment_id=COALESCE(?,payment_id),provider_updated=?,last_check=?
    WHERE id=? AND remote_id=? AND (provider_updated<? OR (provider_updated=? AND (
      status=? OR (status IN ('created','pending') AND ? NOT IN ('created','pending')) OR
      (status='approved' AND ? IN ('review','canceled','refunded','disputed')))))
      AND (status NOT IN ('refunded','disputed') OR ?<>'approved')
  `).bind(status,payment,updated,now(),cart.id,cart.remote_id,updated,updated,status,status,status,status);
  const lineUpdate=env.DB.prepare(`UPDATE orders SET status=?,payment_id=COALESCE(?,payment_id)
    ${dynamic ? ',buyer_email=COALESCE(buyer_email,?)' : ''}
    WHERE cart_id=? AND EXISTS(SELECT 1 FROM checkout_carts c WHERE c.id=? AND c.status=?)`)
    .bind(status,payment,...(dynamic?[buyer]:[]),cart.id,cart.id,status);
  await env.DB.batch([groupUpdate,lineUpdate]);
  await afterPayment(env,cart.id,status,dispatch);
  return dispatch || status === 'approved';
}

async function webhook(request: Request, env: Ready, url: URL) {
  const values = url.searchParams.getAll('data.id');
  const id = values[0];
  if (values.length !== 1 || !validProviderId(id) || !env.MP_WEBHOOK_SECRET ||
      !await validWebhook(request, env.MP_WEBHOOK_SECRET, id)) return error('Notificação inválida.', 401);
  const cart = await env.DB.prepare('SELECT * FROM checkout_carts WHERE remote_id=? COLLATE NOCASE AND mode=? AND seller=?')
    .bind(id,env.MP_MODE,env.MP_SELLER_ID).first<CheckoutCart>();
  if (cart?.remote_id) {
    await reconcileCart(env,cart,cart.remote_id);
    return json({received:true});
  }
  const order = await env.DB.prepare('SELECT * FROM orders WHERE remote_id = ? COLLATE NOCASE AND mode = ? AND seller = ?')
    .bind(id, env.MP_MODE, env.MP_SELLER_ID).first<Order>();
  // Early notifications may arrive before the create response was stored. Scheduled reconciliation covers these.
  if (order?.remote_id) await reconcile(env, order, order.remote_id);
  return json({ received: true });
}

async function recover(request: Request, env: Ready) {
  const body = await readBody(request);
  if (!body || typeof body.code !== 'string' || !uuid.test(body.code)) return error('Código inválido.', 400);
  const recoveryHash = await hash(body.code);
  const cart = await env.DB.prepare('SELECT * FROM checkout_carts WHERE recovery_hash=? AND mode=? AND seller=?')
    .bind(recoveryHash,env.MP_MODE,env.MP_SELLER_ID).first<CheckoutCart>();
  if (cart) return json({id:cart.id},200,{'set-cookie':await cookie(env,cart.id)});
  const order = await env.DB.prepare('SELECT * FROM orders WHERE recovery_hash = ? AND mode = ? AND seller = ?')
    .bind(recoveryHash, env.MP_MODE, env.MP_SELLER_ID).first<Order>();
  if (!order) return error('Compra não encontrada para esse código.', 404);
  return json({ id: order.id }, 200, { 'set-cookie': await cookie(env, order.id) });
}

async function download(request: Request, env: Ready, purchase: PurchaseSession) {
  const body = await readBody(request, true);
  const [expiry = '', mac = ''] = typeof body?.grant === 'string' ? body.grant.split('.') : [];
  let order: Order | null = null;
  if (purchase.kind === 'cart' && typeof body?.item === 'string' && uuid.test(body.item)) {
    order = await env.DB.prepare('SELECT * FROM orders WHERE id=? AND cart_id=?').bind(body.item,purchase.cart.id).first<Order>();
  } else if (purchase.kind === 'order') order = purchase.order;
  const remoteId = purchase.kind === 'cart' ? purchase.cart.remote_id : order?.remote_id;
  const status = purchase.kind === 'cart' ? purchase.cart.status : order?.status;
  if (!order || status !== 'approved' || !remoteId || !env.FILES ||
      !/^\d{10}$/.test(expiry) || Number(expiry) <= now() ||
      !await verifyHmac(env.STORE_SESSION_SECRET, `download:${order.id}.${expiry}`, mac)) {
    return error('Download indisponível para este pedido.', 403);
  }
  if (purchase.kind === 'cart') {
    if (status !== 'approved' || !remoteId || !await reconcileCart(env,purchase.cart,remoteId) ||
        (await findCart(env,purchase.cart.id))?.status !== 'approved') return error('Não foi possível confirmar o acesso ao arquivo.',403);
  } else if (status !== 'approved' || !remoteId || !await reconcile(env,order,remoteId) ||
      (await findOrder(env,order.id))?.status !== 'approved') {
    return error('Não foi possível confirmar o acesso ao arquivo.', 403);
  }
  return streamDownload(env,order);
}

async function streamDownload(env: Ready, order: Order) {
  const file = await env.FILES!.get(order.object_key);
  if (!file) return error('Arquivo temporariamente indisponível.', 503);
  await env.DB.prepare(`
    INSERT INTO order_events(order_id, kind, status)
    SELECT id, 'download_started', status FROM orders WHERE id = ? AND status = 'approved'
    RETURNING id
  `).bind(order.id).first<number>().then((record) => {
    if (!record) throw new Error('Acesso revogado');
  });
  const filename = safeFilename(order.filename);
  return new Response(file.body, { headers: {
    ...headers, 'content-type': 'application/octet-stream', 'content-length': String(file.size),
    'content-disposition': `attachment; filename="${filename}"`,
  } });
}

async function verifyPurchase(env: Ready, order: Order) {
  if (order.cart_id) {
    const cart = await findCart(env,order.cart_id);
    if (!cart?.remote_id || cart.status !== 'approved' || !await reconcileCart(env,cart,cart.remote_id,false)) return null;
    return (await findCart(env,cart.id))?.status === 'approved' ? cart.id : null;
  }
  if (!order.remote_id || order.status !== 'approved' || !await reconcile(env,order,order.remote_id,false)) return null;
  return (await findOrder(env,order.id))?.status === 'approved' ? order.id : null;
}

export async function approvedDeliveryPurchase(env: Env, id: string) {
  if (!ready(env) || !uuid.test(id)) return null;
  const order = await findOrder(env,id);
  return order ? verifyPurchase(env,order) : null;
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
  if (request.method === 'GET' && route.startsWith('/compras/api/arquivo/')) {
    const match = /^\/compras\/api\/arquivo\/([^/]+)\/(\d{10})\.([a-f0-9]{64})$/.exec(route);
    if (!match || !uuid.test(match[1]) || Number(match[2]) <= now() || !env.FILES ||
        !await verifyHmac(env.STORE_SESSION_SECRET,`email-download:${match[1]}.${match[2]}`,match[3])) {
      return error('Link de download inválido ou expirado.',403);
    }
    const order = await findOrder(env,match[1]);
    if (!order || order.status !== 'approved' || !await verifyPurchase(env,order)) return error('Acesso indisponível.',403);
    return streamDownload(env,order);
  }
  if (route === '/compras/api/webhook' && request.method === 'POST') return webhook(request, env, url);
  if (request.method === 'POST' && request.headers.get('origin') !== env.STORE_ORIGIN) return error('Origem inválida.', 403);
  if (route === '/compras/api/disponibilidade' && request.method === 'GET') {
    const sku = url.searchParams.get('sku') ?? '';
    const offer = sku.length <= 80 && skuPattern.test(sku) ? await available(env, sku) : null;
    return json({ available: Boolean(offer), ...(deliveryEnabled(env) ? { emailDelivery: true } : {}),
      ...(env.DYNAMIC_CATALOG === 'true' && offer ? { priceCents: offer.product.priceCents, coupons: env.COUPONS_ENABLED === 'true' } : {}) });
  }
  if (route === '/compras/api/cotacao' && request.method === 'POST') return quote(request,env);
  if (route === '/compras/api/checkout' && request.method === 'POST') return checkout(request, env);
  if (route === '/compras/api/checkout-carrinho' && request.method === 'POST') return checkoutCart(request, env);
  if (route === '/compras/api/recuperar' && request.method === 'POST') return recover(request, env);
  const purchase = await session(request, env);
  if (!purchase) return error('Recupere a compra com seu código de acesso.', 401);
  if (route === '/compras/api/pedido' && request.method === 'GET') {
    const expected = url.searchParams.get('pedido');
    const id = purchase.kind === 'cart' ? purchase.cart.id : purchase.order.id;
    if (expected && expected !== id) return error('Recupere a compra com seu código de acesso.', 401);
    const expiry = now() + 300;
    if (purchase.kind === 'cart') {
      const { results } = await env.DB.prepare('SELECT id,title,sku,status FROM orders WHERE cart_id=? ORDER BY cart_position')
        .bind(purchase.cart.id).all<{id:string;title:string;sku:string;status:string}>();
      const images = await orderImages(env, results.map(({ sku }) => sku)).catch(() => undefined);
      const items = await Promise.all(results.map(async (item) => ({
        id:item.id,title:item.title,sku:item.sku,image:images?.get(item.sku),grant:item.status==='approved'
          ? `${expiry}.${await signature(env.STORE_SESSION_SECRET,`download:${item.id}.${expiry}`)}` : null,
      })));
      return json({id,title:items.map(({title})=>title).join(' · '),status:purchase.cart.status,
        createdAt:purchase.cart.created_at,totalCents:purchase.cart.total_cents,items});
    }
    const order = purchase.order;
    const images = await orderImages(env, [order.sku]).catch(() => undefined);
    const grant = order.status === 'approved' ? `${expiry}.${await signature(env.STORE_SESSION_SECRET, `download:${order.id}.${expiry}`)}` : null;
    return json({ id: order.id, title: order.title, status: order.status, grant,
      createdAt: order.created_at, totalCents: order.price_cents,
      items:[{id:order.id,title:order.title,sku:order.sku,image:images?.get(order.sku),grant}] });
  }
  if (route === '/compras/api/atualizar' && request.method === 'POST') {
    if (purchase.kind === 'cart' && purchase.cart.remote_id) await refreshCart(env,purchase.cart);
    else if (purchase.kind === 'order' && purchase.order.remote_id) await refresh(env,purchase.order);
    return json({ updated: true });
  }
  if (route === '/compras/api/download' && request.method === 'POST') return download(request, env, purchase);
  return error('Rota de compras inválida.', 404);
}

async function refresh(env: Ready, order: Order, dispatch = true) {
  if (!order.remote_id) return;
  const claimed = await env.DB.prepare('UPDATE orders SET last_check = ? WHERE id = ? AND last_check < ? RETURNING id')
    .bind(now(), order.id, now() - 30).first<{ id: string }>();
  if (claimed) await reconcile(env, order, order.remote_id,dispatch);
}

async function refreshCart(env: Ready, cart: CheckoutCart, dispatch = true) {
  if (!cart.remote_id) return;
  const claimed = await env.DB.prepare('UPDATE checkout_carts SET last_check=? WHERE id=? AND last_check<? RETURNING id')
    .bind(now(),cart.id,now()-30).first<{id:string}>();
  if (claimed) await reconcileCart(env,cart,cart.remote_id,dispatch);
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
    const [orders,carts] = await Promise.all([env.DB.prepare(`
      SELECT * FROM orders WHERE mode = ? AND seller = ? AND remote_id IS NOT NULL
      AND status NOT IN ('refunded','canceled') AND created_at > ? AND last_check < ?
      ORDER BY last_check LIMIT 8
    `).bind(env.MP_MODE, env.MP_SELLER_ID, now() - 90 * 86400, now() - 900).all<Order>(),
    env.DB.prepare(`SELECT * FROM checkout_carts WHERE mode=? AND seller=? AND remote_id IS NOT NULL
      AND status NOT IN ('refunded','canceled') AND created_at>? AND last_check<? ORDER BY last_check LIMIT 8`)
      .bind(env.MP_MODE,env.MP_SELLER_ID,now()-90*86400,now()-900).all<CheckoutCart>()]);
    const outcomes = await Promise.allSettled([...orders.results.map((order) => refresh(env, order,false)), ...carts.results.map((cart)=>refreshCart(env,cart,false))]);
    if (outcomes.some((result) => result.status === 'rejected')) console.error('Reconciliação de compras incompleta');
    if (deliveryEnabled(env) && deliveryConfigured(env)) {
      const due = await env.DB.prepare(`SELECT d.purchase_id FROM email_deliveries d
        LEFT JOIN checkout_carts c ON c.id=d.purchase_id LEFT JOIN orders o ON o.id=d.purchase_id AND o.cart_id IS NULL
        WHERE d.state IN ('pending','processing') AND d.next_attempt<=?
        AND COALESCE(c.status,o.status)='approved' AND COALESCE(c.mode,o.mode)=? AND COALESCE(c.seller,o.seller)=?
        ORDER BY d.next_attempt LIMIT 1`).bind(now(),env.MP_MODE,env.MP_SELLER_ID).all<{purchase_id:string}>();
      for (const {purchase_id} of due.results) {
        try {
          const cart = await findCart(env,purchase_id);
          if (cart?.remote_id) await reconcileCart(env,cart,cart.remote_id);
          else {
            const order = await findOrder(env,purchase_id);
            if (order?.remote_id) await reconcile(env,order,order.remote_id);
          }
        } catch { console.error('Retentativa de entrega incompleta'); }
      }
    }
  },

  async queue(batch: { messages: { body: unknown; ack(): void; retry(options?: { delaySeconds: number }): void }[] }, env: Env) {
    if (!ready(env)) {
      for (const message of batch.messages) message.retry({delaySeconds:300});
      return;
    }
    for (const message of batch.messages) {
      if (!deliveryEnabled(env)) { message.ack(); continue; }
      if (!deliveryConfigured(env)) { message.retry({delaySeconds:300}); continue; }
      try {
        const id = message.body && typeof message.body === 'object' && 'purchase_id' in message.body
          ? (message.body as {purchase_id?:unknown}).purchase_id : null;
        if (typeof id !== 'string' || !uuid.test(id)) { message.ack(); continue; }
        const cart = await findCart(env,id);
        let approved = false;
        if (cart?.remote_id) {
          approved = await reconcileCart(env,cart,cart.remote_id,false) && (await findCart(env,id))?.status === 'approved';
        } else {
          const order = await findOrder(env,id);
          if (order?.remote_id) approved = await reconcile(env,order,order.remote_id,false) &&
            (await findOrder(env,id))?.status === 'approved';
        }
        if (!approved) { message.ack(); continue; }
        const delay = await sendDelivery(env,id);
        if (delay) message.retry({delaySeconds:delay});
        else {
          const pending = await env.DB.prepare(`SELECT next_attempt FROM email_deliveries
            WHERE purchase_id=? AND state='pending'`).bind(id).first<{next_attempt:number}>();
          if (pending) message.retry({delaySeconds:Math.max(1,pending.next_attempt-now())});
          else message.ack();
        }
      } catch {
        message.retry({delaySeconds:300});
      }
    }
  },
};
