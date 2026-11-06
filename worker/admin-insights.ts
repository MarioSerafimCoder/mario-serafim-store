import { formatPrice } from '../src/lib/format.ts';
import { orderColumns, type OrderSummary } from './admin-orders.ts';
import { date, empty, html, orderTable, paymentLabel } from './admin-ui.ts';
import type { StoreDB } from './catalog.ts';

export function periodFilter(period: number, extra = '') {
  return `<form class="filters dashboard-period" method="get"><label>Período
    <select name="period">${[7,30,90].map(n=>`<option value="${n}"${n===period?' selected':''}>Últimos ${n} dias</option>`).join('')}</select>
    </label><button>Aplicar</button>${extra}</form>`;
}

export interface Sales { label:string; qty:number; revenue:number }
export interface Daily { day:string; revenue:number }
export interface Event { id:string; title:string; status:string; kind:string; recorded_at:number }

export async function insights(db: StoreDB, mode: string, period: number) {
  const today = Math.floor((Date.now() / 1000 - 10800) / 86400) * 86400 + 10800;
  const since = today - (period - 1) * 86400;
  const [status, products, categories, days, events] = await Promise.all([
    db.prepare(`SELECT status AS label,COUNT(*) AS qty, SUM(CASE WHEN status='approved' THEN price_cents ELSE 0 END) AS revenue
      FROM orders WHERE mode=? AND created_at>=? GROUP BY status ORDER BY qty DESC,status`).bind(mode,since).all<Sales>(),
    db.prepare(`SELECT sku,MAX(title) AS label,COUNT(*) AS qty,SUM(price_cents) AS revenue FROM orders
      WHERE mode=? AND created_at>=? AND status='approved' GROUP BY sku ORDER BY qty DESC,revenue DESC,sku LIMIT 50`).bind(mode,since).all<Sales>(),
    db.prepare(`SELECT COALESCE(NULLIF(category_at_purchase,''),'Categoria não registrada') AS label,COUNT(*) AS qty,SUM(price_cents) AS revenue
      FROM orders WHERE mode=? AND created_at>=? AND status='approved' GROUP BY 1 ORDER BY revenue DESC,label LIMIT 50`).bind(mode,since).all<Sales>(),
    db.prepare(`SELECT date(created_at-10800,'unixepoch') AS day,SUM(price_cents) AS revenue FROM orders
      WHERE mode=? AND created_at>=? AND status='approved' GROUP BY day ORDER BY day`).bind(mode,since).all<Daily>(),
    db.prepare(`SELECT o.id,o.title,e.status,e.kind,e.recorded_at FROM order_events e JOIN orders o ON o.id=e.order_id
      WHERE o.mode=? AND e.recorded_at>=? AND (e.kind='verification_failed' OR
      (e.kind='payment_status' AND e.status IN ('rejected','refunded','canceled','disputed','review')))
      ORDER BY e.recorded_at DESC,e.id DESC LIMIT 25`).bind(mode,since).all<Event>(),
  ]);
  const byDay = new Map(days.results.map(row=>[row.day,row.revenue]));
  const series = Array.from({length:period}, (_,i) => {
    const day = new Date((since + i * 86400 - 10800) * 1000).toISOString().slice(0,10);
    return {day,revenue:byDay.get(day) ?? 0};
  });
  return { since, status:status.results, products:products.results, categories:categories.results, series, events:events.results };
}
export type Insights = Awaited<ReturnType<typeof insights>>;

export function salesChart(series: Daily[]) {
  const total = series.reduce((sum,row)=>sum+row.revenue,0);
  if (!total) return empty('As vendas aprovadas aparecerão aqui.');
  const max = Math.max(...series.map(row=>row.revenue));
  const points = series.map((row,index)=>[Math.round(16 + 388*index/(series.length-1)),Math.round(118 - 98*row.revenue/max)].join(',')).join(' ');
  return `<figure class="sales-chart"><svg viewBox="0 0 420 136" role="img" aria-label="Evolução diária da receita aprovada">
  <path d="M16 20h388M16 52h388M16 85h388M16 118h388" fill="none" stroke="#dedede"/>
  <polyline points="${points}" fill="none" stroke="#b2231b" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
  <figcaption><span>${series[0].day.slice(5).split('-').reverse().join('/')}</span><span>Pico diário ${formatPrice(max)}</span><span>${series.at(-1)!.day.slice(5).split('-').reverse().join('/')}</span></figcaption></figure>`;
}
export function activity(events: Event[]) {
  return events.length ? '<ul class="rank">'+events.map(e=>`<li><span><a href="/admin/pedidos/${html(e.id)}">${html(e.title)}</a>
    <small>${date(e.recorded_at)}</small></span><span class="badge" data-state="${html(e.status)}">${e.kind==='verification_failed'?'Verificação divergente':html(paymentLabel(e.status))}</span></li>`).join('')+'</ul>'
    : empty('Nenhuma falha de verificação ou alteração financeira relevante no período.');
}
export function salesRows(rows: Sales[], financial = true) {
  return rows.length ? '<ul class="rank">'+rows.map(row=>`<li><span>${html(row.label)}</span><strong>${row.qty}${financial?' · '+formatPrice(row.revenue):''}</strong></li>`).join('')+'</ul>'
    : empty('Sem dados no período.');
}

export function reports(data: Insights, period: number) {
  const approved = data.status.find(row=>row.label==='approved');
  return periodFilter(period,`<a class="button" href="/admin/relatorios/exportar?period=${period}">Exportar CSV</a>`) +
    `<p class="helper">Receita e ticket usam pedidos atualmente aprovados, agrupados pela data de criação no horário de Brasília. O histórico mostra eventos na data em que foram registrados.</p>
    <div class="metrics"><div><span>Receita aprovada</span><strong>${formatPrice(approved?.revenue ?? 0)}</strong></div>
    <div><span>Ticket médio aprovado</span><strong>${approved?.qty?formatPrice(Math.round(approved.revenue/approved.qty)):'—'}</strong></div></div>
    <div class="dashboard-grid"><section class="panel dashboard-wide"><h2>Receita por dia</h2>${salesChart(data.series)}</section>
    <section class="panel"><h2>Pedidos por estado</h2>${salesRows(data.status.map(r=>({...r,label:paymentLabel(r.label)})),false)}</section>
    <section class="panel"><h2>Vendas por produto</h2>${salesRows(data.products)}</section>
    <section class="panel"><h2>Vendas por categoria</h2>${salesRows(data.categories)}</section>
    <section class="panel"><h2>Estornos, cancelamentos e alertas</h2>${activity(data.events)}</section></div>`;
}

export async function customers(db: StoreDB, mode: string, query: string, offset: number) {
  const { results } = await db.prepare(`SELECT buyer_email AS email,COUNT(*) AS qty,
    SUM(CASE WHEN status='approved' THEN price_cents ELSE 0 END) AS revenue,MAX(created_at) AS latest,
    (SELECT id FROM orders p WHERE p.mode=o.mode AND p.buyer_email=o.buyer_email ORDER BY created_at DESC,id DESC LIMIT 1) AS anchor
    FROM orders o WHERE mode=? AND buyer_email IS NOT NULL AND instr(buyer_email,lower(?))>0
    GROUP BY buyer_email ORDER BY latest DESC,email LIMIT 31 OFFSET ?`).bind(mode,query,offset)
    .all<{email:string;qty:number;revenue:number;latest:number;anchor:string}>();
  const page = (n: number) => '?q='+encodeURIComponent(query)+'&amp;offset='+n;
  return `<form class="filters" method="get"><label>E-mail <input type="search" name="q" value="${html(query)}" maxlength="80"></label><button>Buscar</button></form>
    <p class="helper">A lista usa o e-mail informado pelo Mercado Pago na verificação de um pagamento aprovado. Pedidos sem esse dado ficam apenas em Pedidos.</p>
    ${results.length?`<div class="table-wrap"><table><thead><tr><th>E-mail</th><th>Pedidos identificados</th><th>Compras aprovadas</th><th>Último pedido</th></tr></thead><tbody>
    ${results.slice(0,30).map(r=>`<tr><td><a href="/admin/clientes/${html(r.anchor)}">${html(r.email)}</a></td><td>${r.qty}</td><td>${formatPrice(r.revenue)}</td><td>${date(r.latest)}</td></tr>`).join('')}</tbody></table></div>`:empty('Nenhum comprador identificado com este filtro.') }
    <nav class="pager" aria-label="Paginação">${offset?`<a href="${page(Math.max(0,offset-30))}">← Anteriores</a>`:''}${results.length>30?`<a href="${page(offset+30)}">Próximos →</a>`:''}</nav>`;
}

export async function customerHistory(db: StoreDB, mode: string, id: string, offset: number) {
  const customer = await db.prepare('SELECT buyer_email AS email FROM orders WHERE mode=? AND id=? AND buyer_email IS NOT NULL').bind(mode,id).first<{email:string}>();
  if (!customer) return null;
  const [orders, totals] = await Promise.all([
    db.prepare(`SELECT ${orderColumns} FROM orders o WHERE mode=? AND buyer_email=? ORDER BY created_at DESC,id DESC LIMIT 31 OFFSET ?`).bind(mode,customer.email,offset).all<OrderSummary>(),
    db.prepare("SELECT COUNT(*) AS qty,SUM(CASE WHEN status='approved' THEN price_cents ELSE 0 END) AS revenue FROM orders WHERE mode=? AND buyer_email=?")
      .bind(mode,customer.email).first<{qty:number;revenue:number}>(),
  ]);
  return `<a href="/admin/clientes">← Clientes</a><section class="panel"><h2>${html(customer.email)}</h2><p>${totals!.qty} pedidos identificados · ${formatPrice(totals!.revenue)} em compras aprovadas</p>
    ${orderTable(orders.results.slice(0,30))}
    <nav class="pager" aria-label="Paginação">${offset?`<a href="?offset=${Math.max(0,offset-30)}">← Anteriores</a>`:''}${orders.results.length>30?`<a href="?offset=${offset+30}">Próximos →</a>`:''}</nav></section>`;
}
