import type { StoreDB } from './catalog.ts';

export const orderColumns = `o.id,o.sku,o.title,o.price_cents,o.remote_id,o.payment_id,o.status,o.created_at,o.coupon_code,o.discount_cents,
  EXISTS(SELECT 1 FROM order_events e WHERE e.order_id=o.id AND e.kind='download_started') AS delivered`;
export const orderStatuses = {
  created:'Criado', pending:'Pendente', approved:'Aprovado', rejected:'Recusado', canceled:'Cancelado',
  refunded:'Estornado', disputed:'Contestação', review:'Em revisão',
} as const;

export interface OrderSummary {
  id: string; sku: string; title: string; price_cents: number; remote_id: string | null;
  coupon_code: string | null; discount_cents: number;
  payment_id: string | null; status: string; created_at: number; delivered: number;
}
export interface OrderEvent { kind: string; status: string; recorded_at: number }

export function orderFilters(params: URLSearchParams) {
  const q = (params.get('q') ?? '').trim().slice(0,80);
  const input = params.get('status') ?? '';
  const status = Object.hasOwn(orderStatuses,input) ? input : '';
  const days = Number(params.get('period'));
  const period = [7,30,90].includes(days) ? days : 0;
  const since = period ? Math.floor(Date.now()/1000) - period * 86400 : 0;
  return { q, status, period, since };
}

export function orderRows(db: StoreDB, mode: string, filter: ReturnType<typeof orderFilters>, limit: number, offset: number) {
  const { q,status,since } = filter;
  return db.prepare(`SELECT ${orderColumns} FROM orders o WHERE o.mode=? AND o.created_at>=?
    AND (?='' OR o.status=?) AND (instr(lower(title),lower(?))>0 OR instr(lower(sku),lower(?))>0
    OR instr(lower(id),lower(?))>0 OR instr(lower(remote_id),lower(?))>0 OR instr(lower(payment_id),lower(?))>0)
    ORDER BY o.created_at DESC,o.id DESC LIMIT ? OFFSET ?`).bind(mode,since,status,status,q,q,q,q,q,limit,offset).all<OrderSummary>();
}

export function productCategories(db: StoreDB) {
  return db.prepare("SELECT DISTINCT category FROM products WHERE category<>'' ORDER BY category COLLATE NOCASE")
    .all<{ category: string }>();
}

export function csv(rows: (string|number|null)[][]) {
  return '\uFEFF' + rows.map(row=>row.map(value=>{
    let cell = String(value ?? '');
    if (typeof value === 'string' && /^(?:[\s\p{Cc}\p{Cf}]*[=+\-@]|[\t\r\n])/u.test(cell)) cell = "'" + cell;
    return '"' + cell.replaceAll('"','""') + '"';
  }).join(',')).join('\r\n') + '\r\n';
}
