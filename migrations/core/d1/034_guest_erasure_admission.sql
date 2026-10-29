-- Guest erasure admission. Original audit retention/ACK cleanup is unchanged.
ALTER TABLE guest_deletion_audit_outbox ADD COLUMN execution_progress_json TEXT
  CHECK (execution_progress_json IS NULL OR
    (json_valid(execution_progress_json) AND length(CAST(execution_progress_json AS BLOB))<=16384));

-- Non-PII coordination; PostgreSQL uses the same reconstructible singleton as a lock.
CREATE TABLE guest_core_mutation_epoch (
  id INTEGER PRIMARY KEY CHECK (id=1),
  revision INTEGER NOT NULL CHECK (revision>=0)
);
INSERT INTO guest_core_mutation_epoch(id,revision) VALUES(1,0);

-- Derived, read-only checks are defense in depth, not replacements for receipt decoding.
CREATE VIEW guest_core_erasure_started AS
SELECT g.tenant_id,g.user_id,a.id AS account_id,t.audit_id,t.operation_id,
  CASE WHEN json_valid(t.execution_progress_json) THEN t.execution_progress_json ELSE '{}' END AS progress
FROM guest_account_lifecycle g
JOIN identity_accounts a ON a.tenant_id=g.tenant_id AND a.legacy_user_id=g.user_id
JOIN guest_deletion_audit_outbox t ON t.tenant_id=g.tenant_id AND t.user_id=g.user_id
  AND t.operation_id=g.deletion_operation_id
WHERE g.phase IN ('deleting','deleted') AND t.status IN ('pending','retry')
  AND json_extract(CASE WHEN json_valid(g.deletion_route_json) THEN g.deletion_route_json ELSE '{}' END,'$.schemaVersion')=2
  AND json_extract(CASE WHEN json_valid(g.deletion_route_json) THEN g.deletion_route_json ELSE '{}' END,'$.tenantId')=g.tenant_id
  AND json_extract(CASE WHEN json_valid(g.deletion_route_json) THEN g.deletion_route_json ELSE '{}' END,'$.userId')=g.user_id
  AND json_extract(CASE WHEN json_valid(g.deletion_route_json) THEN g.deletion_route_json ELSE '{}' END,'$.operationId')=g.deletion_operation_id
  AND json_extract(CASE WHEN json_valid(g.deletion_route_json) THEN g.deletion_route_json ELSE '{}' END,'$.accountId')=a.id
  AND json_extract(CASE WHEN json_valid(g.deletion_route_json) THEN g.deletion_route_json ELSE '{}' END,'$.accountRouteGeneration')=a.account_route_generation
  AND json_extract(CASE WHEN json_valid(g.deletion_route_json) THEN g.deletion_route_json ELSE '{}' END,'$.completionAuditId')=t.audit_id
  AND json_extract(CASE WHEN json_valid(g.deletion_route_json) THEN g.deletion_route_json ELSE '{}' END,'$.execution.phase')='erasure_started'
  AND EXISTS (SELECT 1 FROM account_legal_hold_states authority WHERE authority.tenant_id=a.tenant_id
    AND authority.account_id=a.id AND authority.projection_state='inactive' AND authority.active_hold_id IS NULL)
  AND NOT EXISTS (SELECT 1 FROM legal_holds h WHERE h.tenant_id=a.tenant_id
    AND h.subject_type='account' AND h.subject_id=a.id AND h.state='active');

CREATE VIEW guest_core_erasure_permit_rows AS
SELECT started.tenant_id,started.user_id,started.account_id,
  json_extract(started.progress,'$.corePermit.table') AS mutation_table,key.value AS record_id
FROM guest_core_erasure_started started,
  json_each(CASE WHEN json_type(started.progress,'$.corePermit.ids')='array'
    THEN json_extract(started.progress,'$.corePermit.ids') ELSE '[]' END) key
WHERE json_extract(started.progress,'$.schemaVersion')=1
  AND json_type(started.progress,'$.revision')='integer' AND json_extract(started.progress,'$.revision')>0
  AND json_array_length(CASE WHEN json_type(started.progress,'$.corePermit.ids')='array'
    THEN json_extract(started.progress,'$.corePermit.ids') ELSE '[]' END) BETWEEN 1 AND 16
  AND key.type='text' AND length(CAST(key.value AS BLOB)) BETWEEN 1 AND 256
  AND ((json_extract(started.progress,'$.corePermit.table')='passkeys'
        AND json_extract(started.progress,'$.stage')='drain_passkeys')
    OR (json_extract(started.progress,'$.corePermit.table')='guest_devices'
        AND json_extract(started.progress,'$.stage')='drain_guest_devices')
    OR (json_extract(started.progress,'$.corePermit.table')='totp_backup_codes'
        AND json_extract(started.progress,'$.stage')='drain_totp_backup_codes')
    OR (json_extract(started.progress,'$.corePermit.table')='totp_credentials'
        AND json_extract(started.progress,'$.stage')='drain_totp_credentials')
    OR (json_extract(started.progress,'$.corePermit.table')='identity_accounts'
        AND json_extract(started.progress,'$.stage')='final_core'));

CREATE TRIGGER trg_guest_core_passkeys_insert BEFORE INSERT ON passkeys
BEGIN
  -- REPLACE may perform an implicit DELETE without invoking DELETE triggers.
  SELECT RAISE(ABORT,'guest_erasure_mutation_blocked') WHERE (EXISTS (SELECT 1 FROM passkeys existing JOIN guest_account_lifecycle g
    ON g.tenant_id=existing.tenant_id AND g.user_id=existing.user_id
    WHERE (existing.id=NEW.id OR (existing.tenant_id=NEW.tenant_id AND existing.credential_id=NEW.credential_id)) AND g.phase IN ('deleting','deleted')));
  SELECT RAISE(ABORT,'guest_core_admission_unavailable') WHERE (NOT EXISTS (SELECT 1 FROM guest_core_mutation_epoch WHERE id=1));
  SELECT RAISE(ABORT,'guest_erasure_mutation_blocked') WHERE (EXISTS (SELECT 1 FROM guest_account_lifecycle g WHERE g.tenant_id=NEW.tenant_id AND g.user_id=NEW.user_id AND g.phase IN ('deleting','deleted')) AND NOT (0));
END;

CREATE TRIGGER trg_guest_core_passkeys_update BEFORE UPDATE ON passkeys
BEGIN
  SELECT RAISE(ABORT,'guest_core_admission_unavailable') WHERE (NOT EXISTS (SELECT 1 FROM guest_core_mutation_epoch WHERE id=1));
  SELECT RAISE(ABORT,'guest_erasure_mutation_blocked') WHERE ((EXISTS (SELECT 1 FROM guest_account_lifecycle g WHERE g.tenant_id=OLD.tenant_id AND g.user_id=OLD.user_id AND g.phase IN ('deleting','deleted')) OR EXISTS (SELECT 1 FROM guest_account_lifecycle g WHERE g.tenant_id=NEW.tenant_id AND g.user_id=NEW.user_id AND g.phase IN ('deleting','deleted'))) AND NOT (NEW.id IS OLD.id AND NEW.tenant_id IS OLD.tenant_id AND NEW.user_id IS OLD.user_id AND (EXISTS (SELECT 1 FROM guest_core_erasure_permit_rows permit WHERE permit.tenant_id=OLD.tenant_id AND permit.user_id=OLD.user_id AND permit.mutation_table='passkeys' AND permit.record_id=OLD.id))));
END;

CREATE TRIGGER trg_guest_core_passkeys_delete BEFORE DELETE ON passkeys
BEGIN
  SELECT RAISE(ABORT,'guest_core_admission_unavailable') WHERE (NOT EXISTS (SELECT 1 FROM guest_core_mutation_epoch WHERE id=1));
  SELECT RAISE(ABORT,'guest_erasure_mutation_blocked') WHERE (EXISTS (SELECT 1 FROM guest_account_lifecycle g WHERE g.tenant_id=OLD.tenant_id AND g.user_id=OLD.user_id AND g.phase IN ('deleting','deleted')) AND NOT (EXISTS (SELECT 1 FROM guest_core_erasure_permit_rows permit WHERE permit.tenant_id=OLD.tenant_id AND permit.user_id=OLD.user_id AND permit.mutation_table='passkeys' AND permit.record_id=OLD.id)));
END;

CREATE TRIGGER trg_guest_core_totp_credentials_insert BEFORE INSERT ON totp_credentials
BEGIN
  -- REPLACE may perform an implicit DELETE without invoking DELETE triggers.
  SELECT RAISE(ABORT,'guest_erasure_mutation_blocked') WHERE (EXISTS (SELECT 1 FROM totp_credentials existing JOIN guest_account_lifecycle g
    ON g.tenant_id=existing.tenant_id AND g.user_id=existing.user_id
    WHERE (existing.id=NEW.id) AND g.phase IN ('deleting','deleted')));
  SELECT RAISE(ABORT,'guest_core_admission_unavailable') WHERE (NOT EXISTS (SELECT 1 FROM guest_core_mutation_epoch WHERE id=1));
  SELECT RAISE(ABORT,'guest_erasure_mutation_blocked') WHERE (EXISTS (SELECT 1 FROM guest_account_lifecycle g WHERE g.tenant_id=NEW.tenant_id AND g.user_id=NEW.user_id AND g.phase IN ('deleting','deleted')) AND NOT (0));
END;

CREATE TRIGGER trg_guest_core_totp_credentials_update BEFORE UPDATE ON totp_credentials
BEGIN
  SELECT RAISE(ABORT,'guest_core_admission_unavailable') WHERE (NOT EXISTS (SELECT 1 FROM guest_core_mutation_epoch WHERE id=1));
  SELECT RAISE(ABORT,'guest_erasure_mutation_blocked') WHERE ((EXISTS (SELECT 1 FROM guest_account_lifecycle g WHERE g.tenant_id=OLD.tenant_id AND g.user_id=OLD.user_id AND g.phase IN ('deleting','deleted')) OR EXISTS (SELECT 1 FROM guest_account_lifecycle g WHERE g.tenant_id=NEW.tenant_id AND g.user_id=NEW.user_id AND g.phase IN ('deleting','deleted'))) AND NOT (NEW.id IS OLD.id AND NEW.tenant_id IS OLD.tenant_id AND NEW.user_id IS OLD.user_id AND (EXISTS (SELECT 1 FROM guest_core_erasure_permit_rows permit WHERE permit.tenant_id=OLD.tenant_id AND permit.user_id=OLD.user_id AND permit.mutation_table='totp_credentials' AND permit.record_id=OLD.id))));
END;

CREATE TRIGGER trg_guest_core_totp_credentials_delete BEFORE DELETE ON totp_credentials
BEGIN
  SELECT RAISE(ABORT,'guest_core_admission_unavailable') WHERE (NOT EXISTS (SELECT 1 FROM guest_core_mutation_epoch WHERE id=1));
  SELECT RAISE(ABORT,'guest_erasure_mutation_blocked') WHERE (EXISTS (SELECT 1 FROM guest_account_lifecycle g WHERE g.tenant_id=OLD.tenant_id AND g.user_id=OLD.user_id AND g.phase IN ('deleting','deleted')) AND NOT (EXISTS (SELECT 1 FROM guest_core_erasure_permit_rows permit WHERE permit.tenant_id=OLD.tenant_id AND permit.user_id=OLD.user_id AND permit.mutation_table='totp_credentials' AND permit.record_id=OLD.id)));
END;

CREATE TRIGGER trg_guest_core_totp_backup_codes_insert BEFORE INSERT ON totp_backup_codes
BEGIN
  -- REPLACE may perform an implicit DELETE without invoking DELETE triggers.
  SELECT RAISE(ABORT,'guest_erasure_mutation_blocked') WHERE (EXISTS (SELECT 1 FROM totp_backup_codes existing JOIN guest_account_lifecycle g
    ON g.tenant_id=existing.tenant_id AND g.user_id=existing.user_id
    WHERE (existing.id=NEW.id OR (existing.tenant_id=NEW.tenant_id AND existing.user_id=NEW.user_id AND existing.code_hash=NEW.code_hash)) AND g.phase IN ('deleting','deleted')));
  SELECT RAISE(ABORT,'guest_core_admission_unavailable') WHERE (NOT EXISTS (SELECT 1 FROM guest_core_mutation_epoch WHERE id=1));
  SELECT RAISE(ABORT,'guest_erasure_mutation_blocked') WHERE (EXISTS (SELECT 1 FROM guest_account_lifecycle g WHERE g.tenant_id=NEW.tenant_id AND g.user_id=NEW.user_id AND g.phase IN ('deleting','deleted')) AND NOT (0));
END;

CREATE TRIGGER trg_guest_core_totp_backup_codes_update BEFORE UPDATE ON totp_backup_codes
BEGIN
  SELECT RAISE(ABORT,'guest_core_admission_unavailable') WHERE (NOT EXISTS (SELECT 1 FROM guest_core_mutation_epoch WHERE id=1));
  SELECT RAISE(ABORT,'guest_erasure_mutation_blocked') WHERE ((EXISTS (SELECT 1 FROM guest_account_lifecycle g WHERE g.tenant_id=OLD.tenant_id AND g.user_id=OLD.user_id AND g.phase IN ('deleting','deleted')) OR EXISTS (SELECT 1 FROM guest_account_lifecycle g WHERE g.tenant_id=NEW.tenant_id AND g.user_id=NEW.user_id AND g.phase IN ('deleting','deleted'))) AND NOT (NEW.id IS OLD.id AND NEW.tenant_id IS OLD.tenant_id AND NEW.user_id IS OLD.user_id AND (EXISTS (SELECT 1 FROM guest_core_erasure_permit_rows permit WHERE permit.tenant_id=OLD.tenant_id AND permit.user_id=OLD.user_id AND permit.mutation_table='totp_backup_codes' AND permit.record_id=OLD.id))));
END;

CREATE TRIGGER trg_guest_core_totp_backup_codes_delete BEFORE DELETE ON totp_backup_codes
BEGIN
  SELECT RAISE(ABORT,'guest_core_admission_unavailable') WHERE (NOT EXISTS (SELECT 1 FROM guest_core_mutation_epoch WHERE id=1));
  SELECT RAISE(ABORT,'guest_erasure_mutation_blocked') WHERE (EXISTS (SELECT 1 FROM guest_account_lifecycle g WHERE g.tenant_id=OLD.tenant_id AND g.user_id=OLD.user_id AND g.phase IN ('deleting','deleted')) AND NOT (EXISTS (SELECT 1 FROM guest_core_erasure_permit_rows permit WHERE permit.tenant_id=OLD.tenant_id AND permit.user_id=OLD.user_id AND permit.mutation_table='totp_backup_codes' AND permit.record_id=OLD.id)));
END;

CREATE TRIGGER trg_guest_core_guest_devices_insert BEFORE INSERT ON guest_devices
BEGIN
  -- REPLACE may perform an implicit DELETE without invoking DELETE triggers.
  SELECT RAISE(ABORT,'guest_erasure_mutation_blocked') WHERE (EXISTS (SELECT 1 FROM guest_devices existing JOIN guest_account_lifecycle g
    ON g.tenant_id=existing.tenant_id AND g.user_id=existing.user_id
    WHERE (existing.id=NEW.id OR (existing.tenant_id=NEW.tenant_id AND existing.resume_credential_hash=NEW.resume_credential_hash)) AND g.phase IN ('deleting','deleted')));
  SELECT RAISE(ABORT,'guest_core_admission_unavailable') WHERE (NOT EXISTS (SELECT 1 FROM guest_core_mutation_epoch WHERE id=1));
  SELECT RAISE(ABORT,'guest_erasure_mutation_blocked') WHERE (EXISTS (SELECT 1 FROM guest_account_lifecycle g WHERE g.tenant_id=NEW.tenant_id AND g.user_id=NEW.user_id AND g.phase IN ('deleting','deleted')) AND NOT (0));
END;

CREATE TRIGGER trg_guest_core_guest_devices_update BEFORE UPDATE ON guest_devices
BEGIN
  SELECT RAISE(ABORT,'guest_core_admission_unavailable') WHERE (NOT EXISTS (SELECT 1 FROM guest_core_mutation_epoch WHERE id=1));
  SELECT RAISE(ABORT,'guest_erasure_mutation_blocked') WHERE ((EXISTS (SELECT 1 FROM guest_account_lifecycle g WHERE g.tenant_id=OLD.tenant_id AND g.user_id=OLD.user_id AND g.phase IN ('deleting','deleted')) OR EXISTS (SELECT 1 FROM guest_account_lifecycle g WHERE g.tenant_id=NEW.tenant_id AND g.user_id=NEW.user_id AND g.phase IN ('deleting','deleted'))) AND NOT (NEW.id IS OLD.id AND NEW.tenant_id IS OLD.tenant_id AND NEW.user_id IS OLD.user_id AND (EXISTS (SELECT 1 FROM guest_core_erasure_permit_rows permit WHERE permit.tenant_id=OLD.tenant_id AND permit.user_id=OLD.user_id AND permit.mutation_table='guest_devices' AND permit.record_id=OLD.id))));
END;

CREATE TRIGGER trg_guest_core_guest_devices_delete BEFORE DELETE ON guest_devices
BEGIN
  SELECT RAISE(ABORT,'guest_core_admission_unavailable') WHERE (NOT EXISTS (SELECT 1 FROM guest_core_mutation_epoch WHERE id=1));
  SELECT RAISE(ABORT,'guest_erasure_mutation_blocked') WHERE (EXISTS (SELECT 1 FROM guest_account_lifecycle g WHERE g.tenant_id=OLD.tenant_id AND g.user_id=OLD.user_id AND g.phase IN ('deleting','deleted')) AND NOT (EXISTS (SELECT 1 FROM guest_core_erasure_permit_rows permit WHERE permit.tenant_id=OLD.tenant_id AND permit.user_id=OLD.user_id AND permit.mutation_table='guest_devices' AND permit.record_id=OLD.id)));
END;

CREATE TRIGGER trg_guest_core_identity_accounts_insert BEFORE INSERT ON identity_accounts
BEGIN
  -- REPLACE may perform an implicit DELETE without invoking DELETE triggers.
  SELECT RAISE(ABORT,'guest_erasure_mutation_blocked') WHERE (EXISTS (SELECT 1 FROM identity_accounts existing JOIN guest_account_lifecycle g
    ON g.tenant_id=existing.tenant_id AND g.user_id=existing.legacy_user_id
    WHERE (existing.id=NEW.id) AND g.phase IN ('deleting','deleted')));
  SELECT RAISE(ABORT,'guest_core_admission_unavailable') WHERE (NOT EXISTS (SELECT 1 FROM guest_core_mutation_epoch WHERE id=1));
  SELECT RAISE(ABORT,'guest_erasure_mutation_blocked') WHERE (EXISTS (SELECT 1 FROM guest_account_lifecycle g WHERE g.tenant_id=NEW.tenant_id AND g.user_id=NEW.legacy_user_id AND g.phase IN ('deleting','deleted')) AND NOT (0));
END;

CREATE TRIGGER trg_guest_core_identity_accounts_update BEFORE UPDATE ON identity_accounts
BEGIN
  SELECT RAISE(ABORT,'guest_core_admission_unavailable') WHERE (NOT EXISTS (SELECT 1 FROM guest_core_mutation_epoch WHERE id=1));
  SELECT RAISE(ABORT,'guest_erasure_mutation_blocked') WHERE ((EXISTS (SELECT 1 FROM guest_account_lifecycle g WHERE g.tenant_id=OLD.tenant_id AND g.user_id=OLD.legacy_user_id AND g.phase IN ('deleting','deleted')) OR EXISTS (SELECT 1 FROM guest_account_lifecycle g WHERE g.tenant_id=NEW.tenant_id AND g.user_id=NEW.legacy_user_id AND g.phase IN ('deleting','deleted'))) AND NOT (((NEW.id IS OLD.id AND NEW.tenant_id IS OLD.tenant_id AND NEW.legacy_user_id IS OLD.legacy_user_id AND NEW.account_type IS OLD.account_type AND NEW.registration_state IS OLD.registration_state AND NEW.account_route_generation IS OLD.account_route_generation AND NEW.primary_subject_id IS OLD.primary_subject_id AND NEW.created_at IS OLD.created_at AND (EXISTS (SELECT 1 FROM guest_core_erasure_permit_rows permit WHERE permit.tenant_id=OLD.tenant_id AND permit.user_id=OLD.legacy_user_id AND permit.mutation_table='identity_accounts' AND permit.record_id=OLD.id)) AND NEW.lifecycle_state IN ('deleting','deleted') AND (NEW.display_label IS NULL OR NEW.display_label IS OLD.display_label) AND (NEW.metadata_json IS NULL OR NEW.metadata_json IS OLD.metadata_json)) OR (NEW.id IS OLD.id AND NEW.tenant_id IS OLD.tenant_id AND NEW.legacy_user_id IS OLD.legacy_user_id AND NEW.account_type IS OLD.account_type AND NEW.registration_state IS OLD.registration_state AND NEW.account_route_generation IS OLD.account_route_generation AND NEW.primary_subject_id IS OLD.primary_subject_id AND NEW.created_at IS OLD.created_at AND NEW.display_label IS OLD.display_label AND NEW.metadata_json IS OLD.metadata_json AND NEW.lifecycle_state='deleting' AND OLD.lifecycle_state<>'deleted' AND (NEW.directory_publication_state IS OLD.directory_publication_state OR NEW.directory_publication_state='disabled') AND (OLD.deleted_at IS NULL OR NEW.deleted_at IS OLD.deleted_at) AND NEW.updated_at>=OLD.updated_at AND EXISTS (SELECT 1 FROM guest_core_erasure_started started WHERE started.tenant_id=OLD.tenant_id AND started.user_id=OLD.legacy_user_id AND started.account_id=OLD.id)))));
END;

CREATE TRIGGER trg_guest_core_identity_accounts_delete BEFORE DELETE ON identity_accounts
BEGIN
  SELECT RAISE(ABORT,'guest_core_admission_unavailable') WHERE (NOT EXISTS (SELECT 1 FROM guest_core_mutation_epoch WHERE id=1));
  SELECT RAISE(ABORT,'guest_erasure_mutation_blocked') WHERE (EXISTS (SELECT 1 FROM guest_account_lifecycle g WHERE g.tenant_id=OLD.tenant_id AND g.user_id=OLD.legacy_user_id AND g.phase IN ('deleting','deleted')) AND NOT (EXISTS (SELECT 1 FROM guest_core_erasure_permit_rows permit WHERE permit.tenant_id=OLD.tenant_id AND permit.user_id=OLD.legacy_user_id AND permit.mutation_table='identity_accounts' AND permit.record_id=OLD.id)));
END;

CREATE TRIGGER trg_guest_core_hold_insert BEFORE INSERT ON legal_holds
WHEN NEW.subject_type='account' AND NEW.state='active'
BEGIN
  SELECT RAISE(ABORT,'guest_erasure_hold_admission_blocked') WHERE (EXISTS (
    SELECT 1 FROM identity_accounts a JOIN guest_account_lifecycle g
      ON g.tenant_id=a.tenant_id AND g.user_id=a.legacy_user_id
    WHERE a.tenant_id=NEW.tenant_id AND a.id=NEW.subject_id
      AND (g.phase='deleted' OR (g.phase='deleting' AND NOT (
        json_extract(CASE WHEN json_valid(g.deletion_route_json) THEN g.deletion_route_json ELSE '{}' END,'$.schemaVersion') IS 2
        AND json_extract(CASE WHEN json_valid(g.deletion_route_json) THEN g.deletion_route_json ELSE '{}' END,'$.operationId') IS g.deletion_operation_id
        AND json_extract(CASE WHEN json_valid(g.deletion_route_json) THEN g.deletion_route_json ELSE '{}' END,'$.accountId') IS a.id
        AND json_extract(CASE WHEN json_valid(g.deletion_route_json) THEN g.deletion_route_json ELSE '{}' END,'$.execution.phase') IS 'accepted')))));
END;

CREATE TRIGGER trg_guest_core_boundary_hold_insert BEFORE INSERT ON guest_account_lifecycle
WHEN NEW.phase IN ('deleting','deleted')
  AND json_extract(CASE WHEN json_valid(NEW.deletion_route_json) THEN NEW.deletion_route_json ELSE '{}' END,'$.execution.phase')='erasure_started'
BEGIN
  SELECT RAISE(ABORT,'guest_core_admission_unavailable') WHERE (NOT EXISTS (SELECT 1 FROM guest_core_mutation_epoch WHERE id=1));
  SELECT RAISE(ABORT,'guest_erasure_legal_hold_active') WHERE (EXISTS (SELECT 1 FROM legal_holds h JOIN identity_accounts a
    ON a.tenant_id=h.tenant_id AND a.id=h.subject_id
    WHERE a.tenant_id=NEW.tenant_id AND a.legacy_user_id=NEW.user_id
      AND h.subject_type='account' AND h.state='active'));
END;

CREATE TRIGGER trg_guest_core_boundary_hold_update BEFORE UPDATE ON guest_account_lifecycle
WHEN NEW.phase IN ('deleting','deleted')
  AND json_extract(CASE WHEN json_valid(NEW.deletion_route_json) THEN NEW.deletion_route_json ELSE '{}' END,'$.execution.phase')='erasure_started'
BEGIN
  SELECT RAISE(ABORT,'guest_core_admission_unavailable') WHERE (NOT EXISTS (SELECT 1 FROM guest_core_mutation_epoch WHERE id=1));
  SELECT RAISE(ABORT,'guest_erasure_legal_hold_active') WHERE (EXISTS (SELECT 1 FROM legal_holds h JOIN identity_accounts a
    ON a.tenant_id=h.tenant_id AND a.id=h.subject_id
    WHERE a.tenant_id=NEW.tenant_id AND a.legacy_user_id=NEW.user_id
      AND h.subject_type='account' AND h.state='active'));
END;

-- REPLACE may silently delete its conflicting row when recursive_triggers is off.
CREATE TRIGGER trg_guest_core_lifecycle_insert BEFORE INSERT ON guest_account_lifecycle
WHEN EXISTS (SELECT 1 FROM guest_account_lifecycle g
  WHERE g.tenant_id=NEW.tenant_id AND g.user_id=NEW.user_id
    AND g.phase IN ('deleting','deleted'))
BEGIN SELECT RAISE(ABORT,'guest_erasure_lifecycle_immutable'); END;
CREATE TRIGGER trg_guest_core_lifecycle_delete BEFORE DELETE ON guest_account_lifecycle
WHEN OLD.phase IN ('deleting','deleted')
BEGIN SELECT RAISE(ABORT,'guest_erasure_lifecycle_immutable'); END;
CREATE TRIGGER trg_guest_core_lifecycle_monotone BEFORE UPDATE ON guest_account_lifecycle
WHEN (OLD.phase='deleted' AND NEW.phase<>'deleted')
  OR (OLD.phase='deleting' AND NEW.phase NOT IN ('deleting','deleted'))
  OR (OLD.phase IN ('deleting','deleted') AND (
    NEW.tenant_id IS NOT OLD.tenant_id OR NEW.user_id IS NOT OLD.user_id
    OR NEW.deletion_operation_id IS NOT OLD.deletion_operation_id
    OR NEW.deletion_started_at_ms IS NOT OLD.deletion_started_at_ms))
BEGIN SELECT RAISE(ABORT,'guest_erasure_lifecycle_immutable'); END;
CREATE TRIGGER trg_guest_core_lifecycle_receipt BEFORE UPDATE OF deletion_route_json ON guest_account_lifecycle
WHEN OLD.phase IN ('deleting','deleted') AND NEW.deletion_route_json IS NOT OLD.deletion_route_json
BEGIN
  SELECT RAISE(ABORT,'guest_erasure_lifecycle_immutable') WHERE (NOT (
    OLD.phase='deleting' AND NEW.phase='deleting'
    AND json_extract(CASE WHEN json_valid(OLD.deletion_route_json) THEN OLD.deletion_route_json ELSE '{}' END,'$.execution.phase') IS 'accepted'
    AND json_extract(CASE WHEN json_valid(NEW.deletion_route_json) THEN NEW.deletion_route_json ELSE '{}' END,'$.execution.phase') IS 'erasure_started'
    AND json_remove(CASE WHEN json_valid(OLD.deletion_route_json) THEN OLD.deletion_route_json ELSE '{}' END,'$.execution')
      IS json_remove(CASE WHEN json_valid(NEW.deletion_route_json) THEN NEW.deletion_route_json ELSE '{}' END,'$.execution')
  ));
END;
CREATE TRIGGER trg_guest_core_lifecycle_epoch AFTER UPDATE OF phase,deletion_route_json ON guest_account_lifecycle
BEGIN UPDATE guest_core_mutation_epoch SET revision=revision+1 WHERE id=1; END;

-- Current-source DR witnesses invalidate when owner or hold authority changes.
CREATE TRIGGER trg_guest_core_owner_insert_epoch AFTER INSERT ON identity_accounts
BEGIN UPDATE guest_core_mutation_epoch SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER trg_guest_core_owner_update_epoch AFTER UPDATE ON identity_accounts
BEGIN UPDATE guest_core_mutation_epoch SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER trg_guest_core_owner_delete_epoch AFTER DELETE ON identity_accounts
BEGIN UPDATE guest_core_mutation_epoch SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER trg_guest_core_hold_insert_epoch AFTER INSERT ON legal_holds
BEGIN UPDATE guest_core_mutation_epoch SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER trg_guest_core_hold_update_epoch AFTER UPDATE ON legal_holds
BEGIN UPDATE guest_core_mutation_epoch SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER trg_guest_core_hold_delete_epoch AFTER DELETE ON legal_holds
BEGIN UPDATE guest_core_mutation_epoch SET revision=revision+1 WHERE id=1; END;

CREATE INDEX idx_guest_erasure_passkeys_page ON passkeys(tenant_id,user_id,id);

CREATE INDEX idx_guest_erasure_guest_devices_page ON guest_devices(tenant_id,user_id,id);

CREATE INDEX idx_guest_erasure_totp_credentials_page ON totp_credentials(tenant_id,user_id,id);

CREATE INDEX idx_guest_erasure_totp_backup_codes_page ON totp_backup_codes(tenant_id,user_id,id);

CREATE INDEX idx_guest_erasure_directory_page ON account_routing_outbox(tenant_id,account_id,event_kind,outbox_id);

-- DR current-owner proofs must observe changes to their subject/profile parents.
CREATE TRIGGER trg_guest_core_subject_insert_epoch AFTER INSERT ON identity_subjects
BEGIN
  SELECT RAISE(ABORT,'guest_core_admission_unavailable') WHERE (NOT EXISTS (SELECT 1 FROM guest_core_mutation_epoch WHERE id=1));
  UPDATE guest_core_mutation_epoch SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER trg_guest_core_subject_update_epoch AFTER UPDATE ON identity_subjects
WHEN NEW.id IS NOT OLD.id OR NEW.tenant_id IS NOT OLD.tenant_id OR NEW.subject_type IS NOT OLD.subject_type OR NEW.lifecycle_state IS NOT OLD.lifecycle_state OR NEW.primary_account_id IS NOT OLD.primary_account_id OR NEW.deleted_at IS NOT OLD.deleted_at
BEGIN
  SELECT RAISE(ABORT,'guest_core_admission_unavailable') WHERE (NOT EXISTS (SELECT 1 FROM guest_core_mutation_epoch WHERE id=1));
  UPDATE guest_core_mutation_epoch SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER trg_guest_core_subject_delete_epoch AFTER DELETE ON identity_subjects
BEGIN
  SELECT RAISE(ABORT,'guest_core_admission_unavailable') WHERE (NOT EXISTS (SELECT 1 FROM guest_core_mutation_epoch WHERE id=1));
  UPDATE guest_core_mutation_epoch SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER trg_guest_core_profile_insert_epoch AFTER INSERT ON profiles
BEGIN
  SELECT RAISE(ABORT,'guest_core_admission_unavailable') WHERE (NOT EXISTS (SELECT 1 FROM guest_core_mutation_epoch WHERE id=1));
  UPDATE guest_core_mutation_epoch SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER trg_guest_core_profile_update_epoch AFTER UPDATE ON profiles
WHEN NEW.id IS NOT OLD.id OR NEW.tenant_id IS NOT OLD.tenant_id OR NEW.subject_id IS NOT OLD.subject_id OR NEW.profile_type IS NOT OLD.profile_type OR NEW.lifecycle_state IS NOT OLD.lifecycle_state OR NEW.deleted_at IS NOT OLD.deleted_at
BEGIN
  SELECT RAISE(ABORT,'guest_core_admission_unavailable') WHERE (NOT EXISTS (SELECT 1 FROM guest_core_mutation_epoch WHERE id=1));
  UPDATE guest_core_mutation_epoch SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER trg_guest_core_profile_delete_epoch AFTER DELETE ON profiles
BEGIN
  SELECT RAISE(ABORT,'guest_core_admission_unavailable') WHERE (NOT EXISTS (SELECT 1 FROM guest_core_mutation_epoch WHERE id=1));
  UPDATE guest_core_mutation_epoch SET revision=revision+1 WHERE id=1;
END;
