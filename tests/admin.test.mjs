import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac, createSign, generateKeyPairSync, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { admin } from '../worker/admin.ts';
import { publicImage } from '../worker/admin-data.ts';
import { getSettings, publicProducts } from '../worker/catalog.ts';
import commerce from '../worker/index.ts';

const origin = 'https://store.example';
const issuer = 'https://store-fixture.cloudflareaccess.com';
const owner = 'owner@store.example';
const audience = 'a'.repeat(64);
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

function jwt(override = {}) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = part({ alg: 'RS256', kid: 'fixture-key' });
  const payload = part({ iss: issuer, aud: [audience], email: owner, sub: 'owner-fixture', type: 'app',
    exp: Math.floor(Date.now() / 1000) + 300, ...override });
  const unsigned = header + '.' + payload;
  return unsigned + '.' + createSign('RSA-SHA256').update(unsigned).sign(privateKey).toString('base64url');
}

function database(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  for (const file of ['0001_commerce.sql','0002_admin.sql','0003_admin_insights.sql','0004_coupons.sql','0005_cart_checkout.sql','0006_commercial_identity.sql']) db.exec(readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  function statement(sql, args = []) {
    const stmt = db.prepare(sql);
    const values = args.map((value) => value instanceof ArrayBuffer ? new Uint8Array(value) : value);
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => stmt.get(...values) ?? null,
      all: async () => ({ results: stmt.all(...values) }),
      run: async () => stmt.run(...values),
      execute: () => ({ results: stmt.all(...values) }),
    };
  }
  return { raw: db, binding: {
    prepare: statement,
    batch: async (statements) => {
      db.exec('BEGIN');
      try {
        const result = statements.map((stmt) => stmt.execute());
        db.exec('COMMIT');
        return result;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  } };
}

test('admin verifica identidade, protege mutações e mantém catálogo e pedidos coerentes', async (t) => {
  const { raw, binding } = database(t);
  const env = { DB: binding, STORE_ORIGIN: origin, ADMIN_ACCESS_ISSUER: issuer, ADMIN_ACCESS_AUD: audience,
    ADMIN_EMAIL: owner, MP_MODE: 'test', DYNAMIC_CATALOG: 'true', CHECKOUT_ENABLED: 'false', COUPONS_ENABLED:'true' };
  const key = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture-key' };
  t.mock.method(globalThis,'fetch',async (url, options) => {
    assert.equal(url, issuer + '/cdn-cgi/access/certs');
    assert.equal(options.redirect, 'manual');
    return Response.json({ keys: [key] });
  });
  const token = jwt();
  const call = (path, { token: auth = token, data, blob, origin: from = origin, type } = {}) => admin(
    new Request(origin + path, {
      method: data || blob ? 'POST' : 'GET',
      headers: { ...(auth ? { 'cf-access-jwt-assertion': auth } : {}), origin: from,
        ...(data || blob ? { 'content-type': type ?? 'application/json' } : {}) },
      body: blob ?? (data ? JSON.stringify(data) : undefined),
    }), env, async () => new Response('Prévia privada'));
  const product = { sku:'ART-1', slug:'arte-1', name:'Arte inicial', category:'Templates', price:'19,90', version:'1.0',
    status:'draft', summary:'Um produto digital.', description:'## Descrição\n**Texto** <script>alert(1)</script>',
    images:[{src:'https://assets.example/cover.jpg',alt:'Capa',width:800,height:600}], includes:'Projeto', formats:'PDF',
    requirements:'', licenseType:'Comercial', licenseSummary:'Uso em projetos.', featured:true };
  const api = '/admin/api/produtos';
  const status = async (path, data, expected = 200, overrides = {}) => {
    const response = await call(path, { data, ...overrides });
    const body = await response.json();
    assert.equal(response.status, expected, JSON.stringify(body));
    return body;
  };
  assert.equal((await call('/admin',{token:''})).status,403);
  for (const forged of [jwt({email:'other@store.example'}),jwt({aud:['wrong']}),jwt({exp:1}),jwt({type:'org'}),token.replace(/\.[^.]+$/,'.invalid')]) {
    assert.equal((await call('/admin',{token:forged})).status,403);
  }
  assert.equal((await call('/admin')).status,200);
  await status(api, product, 403, { token:'' });
  await status(api, product, 403, { origin:'https://evil.example' });
  await status(api, {...product,price:'1e2'}, 400);
  await status(api, product, 201);
  assert.deepEqual(await publicProducts(binding),[]);
  await status(api, {...product,sku:'ART-2'},409);
  await status(api, {...product,slug:'different'},409);
  await status(api+'/ART-1/publicar',{revision:1});
  assert.equal((await publicProducts(binding))[0].data.priceCents,1990);
  await status(api+'/ART-1',{...product,status:'published',price:'39,90',slug:'arte-nova',revision:2});
  assert.equal((await publicProducts(binding))[0].data.priceCents,3990);
  assert.equal(raw.prepare("SELECT sku FROM product_slugs WHERE slug='arte-1'").get().sku,'ART-1');
  await status(api+'/ART-1',{...product,revision:2},409);
  await status(api+'/ART-1/arquivar',{revision:3});
  assert.deepEqual(await publicProducts(binding),[]);
  await status(api+'/ART-1/restaurar',{revision:4});
  const copy = await status(api+'/ART-1/duplicar',{revision:5});
  assert.notEqual(copy.sku,'ART-1');
  assert.equal(raw.prepare('SELECT status FROM products WHERE sku=?').get(copy.sku).status,'draft');
  assert.equal((await call('/admin/previa/ART-1',{token:''})).status,403);
  assert.equal((await call('/admin/previa/ART-1')).headers.get('cache-control'),'private, no-store');
  const text = await status('/admin/api/previa',{description:'**Olá** <script>alert(1)</script> [X](javascript:alert%281%29)'});
  assert.match(text.html,/<strong>Olá<\/strong>/);
  assert.doesNotMatch(text.html,/<script|href="javascript:/);
  assert.equal((await call('/admin/api/imagens',{blob:'bad image',type:'image/png'})).status,400);
  assert.equal((await call('/admin/api/arquivos/upload',{blob:'test',type:'application/zip'})).status,503);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jMioAAAAASUVORK5CYII=','base64');
  const upload = await call('/admin/api/imagens',{blob:png,type:'image/png'});
  assert.equal(upload.status,201);
  const {src} = await upload.json();
  assert.equal((await publicImage(binding,src.slice(7))).status,404);
  await status(api+'/ART-1',{...product,slug:'arte-nova',status:'published',revision:5,images:[{...product.images[0],src}]});
  assert.equal((await publicImage(binding,src.slice(7))).status,200);
  await status('/admin/api/configuracoes',{announcement:'Aviso da loja',support:'https://example.com/',period:7,
    legal_name:'Mário Serafim',legal_id:'CPF validado',legal_address:'Endereço validado',legal_email:'contato@example.com',legal_phone:''});
  assert.equal((await getSettings(binding)).announcement,'Aviso da loja');
  assert.equal((await getSettings(binding)).legal_name,'Mário Serafim');
  assert.equal((await getSettings(binding)).legal_email,'contato@example.com');
  await status('/admin/api/configuracoes',{announcement:'Aviso',support:'',period:7,
    legal_name:'Mário',legal_id:'',legal_address:'',legal_email:'e-mail inválido',legal_phone:''},400);

  const id = randomUUID();
  raw.prepare(`INSERT INTO orders(id,recovery_hash,sku,title,price_cents,currency,object_key,filename,mode,seller,created_at)
    VALUES(?,?,?,?,1990,'BRL','private/original','original.zip','test','10',unixepoch())`).run(id, 'fixture', 'ART-1', 'Nome histórico');
  assert.match(await (await call('/admin/pedidos/'+id)).text(), /Nome histórico/);
  for (const path of ['/admin/produtos/categorias','/admin/clientes','/admin/relatorios','/admin/descontos','/admin/integracoes','/admin/loja-online']) {
    const page = await call(path);
    assert.equal(page.status,200,path + ' ' + (page.status!==200 ? await page.text() : ''));
    assert.match(await page.text(),/aria-current="page"/);
    assert.equal((await call(path,{token:''})).status,403);
  }
  assert.match(await (await call('/admin/pedidos?q=ART-1&status=created')).text(),/Nome histórico/);
  assert.doesNotMatch(await (await call('/admin/pedidos?q=ART-1&status=approved')).text(),/Nome histórico/);
  raw.prepare("UPDATE orders SET status='approved',buyer_email='buyer@example.test',category_at_purchase='Design',title='=2+2' WHERE id=?").run(id);
  assert.match(await (await call('/admin/clientes')).text(),/buyer@example.test/);
  assert.match(await (await call('/admin/clientes/'+id)).text(),/buyer@example.test/);
  assert.match(await (await call('/admin/relatorios')).text(),/Design/);
  const exportOrders = await call('/admin/pedidos/exportar?status=approved');
  assert.match(exportOrders.headers.get('content-disposition'),/attachment/);
  assert.match(await exportOrders.text(),/"'=2\+2"/);
  assert.match(await (await call('/admin/relatorios/exportar')).text(),/Receita diária/);
  assert.equal((await call('/admin/pedidos/exportar',{token:''})).status,403);
  await status('/admin/api/cupons',{code:'FIXED',kind:'fixed',value:'2,00',expires:'2099-12-31',maxUses:5,sku:'ART-1',active:true,revision:0});
  await status('/admin/api/cupons',{code:'FIXED',kind:'fixed',value:'2,00',expires:'2099-12-31',maxUses:5,sku:'ART-1',active:true,revision:0},409);
  await status('/admin/api/cupons',{code:'FIXED',kind:'percent',value:'10',expires:'2099-12-31',maxUses:5,sku:'ART-1',active:false,revision:1});
  assert.equal(raw.prepare("SELECT active FROM coupons WHERE code='FIXED'").get().active,0);
  await status(api+'/ART-1/despublicar',{revision:6});
  assert.equal(raw.prepare('SELECT price_cents,object_key FROM orders WHERE id=?').get(id).price_cents,1990);
  assert.equal(raw.prepare('SELECT object_key FROM orders WHERE id=?').get(id).object_key,'private/original');
  assert.equal((await publicImage(binding,src.slice(7))).status,404);
  await status('/admin/api/categorias',{from:'Templates',name:'Design editorial'});
  assert.match(await (await call('/admin/produtos?category=Design+editorial')).text(),/Arte inicial/);
  assert.equal(raw.prepare('SELECT category_at_purchase FROM orders WHERE id=?').get(id).category_at_purchase,'Design');
  assert.ok(raw.prepare('SELECT count(*) AS n FROM admin_events').get().n >= 9);
});

test('checkout usa o preço e a versão do D1 e rejeita cotação antiga', async (t) => {
  const { raw, binding } = database(t);
  raw.prepare("INSERT INTO products(sku,slug,name,category,price_cents,version,status,details) VALUES('ART-1','arte','Arte','Template',2500,'1','published','{}')").run();
  raw.prepare("INSERT INTO fulfillment VALUES('ART-1','1','private/version-1','produto.zip',1)").run();
  const env = { DB: binding, DYNAMIC_CATALOG:'true', CHECKOUT_ENABLED:'true', STORE_ORIGIN:origin, MP_MODE:'test', MP_SELLER_ID:'123',
    MP_ACCESS_TOKEN:'fixture', MP_WEBHOOK_SECRET:'fixture', STORE_SESSION_SECRET:'fixture-not-a-real-session-secret-32',
    FILES:{head:async () => ({}), get:async () => null}, ASSETS:{fetch:async () => {throw new Error('catálogo estático não é fonte de preço');}} };
  t.mock.method(globalThis,'fetch',async (url, options) => {
    assert.equal(url,'https://api.mercadopago.com/v1/orders');
    assert.equal(options.redirect,'manual');
    const body = JSON.parse(options.body);
    assert.equal(body.total_amount,'25.00');
    return Response.json({id:'ORDTST01J49MMW3SSBK5PSV3DFR32959',type:'online',processing_mode:'manual',user_id:'123',country_code:'BRA',
      currency:'BRL',external_reference:body.external_reference,total_amount:'25.00',
      checkout_url:'https://www.mercadopago.com.br/checkout/v1/redirect'});
  });
  const code = randomUUID();
  const start = (expectedPriceCents) => commerce.fetch(new Request(origin+'/compras/api/checkout',{
    method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({sku:'ART-1',code,expectedPriceCents}),
  }),env);
  assert.equal((await start(100)).status,412);
  assert.equal((await start(2500)).status,200);
  raw.prepare("UPDATE products SET status='archived',price_cents=5000 WHERE sku='ART-1'").run();
  const order = raw.prepare('SELECT price_cents,object_key FROM orders').get();
  assert.equal(order.price_cents,2500);
  assert.equal(order.object_key,'private/version-1');
});

test('cupom confere cotação, reserva uma vez e cobra o total no Mercado Pago', async (t) => {
  const {raw,binding} = database(t);
  raw.exec(`
    INSERT INTO products(sku,slug,name,category,price_cents,version,status,details) VALUES
      ('SALE-1','sale','Produto','Design',2500,'1','published','{}'),
      ('OTHER-1','other','Outro','Design',2500,'1','published','{}');
    INSERT INTO fulfillment VALUES('SALE-1','1','private/one','one.zip',1),('OTHER-1','1','private/two','two.zip',1);
    INSERT INTO coupons(code,kind,value,expires_at,max_uses,sku,active) VALUES
      ('SALE10','percent',10,unixepoch()+86400,1,'SALE-1',1),
      ('OLD10','percent',10,unixepoch()-1,5,NULL,1),
      ('INACTIVE','fixed',500,unixepoch()+86400,5,NULL,0),
      ('TOOLOW','fixed',2499,unixepoch()+86400,5,NULL,1);
  `);
  const provider = 'ORDTST01J49MMW3SSBK5PSV3DFR32959';
  const secret = 'test-webhook-fixture';
  const env = { DB:binding, DYNAMIC_CATALOG:'true', COUPONS_ENABLED:'true', CHECKOUT_ENABLED:'true', STORE_ORIGIN:origin,
    MP_MODE:'test', MP_SELLER_ID:'123', MP_ACCESS_TOKEN:'fixture', MP_WEBHOOK_SECRET:secret,
    STORE_SESSION_SECRET:'fixture-not-a-real-session-secret-32', FILES:{head:async()=>({}),get:async()=>null} };
  let requests=0;
  let remote;
  t.mock.method(globalThis,'fetch',async (url, options) => {
    if (url.endsWith('/'+provider)) return Response.json(remote);
    requests++;
    const body = JSON.parse(options.body);
    assert.equal(body.total_amount,'22.50');
    assert.equal(body.items[0].unit_price,'22.50');
    assert.equal(options.headers['x-idempotency-key'],body.external_reference);
    remote = {id:provider,type:'online',processing_mode:'manual',user_id:'123',country_code:'BRA',currency:'BRL',
      external_reference:body.external_reference,total_amount:'22.50',checkout_url:'https://www.mercadopago.com.br/checkout/v1/redirect'};
    return Response.json(remote);
  });
  const post = (path, body, headers = {}) => commerce.fetch(new Request(origin+'/compras/api/'+path,{
    method:'POST',headers:{origin,'content-type':'application/json',...headers},body:JSON.stringify(body),
  }),env);
  const offer = {sku:'SALE-1',coupon:'SALE10',expectedPriceCents:2500};
  const quote = await post('cotacao',offer);
  assert.deepEqual(await quote.json(),{coupon:'SALE10',discountCents:250,totalCents:2250});
  for (const item of [{sku:'OTHER-1'}, {coupon:'OLD10'}, {coupon:'INACTIVE'}, {coupon:'TOOLOW'}]) {
    assert.equal((await post('cotacao',{...offer,...item})).status,422);
  }
  const base = {...offer,code:randomUUID(),expectedTotalCents:2250};
  assert.equal((await post('checkout',{...base,expectedTotalCents:100})).status,412);
  assert.equal((await post('checkout',{...base,priceCents:100})).status,400);
  assert.equal(raw.prepare('SELECT count(*) n FROM orders').get().n,0);
  const both = await Promise.all([post('checkout',base),post('checkout',{...base,code:randomUUID()})]);
  assert.deepEqual(both.map(r=>r.status).sort(),[200,412]);
  const order = raw.prepare('SELECT id,price_cents,discount_cents,coupon_code,category_at_purchase FROM orders').get();
  assert.equal(order.price_cents,2250);
  assert.equal(order.discount_cents,250);
  assert.equal(order.coupon_code,'SALE10');
  assert.equal(order.category_at_purchase,'Design');
  assert.equal((await post('checkout',base)).status,200);
  assert.equal(requests,1);
  assert.equal((await post('cotacao',offer)).status,422);
  const ts = Math.floor(Date.now()/1000);
  const reqId = 'signed-test';
  const signature = createHmac('sha256',secret).update('id:'+provider+';request-id:'+reqId+';ts:'+ts+';').digest('hex');
  const notify = () => post('webhook?data.id='+provider,{}, {'x-signature':'ts='+ts+',v1='+signature,'x-request-id':reqId});
  Object.assign(remote,{status:'processed',status_detail:'accredited',total_paid_amount:'22.50',last_updated_date:new Date().toISOString(),
    payer:{email:'Cliente@Example.test'},transactions:{payments:[{id:'PAY01J67CQQH5904WDBVZEM4JMEP3',amount:'22.50',status:'processed',status_detail:'accredited'}]}});
  remote.total_amount='25.00';
  assert.equal((await notify()).status,200);
  assert.equal(raw.prepare('SELECT buyer_email FROM orders').get().buyer_email,null);
  remote.total_amount='22.50';
  assert.equal((await notify()).status,200);
  const paid=raw.prepare('SELECT status,buyer_email FROM orders').get();
  assert.equal(paid.status,'approved');
  assert.equal(paid.buyer_email,'cliente@example.test');
});
