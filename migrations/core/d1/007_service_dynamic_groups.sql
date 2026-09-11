-- Service membership computation only; no existing authorization data is rewritten.
CREATE TABLE IF NOT EXISTS service_group_inputs (
 tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
 PRIMARY KEY (tenant_id, user_id)
);
CREATE TABLE service_group_catalog (
 tenant_id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, plan_json TEXT NOT NULL,
 updated_at INTEGER NOT NULL, write_token TEXT NOT NULL
);
CREATE TABLE service_group_revisions (
 tenant_id TEXT NOT NULL, revision INTEGER NOT NULL, plan_json TEXT NOT NULL,
 actor_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (tenant_id, revision)
);
CREATE TABLE service_group_manual (
 tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, group_id TEXT NOT NULL,
 PRIMARY KEY (tenant_id, user_id, group_id)
);
CREATE TABLE service_group_results (
 tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0,
 rule_version INTEGER NOT NULL DEFAULT 0, core_version INTEGER NOT NULL DEFAULT -1,
 pii_version INTEGER NOT NULL DEFAULT -1, metadata_version INTEGER NOT NULL DEFAULT -1,
 epoch INTEGER NOT NULL DEFAULT -1, result_json TEXT, route_version TEXT NOT NULL DEFAULT '', evaluated_at INTEGER,
 lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
 error_code TEXT, attempts INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY (tenant_id, user_id)
);
CREATE TABLE service_group_audit (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL,
 rule_version INTEGER NOT NULL, generation INTEGER NOT NULL,
 event_type TEXT NOT NULL, detail_json TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX idx_service_group_audit_subject ON service_group_audit(tenant_id, user_id, created_at);
CREATE TABLE service_group_epoch (
 tenant_id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE service_group_scans (
 tenant_id TEXT NOT NULL, binding_ref TEXT NOT NULL, rule_version INTEGER NOT NULL,
 cursor_id TEXT NOT NULL DEFAULT '', processed INTEGER NOT NULL DEFAULT 0,
 failures INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
 lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
 PRIMARY KEY (tenant_id, binding_ref)
);
CREATE TRIGGER sg_identity_accounts_insert AFTER INSERT ON identity_accounts BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, NEW.legacy_user_id, 1 WHERE (NEW.legacy_user_id IS NOT NULL) AND NEW.legacy_user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;
CREATE TRIGGER sg_identity_accounts_update AFTER UPDATE ON identity_accounts BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, NEW.legacy_user_id, 1 WHERE (NEW.legacy_user_id IS NOT NULL) AND NEW.legacy_user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;
CREATE TRIGGER sg_identity_accounts_delete AFTER DELETE ON identity_accounts BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT OLD.tenant_id, OLD.legacy_user_id, 1 WHERE (OLD.legacy_user_id IS NOT NULL) AND OLD.legacy_user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;
CREATE TRIGGER sg_user_custom_fields_insert AFTER INSERT ON user_custom_fields BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, NEW.user_id, 1 WHERE (1=1) AND NEW.user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;
CREATE TRIGGER sg_user_custom_fields_update AFTER UPDATE ON user_custom_fields BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, NEW.user_id, 1 WHERE (1=1) AND NEW.user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;
CREATE TRIGGER sg_user_custom_fields_delete AFTER DELETE ON user_custom_fields BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT OLD.tenant_id, OLD.user_id, 1 WHERE (1=1) AND OLD.user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;
CREATE TRIGGER sg_user_roles_insert AFTER INSERT ON user_roles BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, NEW.user_id, 1 WHERE (1=1) AND NEW.user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;
CREATE TRIGGER sg_user_roles_update AFTER UPDATE ON user_roles BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, NEW.user_id, 1 WHERE (1=1) AND NEW.user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;
CREATE TRIGGER sg_user_roles_delete AFTER DELETE ON user_roles BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT OLD.tenant_id, OLD.user_id, 1 WHERE (1=1) AND OLD.user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;
CREATE TRIGGER sg_service_group_manual_insert AFTER INSERT ON service_group_manual BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, NEW.user_id, 1 WHERE (1=1) AND NEW.user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;
CREATE TRIGGER sg_service_group_manual_update AFTER UPDATE ON service_group_manual BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, NEW.user_id, 1 WHERE (1=1) AND NEW.user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;
CREATE TRIGGER sg_service_group_manual_delete AFTER DELETE ON service_group_manual BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT OLD.tenant_id, OLD.user_id, 1 WHERE (1=1) AND OLD.user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;
CREATE TRIGGER sg_contact_points_insert AFTER INSERT ON contact_points BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, (SELECT legacy_user_id FROM identity_accounts WHERE id = NEW.account_id AND tenant_id = NEW.tenant_id), 1 WHERE (NEW.account_id IS NOT NULL) AND (SELECT legacy_user_id FROM identity_accounts WHERE id = NEW.account_id AND tenant_id = NEW.tenant_id) IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;
CREATE TRIGGER sg_contact_points_update AFTER UPDATE ON contact_points BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, (SELECT legacy_user_id FROM identity_accounts WHERE id = NEW.account_id AND tenant_id = NEW.tenant_id), 1 WHERE (NEW.account_id IS NOT NULL) AND (SELECT legacy_user_id FROM identity_accounts WHERE id = NEW.account_id AND tenant_id = NEW.tenant_id) IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;
CREATE TRIGGER sg_contact_points_delete AFTER DELETE ON contact_points BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT OLD.tenant_id, (SELECT legacy_user_id FROM identity_accounts WHERE id = OLD.account_id AND tenant_id = OLD.tenant_id), 1 WHERE (OLD.account_id IS NOT NULL) AND (SELECT legacy_user_id FROM identity_accounts WHERE id = OLD.account_id AND tenant_id = OLD.tenant_id) IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;
CREATE TRIGGER sg_epoch_custom_claim_schemas_insert AFTER INSERT ON custom_claim_schemas BEGIN
 INSERT INTO service_group_epoch(tenant_id, revision) VALUES (NEW.tenant_id, 1) ON CONFLICT(tenant_id) DO UPDATE SET revision = service_group_epoch.revision + 1;
END;
CREATE TRIGGER sg_epoch_custom_claim_schemas_update AFTER UPDATE ON custom_claim_schemas BEGIN
 INSERT INTO service_group_epoch(tenant_id, revision) VALUES (NEW.tenant_id, 1) ON CONFLICT(tenant_id) DO UPDATE SET revision = service_group_epoch.revision + 1;
END;
CREATE TRIGGER sg_epoch_custom_claim_schemas_delete AFTER DELETE ON custom_claim_schemas BEGIN
 INSERT INTO service_group_epoch(tenant_id, revision) VALUES (OLD.tenant_id, 1) ON CONFLICT(tenant_id) DO UPDATE SET revision = service_group_epoch.revision + 1;
END;
CREATE TRIGGER sg_epoch_roles_insert AFTER INSERT ON roles BEGIN
 INSERT INTO service_group_epoch(tenant_id, revision) VALUES (NEW.tenant_id, 1) ON CONFLICT(tenant_id) DO UPDATE SET revision = service_group_epoch.revision + 1;
END;
CREATE TRIGGER sg_epoch_roles_update AFTER UPDATE ON roles BEGIN
 INSERT INTO service_group_epoch(tenant_id, revision) VALUES (NEW.tenant_id, 1) ON CONFLICT(tenant_id) DO UPDATE SET revision = service_group_epoch.revision + 1;
END;
CREATE TRIGGER sg_epoch_roles_delete AFTER DELETE ON roles BEGIN
 INSERT INTO service_group_epoch(tenant_id, revision) VALUES (OLD.tenant_id, 1) ON CONFLICT(tenant_id) DO UPDATE SET revision = service_group_epoch.revision + 1;
END;
CREATE TABLE service_group_write_boundaries (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL,
 operation TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX idx_service_group_write_boundaries_subject ON service_group_write_boundaries(tenant_id, user_id);
CREATE TRIGGER sg_write_boundary_insert AFTER INSERT ON service_group_write_boundaries BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) VALUES (NEW.tenant_id, NEW.user_id, 1) ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;
CREATE TRIGGER sg_write_boundary_delete AFTER DELETE ON service_group_write_boundaries BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) VALUES (OLD.tenant_id, OLD.user_id, 1) ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;
