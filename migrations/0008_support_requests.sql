CREATE TABLE support_requests (
  fingerprint TEXT PRIMARY KEY,
  ip_key TEXT NOT NULL,
  email_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  retry_at INTEGER NOT NULL,
  accepted INTEGER NOT NULL DEFAULT 0 CHECK (accepted IN (0, 1))
);
CREATE INDEX support_requests_age ON support_requests(created_at);
