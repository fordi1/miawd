-- Panel login sessions (Admin Panel and Business Panel). The cookie holds a random token; only its SHA-256 is stored.
CREATE TABLE sessions (
  token_hash  text PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('admin', 'business')),
  admin_id    uuid REFERENCES admins(id) ON DELETE CASCADE,
  business_id uuid REFERENCES businesses(id) ON DELETE CASCADE,
  -- true when the platform admin opened a business's panel: its changes are recorded as made by "admin"
  by_admin    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  CHECK ((kind = 'admin' AND admin_id IS NOT NULL) OR (kind = 'business' AND business_id IS NOT NULL))
);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);
CREATE INDEX sessions_business_idx ON sessions (business_id) WHERE business_id IS NOT NULL;
