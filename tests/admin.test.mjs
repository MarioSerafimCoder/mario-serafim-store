import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSign, generateKeyPairSync, randomUUID } from 'node:crypto';
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
  for (const file of ['0001_commerce.sql','0002_admin.sql']) db.exec(readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
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
    ADMIN_EMAIL: owner, MP_MODE: 'test', DYNAMIC_CATALOG: 'true', CHECKOUT_ENABLED: 'false' };
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
  await status('/admin/api/configuracoes',{announcement:'Aviso da loja',support:'https://example.com/',period:7});
  assert.equal((await getSettings(binding)).announcement,'Aviso da loja');

  const id = randomUUID();
  raw.prepare(`INSERT INTO orders(id,recovery_hash,sku,title,price_cents,currency,object_key,filename,mode,seller,created_at)
    VALUES(?,?,?,?,1990,'BRL','private/original','original.zip','test','10',unixepoch())`).run(id, 'fixture', 'ART-1', 'Nome histórico');
  assert.match(await (await call('/admin/pedidos/'+id)).text(), /Nome histórico/);
  await status(api+'/ART-1/despublicar',{revision:6});
  assert.equal(raw.prepare('SELECT price_cents,object_key FROM orders WHERE id=?').get(id).price_cents,1990);
  assert.equal(raw.prepare('SELECT object_key FROM orders WHERE id=?').get(id).object_key,'private/original');
  assert.equal((await publicImage(binding,src.slice(7))).status,404);
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
