-- Extend single-column tenant indexes with the primary key. Each row still has one entry in the
-- index, so writes cost the same, and a tenant's rows are now ordered by primary key inside it.
-- Tenant backup export pages a tenant in primary key order through these indexes instead of
-- walking every tenant's rows in the table.
DROP INDEX idx_admin_attr_values_tenant;
CREATE INDEX idx_admin_attr_values_tenant ON admin_attribute_values(tenant_id, id);
DROP INDEX idx_admin_attributes_tenant;
CREATE INDEX idx_admin_attributes_tenant ON admin_attributes(tenant_id, id);
DROP INDEX idx_admin_policies_tenant;
CREATE INDEX idx_admin_policies_tenant ON admin_policies(tenant_id, id);
DROP INDEX idx_admin_rebac_def_tenant;
CREATE INDEX idx_admin_rebac_def_tenant ON admin_rebac_definitions(tenant_id, id);
DROP INDEX idx_admin_rel_tenant;
CREATE INDEX idx_admin_rel_tenant ON admin_relationships(tenant_id, id);
DROP INDEX idx_admin_role_assignments_tenant;
CREATE INDEX idx_admin_role_assignments_tenant ON admin_role_assignments(tenant_id, id);
DROP INDEX idx_admin_roles_tenant;
CREATE INDEX idx_admin_roles_tenant ON admin_roles(tenant_id, id);
