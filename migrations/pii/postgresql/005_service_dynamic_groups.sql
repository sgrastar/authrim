-- Service membership computation only; no existing authorization data is rewritten.
CREATE TABLE IF NOT EXISTS service_group_inputs (
 tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, revision BIGINT NOT NULL DEFAULT 1,
 PRIMARY KEY (tenant_id, user_id)
);
CREATE FUNCTION sg_identity_sensitive_values_insert_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, NEW.owner_id, 1 WHERE (NEW.owner_type = 'runtime_user') AND NEW.owner_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
 RETURN NEW; END; $$;
CREATE TRIGGER sg_identity_sensitive_values_insert AFTER INSERT ON identity_sensitive_values FOR EACH ROW EXECUTE FUNCTION sg_identity_sensitive_values_insert_fn();
CREATE FUNCTION sg_identity_sensitive_values_update_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, NEW.owner_id, 1 WHERE (NEW.owner_type = 'runtime_user') AND NEW.owner_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
 RETURN NEW; END; $$;
CREATE TRIGGER sg_identity_sensitive_values_update AFTER UPDATE ON identity_sensitive_values FOR EACH ROW EXECUTE FUNCTION sg_identity_sensitive_values_update_fn();
CREATE FUNCTION sg_identity_sensitive_values_delete_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT OLD.tenant_id, OLD.owner_id, 1 WHERE (OLD.owner_type = 'runtime_user') AND OLD.owner_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
 RETURN OLD; END; $$;
CREATE TRIGGER sg_identity_sensitive_values_delete AFTER DELETE ON identity_sensitive_values FOR EACH ROW EXECUTE FUNCTION sg_identity_sensitive_values_delete_fn();
CREATE TABLE service_group_write_boundaries (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL,
 operation TEXT NOT NULL, status TEXT NOT NULL, created_at BIGINT NOT NULL
);
CREATE INDEX idx_service_group_write_boundaries_subject ON service_group_write_boundaries(tenant_id, user_id);
CREATE FUNCTION sg_write_boundary_insert_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) VALUES (NEW.tenant_id, NEW.user_id, 1) ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
 RETURN NEW; END; $$;
CREATE TRIGGER sg_write_boundary_insert AFTER INSERT ON service_group_write_boundaries FOR EACH ROW EXECUTE FUNCTION sg_write_boundary_insert_fn();
CREATE FUNCTION sg_write_boundary_delete_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) VALUES (OLD.tenant_id, OLD.user_id, 1) ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
 RETURN OLD; END; $$;
CREATE TRIGGER sg_write_boundary_delete AFTER DELETE ON service_group_write_boundaries FOR EACH ROW EXECUTE FUNCTION sg_write_boundary_delete_fn();
