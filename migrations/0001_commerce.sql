CREATE TABLE fulfillment (
  sku TEXT NOT NULL,
  version TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  PRIMARY KEY (sku, version)
);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  recovery_hash TEXT NOT NULL UNIQUE,
  sku TEXT NOT NULL,
  title TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  currency TEXT NOT NULL CHECK (currency = 'BRL'),
  object_key TEXT NOT NULL,
  filename TEXT NOT NULL,
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

CREATE INDEX orders_reconcile ON orders(mode, seller, last_check);

CREATE TABLE order_events (
  id INTEGER PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  recorded_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX order_events_order ON order_events(order_id, id);

CREATE TRIGGER order_created AFTER INSERT ON orders
BEGIN
  INSERT INTO order_events(order_id, kind, status) VALUES (NEW.id, 'order_created', NEW.status);
END;

CREATE TRIGGER checkout_created AFTER UPDATE OF remote_id ON orders
WHEN OLD.remote_id IS NULL AND NEW.remote_id IS NOT NULL
BEGIN
  INSERT INTO order_events(order_id, kind, status) VALUES (NEW.id, 'checkout_created', NEW.status);
END;

CREATE TRIGGER payment_updated AFTER UPDATE OF status ON orders
WHEN OLD.status <> NEW.status
BEGIN
  INSERT INTO order_events(order_id, kind, status) VALUES (NEW.id, 'payment_status', NEW.status);
END;
