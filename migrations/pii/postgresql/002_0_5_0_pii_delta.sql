-- Authrim 0.5.0 release migration bundle.
-- Generated from unpublished migrations; do not edit after release.

-- =============================================================================
-- Consolidated from 002_guest_upgrade_operations.sql
-- =============================================================================
-- Verified guest upgrade operations survive request failure and worker restarts.
-- Sensitive enrollment proof is stored in the account's PII database and erased on completion.
CREATE TABLE guest_upgrade_operations (
  operation_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  initiating_session_id TEXT NOT NULL,
  request_token_hash TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('email', 'passkey')),
  state TEXT NOT NULL DEFAULT 'awaiting_proof'
    CHECK (state IN ('awaiting_proof', 'verified', 'committing', 'completed', 'canceled')),
  proof_payload_json TEXT,
  challenge_verifier TEXT,
  reservation_publication_json TEXT,
  attempt_count BIGINT NOT NULL DEFAULT 0,
  expires_at BIGINT NOT NULL,
  lease_owner TEXT,
  lease_expires_at BIGINT,
  completed_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  CHECK (attempt_count >= 0 AND attempt_count <= 5),
  CHECK (expires_at > created_at)
);
CREATE INDEX idx_guest_upgrade_operations_account
  ON guest_upgrade_operations (tenant_id, user_id, created_at);
CREATE INDEX idx_guest_upgrade_operations_recovery
  ON guest_upgrade_operations (tenant_id, state, lease_expires_at, updated_at);

-- =============================================================================
-- Consolidated from 003_account_webhook_outbox.sql
-- =============================================================================
-- Commit PII custom-profile changes and their notification in the same database transaction.
-- Transactional, non-PII account notification outbox. No account FK: deletion must preserve delivery.
CREATE TABLE account_webhook_outbox (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  registration_state TEXT NOT NULL CHECK (registration_state IN ('guest', 'registered')),
  previous_registration_state TEXT,
  changed_field TEXT,
  occurred_at BIGINT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at BIGINT NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until BIGINT NOT NULL DEFAULT 0,
  delivered_at BIGINT
);
CREATE INDEX idx_account_webhook_outbox_due ON account_webhook_outbox
  (tenant_id, delivered_at, next_attempt_at, lease_until);

-- =============================================================================
-- Consolidated from 004_account_webhook_snapshots.sql
-- =============================================================================
-- Event-time email data stays in the PII stream and survives account cleanup for bounded delivery.
CREATE TABLE account_webhook_snapshots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  registration_state TEXT NOT NULL CHECK (registration_state IN ('guest', 'registered')),
  email_before_json TEXT,
  email_after_json TEXT,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX idx_account_webhook_snapshot_expiry ON account_webhook_snapshots (tenant_id, expires_at);
CREATE TABLE account_webhook_delivery_fields (
  tenant_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  webhook_id TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  destination_url TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, event_id, webhook_id)
);

-- =============================================================================
-- Consolidated from 005_service_dynamic_groups.sql
-- =============================================================================
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

-- =============================================================================
-- Consolidated from 006_pii_log_purge_operations.sql
-- =============================================================================
-- Pending PII audit erasure keeps the old anonymous subject while the live mapping rotates.
-- Delete the operation, including its real-user association, only after physical erasure completes.
CREATE TABLE pii_log_purge_operations (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  old_anonymized_user_id TEXT NOT NULL,
  new_anonymized_user_id TEXT,
  created_at BIGINT NOT NULL,
  UNIQUE (tenant_id, user_id)
);
CREATE INDEX idx_pii_log_purge_operations_tenant_created
  ON pii_log_purge_operations (tenant_id, created_at, id);

-- =============================================================================
-- Consolidated from 007_guest_pii_erasure_markers.sql
-- =============================================================================
-- Guest raw/auth source freeze. Existing tombstone, audit-pseudonym and historical delivery TTLs are unchanged.
CREATE TABLE guest_pii_mutation_epoch (
  id INTEGER PRIMARY KEY CHECK(id=1),
  revision BIGINT NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991)
);
INSERT INTO guest_pii_mutation_epoch(id,revision) VALUES(1,0);
CREATE TABLE guest_pii_erasure_markers (
  schema_version INTEGER NOT NULL CHECK(schema_version=1),
  tenant_id TEXT NOT NULL CHECK(length(tenant_id) BETWEEN 1 AND 256),
  user_id TEXT NOT NULL CHECK(length(user_id) BETWEEN 1 AND 256),
  account_id TEXT NOT NULL CHECK(length(account_id) BETWEEN 1 AND 512),
  account_route_generation BIGINT NOT NULL CHECK(account_route_generation BETWEEN 1 AND 9007199254740991),
  state TEXT NOT NULL CHECK(state IN ('erasing','deleted')),
  revision BIGINT NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
  operation_id TEXT,
  boundary_id TEXT,
  source_started_at_ms BIGINT,
  permit_table TEXT,
  permit_keys_json TEXT,
  PRIMARY KEY(tenant_id,user_id),
  UNIQUE(tenant_id,account_id),
  CHECK((state='deleted' AND operation_id IS NULL AND boundary_id IS NULL AND source_started_at_ms IS NULL
      AND permit_table IS NULL AND permit_keys_json IS NULL)
    OR (state='erasing' AND operation_id IS NOT NULL AND boundary_id IS NOT NULL AND source_started_at_ms IS NOT NULL
      AND length(operation_id) BETWEEN 1 AND 256 AND length(boundary_id)=78
      AND source_started_at_ms BETWEEN 1 AND 9007199254740991
      AND ((permit_table IS NULL AND permit_keys_json IS NULL)
        OR (permit_table IS NOT NULL AND permit_keys_json IS NOT NULL AND permit_table IN ('users_pii','identity_sensitive_values','linked_identities','subject_identifiers','pairwise_subject_identifiers','guest_upgrade_operations','identity_identifier_replacement_challenges','identity_identifier_replacement_operations','identity_identifier_replacement_history','identity_identifier_replacement_outbox','external_identifier_unlink_operations','user_anonymization_map') AND length(permit_keys_json)<=8192 AND jsonb_typeof(permit_keys_json::jsonb)='array' AND jsonb_array_length(permit_keys_json::jsonb) BETWEEN 1 AND 16))))
);
CREATE FUNCTION authrim_guest_pii_epoch_guard() RETURNS TRIGGER LANGUAGE plpgsql VOLATILE SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP<>'UPDATE' OR NEW.id IS DISTINCT FROM OLD.id OR NEW.revision IS DISTINCT FROM OLD.revision+1 THEN
  RAISE EXCEPTION 'guest_pii_admission_immutable'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER trg_guest_pii_epoch_immutable BEFORE UPDATE OR DELETE ON guest_pii_mutation_epoch
 FOR EACH ROW EXECUTE FUNCTION authrim_guest_pii_epoch_guard();
CREATE FUNCTION authrim_guest_pii_epoch_insert_guard() RETURNS TRIGGER LANGUAGE plpgsql VOLATILE SET search_path=public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM guest_pii_mutation_epoch) THEN RAISE EXCEPTION 'guest_pii_admission_immutable'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER trg_guest_pii_epoch_no_replace BEFORE INSERT ON guest_pii_mutation_epoch
 FOR EACH ROW EXECUTE FUNCTION authrim_guest_pii_epoch_insert_guard();
CREATE FUNCTION authrim_guest_pii_marker_guard() RETURNS TRIGGER LANGUAGE plpgsql VOLATILE SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'guest_pii_marker_immutable'; END IF;
 -- A write, not only a lock, makes an earlier repeatable-read snapshot fail to serialize.
 UPDATE guest_pii_mutation_epoch SET revision=revision+1 WHERE id=1;
 IF NOT FOUND THEN RAISE EXCEPTION 'guest_pii_admission_unavailable'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.permit_table IS NOT NULL OR NEW.permit_keys_json IS NOT NULL OR (NEW.state='erasing' AND NEW.revision<>1) THEN RAISE EXCEPTION 'guest_pii_marker_initial_invalid'; END IF;
  IF EXISTS(SELECT 1 FROM guest_pii_erasure_markers WHERE tenant_id=NEW.tenant_id AND (user_id=NEW.user_id OR account_id=NEW.account_id)) THEN RAISE EXCEPTION 'guest_pii_marker_identity_conflict'; END IF;
 ELSE
  IF NEW.schema_version IS DISTINCT FROM OLD.schema_version OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.account_route_generation IS DISTINCT FROM OLD.account_route_generation OR NOT (OLD.state='erasing' AND (
  (NEW.state='deleted' AND OLD.permit_table IS NULL AND OLD.permit_keys_json IS NULL AND NEW.revision=OLD.revision+1)
  OR (NEW.state='erasing' AND NEW.operation_id IS NOT DISTINCT FROM OLD.operation_id AND NEW.boundary_id IS NOT DISTINCT FROM OLD.boundary_id
    AND NEW.source_started_at_ms IS NOT DISTINCT FROM OLD.source_started_at_ms AND (
      (OLD.permit_table IS NULL AND OLD.permit_keys_json IS NULL AND NEW.permit_table IS NOT NULL AND NEW.permit_keys_json IS NOT NULL AND NEW.revision=OLD.revision)
      OR (OLD.permit_table IS NOT NULL AND OLD.permit_keys_json IS NOT NULL AND NEW.permit_table IS NULL AND NEW.permit_keys_json IS NULL AND NEW.revision=OLD.revision+1)
    )))
) THEN RAISE EXCEPTION 'guest_pii_marker_immutable'; END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER trg_guest_pii_marker_guard BEFORE INSERT OR UPDATE OR DELETE ON guest_pii_erasure_markers
 FOR EACH ROW EXECUTE FUNCTION authrim_guest_pii_marker_guard();
CREATE FUNCTION authrim_guest_pii_source_guard() RETURNS TRIGGER LANGUAGE plpgsql VOLATILE SET search_path=public,pg_temp AS $$
DECLARE
 old_row JSONB;
 new_row JSONB;
 current_row JSONB;
 owner_tenant TEXT;
 owner_user TEXT;
 owner_account TEXT;
 owner_column TEXT;
 pk_column TEXT;
 marker guest_pii_erasure_markers%ROWTYPE;
 permitted BOOLEAN;
 stable BOOLEAN;
BEGIN
 PERFORM revision FROM guest_pii_mutation_epoch WHERE id=1 FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'guest_pii_admission_unavailable'; END IF;
 IF TG_OP<>'INSERT' THEN old_row:=to_jsonb(OLD); END IF;
 IF TG_OP<>'DELETE' THEN new_row:=to_jsonb(NEW); END IF;
 CASE TG_TABLE_NAME
 WHEN 'users_pii' THEN pk_column:='id'; owner_column:='id';
 WHEN 'identity_sensitive_values' THEN pk_column:='id'; owner_column:='owner_id';
 WHEN 'linked_identities' THEN pk_column:='id'; owner_column:='user_id';
 WHEN 'subject_identifiers' THEN pk_column:='id'; owner_column:='subject_id';
 WHEN 'pairwise_subject_identifiers' THEN pk_column:='id'; owner_column:='user_id';
 WHEN 'guest_upgrade_operations' THEN pk_column:='operation_id'; owner_column:='user_id';
 ELSE RAISE EXCEPTION 'guest_pii_source_table_invalid'; END CASE;
 FOREACH current_row IN ARRAY ARRAY[old_row,new_row] LOOP
  IF current_row IS NULL THEN CONTINUE; END IF;
  IF TG_TABLE_NAME='identity_sensitive_values' AND current_row->>'owner_type'<>'runtime_user' THEN CONTINUE; END IF;
  owner_account:=NULL;
  owner_tenant:=current_row->>'tenant_id'; owner_user:=current_row->>owner_column;
  FOR marker IN SELECT * FROM guest_pii_erasure_markers m WHERE m.tenant_id=owner_tenant AND
    (m.user_id=owner_user OR (owner_account IS NOT NULL AND m.account_id=owner_account)) LOOP
   stable:=TG_OP='DELETE' OR (TG_OP='UPDATE' AND old_row->>pk_column IS NOT DISTINCT FROM new_row->>pk_column
     AND old_row->>'tenant_id' IS NOT DISTINCT FROM new_row->>'tenant_id'
     AND old_row->>owner_column IS NOT DISTINCT FROM new_row->>owner_column);
   IF TG_OP='UPDATE' AND TG_TABLE_NAME='identity_sensitive_values' THEN
    stable:=stable AND old_row->>'owner_type' IS NOT DISTINCT FROM new_row->>'owner_type'; END IF;
   IF TG_OP='UPDATE' AND TG_TABLE_NAME='external_identifier_unlink_operations' THEN
    stable:=stable AND old_row->>'account_id' IS NOT DISTINCT FROM new_row->>'account_id'; END IF;
   permitted:=TG_OP<>'INSERT' AND stable AND marker.state='erasing' AND marker.permit_table=TG_TABLE_NAME
     AND EXISTS(SELECT 1 FROM jsonb_array_elements(marker.permit_keys_json::jsonb) key(value)
       WHERE jsonb_typeof(key.value)='string' AND key.value#>>'{}'=old_row->>pk_column);
   IF NOT COALESCE(permitted,FALSE) THEN RAISE EXCEPTION 'guest_pii_erasure_mutation_blocked'; END IF;
  END LOOP;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END; $$;
CREATE TRIGGER trg_guest_pii_users_pii BEFORE INSERT OR UPDATE OR DELETE ON "users_pii"
 FOR EACH ROW EXECUTE FUNCTION authrim_guest_pii_source_guard();
CREATE TRIGGER trg_guest_pii_identity_sensitive_values BEFORE INSERT OR UPDATE OR DELETE ON "identity_sensitive_values"
 FOR EACH ROW EXECUTE FUNCTION authrim_guest_pii_source_guard();
CREATE TRIGGER trg_guest_pii_linked_identities BEFORE INSERT OR UPDATE OR DELETE ON "linked_identities"
 FOR EACH ROW EXECUTE FUNCTION authrim_guest_pii_source_guard();
CREATE TRIGGER trg_guest_pii_subject_identifiers BEFORE INSERT OR UPDATE OR DELETE ON "subject_identifiers"
 FOR EACH ROW EXECUTE FUNCTION authrim_guest_pii_source_guard();
CREATE TRIGGER trg_guest_pii_pairwise_subject_identifiers BEFORE INSERT OR UPDATE OR DELETE ON "pairwise_subject_identifiers"
 FOR EACH ROW EXECUTE FUNCTION authrim_guest_pii_source_guard();
CREATE TRIGGER trg_guest_pii_guest_upgrade_operations BEFORE INSERT OR UPDATE OR DELETE ON "guest_upgrade_operations"
 FOR EACH ROW EXECUTE FUNCTION authrim_guest_pii_source_guard();
-- Existing six-table profile only; users_pii is already a one-row primary-key lookup.
CREATE INDEX idx_guest_pii_sensitive_drain ON identity_sensitive_values(tenant_id,owner_type,owner_id,id);
CREATE INDEX idx_guest_pii_linked_drain ON linked_identities(tenant_id,user_id,id);
CREATE INDEX idx_guest_pii_subject_drain ON subject_identifiers(tenant_id,subject_id,id);
CREATE INDEX idx_guest_pii_pairwise_drain ON pairwise_subject_identifiers(tenant_id,user_id,id);
CREATE INDEX idx_guest_pii_upgrade_drain ON guest_upgrade_operations(tenant_id,user_id,operation_id);
