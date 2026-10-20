-- Extend single-column tenant indexes with the primary key. Each row still has one entry in the
-- index, so writes cost the same, and a tenant's rows are now ordered by primary key inside it.
-- Tenant backup export pages a tenant in primary key order through these indexes instead of
-- walking every tenant's rows in the table.
DROP INDEX idx_users_pii_tenant;
CREATE INDEX idx_users_pii_tenant ON users_pii(tenant_id, id);
DROP INDEX idx_tombstone_tenant;
CREATE INDEX idx_tombstone_tenant ON users_pii_tombstone(tenant_id, id);
