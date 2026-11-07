-- Migration: 004_account_pii_erasure_markers.sql
-- Description: The fence of a fully deleted account's PII. A full account deletion writes the
--              account's marker in the same batch that erases its PII; from then on no write puts a
--              value back for it (a concurrent update that read the user before the deletion, an
--              IdP sign-in refreshing its attributes): inserting or updating a PII row of a marked
--              account with a value is refused. Erasing (a NULL value, a deleted row) is not. A
--              PII-only deletion, which keeps the account usable, writes no marker.
-- Author: @authrim
-- Date: 2026-11-07
-- Issue: Account deletion vs concurrent updates

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

CREATE TABLE account_pii_erasure_markers (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TRIGGER trg_account_pii_erasure_sensitive_insert BEFORE INSERT ON identity_sensitive_values
WHEN NEW.owner_type = 'runtime_user' AND NEW.value_json IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'account_pii_erasure_mutation_blocked') WHERE EXISTS (
    SELECT 1 FROM account_pii_erasure_markers m
     WHERE m.tenant_id = NEW.tenant_id AND m.user_id = NEW.owner_id);
END;

CREATE TRIGGER trg_account_pii_erasure_sensitive_update BEFORE UPDATE ON identity_sensitive_values
WHEN NEW.owner_type = 'runtime_user' AND NEW.value_json IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'account_pii_erasure_mutation_blocked') WHERE EXISTS (
    SELECT 1 FROM account_pii_erasure_markers m
     WHERE m.tenant_id = NEW.tenant_id AND m.user_id = NEW.owner_id);
END;

CREATE TRIGGER trg_account_pii_erasure_linked_insert BEFORE INSERT ON linked_identities BEGIN
  SELECT RAISE(ABORT, 'account_pii_erasure_mutation_blocked') WHERE EXISTS (
    SELECT 1 FROM account_pii_erasure_markers m
     WHERE m.tenant_id = NEW.tenant_id AND m.user_id = NEW.user_id);
END;

CREATE TRIGGER trg_account_pii_erasure_linked_update BEFORE UPDATE ON linked_identities BEGIN
  SELECT RAISE(ABORT, 'account_pii_erasure_mutation_blocked') WHERE EXISTS (
    SELECT 1 FROM account_pii_erasure_markers m
     WHERE m.tenant_id = NEW.tenant_id AND m.user_id = NEW.user_id);
END;

CREATE TRIGGER trg_account_pii_erasure_subject_insert BEFORE INSERT ON subject_identifiers BEGIN
  SELECT RAISE(ABORT, 'account_pii_erasure_mutation_blocked') WHERE EXISTS (
    SELECT 1 FROM account_pii_erasure_markers m
     WHERE m.tenant_id = NEW.tenant_id AND m.user_id = NEW.subject_id);
END;

CREATE TRIGGER trg_account_pii_erasure_subject_update BEFORE UPDATE ON subject_identifiers BEGIN
  SELECT RAISE(ABORT, 'account_pii_erasure_mutation_blocked') WHERE EXISTS (
    SELECT 1 FROM account_pii_erasure_markers m
     WHERE m.tenant_id = NEW.tenant_id AND m.user_id = NEW.subject_id);
END;

CREATE TRIGGER trg_account_pii_erasure_pairwise_insert BEFORE INSERT ON pairwise_subject_identifiers BEGIN
  SELECT RAISE(ABORT, 'account_pii_erasure_mutation_blocked') WHERE EXISTS (
    SELECT 1 FROM account_pii_erasure_markers m
     WHERE m.tenant_id = NEW.tenant_id AND m.user_id = NEW.user_id);
END;

CREATE TRIGGER trg_account_pii_erasure_pairwise_update BEFORE UPDATE ON pairwise_subject_identifiers BEGIN
  SELECT RAISE(ABORT, 'account_pii_erasure_mutation_blocked') WHERE EXISTS (
    SELECT 1 FROM account_pii_erasure_markers m
     WHERE m.tenant_id = NEW.tenant_id AND m.user_id = NEW.user_id);
END;

CREATE TRIGGER trg_account_pii_erasure_screen_insert BEFORE INSERT ON screen_responses BEGIN
  SELECT RAISE(ABORT, 'account_pii_erasure_mutation_blocked') WHERE EXISTS (
    SELECT 1 FROM account_pii_erasure_markers m
     WHERE m.tenant_id = NEW.tenant_id AND m.user_id = NEW.user_id);
END;

CREATE TRIGGER trg_account_pii_erasure_screen_update BEFORE UPDATE ON screen_responses BEGIN
  SELECT RAISE(ABORT, 'account_pii_erasure_mutation_blocked') WHERE EXISTS (
    SELECT 1 FROM account_pii_erasure_markers m
     WHERE m.tenant_id = NEW.tenant_id AND m.user_id = NEW.user_id);
END;

-- =============================================================================
-- Down Migration (Rollback) - COMMENTED OUT
-- =============================================================================
-- DROP TRIGGER trg_account_pii_erasure_screen_update;
-- DROP TRIGGER trg_account_pii_erasure_screen_insert;
-- DROP TRIGGER trg_account_pii_erasure_pairwise_update;
-- DROP TRIGGER trg_account_pii_erasure_pairwise_insert;
-- DROP TRIGGER trg_account_pii_erasure_subject_update;
-- DROP TRIGGER trg_account_pii_erasure_subject_insert;
-- DROP TRIGGER trg_account_pii_erasure_linked_update;
-- DROP TRIGGER trg_account_pii_erasure_linked_insert;
-- DROP TRIGGER trg_account_pii_erasure_sensitive_update;
-- DROP TRIGGER trg_account_pii_erasure_sensitive_insert;
-- DROP TABLE account_pii_erasure_markers;
-- DELETE FROM schema_migrations WHERE version = 4;
