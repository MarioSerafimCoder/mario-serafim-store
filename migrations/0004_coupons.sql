CREATE TABLE coupons (
  code TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('percent','fixed')),
  value INTEGER NOT NULL CHECK(value > 0 AND (kind='fixed' OR value<=99)),
  expires_at INTEGER NOT NULL,
  max_uses INTEGER NOT NULL CHECK(max_uses BETWEEN 1 AND 100000),
  sku TEXT REFERENCES products(sku),
  active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 1
);
ALTER TABLE orders ADD COLUMN coupon_code TEXT REFERENCES coupons(code);
ALTER TABLE orders ADD COLUMN discount_cents INTEGER NOT NULL DEFAULT 0 CHECK(discount_cents>=0);
CREATE INDEX orders_coupon ON orders(coupon_code) WHERE coupon_code IS NOT NULL;
