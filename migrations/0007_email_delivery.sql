CREATE TABLE email_deliveries (
  purchase_id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK(state IN ('pending','processing','accepted','delivered','failed','blocked')),
  generation INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  first_attempt INTEGER,
  last_attempt INTEGER,
  next_attempt INTEGER NOT NULL DEFAULT 0,
  accepted_at INTEGER,
  provider_id TEXT,
  last_error TEXT
);
CREATE INDEX email_deliveries_due ON email_deliveries(state,next_attempt);
