import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHmac, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import worker from '../worker/index.ts';
import { purchaseLink } from '../worker/email-delivery.ts';

const origin = 'https://store.example';
const providerId = 'ORDTST01J49MMW3SSBK5PSV3DFR32959';
const signatureSecret = 'fixture-not-a-real-webhook-secret';
const product = { sku: 'REAL-1', name: 'Teste de arquivo', priceCents: 1299, currency: 'BRL', version: '1' };
const productTwo = { sku: 'REAL-2', name: 'Segundo arquivo', priceCents: 800, currency: 'BRL', version: '2' };

test('checkout, confirmação e entrega com D1 e Mercado Pago simulados', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(readFileSync(new URL('../migrations/0001_commerce.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/0002_admin.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/0003_admin_insights.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/0004_coupons.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/0005_cart_checkout.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/0006_commercial_identity.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/0007_email_delivery.sql', import.meta.url), 'utf8'));
  db.prepare('INSERT INTO fulfillment VALUES (?, ?, ?, ?, 1)').run('REAL-1', '1', 'versioned/file.zip', 'produto.zip');
  const queued = [];
  const env = {
    ASSETS: { fetch: async () => Response.json([product, productTwo, { ...product, sku: 'DEMO-1' }]) },
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
      async batch(statements) {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        return results;
      },
    },
    FILES: {
      head: async (key) => key === 'versioned/file.zip' ? {} : null,
      get: async (key) => key === 'versioned/file.zip' ? { body: new Response('ZIP').body, size: 3 } : null,
    },
    CHECKOUT_ENABLED: 'true', MP_MODE: 'test', MP_SELLER_ID: '123', STORE_ORIGIN: origin,
    MP_ACCESS_TOKEN: 'fixture-not-a-token', MP_WEBHOOK_SECRET: signatureSecret,
    STORE_SESSION_SECRET: 'fixture-not-a-real-session-secret-32',
    EMAIL_DELIVERY_ENABLED:'true',RESEND_API_KEY:'fixture',STORE_EMAIL_FROM:'store@example.com',
    EMAIL_DELIVERY_QUEUE:{send:async(message,options)=>queued.push({message,options})},
  };

  let createCalls = 0;
  let lookupCalls = 0;
  let failCreate = true;
  let remote;
  const deliveries = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === 'https://api.resend.com/emails') {
      deliveries.push({key:options.headers['idempotency-key'],message:JSON.parse(options.body)});
      return deliveries.length === 1 ? new Response('',{status:503}) : Response.json({id:'mail-fixture'});
    }
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
  const start = (body = { sku: product.sku, code }) => call(api + '/checkout', { method: 'POST', body:{email:'Buyer@EXAMPLE.COM',...body} });
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
  assert.equal((await start({ sku: product.sku, code, email:'bad@' })).status, 400);
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
  Object.assign(remote, { status:'canceled', status_detail:'canceled', last_updated_date:'2026-11-06T10:02:30Z' });
  await notify();
  assert.equal((await state()).status,'canceled');
  assert.equal(deliveries.length,0);

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
  assert.equal(deliveries.length,1);
  assert.equal(db.prepare('SELECT state FROM email_deliveries').get().state,'pending');
  db.prepare('UPDATE email_deliveries SET next_attempt=0').run();
  const queuedRetry=queued.shift();
  assert.deepEqual(queuedRetry.message,{purchase_id:order.id});
  assert.equal(queuedRetry.options.delaySeconds,120);
  db.prepare("UPDATE email_deliveries SET state='processing',next_attempt=?").run(Math.floor(Date.now()/1000)+300);
  let leaseRetry;
  await worker.queue({messages:[{body:queuedRetry.message,ack(){assert.fail('a entrega em processamento ainda precisa de retentativa');},retry(options){leaseRetry=options;}}]},env);
  assert.ok(leaseRetry.delaySeconds > 0 && leaseRetry.delaySeconds <= 300);
  assert.equal(deliveries.length,1);
  db.prepare('UPDATE email_deliveries SET next_attempt=0').run();
  let acknowledged=false;
  await worker.queue({messages:[{body:queuedRetry.message,ack(){acknowledged=true;},retry(){assert.fail('não deve reagendar uma entrega aceita');}}]},env);
  assert.equal(acknowledged,true);
  const duplicateQueueMessage=queued.shift();
  let duplicateAcknowledged=false;
  await worker.queue({messages:[{body:duplicateQueueMessage.message,ack(){duplicateAcknowledged=true;},retry(){assert.fail('a mensagem duplicada deve ser confirmada');}}]},env);
  assert.equal(duplicateAcknowledged,true);
  await notify();
  assert.equal(deliveries.length,2);
  assert.deepEqual(deliveries[0],deliveries[1]);
  assert.deepEqual(deliveries[1].message.to,['Buyer@example.com']);
  assert.equal(db.prepare('SELECT state FROM email_deliveries').get().state,'accepted');
  const path = new URL(deliveries[1].message.text.match(/https:\/\/\S+\/compras\/api\/arquivo\/\S+/)[0]).pathname;
  assert.equal(await (await call(path,{session:false})).text(),'ZIP');
  assert.equal((await call(path.replace(order.id,randomUUID()),{session:false})).status,403);
  const expires = Math.floor(Date.now()/1000)-1;
  const expired = await purchaseLink(env.STORE_SESSION_SECRET,order.id,expires);
  assert.equal((await call(api+'/arquivo/'+order.id+'/'+expires+'.'+expired,{session:false})).status,403);
  const approved = await state();
  assert.equal(approved.status, 'approved');
  assert.equal(approved.deliveryState, 'accepted');
  assert.equal(approved.totalCents, 1299);
  assert.ok(Number.isSafeInteger(approved.createdAt));
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
  assert.equal((await call(path,{session:false})).status,403);
  assert.equal(db.prepare('SELECT state FROM email_deliveries').get().state,'blocked');
  assert.equal((await call(api + '/download', { method: 'POST', body: file() })).status, 403);
  assert.equal((await state()).status, 'refunded');
  Object.assign(remote, { status: 'processing', status_detail: 'in_process', last_updated_date: '2026-11-06T10:05:00Z' });
  await notify();
  assert.equal((await state()).status, 'refunded');
  Object.assign(remote, { status: 'processed', status_detail: 'accredited', last_updated_date: '2026-11-06T10:03:00Z' });
  await notify();
  assert.equal((await state()).grant, null);
  assert.equal((await call(api + '/recuperar', { method: 'POST', body: { code: randomUUID() }, session: false })).status, 404);
});

test('carrinho valida todos os itens, cria uma única order e entrega cada arquivo após a aprovação', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(readFileSync(new URL('../migrations/0001_commerce.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/0002_admin.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/0003_admin_insights.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/0004_coupons.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/0005_cart_checkout.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/0006_commercial_identity.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/0007_email_delivery.sql', import.meta.url), 'utf8'));
  db.prepare('INSERT INTO fulfillment VALUES (?, ?, ?, ?, 1)').run(product.sku, product.version, 'real-1.zip', 'real-1.zip');
  db.prepare('INSERT INTO fulfillment VALUES (?, ?, ?, ?, 1)').run(productTwo.sku, productTwo.version, 'real-2.zip', 'real-2.zip');
  const env = {
    ASSETS: { fetch: async () => Response.json([product,productTwo]) },
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
      async batch(statements) {
        db.exec('BEGIN');
        try { const result=[]; for (const statement of statements) result.push(await statement.run()); db.exec('COMMIT'); return result; }
        catch (failure) { db.exec('ROLLBACK'); throw failure; }
      },
    },
    FILES: { head: async (key) => ['real-1.zip','real-2.zip'].includes(key) ? {size:key==='real-1.zip' ? key.length : 2_000_000} : null,
      get: async (key) => ['real-1.zip','real-2.zip'].includes(key) ? {body:new Response(key).body,size:key.length} : null },
    CHECKOUT_ENABLED:'true',MP_MODE:'test',MP_SELLER_ID:'123',STORE_ORIGIN:origin,
    MP_ACCESS_TOKEN:'fixture-not-a-token',MP_WEBHOOK_SECRET:signatureSecret,STORE_SESSION_SECRET:'fixture-not-a-real-session-secret-32',
    EMAIL_DELIVERY_ENABLED:'true',RESEND_API_KEY:'fixture',STORE_EMAIL_FROM:'store@example.com',
    EMAIL_DELIVERY_QUEUE:{send:async()=>{}},
  };
  const mpId = 'ORDTST01J49MMW3SSBK5PSV3DFR32960';
  let remote;
  const deliveries = [];
  t.mock.method(globalThis,'fetch',async (url,options) => {
    if (url === 'https://api.resend.com/emails') {
      deliveries.push(JSON.parse(options.body));
      return Response.json({id:'cart-mail-fixture'});
    }
    if (url === 'https://api.mercadopago.com/v1/orders') {
      const body=JSON.parse(options.body);
      assert.equal(body.total_amount,'20.99');
      assert.deepEqual(body.items,[{title:product.name,unit_price:'12.99',quantity:1},{title:productTwo.name,unit_price:'8.00',quantity:1}]);
      assert.equal(options.headers['x-idempotency-key'],body.external_reference);
      remote={id:mpId,type:'online',processing_mode:'manual',external_reference:body.external_reference,
        total_amount:'20.99',total_paid_amount:'0.00',user_id:'123',country_code:'BRA',currency:'BRL',status:'created',status_detail:'created',
        last_updated_date:'2026-11-06T10:00:00Z',checkout_url:'https://www.mercadopago.com.br/checkout/v1/redirect?order_id='+mpId};
      return Response.json(remote);
    }
    assert.equal(url,'https://api.mercadopago.com/v1/orders/'+mpId);
    return Response.json(remote);
  });
  let cookie='';
  const call=(path,{method='GET',body,session=true,headers={}}={})=>{
    const form=body instanceof URLSearchParams;
    return worker.fetch(new Request(origin+path,{method,headers:{...(method==='POST'&&{origin}),...(session&&cookie&&{cookie}),
      ...(body&&!form&&{'content-type':'application/json'}),...(form&&{'content-type':'application/x-www-form-urlencoded'}),...headers},
      body:form?body:body?JSON.stringify(path.endsWith('/checkout-carrinho') ? {email:'cart@example.com',...body} : body):undefined}),env);
  };
  const api='/compras/api';
  const code=randomUUID();
  const items=[{sku:product.sku,expectedPriceCents:product.priceCents},{sku:productTwo.sku,expectedPriceCents:productTwo.priceCents}];
  assert.equal((await call(api+'/checkout-carrinho',{method:'POST',body:{code,items:[...items,{...items[0]}]}})).status,400);
  assert.equal((await call(api+'/checkout-carrinho',{method:'POST',body:{code:randomUUID(),items:items.map((item,index)=>({...item,expectedPriceCents:index?800:1}))}})).status,412);
  const response=await call(api+'/checkout-carrinho',{method:'POST',body:{code,items}});
  assert.equal(response.status,200);
  const checkout=await response.json();
  cookie=response.headers.get('set-cookie').split(';')[0];
  const retry=await call(api+'/checkout-carrinho',{method:'POST',body:{code,items}});
  assert.equal(retry.status,200,await retry.text());
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM checkout_carts').get().n,1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders WHERE cart_id=?').get(checkout.id).n,2);
  const state=await (await call(api+'/pedido')).json();
  assert.equal(state.status,'created');
  assert.equal(state.totalCents,2099);
  assert.ok(Number.isSafeInteger(state.createdAt));
  assert.equal(state.items.length,2);
  assert.ok(state.items.every((item)=>item.grant===null));

  const notify=async()=>{
    const stamp=Math.floor(Date.now()/1000),requestId='cart-webhook';
    const value=createHmac('sha256',signatureSecret).update(`id:${mpId};request-id:${requestId};ts:${stamp};`).digest('hex');
    return call(api+'/webhook?data.id='+mpId,{method:'POST',session:false,
      headers:{'x-request-id':requestId,'x-signature':`ts=${stamp},v1=${value}`}});
  };
  Object.assign(remote,{status:'processed',status_detail:'accredited',total_paid_amount:'20.99',last_updated_date:'2026-11-06T10:01:00Z',
    transactions:{payments:[{id:'PAY01J67CQQH5904WDBVZEM4JMEP4',amount:'20.99',status:'processed',status_detail:'accredited'}]}});
  assert.equal((await notify()).status,200);
  await notify();
  assert.equal(deliveries.length,1);
  assert.deepEqual(deliveries[0].attachments,[{filename:'real-1.zip',content:Buffer.from('real-1.zip').toString('base64')}]);
  assert.equal((deliveries[0].text.match(/\/compras\/api\/arquivo\//g) ?? []).length,1);
  const approved=await (await call(api+'/pedido')).json();
  assert.equal(approved.status,'approved');
  assert.ok(approved.items.every((item)=>item.grant));
  for (const item of approved.items) {
    const result=await call(api+'/download',{method:'POST',body:new URLSearchParams({grant:item.grant,item:item.id})});
    assert.equal(result.status,200);
    assert.match(await result.text(),/real-[12]\.zip/);
  }
  const recovery=await call(api+'/recuperar',{method:'POST',body:{code:randomUUID()},session:false});
  assert.equal(recovery.status,404);
});
