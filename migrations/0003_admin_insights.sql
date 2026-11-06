ALTER TABLE orders ADD COLUMN buyer_email TEXT;
ALTER TABLE orders ADD COLUMN category_at_purchase TEXT;
CREATE INDEX orders_admin_buyer ON orders(mode,buyer_email,created_at DESC) WHERE buyer_email IS NOT NULL;
CREATE INDEX events_admin_period ON order_events(kind,recorded_at DESC);
