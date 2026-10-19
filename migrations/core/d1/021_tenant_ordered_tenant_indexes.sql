-- Extend single-column tenant indexes with the primary key. Each row still has one entry in the
-- index, so writes cost the same, and a tenant's rows are now ordered by primary key inside it.
-- Tenant backup export pages a tenant in primary key order through these indexes instead of
-- walking every tenant's rows in the table.
DROP INDEX idx_access_reviews_tenant;
CREATE INDEX idx_access_reviews_tenant ON access_reviews(tenant_id, id);
DROP INDEX idx_audit_log_tenant_id;
CREATE INDEX idx_audit_log_tenant_id ON audit_log(tenant_id, id);
DROP INDEX idx_compliance_reports_tenant;
CREATE INDEX idx_compliance_reports_tenant ON compliance_reports(tenant_id, id);
DROP INDEX idx_credential_configurations_tenant;
CREATE INDEX idx_credential_configurations_tenant ON credential_configurations(tenant_id, id);
DROP INDEX idx_organizations_tenant_id;
CREATE INDEX idx_organizations_tenant_id ON organizations(tenant_id, id);
DROP INDEX idx_passkeys_tenant;
CREATE INDEX idx_passkeys_tenant ON passkeys(tenant_id, id);
DROP INDEX idx_presentation_definitions_tenant;
CREATE INDEX idx_presentation_definitions_tenant ON presentation_definitions(tenant_id, id);
DROP INDEX idx_relationships_tenant_id;
CREATE INDEX idx_relationships_tenant_id ON relationships(tenant_id, id);
DROP INDEX idx_roles_tenant_id;
CREATE INDEX idx_roles_tenant_id ON roles(tenant_id, id);
DROP INDEX idx_security_threats_tenant;
CREATE INDEX idx_security_threats_tenant ON security_threats(tenant_id, id);
DROP INDEX idx_status_lists_tenant;
CREATE INDEX idx_status_lists_tenant ON status_lists(tenant_id, internal_id);
DROP INDEX idx_suspicious_activities_tenant;
CREATE INDEX idx_suspicious_activities_tenant ON suspicious_activities(tenant_id, id);
DROP INDEX idx_tcr_tenant;
CREATE INDEX idx_tcr_tenant ON tenant_consent_requirements(tenant_id, id);
DROP INDEX idx_tdm_tenant;
CREATE INDEX idx_tdm_tenant ON tenant_domain_mappings(tenant_id, id);
DROP INDEX idx_tvd_tenant;
CREATE INDEX idx_tvd_tenant ON tenant_vanity_domains(tenant_id, id);
DROP INDEX idx_trusted_issuers_tenant;
CREATE INDEX idx_trusted_issuers_tenant ON trusted_issuers(tenant_id, id);
DROP INDEX idx_upstream_providers_tenant_id;
CREATE INDEX idx_upstream_providers_tenant_id ON upstream_providers(tenant_id, id);
DROP INDEX idx_users_tenant_id;
CREATE INDEX idx_users_tenant_id ON users(tenant_id, id);
DROP INDEX idx_users_core_tenant;
CREATE INDEX idx_users_core_tenant ON users_core(tenant_id, id);
DROP INDEX idx_webhook_configs_tenant;
CREATE INDEX idx_webhook_configs_tenant ON webhook_configs(tenant_id, id);
DROP INDEX idx_webhook_delivery_logs_tenant;
CREATE INDEX idx_webhook_delivery_logs_tenant ON webhook_delivery_logs(tenant_id, id);
