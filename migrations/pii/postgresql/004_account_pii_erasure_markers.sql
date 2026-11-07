-- Migration: 004_account_pii_erasure_markers.sql
-- Description: The fence of a fully deleted account's PII (PostgreSQL), as the D1 migration of
--              the same name: a marked account's PII rows are not written with a value again.
-- Author: @authrim
-- Date: 2026-11-07
-- Issue: Account deletion vs concurrent updates

CREATE TABLE IF NOT EXISTS public.account_pii_erasure_markers (
    tenant_id text NOT NULL,
    user_id text NOT NULL,
    created_at bigint NOT NULL,
    CONSTRAINT account_pii_erasure_markers_pkey PRIMARY KEY (tenant_id, user_id)
);

CREATE OR REPLACE FUNCTION public.authrim_account_pii_erasure_guard() RETURNS TRIGGER
LANGUAGE plpgsql VOLATILE SET search_path=public,pg_temp AS $$
DECLARE
 owner_user TEXT;
BEGIN
 -- The PII mutation epoch every PII write shares (guest erasure takes it as well): an erasure takes
 -- it exclusively for its batch, so a write waits for an erasure under way and then sees its
 -- marker, and an erasure waits for writes under way and then erases what they wrote.
 PERFORM revision FROM public.guest_pii_mutation_epoch WHERE id = 1 FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'account_pii_erasure_admission_unavailable'; END IF;
 CASE TG_TABLE_NAME
 WHEN 'identity_sensitive_values' THEN
  -- Only a value written back counts (erasing sets it NULL).
  IF NEW.owner_type <> 'runtime_user' OR NEW.value_json IS NULL THEN RETURN NEW; END IF;
  owner_user := NEW.owner_id;
 WHEN 'linked_identities' THEN owner_user := NEW.user_id;
 WHEN 'subject_identifiers' THEN owner_user := NEW.subject_id;
 WHEN 'pairwise_subject_identifiers' THEN owner_user := NEW.user_id;
 WHEN 'screen_responses' THEN owner_user := NEW.user_id;
 ELSE RAISE EXCEPTION 'account_pii_erasure_table_invalid';
 END CASE;
 IF EXISTS (SELECT 1 FROM public.account_pii_erasure_markers m
             WHERE m.tenant_id = NEW.tenant_id AND m.user_id = owner_user) THEN
  RAISE EXCEPTION 'account_pii_erasure_mutation_blocked';
 END IF;
 RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_account_pii_erasure_guard ON public.identity_sensitive_values;
CREATE TRIGGER trg_account_pii_erasure_guard BEFORE INSERT OR UPDATE ON public.identity_sensitive_values
  FOR EACH ROW EXECUTE FUNCTION public.authrim_account_pii_erasure_guard();
DROP TRIGGER IF EXISTS trg_account_pii_erasure_guard ON public.linked_identities;
CREATE TRIGGER trg_account_pii_erasure_guard BEFORE INSERT OR UPDATE ON public.linked_identities
  FOR EACH ROW EXECUTE FUNCTION public.authrim_account_pii_erasure_guard();
DROP TRIGGER IF EXISTS trg_account_pii_erasure_guard ON public.subject_identifiers;
CREATE TRIGGER trg_account_pii_erasure_guard BEFORE INSERT OR UPDATE ON public.subject_identifiers
  FOR EACH ROW EXECUTE FUNCTION public.authrim_account_pii_erasure_guard();
DROP TRIGGER IF EXISTS trg_account_pii_erasure_guard ON public.pairwise_subject_identifiers;
CREATE TRIGGER trg_account_pii_erasure_guard BEFORE INSERT OR UPDATE ON public.pairwise_subject_identifiers
  FOR EACH ROW EXECUTE FUNCTION public.authrim_account_pii_erasure_guard();
DROP TRIGGER IF EXISTS trg_account_pii_erasure_guard ON public.screen_responses;
CREATE TRIGGER trg_account_pii_erasure_guard BEFORE INSERT OR UPDATE ON public.screen_responses
  FOR EACH ROW EXECUTE FUNCTION public.authrim_account_pii_erasure_guard();

-- Rollback (manual):
-- DROP TRIGGER IF EXISTS trg_account_pii_erasure_guard ON public.screen_responses;
-- DROP TRIGGER IF EXISTS trg_account_pii_erasure_guard ON public.pairwise_subject_identifiers;
-- DROP TRIGGER IF EXISTS trg_account_pii_erasure_guard ON public.subject_identifiers;
-- DROP TRIGGER IF EXISTS trg_account_pii_erasure_guard ON public.linked_identities;
-- DROP TRIGGER IF EXISTS trg_account_pii_erasure_guard ON public.identity_sensitive_values;
-- DROP FUNCTION IF EXISTS public.authrim_account_pii_erasure_guard();
-- DROP TABLE IF EXISTS public.account_pii_erasure_markers;
