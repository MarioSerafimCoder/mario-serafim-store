import { empty, html } from './admin-ui.ts';
import type { StoreDB } from './catalog.ts';
import type { Env } from './types.ts';

export async function operations(env: Env, db: StoreDB) {
  const [schema,catalog,file] = await Promise.all([
    db.prepare(`SELECT
      (SELECT COUNT(*) FROM sqlite_schema WHERE type='table' AND name IN ('products','orders','fulfillment','order_events','coupons','store_settings')) AS tables,
      (SELECT COUNT(*) FROM pragma_table_info('orders') WHERE name IN ('coupon_code','discount_cents','buyer_email','category_at_purchase')) AS fields`)
      .first<{tables:number;fields:number}>(),
    db.prepare(`SELECT COUNT(CASE WHEN status='published' THEN 1 END) AS published,
      COUNT(CASE WHEN status='coming_soon' THEN 1 END) AS soon,COUNT(CASE WHEN status='draft' THEN 1 END) AS drafts
      FROM products`).first<{published:number;soon:number;drafts:number}>(),
    db.prepare(`SELECT f.object_key FROM fulfillment f JOIN products p ON p.sku=f.sku AND p.version=f.version
      WHERE f.enabled=1 AND p.status='published' AND p.price_cents>0 AND p.sku NOT LIKE 'DEMO-%' AND p.slug NOT LIKE 'demo-%'
      LIMIT 1`).first<{object_key:string}>(),
  ]);
  const configured = Boolean(env.MP_ACCESS_TOKEN && env.MP_WEBHOOK_SECRET && /^\d+$/.test(env.MP_SELLER_ID ?? '') &&
    (env.STORE_SESSION_SECRET?.length ?? 0)>=32);
  const schemaReady = schema?.tables===6 && schema.fields===4;
  let fileStatus = env.FILES ? 'Vínculo ativo. Nenhum arquivo de venda para consultar.' : 'R2 indisponível neste ambiente.';
  let fileVerified = false;
  if (env.FILES && file) {
    try {
      fileVerified = Boolean(await env.FILES.head(file.object_key));
      fileStatus = fileVerified ? 'Arquivo privado de referência acessível.' : 'Arquivo privado de referência ausente.';
    } catch { fileStatus = 'Falha ao consultar o armazenamento privado.'; }
  }
  const checkout = env.CHECKOUT_ENABLED!=='true' ? 'Desativado' :
    configured && schemaReady && fileVerified ? 'Habilitado na configuração. Há um arquivo de referência disponível.' : 'Configuração incompleta ou arquivo indisponível.';
  return { catalog, configured, schemaReady, fileStatus, checkout };
}
export type Operations = Awaited<ReturnType<typeof operations>>;

export function integrationPage(data: Operations, mode: string) {
  return `<div class="dashboard-grid">
    <section class="panel"><h2>Mercado Pago</h2><p>${mode==='test'?'Homologação':'Produção'} · Checkout Pro (Orders)</p>
    <p>${data.configured?'Credenciais e assinatura vinculadas.':'Configuração incompleta.'} Disponibilidade de compras: ${data.checkout}.</p>
    <p class="helper">O estado da configuração é local. Consulte o painel oficial para verificar as entregas de webhook e a qualidade da integração.</p>
    <a href="https://www.mercadopago.com.br/developers/panel/app" rel="noreferrer">Abrir painel oficial ↗</a></section>
    <section class="panel"><h2>Cloudflare D1</h2><p>Consulta ao banco concluída. ${data.schemaReady?'Estrutura do Admin 2.0 conferida.':'Estrutura do Admin 2.0 incompleta.'}</p>
    <p>${data.catalog?.published ?? 0} produtos publicados · ${data.catalog?.drafts ?? 0} rascunhos.</p><a href="/admin/produtos">Ver catálogo</a></section>
    <section class="panel"><h2>Cloudflare R2</h2><p>${data.fileStatus}</p>
    <p class="helper">Arquivos privados são necessários para habilitar compras e entregas digitais.</p><a href="/admin/arquivos">Gerenciar arquivos</a></section>
  </div>`;
}

export function salesChannels(data: Operations, origin: string) {
  return `<div class="dashboard-grid">
    <section class="panel dashboard-wide"><div class="card-heading"><h2>Loja online</h2><a href="/">Abrir vitrine ↗</a></div>
    <dl><dt>Domínio</dt><dd>${html(origin)}</dd><dt>Catálogo</dt><dd>${data.catalog?.published ?? 0} publicados · ${data.catalog?.soon ?? 0} em breve</dd>
    <dt>Compras</dt><dd>${data.checkout}</dd></dl><a href="/admin/configuracoes">Editar configurações públicas</a></section>
    <section class="panel"><h2>Facebook e Instagram</h2>${empty('Nenhuma conexão Meta configurada para esta loja.')}
    <p class="helper">A sincronização exige um catálogo elegível no Commerce Manager, aprovação da Meta para os itens e um conector autorizado.</p></section>
  </div>`;
}
