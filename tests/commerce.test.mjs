import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHmac, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import worker from '../worker/index.ts';

const origin = 'https://store.example';
const providerId = 'ORDTST01J49MMW3SSBK5PSV3DFR32959';
const signatureSecret = 'fixture-not-a-real-webhook-secret';
const product = { sku: 'REAL-1', name: 'Teste de arquivo', priceCents: 1299, currency: 'BRL', version: '1' };

test('checkout, confirmação e entrega com D1 e Mercado Pago simulados', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(readFileSync(new URL('../migrations/0001_commerce.sql', import.meta.url), 'utf8'));
  db.prepare('INSERT INTO fulfillment VALUES (?, ?, ?, ?, 1)').run('REAL-1', '1', 'versioned/file.zip', 'produto.zip');
  const env = {
    ASSETS: { fetch: async () => Response.json([product, { ...product, sku: 'DEMO-1' }]) },
    DB: {
      prepare(sql) {
        const stmt = db.prepare(sql);
        return {
          bind(...values) {
            return {
              first: async () => stmt.get(...values) ?? null,
              all: async () => ({ results: stmt.all(...values) }),
              run: async () => stmt.run(...values),
            };
          },
        };
      },
    },
    FILES: {
      head: async (key) => key === 'versioned/file.zip' ? {} : null,
      get: async (key) => key === 'versioned/file.zip' ? { body: new Response('ZIP').body, size: 3 } : null,
    },
    CHECKOUT_ENABLED: 'true', MP_MODE: 'test', MP_SELLER_ID: '123', STORE_ORIGIN: origin,
    MP_ACCESS_TOKEN: 'fixture-not-a-token', MP_WEBHOOK_SECRET: signatureSecret,
    STORE_SESSION_SECRET: 'fixture-not-a-real-session-secret-32',
  };

  let createCalls = 0;
  let lookupCalls = 0;
  let failCreate = true;
  let remote;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === 'https://api.mercadopago.com/v1/orders') {
      createCalls++;
      const body = JSON.parse(options.body);
      assert.equal(options.headers['x-idempotency-key'], body.external_reference);
      assert.equal(body.items[0].unit_price, '12.99');
      assert.equal(body.total_amount, '12.99');
      assert.equal(body.processing_mode, 'manual');
      if (remote) assert.equal(remote.external_reference, body.external_reference);
      remote = {
        id: providerId, type: 'online', processing_mode: 'manual', user_id: '123', country_code: 'BRA',
        currency: 'BRL', external_reference: body.external_reference, total_amount: '12.99',
        total_paid_amount: '0.00', status: 'created', status_detail: 'created',
        last_updated_date: '2026-11-06T10:00:00Z',
        checkout_url: 'https://www.mercadopago.com.br/checkout/v1/redirect?order_id=' + providerId,
      };
      if (failCreate) {
        failCreate = false;
        return new Response('', { status: 503 });
      }
      return Response.json(remote);
    }
    assert.equal(url, 'https://api.mercadopago.com/v1/orders/' + providerId);
    lookupCalls++;
    return Response.json(remote);
  });

  let cookie = '';
  const code = randomUUID();
  const call = (path, { method = 'GET', body, session = true, headers = {} } = {}) => {
    const form = body instanceof URLSearchParams;
    return worker.fetch(new Request(origin + path, {
      method,
      headers: {
        ...(method === 'POST' && { origin }),
        ...(session && cookie && { cookie }),
        ...(body && !form && { 'content-type': 'application/json' }),
        ...headers,
      },
      body: form ? body : body ? JSON.stringify(body) : undefined,
    }), env);
  };
  const api = '/compras/api';
  const start = (body = { sku: product.sku, code }) => call(api + '/checkout', { method: 'POST', body });
  const notify = (valid = true, stamp = Math.floor(Date.now() / 1000)) => {
    const requestId = 'fixture-webhook-request';
    const signed = `id:${providerId};request-id:${requestId};ts:${stamp};`;
    const signature = createHmac('sha256', signatureSecret).update(signed).digest('hex');
    return call(api + '/webhook?data.id=' + providerId, {
      method: 'POST', session: false,
      headers: { 'x-request-id': requestId, 'x-signature': `ts=${stamp},v1=${valid ? signature : 'invalid'}` },
    });
  };
  const state = async () => (await call(api + '/pedido')).json();
  const orderCount = () => db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;

  assert.equal((await start({ sku: product.sku, code, priceCents: 1 })).status, 400);
  assert.equal((await start({ sku: 'MISSING', code })).status, 404);
  assert.equal((await start({ sku: 'DEMO-1', code })).status, 404);
  assert.equal((await start({ sku: product.sku, code })).status, 503);
  assert.equal(orderCount(), 1);
  const response = await start();
  assert.equal(response.status, 200);
  const order = await response.json();
  cookie = response.headers.get('set-cookie').split(';')[0];
  assert.equal((await (await start()).json()).id, order.id);
  assert.equal(createCalls, 2);
  assert.equal(orderCount(), 1);

  const returned = await call('/compras/retorno/' + order.id + '/sucesso?status=approved');
  assert.equal(returned.headers.get('location'), '/compras/?pedido=' + order.id);
  assert.equal((await state()).status, 'created');
  assert.equal((await notify(false)).status, 401);
  assert.equal((await notify(true, Math.floor(Date.now() / 1000) - 3600)).status, 401);
  assert.equal(lookupCalls, 0);

  Object.assign(remote, { status: 'processing', status_detail: 'in_process', last_updated_date: '2026-11-06T10:01:00Z' });
  assert.equal((await notify()).status, 200);
  assert.equal((await state()).status, 'pending');
  Object.assign(remote, { status: 'failed', status_detail: 'bad_filled_card_data', last_updated_date: '2026-11-06T10:02:00Z' });
  await notify();
  assert.equal((await state()).status, 'rejected');

  Object.assign(remote, {
    status: 'processed', status_detail: 'accredited', total_paid_amount: '12.99',
    last_updated_date: '2026-11-06T10:03:00Z',
    transactions: { payments: [{ id: 'PAY01J67CQQH5904WDBVZEM4JMEP3', amount: '12.99', status: 'processed', status_detail: 'accredited' }] },
  });
  for (const [key, bad] of [['total_amount', '1.00'], ['currency', 'USD'], ['user_id', '321']]) {
    const correct = remote[key];
    remote[key] = bad;
    await notify();
    assert.equal((await state()).grant, null);
    remote[key] = correct;
  }
  await notify();
  await notify();
  const approved = await state();
  assert.equal(approved.status, 'approved');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM order_events WHERE kind = 'payment_status' AND status = 'approved'").get().n, 1);

  const file = () => new URLSearchParams({ grant: approved.grant });
  assert.equal((await call(api + '/download', { method: 'POST', body: file(), session: false })).status, 401);
  assert.equal((await call(api + '/download', { method: 'POST', body: new URLSearchParams({ grant: 'invalid' }) })).status, 403);
  const recovered = await call(api + '/recuperar', { method: 'POST', body: { code }, session: false });
  assert.equal(recovered.status, 200);
  cookie = recovered.headers.get('set-cookie').split(';')[0];
  const download = await call(api + '/download', { method: 'POST', body: file() });
  assert.match(download.headers.get('content-disposition'), /attachment/);
  assert.equal(await download.text(), 'ZIP');

  Object.assign(remote, { status: 'refunded', status_detail: 'refunded', last_updated_date: '2026-11-06T10:04:00Z' });
  assert.equal((await call(api + '/download', { method: 'POST', body: file() })).status, 403);
  assert.equal((await state()).status, 'refunded');
  Object.assign(remote, { status: 'processed', status_detail: 'accredited', last_updated_date: '2026-11-06T10:03:00Z' });
  await notify();
  assert.equal((await state()).grant, null);
  assert.equal((await call(api + '/recuperar', { method: 'POST', body: { code: randomUUID() }, session: false })).status, 404);
});
