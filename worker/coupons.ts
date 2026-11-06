import type { StoreDB } from './catalog.ts';

export const couponPattern = /^[A-Z0-9][A-Z0-9-]{2,23}$/;
export const minimumCharged = 100;

// The checkout INSERT and this read share the same eligibility rules. SQLite serializes
// the eligibility check and insertion so simultaneous orders cannot oversubscribe a coupon.
export const eligibleCoupon = `
  SELECT c.code, CASE WHEN c.kind='percent' THEN p.price_cents*c.value/100 ELSE c.value END AS discount
  FROM coupons c CROSS JOIN products p
  WHERE c.code=? AND p.sku=? AND p.status='published' AND c.active=1 AND c.expires_at>unixepoch()
  AND (c.sku IS NULL OR c.sku=p.sku)
  AND (SELECT COUNT(*) FROM orders WHERE coupon_code=c.code)<c.max_uses
`;

export async function couponDiscount(db: StoreDB, code: string, sku: string, price: number) {
  const row = await db.prepare(eligibleCoupon).bind(code,sku).first<{discount:number}>();
  if (!row || row.discount <= 0 || price - row.discount < minimumCharged) return null;
  return row.discount;
}

export interface Coupon {
  code: string; kind: 'percent' | 'fixed'; value: number; expires_at: number;
  max_uses: number; sku: string | null; active: number; revision: number; uses: number;
}
