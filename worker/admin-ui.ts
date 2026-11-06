import { formatPrice } from '../src/lib/format.ts';
import { statuses, toProduct, type ProductRow, type Settings } from './catalog.ts';

export const html = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
const href = (sku: string) => '/admin/produtos/' + encodeURIComponent(sku);
export const date = (value: number) => new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(value * 1000);
const empty = (message: string) => '<p class="empty">' + html(message) + '</p>';

export function page(title: string, content: string, active: string, logout: string) {
  const links = [['/admin','Visão geral'],['/admin/produtos','Produtos'],['/admin/pedidos','Pedidos'],['/admin/arquivos','Arquivos digitais'],['/admin/configuracoes','Configurações']];
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow"><title>${html(title)} · Mário Serafim Store</title>
  <link rel="stylesheet" href="/admin-ui.css"><script defer src="/admin-ui.js"></script></head>
  <body><a href="#main" class="skip">Pular para o conteúdo</a><aside><a class="brand" href="/admin"><img src="/marca/monograma.png" width="36" height="36" alt=""><span>Mário Serafim<br><strong>Store / Administração</strong></span></a>
  <nav aria-label="Painel">${links.map(([url,label])=>`<a href="${url}"${active===url?' aria-current="page"':''}>${label}</a>`).join('')}</nav>
  <div class="aux"><a href="/">Ver loja ↗</a><a href="${html(logout)}">Sair</a></div></aside>
  <main id="main"><header class="heading"><p class="eyebrow">Mário Serafim Store / Administração</p><h1>${html(title)}</h1></header>
  <p id="feedback" role="status" aria-live="polite" hidden></p>${content}</main></body></html>`;
}

const labels: Record<string,string> = { created:'Criado', pending:'Pendente', approved:'Aprovado', rejected:'Recusado', canceled:'Cancelado', refunded:'Estornado', disputed:'Contestação', review:'Em revisão' };
export function paymentLabel(status: string) { return labels[status] ?? status; }
export interface OrderSummary { id:string; sku:string; title:string; price_cents:number; remote_id:string|null; payment_id:string|null; status:string; created_at:number; delivered:number }
function delivery(order: OrderSummary) {
  if (['refunded','disputed'].includes(order.status)) return 'Acesso revogado';
  if (order.status !== 'approved') return 'Aguardando aprovação';
  return order.delivered ? 'Download registrado' : 'Acesso liberado';
}
export function orderTable(orders: OrderSummary[]) {
  if (!orders.length) return empty('Nenhum pedido neste período ou filtro.');
  return `<div class="table-wrap"><table><thead><tr><th>Produto / pedido</th><th>Data</th><th>Valor</th><th>Pagamento</th><th>Entrega</th></tr></thead><tbody>
  ${orders.map(o=>`<tr><td><a href="/admin/pedidos/${html(o.id)}">${html(o.title)}</a><small>${html(o.sku)} · ${html(o.id.slice(0,8))}</small></td><td>${date(o.created_at)}</td><td>${formatPrice(o.price_cents)}</td><td>${html(paymentLabel(o.status))}</td><td>${delivery(o)}</td></tr>`).join('')}</tbody></table></div>`;
}

export function orderDetail(order: OrderSummary, events: {kind:string;status:string;recorded_at:number}[]) {
  const eventLabels: Record<string,string> = { order_created:'Pedido criado', checkout_created:'Checkout criado', payment_status:'Pagamento atualizado', download_started:'Download iniciado', verification_failed:'Verificação divergente' };
  return `<a href="/admin/pedidos">← Pedidos</a><section class="panel"><h2>${html(order.title)}</h2><dl>
    <dt>Pedido</dt><dd>${html(order.id)}</dd><dt>SKU</dt><dd>${html(order.sku)}</dd><dt>Data</dt><dd>${date(order.created_at)}</dd><dt>Valor registrado</dt><dd>${formatPrice(order.price_cents)}</dd>
    <dt>Order Mercado Pago</dt><dd>${html(order.remote_id ?? 'Ainda sem referência')}</dd><dt>Pagamento Mercado Pago</dt><dd>${html(order.payment_id ?? 'Ainda sem referência')}</dd>
    <dt>Pagamento</dt><dd>${html(paymentLabel(order.status))}</dd><dt>Entrega</dt><dd>${delivery(order)}</dd></dl></section>
    <section class="panel"><h2>Histórico</h2>${events.length ? '<ol>'+events.map(e=>`<li>${date(e.recorded_at)} · ${html(eventLabels[e.kind] ?? e.kind)} · ${html(paymentLabel(e.status))}</li>`).join('')+'</ol>' : empty('Sem eventos registrados.')}</section>`;
}

export function dashboard(stats: {total:number; revenue:number; pending:number; alerts:number}, products: {published:number;draft:number}, orders: OrderSummary[], sales: {title:string;qty:number;revenue:number}[], period:number) {
  const items = [['Receita aprovada', formatPrice(stats.revenue)],['Pedidos no período', stats.total],['Pedidos pendentes',stats.pending],['Produtos publicados',products.published],['Produtos em rascunho',products.draft],['Pedidos em revisão, estorno ou disputa',stats.alerts]];
  return `<form class="filters" method="get"><label>Período <select name="period">${[7,30,90].map(days=>`<option value="${days}"${period===days?' selected':''}>Últimos ${days} dias</option>`).join('')}</select></label><button>Aplicar</button></form>
  <section class="metrics" aria-label="Indicadores">${items.map(([label,value])=>`<div><span>${label}</span><strong>${value}</strong></div>`).join('')}</section>
  <section class="panel"><h2>Pedidos recentes</h2>${orderTable(orders)}</section>
  <section class="panel"><h2>Vendas por produto</h2>${sales.length?'<ul>'+sales.map(s=>`<li>${html(s.title)} · ${s.qty} · ${formatPrice(s.revenue)}</li>`).join('')+'</ul>':empty('Nenhuma venda aprovada no período.')}</section>`;
}

function action(row: ProductRow, label: string, command: string, confirm = '') {
  return `<button type="button" class="quiet" data-action="${command}" data-sku="${html(row.sku)}" data-revision="${row.revision}" data-confirm="${html(confirm)}">${label}</button>`;
}

export function productsTable(rows: ProductRow[], query: string, status: string, offset: number) {
  const pagination = (next: number, label: string) => `<a href="?q=${encodeURIComponent(query)}&amp;status=${encodeURIComponent(status)}&amp;offset=${next}">${label}</a>`;
  return `<a class="button primary" href="/admin/produtos/novo">Novo produto</a>
    <form class="filters" method="get"><label>Buscar <input name="q" type="search" value="${html(query)}" maxlength="80" placeholder="Nome, SKU ou slug"></label>
    <label>Estado <select name="status"><option value="">Todos</option>${Object.entries(statuses).map(([key,label])=>`<option value="${key}"${status===key?' selected':''}>${label}</option>`).join('')}</select></label><button>Filtrar</button></form>
    ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Produto</th><th>Estado</th><th>Preço</th><th>Ações</th></tr></thead><tbody>
    ${rows.slice(0,30).map(row=>`<tr><td><a href="${href(row.sku)}">${html(row.name)}</a><small>${html(row.sku)}</small></td><td>${statuses[row.status]}</td><td>${formatPrice(row.price_cents)}</td>
      <td class="actions"><a href="${href(row.sku)}">Editar</a>${action(row,'Duplicar','duplicar')}
      ${row.status==='archived'?action(row,'Restaurar','restaurar'):action(row,'Arquivar','arquivar','Arquivar este produto e retirá-lo da vitrine?')}
      ${row.status==='published'||row.status==='coming_soon'?action(row,'Despublicar','despublicar','Retirar o produto da vitrine?'):''}
      ${row.status==='draft'||row.status==='coming_soon'?action(row,'Publicar','publicar'):''}
      <a href="/admin/previa/${html(row.sku)}">Prévia</a>${['published','coming_soon'].includes(row.status)?`<a href="/produtos/${html(row.slug)}/">Na loja ↗</a>`:''}</td></tr>`).join('')}</tbody></table></div>` : empty('Nenhum produto encontrado.')}
    <nav class="pager" aria-label="Paginação">${offset ? pagination(Math.max(0, offset-30), '← Anteriores') : ''}${rows.length>30 ? pagination(offset+30,'Próximos →') : ''}</nav>`;
}

const input = (name: string, label: string, value: unknown, attrs = '') => `<label>${label}<input name="${name}" value="${html(value)}" ${attrs}></label>`;
const area = (name: string, label: string, value: unknown, max: number) => `<label>${label}<textarea name="${name}" maxlength="${max}">${html(value)}</textarea></label>`;

export function editor(row?: ProductRow) {
  const product = row && toProduct(row).data;
  return `<a href="/admin/produtos">← Produtos</a>${row ? `<a class="preview-link" href="/admin/previa/${html(row.sku)}" target="_blank" rel="noopener">Prévia salva ↗</a>` : ''}
    <form class="editor" method="post" data-product data-url="/admin/api/produtos${row ? '/'+html(row.sku) : ''}">
    <input type="hidden" name="revision" value="${row?.revision ?? 0}">
    <section class="panel"><h2>Identificação</h2><div class="fields">
    ${input('name','Nome',product?.name,'required maxlength="127"')}${input('category','Categoria',product?.category,'maxlength="80"')}
    ${input('sku','SKU',product?.sku,'required maxlength="80" pattern="[A-Z0-9]+(-[A-Z0-9]+)*"'+(row?' readonly':''))}
    ${input('slug','Slug',product?.slug,'required maxlength="100" pattern="[a-z0-9]+(-[a-z0-9]+)*"')}
    ${input('price','Preço em reais',product ? (product.priceCents/100).toFixed(2).replace('.',',') : '0,00','required inputmode="decimal" maxlength="10"')}
    ${input('version','Versão',product?.version ?? '1.0','required maxlength="40"')}
    </div>${area('summary','Resumo',product?.summary,300)}</section>
    <section class="panel"><h2>Descrição</h2><p>Formate o texto com os botões ou use Markdown.</p>
    <div class="actions" aria-label="Formatação">${[['Título','## '],['Negrito','**'],['Itálico','_'],['Lista','- '],['Link','link']].map(([label,format])=>`<button type="button" class="quiet" data-format="${format}">${label}</button>`).join('')}</div>
    ${area('description','Descrição completa',product?.description,16000)}<button type="button" data-preview-text>Prévia do texto</button><div id="rich-preview" class="rich" hidden></div></section>
    <section class="panel"><h2>Imagens públicas</h2><p>A primeira imagem é a capa. Use JPEG, PNG ou WebP, até 900 KB por imagem.</p>
    <input type="hidden" name="images" value="${html(JSON.stringify(product?.images ?? []))}"><div id="images"></div>
    <div class="fields"><label>Enviar prévia <input id="image-file" type="file" accept="image/jpeg,image/png,image/webp"></label>
    ${input('image-url','Ou informe uma URL HTTPS','','type="url" maxlength="700"')}${input('image-alt','Texto alternativo','','maxlength="200"')}</div>
    <button type="button" data-add-image>Adicionar imagem</button><progress id="image-progress" max="100" value="0" hidden></progress></section>
    <section class="panel"><h2>Pacote e licença</h2><div class="fields">
    ${area('includes','Conteúdo do pacote (um por linha)',product?.includes.join('\n'),1800)}${area('formats','Formatos (um por linha)',product?.formats.join('\n'),1800)}
    ${area('requirements','Requisitos (um por linha)',product?.requirements.join('\n'),1800)}
    ${input('licenseType','Tipo de licença',product?.license.type,'maxlength="100"')}</div>
    ${area('licenseSummary','Descrição da licença',product?.license.summary,1800)}${row?`<a href="/admin/arquivos?sku=${html(row.sku)}">Gerenciar arquivo digital deste produto ↗</a>`:'<p>Salve o rascunho para associar um arquivo digital.</p>'}</section>
    <section class="panel"><h2>Publicação</h2><label>Estado <select name="status">${Object.entries(statuses).filter(([key])=>row?.status==='archived'?key==='archived':key!=='archived').map(([key,label])=>`<option value="${key}"${(row?.status ?? 'draft')===key?' selected':''}>${label}</option>`).join('')}</select></label>
    <label class="check"><input type="checkbox" name="featured"${product?.featured?' checked':''}> Destacar na home</label>
    <button class="primary" type="submit">Salvar produto</button> ${row?.status!=='archived'?'<button type="button" data-save-draft>Salvar como rascunho</button>':''} <span id="dirty" role="status"></span></section></form>`;
}

export function filePage(files: {sku:string;version:string;filename:string;enabled:number;available:boolean}[], bound:boolean, selected:string, version:string) {
  return `<section class="panel"><h2>Entrega privada</h2><p>${bound?'Envie uma nova versão. Arquivos de pedidos anteriores permanecem no armazenamento.':'O R2 privado ainda não está configurado. O upload e a entrega de arquivos estão indisponíveis.'}</p>
    ${bound?`<form method="post" data-private-upload><div class="fields">${input('sku','SKU',selected,'required maxlength="80"')}${input('version','Versão',version,'required maxlength="40"')}<label>Arquivo (até 25 MB)<input name="file" type="file" required accept=".zip,.pdf,.psd,.ai,.fig"></label></div>
      <button type="submit" class="primary">Enviar versão</button><progress max="100" value="0" hidden></progress></form>`:''}</section>
    ${files.length?`<div class="table-wrap"><table><thead><tr><th>Produto / versão</th><th>Arquivo</th><th>Armazenamento</th><th>Novas entregas</th></tr></thead><tbody>
    ${files.map(f=>`<tr><td>${html(f.sku)} · ${html(f.version)}</td><td>${html(f.filename)}</td><td>${f.available?'Disponível':bound?'Ausente':'R2 indisponível'}</td><td>${f.enabled?'Permitidas':'Bloqueadas'} ${bound?`<button type="button" class="quiet" data-file-toggle data-sku="${html(f.sku)}" data-version="${html(f.version)}" data-enabled="${f.enabled ? 'false' : 'true'}">${f.enabled?'Bloquear':'Permitir'}</button>`:''}</td></tr>`).join('')}</tbody></table></div>`:empty('Nenhuma versão de arquivo associada.')}`;
}

export function settingsPage(settings: Settings, checkout: boolean, mp: boolean, files: boolean) {
  return `<section class="panel"><h2>Integrações</h2><dl><dt>Catálogo e pedidos</dt><dd>D1 conectado</dd><dt>Checkout</dt><dd>${checkout?'Habilitado na infraestrutura':'Desativado'}</dd>
  <dt>Mercado Pago</dt><dd>${mp?'Credenciais vinculadas':'Credenciais pendentes'}</dd><dt>Armazenamento privado</dt><dd>${files?'R2 vinculado':'R2 indisponível'}</dd></dl></section>
  <form class="panel" method="post" data-settings><h2>Loja e preferências</h2>${input('announcement','Aviso na página inicial',settings.announcement,'maxlength="180"')}${input('support','URL pública de atendimento',settings.support_url,'type="url" maxlength="400"')}
  <label>Período inicial do dashboard <select name="period">${[7,30,90].map(n=>`<option value="${n}"${settings.period===n?' selected':''}>${n} dias</option>`).join('')}</select></label><button class="primary">Salvar configurações</button></form>`;
}
