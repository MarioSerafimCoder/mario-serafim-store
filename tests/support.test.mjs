import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { submitSupport } from '../worker/support.ts';

test('suporte valida entradas, encaminha e confirma uma única vez e limita abuso', async t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(readFileSync(new URL('../migrations/0008_support_requests.sql', import.meta.url), 'utf8'));
  const origin = 'https://store.example';
  const env = {
    STORE_ORIGIN: origin, RESEND_API_KEY: 'fixture', STORE_EMAIL_FROM: 'store@example.com', STORE_SESSION_SECRET: 'fixture',
    DB: {
      prepare(sql) {
        const stmt = db.prepare(sql);
        return { bind: (...values) => ({ first: async () => stmt.get(...values), run: async () => stmt.run(...values) }) };
      },
    },
  };
  const sent = [];
  let providerStatus = 200;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.resend.com/emails/batch');
    sent.push({ key: options.headers['idempotency-key'], messages: JSON.parse(options.body) });
    return Response.json({ data: [{ id: 'support' }, { id: 'confirmation' }] }, { status: providerStatus });
  });
  const call = (fields = {}, requestOrigin = origin, config = env) => submitSupport(new Request(origin + '/contato/api/suporte', {
    method: 'POST',
    headers: { origin: requestOrigin, 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.10' },
    body: JSON.stringify({ topic: 'compra', issue: 'download', email: 'cliente@example.com',
      order: 'ABC-123', description: 'Meu download <não abre>.', website: '', ...fields }),
  }), config);

  assert.equal((await call({}, 'https://elsewhere.example')).status, 403);
  assert.equal((await call({}, origin, { ...env, RESEND_API_KEY: undefined })).status, 503);
  assert.equal((await call({ website: 'bot' })).status, 400);
  assert.equal((await call({ issue: 'comercial' })).status, 400);
  assert.equal((await call({ email: 'endereço inválido' })).status, 400);
  assert.equal((await call({ description: 'curta' })).status, 400);
  assert.equal(sent.length, 0);

  providerStatus = 503;
  assert.equal((await call()).status, 503);
  assert.equal((await call()).status, 429);
  db.exec('UPDATE support_requests SET retry_at=0');
  providerStatus = 200;
  assert.match((await (await call()).json()).message, /Solicitação enviada/);
  assert.deepEqual(sent[0], sent[1]);
  const [ticket, confirmation] = sent[1].messages;
  assert.deepEqual(ticket.to, ['contato@marioserafim.com.br']);
  assert.equal(ticket.reply_to, 'cliente@example.com');
  assert.match(ticket.subject, /Pedido #ABC-123/);
  assert.match(ticket.html, /&lt;não abre&gt;/);
  assert.deepEqual(confirmation.to, ['cliente@example.com']);
  assert.equal(confirmation.reply_to, 'contato@marioserafim.com.br');
  assert.doesNotMatch(confirmation.html, /Meu download/);

  assert.equal((await call()).status, 200);
  assert.equal(sent.length, 2);
  assert.equal((await call({ order: 'ABC-124' })).status, 200);
  assert.equal((await call({ order: 'ABC-125' })).status, 429);
  assert.equal((await call({ email: 'outro@example.com' })).status, 200);
  assert.equal((await call({ email: 'terceiro@example.com' })).status, 429);
});
