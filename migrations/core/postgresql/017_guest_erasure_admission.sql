-- Guest-only source mutation admission; no new timestamp/actor retention policy.
-- Closed PostgreSQL Core profile: passkeys/devices exist; Core TOTP and routing outbox do not.
ALTER TABLE guest_deletion_audit_outbox ADD COLUMN execution_progress_json TEXT
  CHECK (execution_progress_json IS NULL OR octet_length(execution_progress_json)<=16384);

-- Shared locks fence ordinary source writes. Boundary changes update this row,
-- including under repeatable read: a stale snapshot must serialize/retry.
CREATE TABLE guest_core_mutation_epoch (
  id INTEGER PRIMARY KEY CHECK (id=1),
  revision BIGINT NOT NULL CHECK (revision>=0)
);
INSERT INTO guest_core_mutation_epoch(id,revision) VALUES(1,0);

CREATE FUNCTION authrim_guest_erasure_json(value TEXT) RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  RETURN COALESCE(value::jsonb,'{}'::jsonb);
EXCEPTION WHEN invalid_text_representation THEN
  RETURN '{}'::jsonb;
END;
$$;

CREATE FUNCTION authrim_guest_core_page_permitted(
  p_tenant TEXT,p_user TEXT,p_table TEXT,p_id TEXT
) RETURNS BOOLEAN LANGUAGE SQL VOLATILE AS $$
  SELECT EXISTS (
    SELECT 1 FROM guest_account_lifecycle g
    JOIN identity_accounts a ON a.tenant_id=g.tenant_id AND a.legacy_user_id=g.user_id
    JOIN guest_deletion_audit_outbox task ON task.tenant_id=g.tenant_id AND task.user_id=g.user_id
      AND task.operation_id=g.deletion_operation_id
    CROSS JOIN LATERAL (SELECT authrim_guest_erasure_json(g.deletion_route_json) AS route,
      authrim_guest_erasure_json(task.execution_progress_json) AS progress) document
    WHERE g.tenant_id=p_tenant AND g.user_id=p_user AND g.phase IN ('deleting','deleted')
      AND task.status IN ('pending','retry')
      AND document.route->'schemaVersion'='2'::jsonb
      AND document.route->>'operationId'=g.deletion_operation_id
      AND document.route->>'tenantId'=g.tenant_id AND document.route->>'userId'=g.user_id
      AND document.route->>'accountId'=a.id
      AND document.route->'accountRouteGeneration'=to_jsonb(a.account_route_generation)
      AND document.route->>'completionAuditId'=task.audit_id
      AND document.route#>>'{execution,phase}'='erasure_started'
      AND EXISTS (SELECT 1 FROM account_legal_hold_states authority
        WHERE authority.tenant_id=a.tenant_id AND authority.account_id=a.id
          AND authority.projection_state='inactive' AND authority.active_hold_id IS NULL)
      AND NOT EXISTS (SELECT 1 FROM legal_holds h WHERE h.tenant_id=a.tenant_id
        AND h.subject_type='account' AND h.subject_id=a.id AND h.state='active')
      AND document.progress->'schemaVersion'='1'::jsonb
      AND jsonb_typeof(document.progress->'revision')='number'
      AND (document.progress->>'revision')::numeric>0
      AND document.progress#>>'{corePermit,table}'=p_table
      AND document.progress->>'stage'=CASE p_table
        WHEN 'passkeys' THEN 'drain_passkeys' WHEN 'guest_devices' THEN 'drain_guest_devices'
        WHEN 'identity_accounts' THEN 'final_core' ELSE NULL END
      AND jsonb_typeof(document.progress#>'{corePermit,ids}')='array'
      AND jsonb_array_length(CASE WHEN jsonb_typeof(document.progress#>'{corePermit,ids}')='array'
        THEN document.progress#>'{corePermit,ids}' ELSE '[]'::jsonb END) BETWEEN 1 AND 16
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(document.progress#>'{corePermit,ids}')='array'
          THEN document.progress#>'{corePermit,ids}' ELSE '[]'::jsonb END) AS key(value)
        WHERE jsonb_typeof(key.value)='string' AND octet_length(key.value#>>'{}') BETWEEN 1 AND 256
          AND key.value#>>'{}'=p_id)
  );
$$;

CREATE FUNCTION authrim_guest_core_source_guard() RETURNS TRIGGER LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  old_row JSONB;
  new_row JSONB;
  user_column TEXT;
  frozen BOOLEAN;
  permitted BOOLEAN;
BEGIN
  user_column:=CASE WHEN TG_TABLE_NAME='identity_accounts' THEN 'legacy_user_id' ELSE 'user_id' END;
  IF TG_OP<>'INSERT' THEN old_row:=to_jsonb(OLD); END IF;
  IF TG_OP<>'DELETE' THEN new_row:=to_jsonb(NEW); END IF;
  IF TG_TABLE_NAME='identity_accounts' AND (TG_OP<>'UPDATE' OR
    (new_row-ARRAY['display_label','metadata_json','updated_at']) IS DISTINCT FROM
      (old_row-ARRAY['display_label','metadata_json','updated_at'])) THEN
    -- Owner/status changes invalidate current-source proofs. Ordinary metadata writes
    -- retain shared admission, without serializing all unrelated profile updates.
    UPDATE guest_core_mutation_epoch SET revision=revision+1 WHERE id=1;
  ELSE
    PERFORM revision FROM guest_core_mutation_epoch WHERE id=1 FOR SHARE;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'guest_core_admission_unavailable'; END IF;
  SELECT EXISTS (SELECT 1 FROM guest_account_lifecycle g WHERE g.phase IN ('deleting','deleted')
    AND ((g.tenant_id=old_row->>'tenant_id' AND g.user_id=old_row->>user_column)
      OR (g.tenant_id=new_row->>'tenant_id' AND g.user_id=new_row->>user_column))) INTO frozen;
  IF frozen THEN
    permitted:=TG_OP<>'INSERT' AND authrim_guest_core_page_permitted(
      old_row->>'tenant_id',old_row->>user_column,TG_TABLE_NAME,old_row->>'id');
    IF TG_OP='UPDATE' THEN
      permitted:=permitted AND new_row->>'id'=old_row->>'id'
        AND new_row->>'tenant_id'=old_row->>'tenant_id'
        AND new_row->>user_column IS NOT DISTINCT FROM old_row->>user_column;
      IF TG_TABLE_NAME='identity_accounts' THEN
        permitted:=permitted
          AND (new_row-ARRAY['display_label','metadata_json','lifecycle_state','deleted_at',
            'updated_at','directory_publication_state'])=
            (old_row-ARRAY['display_label','metadata_json','lifecycle_state','deleted_at',
            'updated_at','directory_publication_state'])
          AND new_row->>'lifecycle_state' IN ('deleting','deleted')
          AND (new_row->>'display_label' IS NULL OR new_row->'display_label'=old_row->'display_label')
          AND (new_row->>'metadata_json' IS NULL OR new_row->'metadata_json'=old_row->'metadata_json');
        -- Allow the exact monotone B transition and its directory-disable effect.
        permitted:=permitted OR (
          (new_row-ARRAY['lifecycle_state','updated_at','deleted_at','directory_publication_state'])=
            (old_row-ARRAY['lifecycle_state','updated_at','deleted_at','directory_publication_state'])
          AND new_row->>'lifecycle_state'='deleting' AND old_row->>'lifecycle_state'<>'deleted'
          AND (new_row->>'directory_publication_state'=old_row->>'directory_publication_state'
            OR new_row->>'directory_publication_state'='disabled')
          AND (old_row->>'deleted_at' IS NULL OR new_row->'deleted_at'=old_row->'deleted_at')
          AND (new_row->>'updated_at')::bigint >= (old_row->>'updated_at')::bigint
          AND EXISTS (SELECT 1 FROM guest_account_lifecycle g
            JOIN guest_deletion_audit_outbox task ON task.tenant_id=g.tenant_id AND task.user_id=g.user_id
              AND task.operation_id=g.deletion_operation_id
            CROSS JOIN LATERAL (SELECT authrim_guest_erasure_json(g.deletion_route_json) AS route) document
            WHERE g.tenant_id=old_row->>'tenant_id' AND g.user_id=old_row->>'legacy_user_id'
              AND g.phase='deleting' AND task.status IN ('pending','retry')
              AND document.route->'schemaVersion'='2'::jsonb
              AND document.route->>'operationId'=g.deletion_operation_id
              AND document.route#>>'{execution,phase}'='erasure_started'
              AND document.route->>'accountId'=old_row->>'id'
              AND document.route->'accountRouteGeneration'=old_row->'account_route_generation'
              AND document.route->>'completionAuditId'=task.audit_id
              AND EXISTS (SELECT 1 FROM account_legal_hold_states authority
                WHERE authority.tenant_id=g.tenant_id AND authority.account_id=old_row->>'id'
                  AND authority.projection_state='inactive' AND authority.active_hold_id IS NULL))
          AND NOT EXISTS (SELECT 1 FROM legal_holds h WHERE h.tenant_id=old_row->>'tenant_id'
            AND h.subject_type='account' AND h.subject_id=old_row->>'id' AND h.state='active')
        );
      END IF;
    END IF;
    IF NOT COALESCE(permitted,FALSE) THEN RAISE EXCEPTION 'guest_erasure_mutation_blocked'; END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;

CREATE TRIGGER trg_guest_core_passkeys BEFORE INSERT OR UPDATE OR DELETE ON passkeys
FOR EACH ROW EXECUTE FUNCTION authrim_guest_core_source_guard();
CREATE TRIGGER trg_guest_core_devices BEFORE INSERT OR UPDATE OR DELETE ON guest_devices
FOR EACH ROW EXECUTE FUNCTION authrim_guest_core_source_guard();
CREATE TRIGGER trg_guest_core_accounts BEFORE INSERT OR UPDATE OR DELETE ON identity_accounts
FOR EACH ROW EXECUTE FUNCTION authrim_guest_core_source_guard();

CREATE FUNCTION authrim_guest_core_boundary_guard() RETURNS TRIGGER LANGUAGE plpgsql VOLATILE AS $$
DECLARE route JSONB;
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.phase IN ('deleting','deleted') THEN
      RAISE EXCEPTION 'guest_erasure_lifecycle_immutable';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' AND (
    (OLD.phase='deleted' AND NEW.phase<>'deleted')
    OR (OLD.phase='deleting' AND NEW.phase NOT IN ('deleting','deleted'))
    OR (OLD.phase IN ('deleting','deleted') AND (
      NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.user_id IS DISTINCT FROM OLD.user_id
      OR NEW.deletion_operation_id IS DISTINCT FROM OLD.deletion_operation_id
      OR NEW.deletion_started_at_ms IS DISTINCT FROM OLD.deletion_started_at_ms)))
  THEN RAISE EXCEPTION 'guest_erasure_lifecycle_immutable'; END IF;
  IF TG_OP='UPDATE' AND OLD.phase IN ('deleting','deleted')
    AND NEW.deletion_route_json IS DISTINCT FROM OLD.deletion_route_json AND NOT COALESCE(
      OLD.phase='deleting' AND NEW.phase='deleting'
      AND authrim_guest_erasure_json(OLD.deletion_route_json)#>>'{execution,phase}'='accepted'
      AND authrim_guest_erasure_json(NEW.deletion_route_json)#>>'{execution,phase}'='erasure_started'
      AND (authrim_guest_erasure_json(OLD.deletion_route_json)-'execution')=
        (authrim_guest_erasure_json(NEW.deletion_route_json)-'execution'),FALSE)
  THEN RAISE EXCEPTION 'guest_erasure_lifecycle_immutable'; END IF;
  -- Ordinary enrollment/upgrades do not start a source freeze or upgrade shared locks.
  IF NEW.phase NOT IN ('deleting','deleted') THEN RETURN NEW; END IF;
  UPDATE guest_core_mutation_epoch SET revision=revision+1 WHERE id=1;
  IF NOT FOUND THEN RAISE EXCEPTION 'guest_core_admission_unavailable'; END IF;
  route:=authrim_guest_erasure_json(NEW.deletion_route_json);
  IF NEW.phase IN ('deleting','deleted') AND route#>>'{execution,phase}'='erasure_started'
    AND EXISTS (SELECT 1 FROM legal_holds h JOIN identity_accounts a
      ON a.tenant_id=h.tenant_id AND a.id=h.subject_id
      WHERE a.tenant_id=NEW.tenant_id AND a.legacy_user_id=NEW.user_id
        AND h.subject_type='account' AND h.state='active')
  THEN RAISE EXCEPTION 'guest_erasure_legal_hold_active'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_guest_core_boundary BEFORE INSERT OR UPDATE OR DELETE
ON guest_account_lifecycle FOR EACH ROW EXECUTE FUNCTION authrim_guest_core_boundary_guard();

CREATE FUNCTION authrim_guest_core_hold_guard() RETURNS TRIGGER LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  -- Both admission paths write this row before evaluating the opposite boundary.
  UPDATE guest_core_mutation_epoch SET revision=revision+1 WHERE id=1;
  IF NOT FOUND THEN RAISE EXCEPTION 'guest_core_admission_unavailable'; END IF;
  IF NEW.subject_type='account' AND NEW.state='active' AND EXISTS (
    SELECT 1 FROM identity_accounts a JOIN guest_account_lifecycle g
      ON g.tenant_id=a.tenant_id AND g.user_id=a.legacy_user_id
    CROSS JOIN LATERAL (SELECT authrim_guest_erasure_json(g.deletion_route_json) AS route) document
    WHERE a.tenant_id=NEW.tenant_id AND a.id=NEW.subject_id
      AND (g.phase='deleted' OR (g.phase='deleting' AND NOT COALESCE(
        document.route->'schemaVersion'='2'::jsonb AND document.route->>'operationId'=g.deletion_operation_id
        AND document.route->>'accountId'=a.id
        AND document.route#>>'{execution,phase}'='accepted',FALSE)))
  ) THEN RAISE EXCEPTION 'guest_erasure_hold_admission_blocked'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_guest_core_hold BEFORE INSERT OR UPDATE ON legal_holds
FOR EACH ROW EXECUTE FUNCTION authrim_guest_core_hold_guard();

CREATE INDEX idx_guest_erasure_passkeys_page ON passkeys(tenant_id,user_id,id);

CREATE INDEX idx_guest_erasure_guest_devices_page ON guest_devices(tenant_id,user_id,id);


-- Reuse the non-PII epoch for the parents trusted by current-owner restore admission.
CREATE FUNCTION authrim_guest_core_parent_epoch_guard() RETURNS TRIGGER LANGUAGE plpgsql VOLATILE AS $$
DECLARE old_row JSONB; new_row JSONB; fields TEXT[];
BEGIN
  IF TG_OP='UPDATE' THEN
    old_row:=to_jsonb(OLD); new_row:=to_jsonb(NEW);
    fields:=CASE WHEN TG_TABLE_NAME='identity_subjects'
      THEN ARRAY['id','tenant_id','subject_type','lifecycle_state','primary_account_id','deleted_at']
      ELSE ARRAY['id','tenant_id','subject_id','profile_type','lifecycle_state','deleted_at'] END;
    IF NOT EXISTS (SELECT 1 FROM unnest(fields) AS field(name)
      WHERE old_row->field.name IS DISTINCT FROM new_row->field.name) THEN RETURN NEW; END IF;
  END IF;
  UPDATE guest_core_mutation_epoch SET revision=revision+1 WHERE id=1;
  IF NOT FOUND THEN RAISE EXCEPTION 'guest_core_admission_unavailable'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
CREATE TRIGGER trg_guest_core_subjects BEFORE INSERT OR UPDATE OR DELETE ON identity_subjects
FOR EACH ROW EXECUTE FUNCTION authrim_guest_core_parent_epoch_guard();
CREATE TRIGGER trg_guest_core_profiles BEFORE INSERT OR UPDATE OR DELETE ON profiles
FOR EACH ROW EXECUTE FUNCTION authrim_guest_core_parent_epoch_guard();
