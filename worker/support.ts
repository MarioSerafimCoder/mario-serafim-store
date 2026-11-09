import { helpTopics } from '../src/config/help-topics.ts';
import { storeSupport } from '../src/config/site.ts';
import { deliveryAddress } from './email-delivery.ts';
import { readBody } from './index.ts';
import { hex, hmacKey } from './mercado-pago.ts';
import type { Env } from './types.ts';

const encoder = new TextEncoder();
const response = (status: number, message: string) =>
  Response.json({ message }, { status, headers: { 'cache-control': 'no-store' } });
const escape = (value: string) => value.replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const unavailable = 'O formulário está temporariamente indisponível. Use o e-mail de suporte.';

function template(heading: string, content: string) {
  return `<div lang="pt-BR" style="padding:16px;background:#f7f5f4;color:#191515;font:16px/1.5 Arial,sans-serif">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;margin:auto;background:#fff;border-top:4px solid #e40b18">
      <tr><td bgcolor="#191515" style="padding:16px 24px;color:#fff"><strong>Mário Serafim Store</strong></td></tr>
      <tr><td style="padding:24px;overflow-wrap:anywhere"><h1 style="margin:0;font-size:23px">${heading}</h1>${content}</td></tr>
    </table></div>`;
}

export async function submitSupport(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return response(405, 'Use o formulário da Central de Ajuda.');
  if (!env.STORE_ORIGIN || request.headers.get('origin') !== env.STORE_ORIGIN ||
      new URL(request.url).origin !== env.STORE_ORIGIN) return response(403, 'Abra o formulário na loja.');
  if (!env.DB || !env.STORE_SESSION_SECRET || !env.RESEND_API_KEY || !env.STORE_EMAIL_FROM) {
    return response(503, 'O envio pelo formulário ainda não está configurado. Use o e-mail de suporte.');
  }

  const body = await readBody(request);
  const email = deliveryAddress(body?.email);
  const topic = helpTopics.find(item => item.id === body?.topic);
  const issue = topic?.issues.find(item => item.id === body?.issue);
  const description = typeof body?.description === 'string' ? body.description.trim().replace(/\r\n?/g, '\n') : '';
  const order = (topic?.order || issue?.order) && typeof body?.order === 'string' ? body.order.trim() : '';
  if (!body || body.website !== '' || !email || !topic || !issue || description.length < 10 || description.length > 900 ||
      !/^[a-z0-9-]{0,64}$/i.test(order) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(description)) {
    return response(400, 'Confira o e-mail, o assunto, o número do pedido e a descrição.');
  }

  const db = env.DB;
  const now = Math.floor(Date.now() / 1000);
  try {
    const key = await hmacKey(env.STORE_SESSION_SECRET);
    const fingerprintFor = async (kind: string, value: string) =>
      hex(await crypto.subtle.sign('HMAC', key, encoder.encode(`support/${kind}/${value}`)));
    const [fingerprint, ipKey, emailKey] = await Promise.all([
      fingerprintFor('request', JSON.stringify([email, topic.id, issue.id, order, description])),
      fingerprintFor('ip', request.headers.get('cf-connecting-ip') ?? 'unknown'),
      fingerprintFor('email', email.toLowerCase()),
    ]);
    const reference = fingerprint.slice(0, 12).toUpperCase();
    const accepted = () => response(200, `Solicitação enviada. A confirmação foi encaminhada para o e-mail informado. Protocolo ${reference}.`);
    // Retain only short-lived hashes and counters. The atomic insert enforces all limits before sending.
    await db.prepare('DELETE FROM support_requests WHERE created_at <= ?').bind(now - 86400).run();
    const claim = await db.prepare(`INSERT INTO support_requests(fingerprint, ip_key, email_key, created_at, retry_at)
      SELECT ?, ?, ?, ?, ?
      WHERE (SELECT COUNT(*) FROM support_requests) < 12
      AND (SELECT COUNT(*) FROM support_requests WHERE ip_key=? AND created_at>?) < 3
      AND (SELECT COUNT(*) FROM support_requests WHERE email_key=? AND created_at>?) < 2
      ON CONFLICT(fingerprint) DO NOTHING RETURNING fingerprint`)
      .bind(fingerprint, ipKey, emailKey, now, now + 60, ipKey, now - 3600, emailKey, now - 3600).first();
    if (!claim) {
      const existing = await db.prepare('SELECT accepted FROM support_requests WHERE fingerprint=?')
        .bind(fingerprint).first<{ accepted: number }>();
      if (existing?.accepted) return accepted();
      const retry = existing && await db.prepare(`UPDATE support_requests SET retry_at=?
        WHERE fingerprint=? AND accepted=0 AND retry_at<=? RETURNING fingerprint`)
        .bind(now + 60, fingerprint, now).first();
      if (!retry) return response(429, 'Aguarde antes de tentar novamente ou escreva para o e-mail de suporte.');
    }

    const orderLabel = order ? `Pedido #${order}` : 'Pedido não informado';
    const title = `[SUPORTE LOJA] ${issue.title} | ${order ? orderLabel : reference}`;
    const acknowledgment = `Recebemos sua solicitação sobre “${issue.title}”. O suporte responderá por e-mail. Protocolo ${reference}.`;
    const sent = await fetch('https://api.resend.com/emails/batch', {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json',
        'idempotency-key': `store-support/${fingerprint}`,
      },
      body: JSON.stringify([
        {
          from: env.STORE_EMAIL_FROM, to: [storeSupport.email], reply_to: email, subject: title,
          text: `${topic.title}\n${issue.title}\n${orderLabel}\nProtocolo ${reference}\n\n${description}`,
          html: template('Nova solicitação de suporte', `<p><strong>${escape(topic.title)}</strong><br>${escape(issue.title)}<br>${escape(orderLabel)}<br>Protocolo ${reference}</p><p>${escape(description).replace(/\n/g, '<br>')}</p>`),
        },
        {
          from: env.STORE_EMAIL_FROM, to: [email], reply_to: storeSupport.email,
          subject: `Solicitação recebida | Mário Serafim Store | ${reference}`, text: acknowledgment,
          html: template('Solicitação recebida', `<p>${escape(acknowledgment)}</p>`),
        },
      ]),
    });
    if (!sent.ok) {
      await sent.body?.cancel();
      return response(503, unavailable);
    }
    const result = await sent.json() as { data?: { id?: string }[] };
    if (!Array.isArray(result.data) || result.data.length !== 2 || !result.data.every(item => item?.id)) {
      return response(503, unavailable);
    }
    await db.prepare('UPDATE support_requests SET accepted=1 WHERE fingerprint=?').bind(fingerprint).run();
    return accepted();
  } catch {
    return response(503, unavailable);
  }
}
