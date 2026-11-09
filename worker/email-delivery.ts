import { hex, hmacKey } from './mercado-pago.ts';
import type { Env, Order } from './types.ts';

export const deliveryEnabled = (env: Env) => env.EMAIL_DELIVERY_ENABLED === 'true';
export const deliveryConfigured = (env: Env) => Boolean(env.RESEND_API_KEY && env.STORE_EMAIL_FROM && env.FILES && env.EMAIL_DELIVERY_QUEUE);
const clock = () => Math.floor(Date.now() / 1000);
const escape = (value: string) => value.replace(/[&<>"']/g, ch =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
export const safeFilename = (name: string) => name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'produto.zip';

export function deliveryAddress(value: unknown) {
  if (typeof value !== 'string' || value.length > 254) return null;
  const address = value.trim();
  const match = /^([a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*)@((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})$/i.exec(address);
  return match && match[1].length <= 64 ? match[1] + '@' + match[2].toLowerCase() : null;
}

export async function registerDelivery(db: NonNullable<Env['DB']>, id: string, email: string) {
  await db.batch([
    db.prepare('INSERT INTO email_deliveries(purchase_id,email) VALUES (?,?) ON CONFLICT(purchase_id) DO NOTHING')
      .bind(id,email),
    db.prepare(`UPDATE orders SET buyer_email=COALESCE(buyer_email,?)
      WHERE (id=? AND cart_id IS NULL) OR cart_id=?`).bind(email,id,id),
  ]);
  const row = await db.prepare('SELECT email FROM email_deliveries WHERE purchase_id=?').bind(id).first<{email:string}>();
  return row?.email === email;
}

export interface Delivery {
  purchase_id: string;
  email: string;
  state: string;
  generation: number;
  attempts: number;
  first_attempt: number;
  last_attempt: number | null;
  accepted_at: number | null;
  last_error: string | null;
}

export async function purchaseLink(secret: string, item: string, expires: number) {
  const data = new TextEncoder().encode(`email-download:${item}.${expires}`);
  return hex(await crypto.subtle.sign('HMAC', await hmacKey(secret), data));
}

function limit(value: string | undefined, fallback: number, min: number, max: number) {
  const number = value === undefined ? fallback : Number(value);
  return Number.isSafeInteger(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

async function message(env: Env, delivery: Delivery, items: Order[]) {
  let remaining = limit(env.EMAIL_ATTACHMENT_MAX_BYTES, 512 * 1024, 0, 1024 * 1024);
  const ttl = limit(env.EMAIL_LINK_TTL_SECONDS, 7 * 86400, 86400, 30 * 86400);
  const expires = delivery.first_attempt + ttl;
  const attachments: { filename: string; content: string }[] = [];
  const entries: { title: string; url?: string; filename?: string }[] = [];
  for (const item of items) {
    const filename = safeFilename(item.filename);
    const metadata = await env.FILES!.head(item.object_key) as { size?: number } | null;
    if (!metadata) throw new Error('Arquivo indisponível');
    if (metadata.size !== undefined && metadata.size <= remaining && /\.(pdf|zip)$/i.test(filename)) {
      const object = await env.FILES!.get(item.object_key);
      if (!object) throw new Error('Arquivo indisponível');
      if (object.size <= remaining) {
        const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
        remaining -= bytes.length;
        const uniqueName = attachments.some(entry => entry.filename === filename) ? item.id + '-' + filename : filename;
        attachments.push({ filename: uniqueName, content: Buffer.from(bytes).toString('base64') });
        entries.push({title:item.title,filename:uniqueName});
        continue;
      }
      await object.body.cancel();
    }
    const token = await purchaseLink(env.STORE_SESSION_SECRET!,item.id,expires);
    entries.push({title:item.title,url:`${env.STORE_ORIGIN}/compras/api/arquivo/${item.id}/${expires}.${token}`});
  }
  const intro = 'Seu pagamento foi confirmado e seus produtos digitais já estão disponíveis.';
  const thanks = 'Obrigado por comprar na Mário Serafim Store.';
  const supportEmail = 'contato@marioserafim.com.br';
  const whatsapp = `https://wa.me/5585981866552?text=${encodeURIComponent('olá quero ajuda com o meu produto')}`;
  const products = entries.map((item) => `
    <tr><td style="padding:0 0 10px">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
    <td width="48" align="center" valign="middle" bgcolor="#85191d" style="color:#fff;font: bold 11px Arial,sans-serif;letter-spacing:1px">${item.filename ? escape(item.filename.split('.').pop()!.toUpperCase()) : 'ARQ'}</td>
    <td bgcolor="#f5f2f1" style="padding:16px;overflow-wrap:anywhere">
      <p style="margin:0 0 8px;font-weight:bold">${escape(item.title)}</p>
      ${item.url
        ? `<a style="display:inline-block;padding:10px 16px;border-radius:6px;background:#e40b18;color:#ffffff;font-weight:bold;text-decoration:none" href="${escape(item.url)}">Baixar arquivo</a>`
        : `<p style="margin:0;color:#4d4645;font-size:14px;overflow-wrap:anywhere">Disponível no anexo deste e-mail<br>${escape(item.filename!)}</p>`}
    </td></tr></table></td></tr>`).join('');
  return {
    from: env.STORE_EMAIL_FROM,
    to: [delivery.email],
    subject: 'Sua compra está pronta | Mário Serafim Store',
    text: `Olá!\n\n${intro}\n\nPedido: ${delivery.purchase_id}\nProdutos adquiridos:\n${entries.map(item => `- ${item.title}: ${item.url ?? 'Anexo ' + item.filename}`).join('\n')}\n\n${thanks}\nPrecisa de ajuda? Falar com o suporte.\nWhatsApp: ${whatsapp}\nE-mail: ${supportEmail}\n\nMário Serafim Store`,
    html: `<div lang="pt-BR" style="padding:20px 12px;background:#f7f5f4;color:#191515;font:16px/1.5 Arial,sans-serif">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e7e1df;border-top:4px solid #e40b18">
        <tr><td bgcolor="#191515" style="padding:20px 24px">
          <img src="${escape(`${env.STORE_ORIGIN}/marca/logo-email.png`)}" width="220" alt="Mário Serafim Store" style="display:block;width:220px;max-width:100%;height:auto;color:#ffffff;font:bold 14px Arial,sans-serif">
        </td></tr>
        <tr><td style="padding:28px 24px">
          <p style="margin:0 0 8px;color:#85191d;font-size:12px;font-weight:bold;letter-spacing:1.2px">✓ &nbsp; PAGAMENTO CONFIRMADO</p>
          <h1 style="margin:0 0 10px;font-size:32px;line-height:1.15;letter-spacing:-.6px">Sua compra está pronta</h1>
          <p style="margin:0 0 24px;color:#4d4645">Seus arquivos estão disponíveis abaixo.</p>
          <h2 style="margin:0 0 12px;font-size:18px">Produtos da compra</h2>
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0">${products}</table>
          <p style="margin:10px 0 0;padding-top:16px;border-top:1px solid #e7e1df;color:#4d4645;font-size:13px;overflow-wrap:anywhere"><strong>Pedido</strong><br>${escape(delivery.purchase_id)}</p>
        </td></tr>
        <tr><td bgcolor="#f0ecea" style="padding:16px 24px;color:#4d4645;font-size:14px">
          <p style="margin:0 0 8px"><strong>Precisa de ajuda?</strong></p>
          <p style="margin:0 0 4px"><a style="color:#85191d;font-weight:bold;text-decoration:underline" href="${escape(whatsapp)}">Falar com o suporte pelo WhatsApp</a></p>
          <p style="margin:0"><a style="color:#85191d;text-decoration:underline" href="mailto:${supportEmail}">${supportEmail}</a></p>
        </td></tr>
      </table>
    </div>`,
    attachments,
  };
}

const approved = `(EXISTS(SELECT 1 FROM orders o WHERE o.id=email_deliveries.purchase_id AND o.cart_id IS NULL AND o.status='approved')
  OR EXISTS(SELECT 1 FROM checkout_carts c WHERE c.id=email_deliveries.purchase_id AND c.status='approved'))`;

export async function sendDelivery(env: Env, id: string): Promise<number | null> {
  if (!deliveryEnabled(env) || !deliveryConfigured(env) || !env.DB) return null;
  const db = env.DB;
  const time = clock();
  await db.prepare(`UPDATE email_deliveries SET state='failed',last_error='Limite de retentativas atingido'
    WHERE purchase_id=? AND state IN ('pending','processing') AND next_attempt<=?
    AND (attempts>=8 OR first_attempt<=?)`).bind(id,time,time-23*3600).run();
  const job = await db.prepare(`UPDATE email_deliveries SET state='processing',attempts=attempts+1,
    first_attempt=COALESCE(first_attempt,?),last_attempt=?,next_attempt=?
    WHERE purchase_id=? AND state IN ('pending','processing') AND next_attempt<=? AND ${approved} RETURNING *`)
    .bind(time,time,time+300,id,time).first<Delivery>();
  if (!job) return null;
  const update = (state: string, next: number, issue: string | null, provider: string | null = null) =>
    db.prepare(`UPDATE email_deliveries SET state=?,next_attempt=?,last_error=?,provider_id=?,accepted_at=?
      WHERE purchase_id=? AND generation=? AND attempts=? AND state='processing'`)
      .bind(state,next,issue,provider,provider ? clock() : null,id,job.generation,job.attempts).run();
  try {
    const { results: items } = await db.prepare(`SELECT * FROM orders WHERE status='approved' AND
      ((id=? AND cart_id IS NULL) OR cart_id=?) ORDER BY cart_position,id`).bind(id,id).all<Order>();
    if (!items.length) { await update('blocked',0,'Pagamento não aprovado'); return null; }
    const payload = await message(env,job,items);
    // Check again after reading attachments, immediately before the external call.
    if (!await db.prepare(`SELECT 1 FROM email_deliveries WHERE purchase_id=? AND state='processing'
      AND generation=? AND attempts=? AND ${approved}`).bind(id,job.generation,job.attempts).first()) return null;
    const response = await fetch('https://api.resend.com/emails', {
      method:'POST', redirect:'manual', signal:AbortSignal.timeout(10_000),
      headers: { authorization:`Bearer ${env.RESEND_API_KEY}`, 'content-type':'application/json',
        'idempotency-key':`store-delivery/${id}/${job.generation}` },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const retry = [408,409,429].includes(response.status) || response.status >= 500;
      await response.body?.cancel();
      const delay = Math.min(3600,60*2**job.attempts);
      await update(retry ? 'pending' : 'failed',clock()+delay,`Resend HTTP ${response.status}`);
      return retry ? delay : null;
    }
    const result = await response.json() as {id?:string};
    if (typeof result.id !== 'string' || !/^[\w-]{1,100}$/.test(result.id)) throw new Error('Resposta inesperada');
    await update('accepted',0,null,result.id);
    return null;
  } catch {
    const delay = Math.min(3600,60*2**job.attempts);
    await update('pending',clock()+delay,'Falha temporária de preparação ou envio');
    return delay;
  }
}

export async function dispatchDelivery(env: Env, id: string) {
  if (!deliveryEnabled(env) || !deliveryConfigured(env)) return;
  const delay = await sendDelivery(env,id);
  if (delay) {
    await env.EMAIL_DELIVERY_QUEUE!.send({purchase_id:id},{delaySeconds:delay});
    return;
  }
  const pending = await env.DB?.prepare(`SELECT state,next_attempt FROM email_deliveries
    WHERE purchase_id=? AND state IN ('pending','processing')`).bind(id).first<{state:string;next_attempt:number}>();
  if (pending) await env.EMAIL_DELIVERY_QUEUE!.send({purchase_id:id},
    {delaySeconds:Math.max(1,pending.next_attempt-clock())});
}

export async function blockDelivery(env: Env, id: string) {
  if (!deliveryEnabled(env)) return;
  await env.DB!.prepare(`UPDATE email_deliveries SET state='blocked',last_error='Pagamento revogado' WHERE purchase_id=?
    AND (EXISTS(SELECT 1 FROM orders WHERE id=purchase_id AND status IN ('refunded','disputed'))
      OR EXISTS(SELECT 1 FROM checkout_carts WHERE id=purchase_id AND status IN ('refunded','disputed')))`)
    .bind(id).run();
}
