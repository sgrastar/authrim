-- When each settings document was last compared with its Workers KV projection. The scheduled
-- retry takes the least recently reconciled documents first, so every document gets its turn
-- whatever is added, removed or failing meanwhile. Existing documents start at 0 (compared first);
-- new ones start at their creation time and queue behind older ones.
ALTER TABLE tenant_settings_documents
  ADD COLUMN reconciled_at INTEGER NOT NULL DEFAULT 0 CHECK(reconciled_at>=0);

CREATE INDEX idx_tenant_settings_documents_reconciled
  ON tenant_settings_documents(reconciled_at,tenant_id,scope_type,scope_id,category);
