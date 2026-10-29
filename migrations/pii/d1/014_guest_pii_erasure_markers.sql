-- Guest raw/auth source freeze. Existing tombstone, audit-pseudonym and historical delivery TTLs are unchanged.
CREATE TABLE guest_pii_mutation_epoch (
  id INTEGER PRIMARY KEY CHECK(id=1),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991)
);
INSERT INTO guest_pii_mutation_epoch(id,revision) VALUES(1,0);
CREATE TABLE guest_pii_erasure_markers (
  schema_version INTEGER NOT NULL CHECK(schema_version=1),
  tenant_id TEXT NOT NULL CHECK(length(tenant_id) BETWEEN 1 AND 256),
  user_id TEXT NOT NULL CHECK(length(user_id) BETWEEN 1 AND 256),
  account_id TEXT NOT NULL CHECK(length(account_id) BETWEEN 1 AND 512),
  account_route_generation INTEGER NOT NULL CHECK(account_route_generation BETWEEN 1 AND 9007199254740991),
  state TEXT NOT NULL CHECK(state IN ('erasing','deleted')),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
  operation_id TEXT,
  boundary_id TEXT,
  source_started_at_ms INTEGER,
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
        OR (permit_table IS NOT NULL AND permit_keys_json IS NOT NULL AND permit_table IN ('users_pii','identity_sensitive_values','linked_identities','subject_identifiers','pairwise_subject_identifiers','guest_upgrade_operations','identity_identifier_replacement_challenges','identity_identifier_replacement_operations','identity_identifier_replacement_history','identity_identifier_replacement_outbox','external_identifier_unlink_operations','user_anonymization_map') AND length(permit_keys_json)<=8192 AND json_valid(permit_keys_json) AND json_type(permit_keys_json)='array' AND json_array_length(permit_keys_json) BETWEEN 1 AND 16))))
);
CREATE TRIGGER trg_guest_pii_epoch_no_delete BEFORE DELETE ON guest_pii_mutation_epoch BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_immutable'); END;
CREATE TRIGGER trg_guest_pii_epoch_no_replace BEFORE INSERT ON guest_pii_mutation_epoch WHEN EXISTS(SELECT 1 FROM guest_pii_mutation_epoch) BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_immutable'); END;
CREATE TRIGGER trg_guest_pii_epoch_monotonic BEFORE UPDATE ON guest_pii_mutation_epoch BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_immutable') WHERE (NEW.id IS NOT OLD.id OR NEW.revision IS NOT OLD.revision+1); END;
CREATE TRIGGER trg_guest_pii_marker_no_delete BEFORE DELETE ON guest_pii_erasure_markers BEGIN
 SELECT RAISE(ABORT,'guest_pii_marker_immutable'); END;
CREATE TRIGGER trg_guest_pii_marker_insert BEFORE INSERT ON guest_pii_erasure_markers BEGIN
 SELECT RAISE(ABORT,'guest_pii_marker_initial_invalid') WHERE (NEW.permit_table IS NOT NULL OR NEW.permit_keys_json IS NOT NULL OR (NEW.state='erasing' AND NEW.revision<>1));
 SELECT RAISE(ABORT,'guest_pii_marker_identity_conflict') WHERE (EXISTS(SELECT 1 FROM guest_pii_erasure_markers WHERE tenant_id=NEW.tenant_id AND (user_id=NEW.user_id OR account_id=NEW.account_id)));
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 UPDATE guest_pii_mutation_epoch SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER trg_guest_pii_marker_update BEFORE UPDATE ON guest_pii_erasure_markers BEGIN
 SELECT RAISE(ABORT,'guest_pii_marker_immutable') WHERE (NEW.schema_version IS NOT OLD.schema_version OR NEW.tenant_id IS NOT OLD.tenant_id OR NEW.user_id IS NOT OLD.user_id OR NEW.account_id IS NOT OLD.account_id OR NEW.account_route_generation IS NOT OLD.account_route_generation OR NOT (OLD.state='erasing' AND (
  (NEW.state='deleted' AND OLD.permit_table IS NULL AND OLD.permit_keys_json IS NULL AND NEW.revision=OLD.revision+1)
  OR (NEW.state='erasing' AND NEW.operation_id IS OLD.operation_id AND NEW.boundary_id IS OLD.boundary_id
    AND NEW.source_started_at_ms IS OLD.source_started_at_ms AND (
      (OLD.permit_table IS NULL AND OLD.permit_keys_json IS NULL AND NEW.permit_table IS NOT NULL AND NEW.permit_keys_json IS NOT NULL AND NEW.revision=OLD.revision)
      OR (OLD.permit_table IS NOT NULL AND OLD.permit_keys_json IS NOT NULL AND NEW.permit_table IS NULL AND NEW.permit_keys_json IS NULL AND NEW.revision=OLD.revision+1)
    )))
));
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 UPDATE guest_pii_mutation_epoch SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER trg_guest_pii_users_pii_insert BEFORE INSERT ON "users_pii" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=NEW.tenant_id AND m.user_id=NEW.id) OR EXISTS(SELECT 1 FROM "users_pii" existing WHERE ((existing."tenant_id"=NEW."tenant_id" AND existing."email_blind_index"=NEW."email_blind_index") OR (existing."id"=NEW."id")) AND EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=existing.tenant_id AND m.user_id=existing.id)));
END;
CREATE TRIGGER trg_guest_pii_users_pii_delete BEFORE DELETE ON "users_pii" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=OLD.tenant_id AND m.user_id=OLD.id AND NOT (m.state='erasing' AND m.permit_table='users_pii' AND EXISTS(SELECT 1 FROM json_each(m.permit_keys_json) key WHERE key.type='text' AND key.value=OLD."id"))));
END;
CREATE TRIGGER trg_guest_pii_users_pii_update BEFORE UPDATE ON "users_pii" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (((EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=OLD.tenant_id AND m.user_id=OLD.id) OR EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=NEW.tenant_id AND m.user_id=NEW.id)) AND NOT (NEW."id" IS OLD."id" AND NEW.tenant_id IS OLD.tenant_id AND NEW."id" IS OLD."id")) OR EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE ((m.tenant_id=OLD.tenant_id AND m.user_id=OLD.id) OR (m.tenant_id=NEW.tenant_id AND m.user_id=NEW.id)) AND NOT (m.state='erasing' AND m.permit_table='users_pii' AND EXISTS(SELECT 1 FROM json_each(m.permit_keys_json) key WHERE key.type='text' AND key.value=OLD."id"))));
END;
CREATE TRIGGER trg_guest_pii_identity_sensitive_values_insert BEFORE INSERT ON "identity_sensitive_values" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=NEW.tenant_id AND m.user_id=NEW.owner_id AND NEW.owner_type='runtime_user') OR EXISTS(SELECT 1 FROM "identity_sensitive_values" existing WHERE ((existing."tenant_id"=NEW."tenant_id" AND existing."owner_type"=NEW."owner_type" AND existing."owner_id"=NEW."owner_id" AND existing."value_key"=NEW."value_key") OR (existing."id"=NEW."id")) AND EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=existing.tenant_id AND m.user_id=existing.owner_id AND existing.owner_type='runtime_user')));
END;
CREATE TRIGGER trg_guest_pii_identity_sensitive_values_delete BEFORE DELETE ON "identity_sensitive_values" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=OLD.tenant_id AND m.user_id=OLD.owner_id AND OLD.owner_type='runtime_user' AND NOT (m.state='erasing' AND m.permit_table='identity_sensitive_values' AND EXISTS(SELECT 1 FROM json_each(m.permit_keys_json) key WHERE key.type='text' AND key.value=OLD."id"))));
END;
CREATE TRIGGER trg_guest_pii_identity_sensitive_values_update BEFORE UPDATE ON "identity_sensitive_values" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (((EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=OLD.tenant_id AND m.user_id=OLD.owner_id AND OLD.owner_type='runtime_user') OR EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=NEW.tenant_id AND m.user_id=NEW.owner_id AND NEW.owner_type='runtime_user')) AND NOT (NEW."id" IS OLD."id" AND NEW.tenant_id IS OLD.tenant_id AND NEW."owner_id" IS OLD."owner_id" AND NEW.owner_type IS OLD.owner_type)) OR EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE ((m.tenant_id=OLD.tenant_id AND m.user_id=OLD.owner_id AND OLD.owner_type='runtime_user') OR (m.tenant_id=NEW.tenant_id AND m.user_id=NEW.owner_id AND NEW.owner_type='runtime_user')) AND NOT (m.state='erasing' AND m.permit_table='identity_sensitive_values' AND EXISTS(SELECT 1 FROM json_each(m.permit_keys_json) key WHERE key.type='text' AND key.value=OLD."id"))));
END;
CREATE TRIGGER trg_guest_pii_linked_identities_insert BEFORE INSERT ON "linked_identities" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=NEW.tenant_id AND m.user_id=NEW.user_id) OR EXISTS(SELECT 1 FROM "linked_identities" existing WHERE ((existing."tenant_id"=NEW."tenant_id" AND existing."provider_id"=NEW."provider_id" AND existing."provider_user_id"=NEW."provider_user_id") OR (existing."id"=NEW."id")) AND EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=existing.tenant_id AND m.user_id=existing.user_id)));
END;
CREATE TRIGGER trg_guest_pii_linked_identities_delete BEFORE DELETE ON "linked_identities" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=OLD.tenant_id AND m.user_id=OLD.user_id AND NOT (m.state='erasing' AND m.permit_table='linked_identities' AND EXISTS(SELECT 1 FROM json_each(m.permit_keys_json) key WHERE key.type='text' AND key.value=OLD."id"))));
END;
CREATE TRIGGER trg_guest_pii_linked_identities_update BEFORE UPDATE ON "linked_identities" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (((EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=OLD.tenant_id AND m.user_id=OLD.user_id) OR EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=NEW.tenant_id AND m.user_id=NEW.user_id)) AND NOT (NEW."id" IS OLD."id" AND NEW.tenant_id IS OLD.tenant_id AND NEW."user_id" IS OLD."user_id")) OR EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE ((m.tenant_id=OLD.tenant_id AND m.user_id=OLD.user_id) OR (m.tenant_id=NEW.tenant_id AND m.user_id=NEW.user_id)) AND NOT (m.state='erasing' AND m.permit_table='linked_identities' AND EXISTS(SELECT 1 FROM json_each(m.permit_keys_json) key WHERE key.type='text' AND key.value=OLD."id"))));
END;
CREATE TRIGGER trg_guest_pii_subject_identifiers_insert BEFORE INSERT ON "subject_identifiers" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=NEW.tenant_id AND m.user_id=NEW.subject_id) OR EXISTS(SELECT 1 FROM "subject_identifiers" existing WHERE ((existing."tenant_id"=NEW."tenant_id" AND existing."identifier_type"=NEW."identifier_type" AND existing."identifier_value"=NEW."identifier_value") OR (existing."id"=NEW."id")) AND EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=existing.tenant_id AND m.user_id=existing.subject_id)));
END;
CREATE TRIGGER trg_guest_pii_subject_identifiers_delete BEFORE DELETE ON "subject_identifiers" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=OLD.tenant_id AND m.user_id=OLD.subject_id AND NOT (m.state='erasing' AND m.permit_table='subject_identifiers' AND EXISTS(SELECT 1 FROM json_each(m.permit_keys_json) key WHERE key.type='text' AND key.value=OLD."id"))));
END;
CREATE TRIGGER trg_guest_pii_subject_identifiers_update BEFORE UPDATE ON "subject_identifiers" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (((EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=OLD.tenant_id AND m.user_id=OLD.subject_id) OR EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=NEW.tenant_id AND m.user_id=NEW.subject_id)) AND NOT (NEW."id" IS OLD."id" AND NEW.tenant_id IS OLD.tenant_id AND NEW."subject_id" IS OLD."subject_id")) OR EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE ((m.tenant_id=OLD.tenant_id AND m.user_id=OLD.subject_id) OR (m.tenant_id=NEW.tenant_id AND m.user_id=NEW.subject_id)) AND NOT (m.state='erasing' AND m.permit_table='subject_identifiers' AND EXISTS(SELECT 1 FROM json_each(m.permit_keys_json) key WHERE key.type='text' AND key.value=OLD."id"))));
END;
CREATE TRIGGER trg_guest_pii_pairwise_subject_identifiers_insert BEFORE INSERT ON "pairwise_subject_identifiers" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=NEW.tenant_id AND m.user_id=NEW.user_id) OR EXISTS(SELECT 1 FROM "pairwise_subject_identifiers" existing WHERE ((existing."tenant_id"=NEW."tenant_id" AND existing."user_id"=NEW."user_id" AND existing."sector_identifier"=NEW."sector_identifier") OR (existing."id"=NEW."id")) AND EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=existing.tenant_id AND m.user_id=existing.user_id)));
END;
CREATE TRIGGER trg_guest_pii_pairwise_subject_identifiers_delete BEFORE DELETE ON "pairwise_subject_identifiers" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=OLD.tenant_id AND m.user_id=OLD.user_id AND NOT (m.state='erasing' AND m.permit_table='pairwise_subject_identifiers' AND EXISTS(SELECT 1 FROM json_each(m.permit_keys_json) key WHERE key.type='text' AND key.value=OLD."id"))));
END;
CREATE TRIGGER trg_guest_pii_pairwise_subject_identifiers_update BEFORE UPDATE ON "pairwise_subject_identifiers" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (((EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=OLD.tenant_id AND m.user_id=OLD.user_id) OR EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=NEW.tenant_id AND m.user_id=NEW.user_id)) AND NOT (NEW."id" IS OLD."id" AND NEW.tenant_id IS OLD.tenant_id AND NEW."user_id" IS OLD."user_id")) OR EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE ((m.tenant_id=OLD.tenant_id AND m.user_id=OLD.user_id) OR (m.tenant_id=NEW.tenant_id AND m.user_id=NEW.user_id)) AND NOT (m.state='erasing' AND m.permit_table='pairwise_subject_identifiers' AND EXISTS(SELECT 1 FROM json_each(m.permit_keys_json) key WHERE key.type='text' AND key.value=OLD."id"))));
END;
CREATE TRIGGER trg_guest_pii_guest_upgrade_operations_insert BEFORE INSERT ON "guest_upgrade_operations" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=NEW.tenant_id AND m.user_id=NEW.user_id) OR EXISTS(SELECT 1 FROM "guest_upgrade_operations" existing WHERE ((existing."operation_id"=NEW."operation_id")) AND EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=existing.tenant_id AND m.user_id=existing.user_id)));
END;
CREATE TRIGGER trg_guest_pii_guest_upgrade_operations_delete BEFORE DELETE ON "guest_upgrade_operations" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=OLD.tenant_id AND m.user_id=OLD.user_id AND NOT (m.state='erasing' AND m.permit_table='guest_upgrade_operations' AND EXISTS(SELECT 1 FROM json_each(m.permit_keys_json) key WHERE key.type='text' AND key.value=OLD."operation_id"))));
END;
CREATE TRIGGER trg_guest_pii_guest_upgrade_operations_update BEFORE UPDATE ON "guest_upgrade_operations" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (((EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=OLD.tenant_id AND m.user_id=OLD.user_id) OR EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=NEW.tenant_id AND m.user_id=NEW.user_id)) AND NOT (NEW."operation_id" IS OLD."operation_id" AND NEW.tenant_id IS OLD.tenant_id AND NEW."user_id" IS OLD."user_id")) OR EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE ((m.tenant_id=OLD.tenant_id AND m.user_id=OLD.user_id) OR (m.tenant_id=NEW.tenant_id AND m.user_id=NEW.user_id)) AND NOT (m.state='erasing' AND m.permit_table='guest_upgrade_operations' AND EXISTS(SELECT 1 FROM json_each(m.permit_keys_json) key WHERE key.type='text' AND key.value=OLD."operation_id"))));
END;
CREATE TRIGGER trg_guest_pii_identity_identifier_replacement_challenges_insert BEFORE INSERT ON "identity_identifier_replacement_challenges" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=NEW.tenant_id AND m.user_id=NEW.account_id) OR EXISTS(SELECT 1 FROM "identity_identifier_replacement_challenges" existing WHERE ((existing."challenge_id"=NEW."challenge_id")) AND EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=existing.tenant_id AND m.user_id=existing.account_id)));
END;
CREATE TRIGGER trg_guest_pii_identity_identifier_replacement_challenges_delete BEFORE DELETE ON "identity_identifier_replacement_challenges" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=OLD.tenant_id AND m.user_id=OLD.account_id AND NOT (m.state='erasing' AND m.permit_table='identity_identifier_replacement_challenges' AND EXISTS(SELECT 1 FROM json_each(m.permit_keys_json) key WHERE key.type='text' AND key.value=OLD."challenge_id"))));
END;
CREATE TRIGGER trg_guest_pii_identity_identifier_replacement_challenges_update BEFORE UPDATE ON "identity_identifier_replacement_challenges" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (((EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=OLD.tenant_id AND m.user_id=OLD.account_id) OR EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=NEW.tenant_id AND m.user_id=NEW.account_id)) AND NOT (NEW."challenge_id" IS OLD."challenge_id" AND NEW.tenant_id IS OLD.tenant_id AND NEW."account_id" IS OLD."account_id")) OR EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE ((m.tenant_id=OLD.tenant_id AND m.user_id=OLD.account_id) OR (m.tenant_id=NEW.tenant_id AND m.user_id=NEW.account_id)) AND NOT (m.state='erasing' AND m.permit_table='identity_identifier_replacement_challenges' AND EXISTS(SELECT 1 FROM json_each(m.permit_keys_json) key WHERE key.type='text' AND key.value=OLD."challenge_id"))));
END;
CREATE TRIGGER trg_guest_pii_identity_identifier_replacement_operations_insert BEFORE INSERT ON "identity_identifier_replacement_operations" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=NEW.tenant_id AND m.user_id=NEW.account_id) OR EXISTS(SELECT 1 FROM "identity_identifier_replacement_operations" existing WHERE ((existing."tenant_id"=NEW."tenant_id" AND existing."account_id"=NEW."account_id" AND existing."identifier_kind"=NEW."identifier_kind" AND existing.state NOT IN ('completed','canceled') AND NEW.state NOT IN ('completed','canceled')) OR (existing."tenant_id"=NEW."tenant_id" AND existing."authority"=NEW."authority" AND existing."idempotency_key_sha256"=NEW."idempotency_key_sha256") OR (existing."outbox_id"=NEW."outbox_id") OR (existing."operation_id"=NEW."operation_id")) AND EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=existing.tenant_id AND m.user_id=existing.account_id)));
END;
CREATE TRIGGER trg_guest_pii_identity_identifier_replacement_operations_delete BEFORE DELETE ON "identity_identifier_replacement_operations" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=OLD.tenant_id AND m.user_id=OLD.account_id AND NOT (m.state='erasing' AND m.permit_table='identity_identifier_replacement_operations' AND EXISTS(SELECT 1 FROM json_each(m.permit_keys_json) key WHERE key.type='text' AND key.value=OLD."operation_id"))));
END;
CREATE TRIGGER trg_guest_pii_identity_identifier_replacement_operations_update BEFORE UPDATE ON "identity_identifier_replacement_operations" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (((EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=OLD.tenant_id AND m.user_id=OLD.account_id) OR EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=NEW.tenant_id AND m.user_id=NEW.account_id)) AND NOT (NEW."operation_id" IS OLD."operation_id" AND NEW.tenant_id IS OLD.tenant_id AND NEW."account_id" IS OLD."account_id")) OR EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE ((m.tenant_id=OLD.tenant_id AND m.user_id=OLD.account_id) OR (m.tenant_id=NEW.tenant_id AND m.user_id=NEW.account_id)) AND NOT (m.state='erasing' AND m.permit_table='identity_identifier_replacement_operations' AND EXISTS(SELECT 1 FROM json_each(m.permit_keys_json) key WHERE key.type='text' AND key.value=OLD."operation_id"))));
END;
CREATE TRIGGER trg_guest_pii_identity_identifier_replacement_history_insert BEFORE INSERT ON "identity_identifier_replacement_history" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE EXISTS (SELECT 1 FROM identity_identifier_replacement_operations owner WHERE owner.operation_id=NEW.operation_id AND m.tenant_id=owner.tenant_id AND m.user_id=owner.account_id)) OR EXISTS(SELECT 1 FROM "identity_identifier_replacement_history" existing WHERE ((existing."operation_id"=NEW."operation_id")) AND EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE EXISTS (SELECT 1 FROM identity_identifier_replacement_operations owner WHERE owner.operation_id=existing.operation_id AND m.tenant_id=owner.tenant_id AND m.user_id=owner.account_id))));
END;
CREATE TRIGGER trg_guest_pii_identity_identifier_replacement_history_delete BEFORE DELETE ON "identity_identifier_replacement_history" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE EXISTS (SELECT 1 FROM identity_identifier_replacement_operations owner WHERE owner.operation_id=OLD.operation_id AND m.tenant_id=owner.tenant_id AND m.user_id=owner.account_id) AND NOT (m.state='erasing' AND m.permit_table='identity_identifier_replacement_history' AND EXISTS(SELECT 1 FROM json_each(m.permit_keys_json) key WHERE key.type='text' AND key.value=OLD."operation_id"))));
END;
CREATE TRIGGER trg_guest_pii_identity_identifier_replacement_history_update BEFORE UPDATE ON "identity_identifier_replacement_history" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (((EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE EXISTS (SELECT 1 FROM identity_identifier_replacement_operations owner WHERE owner.operation_id=OLD.operation_id AND m.tenant_id=owner.tenant_id AND m.user_id=owner.account_id)) OR EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE EXISTS (SELECT 1 FROM identity_identifier_replacement_operations owner WHERE owner.operation_id=NEW.operation_id AND m.tenant_id=owner.tenant_id AND m.user_id=owner.account_id))) AND NOT (NEW."operation_id" IS OLD."operation_id")) OR EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE ((EXISTS (SELECT 1 FROM identity_identifier_replacement_operations owner WHERE owner.operation_id=OLD.operation_id AND m.tenant_id=owner.tenant_id AND m.user_id=owner.account_id)) OR (EXISTS (SELECT 1 FROM identity_identifier_replacement_operations owner WHERE owner.operation_id=NEW.operation_id AND m.tenant_id=owner.tenant_id AND m.user_id=owner.account_id))) AND NOT (m.state='erasing' AND m.permit_table='identity_identifier_replacement_history' AND EXISTS(SELECT 1 FROM json_each(m.permit_keys_json) key WHERE key.type='text' AND key.value=OLD."operation_id"))));
END;
CREATE TRIGGER trg_guest_pii_identity_identifier_replacement_outbox_insert BEFORE INSERT ON "identity_identifier_replacement_outbox" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=NEW.tenant_id AND m.user_id=NEW.account_id) OR EXISTS(SELECT 1 FROM "identity_identifier_replacement_outbox" existing WHERE ((existing."operation_id"=NEW."operation_id") OR (existing."outbox_id"=NEW."outbox_id")) AND EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=existing.tenant_id AND m.user_id=existing.account_id)));
END;
CREATE TRIGGER trg_guest_pii_identity_identifier_replacement_outbox_delete BEFORE DELETE ON "identity_identifier_replacement_outbox" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=OLD.tenant_id AND m.user_id=OLD.account_id AND NOT (m.state='erasing' AND m.permit_table='identity_identifier_replacement_outbox' AND EXISTS(SELECT 1 FROM json_each(m.permit_keys_json) key WHERE key.type='text' AND key.value=OLD."outbox_id"))));
END;
CREATE TRIGGER trg_guest_pii_identity_identifier_replacement_outbox_update BEFORE UPDATE ON "identity_identifier_replacement_outbox" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (((EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=OLD.tenant_id AND m.user_id=OLD.account_id) OR EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=NEW.tenant_id AND m.user_id=NEW.account_id)) AND NOT (NEW."outbox_id" IS OLD."outbox_id" AND NEW.tenant_id IS OLD.tenant_id AND NEW."account_id" IS OLD."account_id")) OR EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE ((m.tenant_id=OLD.tenant_id AND m.user_id=OLD.account_id) OR (m.tenant_id=NEW.tenant_id AND m.user_id=NEW.account_id)) AND NOT (m.state='erasing' AND m.permit_table='identity_identifier_replacement_outbox' AND EXISTS(SELECT 1 FROM json_each(m.permit_keys_json) key WHERE key.type='text' AND key.value=OLD."outbox_id"))));
END;
CREATE TRIGGER trg_guest_pii_external_identifier_unlink_operations_insert BEFORE INSERT ON "external_identifier_unlink_operations" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=NEW.tenant_id AND (m.user_id=NEW.user_id OR m.account_id=NEW.account_id)) OR EXISTS(SELECT 1 FROM "external_identifier_unlink_operations" existing WHERE ((existing."operation_id"=NEW."operation_id")) AND EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=existing.tenant_id AND (m.user_id=existing.user_id OR m.account_id=existing.account_id))));
END;
CREATE TRIGGER trg_guest_pii_external_identifier_unlink_operations_delete BEFORE DELETE ON "external_identifier_unlink_operations" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=OLD.tenant_id AND (m.user_id=OLD.user_id OR m.account_id=OLD.account_id) AND NOT (m.state='erasing' AND m.permit_table='external_identifier_unlink_operations' AND EXISTS(SELECT 1 FROM json_each(m.permit_keys_json) key WHERE key.type='text' AND key.value=OLD."operation_id"))));
END;
CREATE TRIGGER trg_guest_pii_external_identifier_unlink_operations_update BEFORE UPDATE ON "external_identifier_unlink_operations" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (((EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=OLD.tenant_id AND (m.user_id=OLD.user_id OR m.account_id=OLD.account_id)) OR EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=NEW.tenant_id AND (m.user_id=NEW.user_id OR m.account_id=NEW.account_id))) AND NOT (NEW."operation_id" IS OLD."operation_id" AND NEW.tenant_id IS OLD.tenant_id AND NEW."user_id" IS OLD."user_id" AND NEW.account_id IS OLD.account_id)) OR EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE ((m.tenant_id=OLD.tenant_id AND (m.user_id=OLD.user_id OR m.account_id=OLD.account_id)) OR (m.tenant_id=NEW.tenant_id AND (m.user_id=NEW.user_id OR m.account_id=NEW.account_id))) AND NOT (m.state='erasing' AND m.permit_table='external_identifier_unlink_operations' AND EXISTS(SELECT 1 FROM json_each(m.permit_keys_json) key WHERE key.type='text' AND key.value=OLD."operation_id"))));
END;
-- Fixed-owner keyset/high-water reads must not sort or scan unrelated subjects.
CREATE INDEX idx_guest_pii_sensitive_drain ON identity_sensitive_values(tenant_id,owner_type,owner_id,id);
CREATE INDEX idx_guest_pii_linked_drain ON linked_identities(tenant_id,user_id,id);
CREATE INDEX idx_guest_pii_subject_drain ON subject_identifiers(tenant_id,subject_id,id);
CREATE INDEX idx_guest_pii_pairwise_drain ON pairwise_subject_identifiers(tenant_id,user_id,id);
CREATE INDEX idx_guest_pii_upgrade_drain ON guest_upgrade_operations(tenant_id,user_id,operation_id);
CREATE INDEX idx_guest_pii_replacement_challenge_drain ON identity_identifier_replacement_challenges(tenant_id,account_id,challenge_id);
CREATE INDEX idx_guest_pii_replacement_operation_drain ON identity_identifier_replacement_operations(tenant_id,account_id,operation_id);
CREATE INDEX idx_guest_pii_replacement_outbox_drain ON identity_identifier_replacement_outbox(tenant_id,account_id,outbox_id);
CREATE INDEX idx_guest_pii_unlink_drain ON external_identifier_unlink_operations(tenant_id,user_id,account_id,operation_id);
