CREATE TABLE checkout_carts (
  id TEXT PRIMARY KEY,
  recovery_hash TEXT NOT NULL UNIQUE,
  total_cents INTEGER NOT NULL CHECK (total_cents > 0),
  currency TEXT NOT NULL CHECK (currency = 'BRL'),
  mode TEXT NOT NULL CHECK (mode IN ('test', 'production')),
  seller TEXT NOT NULL,
  remote_id TEXT UNIQUE,
  checkout_url TEXT,
  payment_id TEXT,
  status TEXT NOT NULL DEFAULT 'created',
  provider_updated INTEGER NOT NULL DEFAULT 0,
  last_check INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX checkout_carts_reconcile ON checkout_carts(mode, seller, last_check);
ALTER TABLE orders ADD COLUMN cart_id TEXT REFERENCES checkout_carts(id);
ALTER TABLE orders ADD COLUMN cart_position INTEGER;
CREATE INDEX orders_cart ON orders(cart_id, created_at);

CREATE TRIGGER cart_checkout_created AFTER UPDATE OF remote_id ON checkout_carts
WHEN OLD.remote_id IS NULL AND NEW.remote_id IS NOT NULL
BEGIN
  INSERT INTO order_events(order_id, kind, status)
  SELECT id, 'checkout_created', status FROM orders WHERE cart_id = NEW.id;
END;
