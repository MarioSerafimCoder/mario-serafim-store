import type { Env, Order } from './types.ts';

const encoder = new TextEncoder();

export async function hmacKey(secret: string) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export function hex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function verifyHmac(secret: string, data: string, signature: string) {
  if (!/^[a-f0-9]{64}$/i.test(signature)) return false;
  const bytes = Uint8Array.from(signature.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
  return crypto.subtle.verify('HMAC', await hmacKey(secret), bytes, encoder.encode(data));
}

export async function validWebhook(request: Request, secret: string, id: string) {
  const parts = (request.headers.get('x-signature') ?? '').split(',').map((part) => part.trim().split('='));
  const ts = parts.find(([key]) => key === 'ts')?.[1] ?? '';
  const signature = parts.find(([key]) => key === 'v1')?.[1] ?? '';
  const requestId = request.headers.get('x-request-id') ?? '';
  if (!/^\d{10}(?:\d{3})?$/.test(ts) || !/^[\w-]{1,128}$/.test(requestId)) return false;
  const time = Number(ts) * (ts.length === 10 ? 1000 : 1);
  if (Math.abs(Date.now() - time) > 10 * 60_000) return false;
  return verifyHmac(secret, `id:${id.toLowerCase()};request-id:${requestId};ts:${ts};`, signature);
}

interface RemoteOrder {
  id: string;
  type: string;
  processing_mode: string;
  external_reference: string;
  total_amount: string;
  total_paid_amount?: string;
  user_id: string | number;
  country_code: string;
  currency: string;
  checkout_url?: string;
  status: string;
  status_detail: string;
  last_updated_date: string;
  transactions?: { payments?: { id: string; amount: string; status: string; status_detail: string }[]; refunds?: unknown[] };
}

async function api(env: Env, path: string, options: RequestInit = {}): Promise<RemoteOrder> {
  const response = await fetch(`https://api.mercadopago.com${path}`, {
    ...options,
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
    headers: { authorization: `Bearer ${env.MP_ACCESS_TOKEN}`, accept: 'application/json', ...options.headers },
  });
  if (!response.ok) throw new Error(`Mercado Pago HTTP ${response.status}`);
  return response.json() as Promise<RemoteOrder>;
}

function cents(value: unknown) {
  if (typeof value !== 'string' || !/^\d{1,12}(?:\.\d{1,2})?$/.test(value)) return NaN;
  const [whole, fraction = ''] = value.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

export function validProviderId(id: unknown): id is string {
  return typeof id === 'string' && /^ORD[A-Z0-9]{8,60}$/i.test(id);
}

export function verifyOrder(remote: RemoteOrder, order: Order) {
  return validProviderId(remote.id)
    && /^ORDTST/i.test(remote.id) === (order.mode === 'test')
    && (!order.remote_id || remote.id.toUpperCase() === order.remote_id.toUpperCase())
    && remote.type === 'online' && remote.processing_mode === 'manual'
    && remote.external_reference === order.id
    && String(remote.user_id) === order.seller
    && remote.country_code === 'BRA' && remote.currency === order.currency
    && cents(remote.total_amount) === order.price_cents;
}

export function paymentState(remote: RemoteOrder, order: Order) {
  const payments = remote.transactions?.payments ?? [];
  const credited = payments.filter((payment) =>
    payment.status === 'processed' && payment.status_detail === 'accredited' &&
    cents(payment.amount) === order.price_cents && /^PAY[A-Z0-9]{8,60}$/i.test(payment.id),
  );
  if (remote.status === 'refunded' || remote.status_detail === 'partially_refunded' ||
      (remote.transactions?.refunds?.length ?? 0) > 0) return { status: 'refunded', payment: null };
  if (remote.status === 'processed' && remote.status_detail === 'accredited') {
    if (cents(remote.total_paid_amount) === order.price_cents && credited.length === 1) {
      return { status: 'approved', payment: credited[0].id };
    }
    return { status: 'review', payment: null };
  }
  if (remote.status === 'failed') return { status: 'rejected', payment: null };
  if (remote.status === 'canceled' || remote.status === 'expired') return { status: 'canceled', payment: null };
  if (['charged_back', 'in_mediation'].includes(remote.status)) return { status: 'disputed', payment: null };
  return { status: 'pending', payment: null };
}

export async function createRemoteOrder(env: Env, order: Order) {
  const amount = (order.price_cents / 100).toFixed(2);
  const back = `${env.STORE_ORIGIN}/compras/retorno/${order.id}`;
  const remote = await api(env, '/v1/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-idempotency-key': order.id },
    body: JSON.stringify({
      type: 'online',
      processing_mode: 'manual',
      expiration_time: 'P1D',
      external_reference: order.id,
      total_amount: amount,
      items: [{ title: order.title, unit_price: amount, quantity: 1 }],
      config: { online: {
        success_url: `${back}/sucesso`, pending_url: `${back}/pendente`, failure_url: `${back}/falha`,
        auto_return: 'all',
      } },
    }),
  });
  if (!verifyOrder(remote, order) || !remote.checkout_url) throw new Error('Order retornada não corresponde ao pedido');
  const url = new URL(remote.checkout_url);
  if (url.origin !== 'https://www.mercadopago.com.br' || !url.pathname.startsWith('/checkout/')) {
    throw new Error('URL de checkout inválida');
  }
  return { id: remote.id, url: url.href };
}

export function getRemoteOrder(env: Env, id: string) {
  return api(env, `/v1/orders/${encodeURIComponent(id)}`);
}
