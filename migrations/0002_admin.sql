CREATE TABLE products (
  sku TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents BETWEEN 0 AND 99999999),
  version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','coming_soon','published','archived')),
  details TEXT NOT NULL CHECK (json_valid(details)),
  updated_at TEXT NOT NULL DEFAULT (date('now')),
  revision INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX products_public ON products(status, name);
CREATE TABLE product_slugs (
  slug TEXT PRIMARY KEY,
  sku TEXT NOT NULL REFERENCES products(sku)
);
CREATE TRIGGER reserve_product_slug AFTER INSERT ON products
BEGIN
  INSERT INTO product_slugs(slug, sku) VALUES(NEW.slug, NEW.sku);
END;
CREATE TRIGGER reserve_renamed_slug AFTER UPDATE OF slug ON products
WHEN OLD.slug <> NEW.slug
BEGIN
  INSERT INTO product_slugs(slug, sku) SELECT NEW.slug, NEW.sku
  WHERE NOT EXISTS(SELECT 1 FROM product_slugs WHERE slug=NEW.slug AND sku=NEW.sku);
END;

CREATE TABLE catalog_revision (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
INSERT INTO catalog_revision VALUES (1, 1);
CREATE TRIGGER catalog_created AFTER INSERT ON products BEGIN
  UPDATE catalog_revision SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER catalog_changed AFTER UPDATE ON products BEGIN
  UPDATE catalog_revision SET revision=revision+1 WHERE id=1;
END;

CREATE TABLE product_images (
  id TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  bytes BLOB NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE admin_events (
  id INTEGER PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE admin_rate (
  bucket INTEGER PRIMARY KEY,
  hits INTEGER NOT NULL
);
CREATE TRIGGER prune_admin_rate AFTER INSERT ON admin_rate BEGIN
  DELETE FROM admin_rate WHERE bucket<NEW.bucket-15;
END;
CREATE TABLE store_settings (
  id INTEGER PRIMARY KEY CHECK(id=1),
  announcement TEXT NOT NULL DEFAULT '',
  support_url TEXT NOT NULL DEFAULT '',
  period INTEGER NOT NULL DEFAULT 30 CHECK(period IN (7, 30, 90))
);
INSERT INTO store_settings(id) VALUES (1);
CREATE TRIGGER catalog_settings AFTER UPDATE ON store_settings BEGIN
  UPDATE catalog_revision SET revision=revision+1 WHERE id=1;
END;
CREATE INDEX orders_admin_date ON orders(mode, created_at DESC);
