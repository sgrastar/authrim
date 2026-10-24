-- Non-PII, cumulative observations of OIDC mapping failures. The tuple hash preserves
-- nullable tier/set identity. This mutable aggregate is not an append-only R2 archive source.
CREATE TABLE identity_mapping_failures (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 64 AND id NOT GLOB '*[^0-9a-f]*'),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  client_id TEXT NOT NULL CHECK (length(client_id) BETWEEN 1 AND 256),
  code TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 100),
  tier TEXT CHECK (tier IN ('client', 'tenant_default', 'platform_default')),
  set_id TEXT CHECK (length(set_id) BETWEEN 1 AND 200),
  first_at INTEGER NOT NULL CHECK (first_at BETWEEN 0 AND 9007199254740991),
  last_at INTEGER NOT NULL CHECK (last_at BETWEEN first_at AND 9007199254740991),
  count INTEGER NOT NULL CHECK (count BETWEEN 1 AND 9007199254740991)
) STRICT;
CREATE INDEX idx_identity_mapping_failures_tenant_time
  ON identity_mapping_failures(tenant_id, last_at DESC, id DESC);
CREATE INDEX idx_identity_mapping_failures_client_time
  ON identity_mapping_failures(tenant_id, client_id, last_at DESC, id DESC);
