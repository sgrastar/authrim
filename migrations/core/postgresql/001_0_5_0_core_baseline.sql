-- Authrim 0.5.0 semantic fresh-install baseline.
-- Logical stream: core-postgresql.
-- Generated from the final database state; do not append historical migration SQL here.
-- Fresh-install baselines must never be applied to upgrade an existing database.
--
-- PostgreSQL database dump
--

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: account_webhook_guest_retention_fn(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.account_webhook_guest_retention_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, changed_field, occurred_at) SELECT 'evt_' || replace(gen_random_uuid()::text, '-', ''), a.tenant_id, a.legacy_user_id, 'account.updated', 'guest', 'account', __AUTHRIM_NOW_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.tenant_id = NEW.tenant_id AND a.legacy_user_id = NEW.user_id AND a.account_type = 'user' AND a.registration_state = 'guest' AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleting', 'deleted') AND NEW.phase IN ('active', 'upgrading') AND (NEW.deletion_due_at IS DISTINCT FROM OLD.deletion_due_at OR NEW.upgrade_hold_until IS DISTINCT FROM OLD.upgrade_hold_until OR NEW.policy_version IS DISTINCT FROM OLD.policy_version);
RETURN NEW;
END;
$$;

--
-- Name: authrim_account_creation_operation_status_transition(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.authrim_account_creation_operation_status_transition() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.status <> NEW.status AND NOT (
    (OLD.status = 'preparing' AND NEW.status IN ('reserved', 'blocked', 'canceled')) OR
    (OLD.status = 'reserved' AND NEW.status IN ('writing', 'blocked', 'canceled')) OR
    (OLD.status = 'writing' AND NEW.status IN ('directory_pending', 'succeeded', 'blocked')) OR
    (OLD.status = 'directory_pending' AND NEW.status IN ('succeeded', 'blocked')) OR
    (OLD.status = 'blocked' AND NEW.status IN ('reserved', 'writing', 'directory_pending', 'canceled'))
  ) THEN RAISE EXCEPTION 'invalid_account_creation_operation_status_transition'; END IF;
  RETURN NEW;
END; $$;

--
-- Name: authrim_account_lifecycle_event_outbox_initial_state(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.authrim_account_lifecycle_event_outbox_initial_state() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.status <> 'pending' OR NEW.attempt_count <> 0 THEN
    RAISE EXCEPTION 'invalid_account_lifecycle_event_initial_state';
  END IF;
  RETURN NEW;
END; $$;

--
-- Name: authrim_account_lifecycle_event_outbox_status_transition(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.authrim_account_lifecycle_event_outbox_status_transition() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.status <> NEW.status AND NOT (
    (OLD.status = 'pending' AND NEW.status IN ('leased', 'succeeded', 'dead_letter')) OR
    (OLD.status = 'leased' AND NEW.status IN ('retry', 'succeeded', 'dead_letter')) OR
    (OLD.status = 'retry' AND NEW.status IN ('leased', 'succeeded', 'dead_letter'))
  ) THEN RAISE EXCEPTION 'invalid_account_lifecycle_event_status_transition'; END IF;
  RETURN NEW;
END; $$;

--
-- Name: authrim_account_webhook_contact_points_delete(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.authrim_account_webhook_contact_points_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || replace(gen_random_uuid()::text, '-', ''), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'contact', __AUTHRIM_NOW_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = OLD.tenant_id AND a.id = OLD.account_id AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || replace(gen_random_uuid()::text, '-', ''), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'contact', __AUTHRIM_NOW_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = OLD.tenant_id AND a.primary_subject_id = OLD.subject_id AND a.id IS DISTINCT FROM OLD.account_id AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
RETURN NULL;
END;
$$;

--
-- Name: authrim_account_webhook_contact_points_insert(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.authrim_account_webhook_contact_points_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || replace(gen_random_uuid()::text, '-', ''), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'contact', __AUTHRIM_NOW_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND a.id = NEW.account_id AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || replace(gen_random_uuid()::text, '-', ''), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'contact', __AUTHRIM_NOW_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND a.primary_subject_id = NEW.subject_id AND a.id IS DISTINCT FROM NEW.account_id AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
RETURN NULL;
END;
$$;

--
-- Name: authrim_account_webhook_contact_points_update(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.authrim_account_webhook_contact_points_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || replace(gen_random_uuid()::text, '-', ''), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'contact', __AUTHRIM_NOW_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND a.id = NEW.account_id AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || replace(gen_random_uuid()::text, '-', ''), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'contact', __AUTHRIM_NOW_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND a.primary_subject_id = NEW.subject_id AND a.id IS DISTINCT FROM NEW.account_id AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
RETURN NULL;
END;
$$;

--
-- Name: authrim_account_webhook_created_activate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.authrim_account_webhook_created_activate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || replace(gen_random_uuid()::text, '-', ''), a.tenant_id, a.legacy_user_id, 'account.created', a.registration_state, NULL, NULL, __AUTHRIM_NOW_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.id = NEW.id AND a.tenant_id = NEW.tenant_id AND (OLD.directory_publication_state <> 'active' AND NEW.directory_publication_state = 'active' AND OLD.directory_publication_state <> 'disabled'));
RETURN NULL;
END;
$$;

--
-- Name: authrim_account_webhook_created_insert(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.authrim_account_webhook_created_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || replace(gen_random_uuid()::text, '-', ''), a.tenant_id, a.legacy_user_id, 'account.created', a.registration_state, NULL, NULL, __AUTHRIM_NOW_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.id = NEW.id AND a.tenant_id = NEW.tenant_id AND (NEW.directory_publication_state = 'active'));
RETURN NULL;
END;
$$;

--
-- Name: authrim_account_webhook_deleted(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.authrim_account_webhook_deleted() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || replace(gen_random_uuid()::text, '-', ''), a.tenant_id, a.legacy_user_id, 'account.deleted', a.registration_state, NULL, NULL, __AUTHRIM_NOW_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.id = NEW.id AND a.tenant_id = NEW.tenant_id AND (NEW.lifecycle_state = 'deleted' AND OLD.lifecycle_state <> 'deleted'));
RETURN NULL;
END;
$$;

--
-- Name: authrim_account_webhook_guest_committed(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.authrim_account_webhook_guest_committed() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || replace(gen_random_uuid()::text, '-', ''), a.tenant_id, a.legacy_user_id, 'account.registration.changed', 'registered', 'guest', 'registration_state', __AUTHRIM_NOW_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND a.legacy_user_id = NEW.user_id AND OLD.phase = 'upgrading' AND NEW.phase = 'registered' AND a.registration_state = 'registered');
RETURN NULL;
END;
$$;

--
-- Name: authrim_account_webhook_profile_attribute_values_delete(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.authrim_account_webhook_profile_attribute_values_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || replace(gen_random_uuid()::text, '-', ''), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'profile', __AUTHRIM_NOW_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = OLD.tenant_id AND a.primary_subject_id = (SELECT p.subject_id FROM profiles p WHERE p.id = OLD.profile_id AND p.tenant_id = OLD.tenant_id) AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
RETURN NULL;
END;
$$;

--
-- Name: authrim_account_webhook_profile_attribute_values_insert(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.authrim_account_webhook_profile_attribute_values_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || replace(gen_random_uuid()::text, '-', ''), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'profile', __AUTHRIM_NOW_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND a.primary_subject_id = (SELECT p.subject_id FROM profiles p WHERE p.id = NEW.profile_id AND p.tenant_id = NEW.tenant_id) AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
RETURN NULL;
END;
$$;

--
-- Name: authrim_account_webhook_profile_attribute_values_update(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.authrim_account_webhook_profile_attribute_values_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || replace(gen_random_uuid()::text, '-', ''), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'profile', __AUTHRIM_NOW_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND a.primary_subject_id = (SELECT p.subject_id FROM profiles p WHERE p.id = NEW.profile_id AND p.tenant_id = NEW.tenant_id) AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
RETURN NULL;
END;
$$;

--
-- Name: authrim_account_webhook_profiles_delete(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.authrim_account_webhook_profiles_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || replace(gen_random_uuid()::text, '-', ''), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'profile', __AUTHRIM_NOW_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = OLD.tenant_id AND (a.primary_subject_id = OLD.subject_id) AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
RETURN NULL;
END;
$$;

--
-- Name: authrim_account_webhook_profiles_insert(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.authrim_account_webhook_profiles_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || replace(gen_random_uuid()::text, '-', ''), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'profile', __AUTHRIM_NOW_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND (a.primary_subject_id = NEW.subject_id) AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
RETURN NULL;
END;
$$;

--
-- Name: authrim_account_webhook_profiles_update(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.authrim_account_webhook_profiles_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || replace(gen_random_uuid()::text, '-', ''), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'profile', __AUTHRIM_NOW_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND (a.primary_subject_id = NEW.subject_id) AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
RETURN NULL;
END;
$$;

--
-- Name: authrim_account_webhook_registration(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.authrim_account_webhook_registration() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || replace(gen_random_uuid()::text, '-', ''), a.tenant_id, a.legacy_user_id, 'account.registration.changed', a.registration_state, OLD.registration_state, 'registration_state', __AUTHRIM_NOW_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.id = NEW.id AND a.tenant_id = NEW.tenant_id AND (OLD.registration_state <> NEW.registration_state AND (NEW.registration_state = 'guest' OR NOT EXISTS (SELECT 1 FROM guest_account_lifecycle g WHERE g.tenant_id = NEW.tenant_id AND g.user_id = NEW.legacy_user_id AND g.phase <> 'registered'))));
RETURN NULL;
END;
$$;

--
-- Name: authrim_account_webhook_updated(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.authrim_account_webhook_updated() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || replace(gen_random_uuid()::text, '-', ''), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'account', __AUTHRIM_NOW_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.id = NEW.id AND a.tenant_id = NEW.tenant_id AND (NEW.lifecycle_state NOT IN ('deleted', 'deleting') AND OLD.directory_publication_state = 'active' AND NEW.registration_state = OLD.registration_state AND (NEW.lifecycle_state IS DISTINCT FROM OLD.lifecycle_state OR NEW.display_label IS DISTINCT FROM OLD.display_label OR NEW.metadata_json IS DISTINCT FROM OLD.metadata_json)));
RETURN NULL;
END;
$$;

--
-- Name: authrim_account_webhook_user_custom_fields_delete(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.authrim_account_webhook_user_custom_fields_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || replace(gen_random_uuid()::text, '-', ''), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'custom_profile', __AUTHRIM_NOW_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = OLD.tenant_id AND (a.legacy_user_id = OLD.user_id) AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
RETURN NULL;
END;
$$;

--
-- Name: authrim_account_webhook_user_custom_fields_insert(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.authrim_account_webhook_user_custom_fields_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || replace(gen_random_uuid()::text, '-', ''), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'custom_profile', __AUTHRIM_NOW_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND (a.legacy_user_id = NEW.user_id) AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
RETURN NULL;
END;
$$;

--
-- Name: authrim_account_webhook_user_custom_fields_update(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.authrim_account_webhook_user_custom_fields_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || replace(gen_random_uuid()::text, '-', ''), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'custom_profile', __AUTHRIM_NOW_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND (a.legacy_user_id = NEW.user_id) AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
RETURN NULL;
END;
$$;

--
-- Name: authrim_guest_core_boundary_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.authrim_guest_core_boundary_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

--
-- Name: authrim_guest_core_hold_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.authrim_guest_core_hold_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

--
-- Name: authrim_guest_core_page_permitted(text, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.authrim_guest_core_page_permitted(p_tenant text, p_user text, p_table text, p_id text) RETURNS boolean
    LANGUAGE sql
    AS $$
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

--
-- Name: authrim_guest_core_parent_epoch_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.authrim_guest_core_parent_epoch_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

--
-- Name: authrim_guest_core_source_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.authrim_guest_core_source_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

--
-- Name: authrim_guest_erasure_json(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.authrim_guest_erasure_json(value text) RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE
    AS $$
BEGIN
  RETURN COALESCE(value::jsonb,'{}'::jsonb);
EXCEPTION WHEN invalid_text_representation THEN
  RETURN '{}'::jsonb;
END;
$$;

--
-- Name: authrim_identity_account_active_hold_delete(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.authrim_identity_account_active_hold_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM legal_holds hold
     WHERE hold.tenant_id = OLD.tenant_id AND hold.subject_type = 'account'
       AND hold.subject_id = OLD.id AND hold.state = 'active'
  ) THEN
    RAISE EXCEPTION 'account_legal_hold_active';
  END IF;
  RETURN OLD;
END;
$$;

--
-- Name: authrim_identity_account_legal_hold_state_insert(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.authrim_identity_account_legal_hold_state_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO account_legal_hold_states (
    tenant_id, account_id, active_hold_id, projection_state, projection_generation, updated_at
  ) VALUES (NEW.tenant_id, NEW.id, NULL, 'inactive', 1, NEW.updated_at)
  ON CONFLICT (tenant_id, account_id) DO NOTHING;
  RETURN NEW;
END;
$$;

--
-- Name: authrim_legal_hold_event_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.authrim_legal_hold_event_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'legal_hold_event_immutable';
END;
$$;

--
-- Name: authrim_legal_hold_forbid_delete(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.authrim_legal_hold_forbid_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'legal_hold_delete_forbidden';
END;
$$;

--
-- Name: authrim_legal_hold_projection_state_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.authrim_legal_hold_projection_state_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO account_legal_hold_states (
      tenant_id, account_id, active_hold_id, projection_state, projection_generation, updated_at
    ) VALUES (NEW.tenant_id, NEW.subject_id, NEW.id, 'active', 1, NEW.updated_at)
    ON CONFLICT (tenant_id, account_id) DO UPDATE SET
      active_hold_id = EXCLUDED.active_hold_id,
      projection_state = 'active',
      projection_generation = account_legal_hold_states.projection_generation + 1,
      updated_at = EXCLUDED.updated_at;
  ELSIF OLD.state = 'active' AND NEW.state IN ('released', 'expired') THEN
    UPDATE account_legal_hold_states
       SET active_hold_id = NULL, projection_state = 'inactive',
           projection_generation = projection_generation + 1, updated_at = NEW.updated_at
     WHERE tenant_id = NEW.tenant_id AND account_id = NEW.subject_id
       AND active_hold_id = NEW.id AND projection_state = 'active';
  END IF;
  RETURN NEW;
END;
$$;

--
-- Name: authrim_legal_hold_validate_account(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.authrim_legal_hold_validate_account() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM identity_accounts account
     WHERE account.id = NEW.subject_id AND account.tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'legal_hold_account_not_found';
  END IF;
  RETURN NEW;
END;
$$;

--
-- Name: authrim_legal_hold_validate_update(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.authrim_legal_hold_validate_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.tenant_id <> NEW.tenant_id OR OLD.subject_type <> NEW.subject_type OR
     OLD.subject_id <> NEW.subject_id THEN
    RAISE EXCEPTION 'legal_hold_subject_immutable';
  END IF;
  IF NOT (
    OLD.state = 'active' AND NEW.state IN ('active', 'released', 'expired') AND
    NEW.version = OLD.version + 1 AND NEW.created_by = OLD.created_by AND
    NEW.created_at = OLD.created_at
  ) THEN
    RAISE EXCEPTION 'legal_hold_transition_invalid';
  END IF;
  RETURN NEW;
END;
$$;

--
-- Name: authrim_support_context_active_hold_delete(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.authrim_support_context_active_hold_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM legal_holds hold
     WHERE hold.tenant_id = OLD.tenant_id AND hold.subject_type = 'account'
       AND hold.subject_id = OLD.account_id AND hold.state = 'active'
  ) THEN
    RAISE EXCEPTION 'account_support_context_legal_hold_active';
  END IF;
  RETURN OLD;
END;
$$;

--
-- Name: authrim_support_context_validate_account(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.authrim_support_context_validate_account() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM identity_accounts account
     WHERE account.id = NEW.account_id AND account.tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'account_support_context_account_not_found';
  END IF;
  RETURN NEW;
END;
$$;

--
-- Name: authrim_support_context_validate_update(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.authrim_support_context_validate_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.tenant_id <> NEW.tenant_id OR OLD.account_id <> NEW.account_id THEN
    RAISE EXCEPTION 'account_support_context_account_immutable';
  END IF;
  IF NEW.version <> OLD.version + 1 OR NEW.created_by <> OLD.created_by OR
     NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'account_support_context_version_invalid';
  END IF;
  RETURN NEW;
END;
$$;

--
-- Name: authrim_tenant_lookup_retention_policy_insert(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.authrim_tenant_lookup_retention_policy_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO lookup_retention_policies (
    tenant_id, retention_days, policy_generation, updated_by, created_at, updated_at
  ) VALUES (NEW.id, 180, 1, 'tenant-default', NEW.created_at, NEW.updated_at)
  ON CONFLICT (tenant_id) DO NOTHING;
  INSERT INTO lookup_retention_policy_projection_outbox (
    operation_id, tenant_id, policy_generation, retention_days,
    next_attempt_at, created_at, updated_at
  )
  SELECT 'lookup-retention-policy:init:' || md5(tenant_id || ':' || policy_generation::text),
         tenant_id, policy_generation, retention_days, updated_at, created_at, updated_at
    FROM lookup_retention_policies WHERE tenant_id = NEW.id
  ON CONFLICT (tenant_id, policy_generation) DO NOTHING;
  RETURN NEW;
END;
$$;

--
-- Name: sg_contact_points_delete_fn(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sg_contact_points_delete_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT OLD.tenant_id, (SELECT legacy_user_id FROM identity_accounts WHERE id = OLD.account_id AND tenant_id = OLD.tenant_id), 1 WHERE (OLD.account_id IS NOT NULL) AND (SELECT legacy_user_id FROM identity_accounts WHERE id = OLD.account_id AND tenant_id = OLD.tenant_id) IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
 RETURN OLD; END; $$;

--
-- Name: sg_contact_points_insert_fn(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sg_contact_points_insert_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, (SELECT legacy_user_id FROM identity_accounts WHERE id = NEW.account_id AND tenant_id = NEW.tenant_id), 1 WHERE (NEW.account_id IS NOT NULL) AND (SELECT legacy_user_id FROM identity_accounts WHERE id = NEW.account_id AND tenant_id = NEW.tenant_id) IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
 RETURN NEW; END; $$;

--
-- Name: sg_contact_points_update_fn(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sg_contact_points_update_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, (SELECT legacy_user_id FROM identity_accounts WHERE id = NEW.account_id AND tenant_id = NEW.tenant_id), 1 WHERE (NEW.account_id IS NOT NULL) AND (SELECT legacy_user_id FROM identity_accounts WHERE id = NEW.account_id AND tenant_id = NEW.tenant_id) IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
 RETURN NEW; END; $$;

--
-- Name: sg_epoch_custom_claim_schemas_delete_fn(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sg_epoch_custom_claim_schemas_delete_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN
 INSERT INTO service_group_epoch(tenant_id, revision) VALUES (OLD.tenant_id, 1) ON CONFLICT(tenant_id) DO UPDATE SET revision = service_group_epoch.revision + 1;
 RETURN OLD; END; $$;

--
-- Name: sg_epoch_custom_claim_schemas_insert_fn(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sg_epoch_custom_claim_schemas_insert_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN
 INSERT INTO service_group_epoch(tenant_id, revision) VALUES (NEW.tenant_id, 1) ON CONFLICT(tenant_id) DO UPDATE SET revision = service_group_epoch.revision + 1;
 RETURN NEW; END; $$;

--
-- Name: sg_epoch_custom_claim_schemas_update_fn(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sg_epoch_custom_claim_schemas_update_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN
 INSERT INTO service_group_epoch(tenant_id, revision) VALUES (NEW.tenant_id, 1) ON CONFLICT(tenant_id) DO UPDATE SET revision = service_group_epoch.revision + 1;
 RETURN NEW; END; $$;

--
-- Name: sg_epoch_roles_delete_fn(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sg_epoch_roles_delete_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN
 INSERT INTO service_group_epoch(tenant_id, revision) VALUES (OLD.tenant_id, 1) ON CONFLICT(tenant_id) DO UPDATE SET revision = service_group_epoch.revision + 1;
 RETURN OLD; END; $$;

--
-- Name: sg_epoch_roles_insert_fn(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sg_epoch_roles_insert_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN
 INSERT INTO service_group_epoch(tenant_id, revision) VALUES (NEW.tenant_id, 1) ON CONFLICT(tenant_id) DO UPDATE SET revision = service_group_epoch.revision + 1;
 RETURN NEW; END; $$;

--
-- Name: sg_epoch_roles_update_fn(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sg_epoch_roles_update_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN
 INSERT INTO service_group_epoch(tenant_id, revision) VALUES (NEW.tenant_id, 1) ON CONFLICT(tenant_id) DO UPDATE SET revision = service_group_epoch.revision + 1;
 RETURN NEW; END; $$;

--
-- Name: sg_identity_accounts_delete_fn(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sg_identity_accounts_delete_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT OLD.tenant_id, OLD.legacy_user_id, 1 WHERE (OLD.legacy_user_id IS NOT NULL) AND OLD.legacy_user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
 RETURN OLD; END; $$;

--
-- Name: sg_identity_accounts_insert_fn(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sg_identity_accounts_insert_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, NEW.legacy_user_id, 1 WHERE (NEW.legacy_user_id IS NOT NULL) AND NEW.legacy_user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
 RETURN NEW; END; $$;

--
-- Name: sg_identity_accounts_update_fn(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sg_identity_accounts_update_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, NEW.legacy_user_id, 1 WHERE (NEW.legacy_user_id IS NOT NULL) AND NEW.legacy_user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
 RETURN NEW; END; $$;

--
-- Name: sg_service_group_manual_delete_fn(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sg_service_group_manual_delete_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT OLD.tenant_id, OLD.user_id, 1 WHERE (1=1) AND OLD.user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
 RETURN OLD; END; $$;

--
-- Name: sg_service_group_manual_insert_fn(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sg_service_group_manual_insert_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, NEW.user_id, 1 WHERE (1=1) AND NEW.user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
 RETURN NEW; END; $$;

--
-- Name: sg_service_group_manual_update_fn(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sg_service_group_manual_update_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, NEW.user_id, 1 WHERE (1=1) AND NEW.user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
 RETURN NEW; END; $$;

--
-- Name: sg_user_custom_fields_delete_fn(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sg_user_custom_fields_delete_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT OLD.tenant_id, OLD.user_id, 1 WHERE (1=1) AND OLD.user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
 RETURN OLD; END; $$;

--
-- Name: sg_user_custom_fields_insert_fn(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sg_user_custom_fields_insert_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, NEW.user_id, 1 WHERE (1=1) AND NEW.user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
 RETURN NEW; END; $$;

--
-- Name: sg_user_custom_fields_update_fn(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sg_user_custom_fields_update_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, NEW.user_id, 1 WHERE (1=1) AND NEW.user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
 RETURN NEW; END; $$;

--
-- Name: sg_user_roles_delete_fn(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sg_user_roles_delete_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT OLD.tenant_id, OLD.user_id, 1 WHERE (1=1) AND OLD.user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
 RETURN OLD; END; $$;

--
-- Name: sg_user_roles_insert_fn(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sg_user_roles_insert_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, NEW.user_id, 1 WHERE (1=1) AND NEW.user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
 RETURN NEW; END; $$;

--
-- Name: sg_user_roles_update_fn(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sg_user_roles_update_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, NEW.user_id, 1 WHERE (1=1) AND NEW.user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
 RETURN NEW; END; $$;

--
-- Name: sg_write_boundary_delete_fn(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sg_write_boundary_delete_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) VALUES (OLD.tenant_id, OLD.user_id, 1) ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
 RETURN OLD; END; $$;

--
-- Name: sg_write_boundary_insert_fn(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sg_write_boundary_insert_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) VALUES (NEW.tenant_id, NEW.user_id, 1) ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
 RETURN NEW; END; $$;

--
-- Name: statement_consent_admission_immutable_fn(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.statement_consent_admission_immutable_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TRUE THEN RAISE EXCEPTION 'statement_consent_admission_immutable'; END IF;
  RETURN NEW;
END;
$$;

--
-- Name: statement_consent_admissions_replace_guard_fn(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.statement_consent_admissions_replace_guard_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM statement_consent_admissions r WHERE r.tenant_id = NEW.tenant_id AND r.operation_id = NEW.operation_id) THEN RAISE EXCEPTION 'statement_consent_admissions_replace_guard'; END IF;
  RETURN NEW;
END;
$$;

--
-- Name: statement_consent_consent_item_history_delete_guard_fn(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.statement_consent_consent_item_history_delete_guard_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = OLD.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled')) AND NOT (EXISTS (SELECT 1 FROM statement_consent_retention_permits p
    JOIN statement_consent_guards g ON g.tenant_id=p.tenant_id AND g.scope_kind='tenant' AND g.scope_key=''
    WHERE p.tenant_id=OLD.tenant_id AND p.row_kind='history' AND p.row_id=OLD.id
      AND p.user_id=OLD.user_id AND p.statement_id=OLD.statement_id
      AND p.account_id=g.account_id AND p.physical_id=g.physical_id AND p.restore_epoch=g.restore_epoch
      AND CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000) AS BIGINT) BETWEEN p.issued_at AND p.expires_at AND p.cutoff_at<=CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000) AS BIGINT)
      AND NOT EXISTS (SELECT 1 FROM user_consent_records r WHERE r.tenant_id=OLD.tenant_id AND r.user_id=OLD.user_id AND r.statement_id=OLD.statement_id AND r.status='granted')
      AND ((OLD.consent_settings_snapshot_at IS NOT NULL AND OLD.retain_until IS NOT NULL AND OLD.retain_until<p.cutoff_at)
        OR (OLD.consent_settings_snapshot_at IS NULL AND p.legacy_retention_days IS NOT NULL
          AND OLD.created_at<p.cutoff_at-p.legacy_retention_days*86400000)))) THEN RAISE EXCEPTION 'statement_consent_consent_item_history_delete_guard'; END IF;
  RETURN OLD;
END;
$$;

--
-- Name: statement_consent_consent_item_history_insert_guard_fn(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.statement_consent_consent_item_history_insert_guard_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = NEW.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled')) AND NOT (EXISTS (SELECT 1 FROM statement_consent_operations o WHERE o.tenant_id = NEW.tenant_id AND o.user_id = NEW.user_id
              AND o.statement_id = NEW.statement_id AND o.status = 'executing' AND o.admitted = 1 AND o.is_noop = 0 AND CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000) AS BIGINT) BETWEEN o.issued_at AND o.expires_at
              AND jsonb_build_object('id', NEW.id, 'tenant_id', NEW.tenant_id, 'user_id', NEW.user_id, 'statement_id', NEW.statement_id, 'action', NEW.action, 'version_before', NEW.version_before, 'version_after', NEW.version_after, 'status_before', NEW.status_before, 'status_after', NEW.status_after, 'client_id', NEW.client_id, 'created_at', NEW.created_at, 'version_id_before', NEW.version_id_before, 'version_id_after', NEW.version_id_after, 'granted_at', NEW.granted_at, 'withdrawn_at', NEW.withdrawn_at, 'expires_at', NEW.expires_at, 'retain_until', NEW.retain_until, 'consent_settings_snapshot_at', NEW.consent_settings_snapshot_at, 'record_retention_days_snapshot', NEW.record_retention_days_snapshot, 'reconsent_interval_days_snapshot', NEW.reconsent_interval_days_snapshot, 'content_hash_after', NEW.content_hash_after) = (o.history_json)::jsonb)) THEN RAISE EXCEPTION 'statement_consent_consent_item_history_insert_guard'; END IF;
  RETURN NEW;
END;
$$;

--
-- Name: statement_consent_consent_item_history_update_guard_fn(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.statement_consent_consent_item_history_update_guard_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF ((EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = OLD.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled')) OR (EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = NEW.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled'))) AND NOT (((NEW.id IS NOT DISTINCT FROM OLD.id) AND (NEW.tenant_id IS NOT DISTINCT FROM OLD.tenant_id) AND (NEW.user_id IS NOT DISTINCT FROM OLD.user_id) AND (NEW.statement_id IS NOT DISTINCT FROM OLD.statement_id) AND (NEW.action IS NOT DISTINCT FROM OLD.action) AND (NEW.version_before IS NOT DISTINCT FROM OLD.version_before) AND (NEW.version_after IS NOT DISTINCT FROM OLD.version_after) AND (NEW.status_before IS NOT DISTINCT FROM OLD.status_before) AND (NEW.status_after IS NOT DISTINCT FROM OLD.status_after) AND (NEW.client_id IS NOT DISTINCT FROM OLD.client_id) AND (NEW.created_at IS NOT DISTINCT FROM OLD.created_at) AND (NEW.version_id_before IS NOT DISTINCT FROM OLD.version_id_before) AND (NEW.version_id_after IS NOT DISTINCT FROM OLD.version_id_after) AND (NEW.granted_at IS NOT DISTINCT FROM OLD.granted_at) AND (NEW.withdrawn_at IS NOT DISTINCT FROM OLD.withdrawn_at) AND (NEW.expires_at IS NOT DISTINCT FROM OLD.expires_at) AND (NEW.ip_address_hash IS NOT DISTINCT FROM OLD.ip_address_hash) AND (NEW.user_agent IS NOT DISTINCT FROM OLD.user_agent) AND (NEW.content_hash_after IS NOT DISTINCT FROM OLD.content_hash_after) AND (NEW.metadata_json IS NOT DISTINCT FROM OLD.metadata_json)) AND EXISTS (SELECT 1 FROM statement_consent_operations o WHERE o.tenant_id = OLD.tenant_id AND o.user_id = OLD.user_id AND o.statement_id = OLD.statement_id
                  AND o.status = 'executing' AND o.admitted = 1 AND o.is_noop = 0 AND o.before_json IS NOT NULL AND CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000) AS BIGINT) BETWEEN o.issued_at AND o.expires_at
                  AND (OLD.retain_until IS NULL OR OLD.retain_until < CAST((o.after_json::jsonb ->> 'retain_until') AS BIGINT)) AND (NEW.retain_until IS NOT DISTINCT FROM CAST((o.after_json::jsonb ->> 'retain_until') AS BIGINT)) AND (NEW.consent_settings_snapshot_at IS NOT DISTINCT FROM CAST((o.after_json::jsonb ->> 'consent_settings_snapshot_at') AS BIGINT)) AND (NEW.record_retention_days_snapshot IS NOT DISTINCT FROM CAST((o.after_json::jsonb ->> 'record_retention_days_snapshot') AS BIGINT)) AND (NEW.reconsent_interval_days_snapshot IS NOT DISTINCT FROM CAST((o.after_json::jsonb ->> 'reconsent_interval_days_snapshot') AS BIGINT)))) THEN RAISE EXCEPTION 'statement_consent_consent_item_history_update_guard'; END IF;
  RETURN NEW;
END;
$$;

--
-- Name: statement_consent_guard_delete_fn(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.statement_consent_guard_delete_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.mode <> 'disabled' THEN RAISE EXCEPTION 'statement_consent_guard_delete'; END IF;
  RETURN OLD;
END;
$$;

--
-- Name: statement_consent_guard_monotonic_fn(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.statement_consent_guard_monotonic_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.scope_kind <> OLD.scope_kind OR NEW.scope_key <> OLD.scope_key OR NEW.definition_generation < OLD.definition_generation OR NEW.closed_generation < OLD.closed_generation OR NEW.account_id <> OLD.account_id OR NEW.physical_id <> OLD.physical_id OR NEW.restore_epoch <> OLD.restore_epoch OR NEW.updated_at < OLD.updated_at OR (OLD.mode = 'closed' AND NEW.mode <> 'closed' AND NOT (OLD.scope_kind = 'statement' AND NEW.mode = 'enforced' AND NEW.definition_generation > OLD.definition_generation)) OR (OLD.mode = 'enforced' AND NEW.mode = 'disabled') THEN RAISE EXCEPTION 'statement_consent_guard_monotonic'; END IF;
  RETURN NEW;
END;
$$;

--
-- Name: statement_consent_guards_replace_guard_fn(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.statement_consent_guards_replace_guard_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM statement_consent_guards r WHERE r.tenant_id = NEW.tenant_id AND r.scope_kind = NEW.scope_kind AND r.scope_key = NEW.scope_key) THEN RAISE EXCEPTION 'statement_consent_guards_replace_guard'; END IF;
  RETURN NEW;
END;
$$;

--
-- Name: statement_consent_key_delete_guard_fn(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.statement_consent_key_delete_guard_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = OLD.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled') THEN RAISE EXCEPTION 'statement_consent_key_delete_guard'; END IF;
  RETURN OLD;
END;
$$;

--
-- Name: statement_consent_key_states_replace_guard_fn(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.statement_consent_key_states_replace_guard_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM statement_consent_key_states r WHERE r.tenant_id = NEW.tenant_id AND r.user_id = NEW.user_id AND r.statement_id = NEW.statement_id) THEN RAISE EXCEPTION 'statement_consent_key_states_replace_guard'; END IF;
  RETURN NEW;
END;
$$;

--
-- Name: statement_consent_key_update_guard_fn(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.statement_consent_key_update_guard_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NOT (NEW.tenant_id IS NOT DISTINCT FROM OLD.tenant_id) OR NOT (NEW.user_id IS NOT DISTINCT FROM OLD.user_id) OR NOT (NEW.statement_id IS NOT DISTINCT FROM OLD.statement_id) OR NOT (NEW.account_id IS NOT DISTINCT FROM OLD.account_id) OR NOT (NEW.physical_id IS NOT DISTINCT FROM OLD.physical_id) OR NOT (NEW.restore_epoch IS NOT DISTINCT FROM OLD.restore_epoch) OR NOT (EXISTS (SELECT 1 FROM statement_consent_operations o WHERE o.tenant_id = OLD.tenant_id AND o.user_id = OLD.user_id AND o.statement_id = OLD.statement_id
      AND o.status = 'executing' AND o.admitted = 1 AND o.is_noop = 0 AND o.account_id = OLD.account_id AND CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000) AS BIGINT) BETWEEN o.issued_at AND o.expires_at
      AND OLD.revision = o.expected_revision AND OLD.withdrawal_generation = o.expected_withdrawal_generation
      AND NEW.revision = OLD.revision + 1 AND NEW.withdrawal_generation = OLD.withdrawal_generation + CASE WHEN o.action IN ('deny','withdraw') THEN 1 ELSE 0 END
      AND NEW.last_operation_id = o.operation_id AND NEW.updated_at >= OLD.updated_at)) THEN RAISE EXCEPTION 'statement_consent_key_update_guard'; END IF;
  RETURN NEW;
END;
$$;

--
-- Name: statement_consent_operation_delete_guard_fn(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.statement_consent_operation_delete_guard_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.is_terminal = 0 THEN RAISE EXCEPTION 'statement_consent_operation_delete_guard'; END IF;
  RETURN OLD;
END;
$$;

--
-- Name: statement_consent_operation_finalize_guard_fn(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.statement_consent_operation_finalize_guard_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.status <> 'executing' OR NOT (NEW.tenant_id IS NOT DISTINCT FROM OLD.tenant_id) OR NOT (NEW.operation_id IS NOT DISTINCT FROM OLD.operation_id) OR NOT (NEW.attempt_id IS NOT DISTINCT FROM OLD.attempt_id) OR NOT (NEW.payload_sha256 IS NOT DISTINCT FROM OLD.payload_sha256) OR NOT (NEW.actor_id IS NOT DISTINCT FROM OLD.actor_id) OR NOT (NEW.actor_type IS NOT DISTINCT FROM OLD.actor_type) OR NOT (NEW.action IS NOT DISTINCT FROM OLD.action) OR NOT (NEW.user_id IS NOT DISTINCT FROM OLD.user_id) OR NOT (NEW.account_id IS NOT DISTINCT FROM OLD.account_id) OR NOT (NEW.statement_id IS NOT DISTINCT FROM OLD.statement_id) OR NOT (NEW.physical_id IS NOT DISTINCT FROM OLD.physical_id) OR NOT (NEW.restore_epoch IS NOT DISTINCT FROM OLD.restore_epoch) OR NOT (NEW.expected_revision IS NOT DISTINCT FROM OLD.expected_revision) OR NOT (NEW.expected_withdrawal_generation IS NOT DISTINCT FROM OLD.expected_withdrawal_generation) OR NOT (NEW.expected_definition_generation IS NOT DISTINCT FROM OLD.expected_definition_generation) OR NOT (NEW.expected_closed_generation IS NOT DISTINCT FROM OLD.expected_closed_generation) OR NOT (NEW.issued_at IS NOT DISTINCT FROM OLD.issued_at) OR NOT (NEW.expires_at IS NOT DISTINCT FROM OLD.expires_at) OR NOT (NEW.effect_at IS NOT DISTINCT FROM OLD.effect_at) OR NOT (NEW.definition_json IS NOT DISTINCT FROM OLD.definition_json) OR NOT (NEW.before_json IS NOT DISTINCT FROM OLD.before_json) OR NOT (NEW.after_json IS NOT DISTINCT FROM OLD.after_json) OR NOT (NEW.history_json IS NOT DISTINCT FROM OLD.history_json) OR NOT (NEW.admitted IS NOT DISTINCT FROM OLD.admitted) OR NOT (NEW.is_noop IS NOT DISTINCT FROM OLD.is_noop) OR NOT (NEW.required_terminal IS NOT DISTINCT FROM OLD.required_terminal) OR NEW.is_terminal <> 1 OR (NEW.admitted = 0 AND NEW.status <> 'rejected') OR (NEW.admitted = 1 AND (NEW.status <> 'applied' OR NOT (CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000) AS BIGINT) BETWEEN NEW.issued_at AND NEW.expires_at) OR NOT (EXISTS (SELECT 1 FROM statement_consent_key_states k WHERE k.tenant_id = NEW.tenant_id AND k.user_id = NEW.user_id AND k.statement_id = NEW.statement_id
      AND k.account_id = NEW.account_id AND k.physical_id = NEW.physical_id AND k.restore_epoch = NEW.restore_epoch
      AND k.revision = NEW.expected_revision + CASE WHEN NEW.is_noop = 1 THEN 0 ELSE 1 END
      AND k.withdrawal_generation = NEW.expected_withdrawal_generation + CASE WHEN NEW.is_noop = 0 AND NEW.action IN ('deny', 'withdraw') THEN 1 ELSE 0 END
      AND (NEW.is_noop = 1 OR k.last_operation_id = NEW.operation_id)) AND EXISTS (SELECT 1 FROM user_consent_records r WHERE r.tenant_id = NEW.tenant_id AND r.user_id = NEW.user_id
      AND r.statement_id = NEW.statement_id AND jsonb_build_object('id', r.id, 'tenant_id', r.tenant_id, 'user_id', r.user_id, 'statement_id', r.statement_id, 'version_id', r.version_id, 'version', r.version, 'status', r.status, 'granted_at', r.granted_at, 'withdrawn_at', r.withdrawn_at, 'expires_at', r.expires_at, 'client_id', r.client_id, 'receipt_id', r.receipt_id, 'created_at', r.created_at, 'updated_at', r.updated_at, 'retain_until', r.retain_until, 'consent_settings_snapshot_at', r.consent_settings_snapshot_at, 'record_retention_days_snapshot', r.record_retention_days_snapshot, 'reconsent_interval_days_snapshot', r.reconsent_interval_days_snapshot, 'content_hash', r.content_hash) = (NEW.after_json)::jsonb) AND ((NEW.is_noop = 1 AND NEW.before_json = NEW.after_json) OR
      (NEW.is_noop = 0 AND EXISTS (SELECT 1 FROM consent_item_history h WHERE h.id = (NEW.history_json::jsonb ->> 'id')
        AND h.tenant_id = NEW.tenant_id AND jsonb_build_object('id', h.id, 'tenant_id', h.tenant_id, 'user_id', h.user_id, 'statement_id', h.statement_id, 'action', h.action, 'version_before', h.version_before, 'version_after', h.version_after, 'status_before', h.status_before, 'status_after', h.status_after, 'client_id', h.client_id, 'created_at', h.created_at, 'version_id_before', h.version_id_before, 'version_id_after', h.version_id_after, 'granted_at', h.granted_at, 'withdrawn_at', h.withdrawn_at, 'expires_at', h.expires_at, 'retain_until', h.retain_until, 'consent_settings_snapshot_at', h.consent_settings_snapshot_at, 'record_retention_days_snapshot', h.record_retention_days_snapshot, 'reconsent_interval_days_snapshot', h.reconsent_interval_days_snapshot, 'content_hash_after', h.content_hash_after) = (NEW.history_json)::jsonb))) AND (NEW.before_json IS NULL OR NEW.is_noop = 1 OR NOT EXISTS (SELECT 1 FROM consent_item_history h
      WHERE h.tenant_id = NEW.tenant_id AND h.user_id = NEW.user_id AND h.statement_id = NEW.statement_id
        AND (h.retain_until IS NULL OR h.retain_until < CAST((NEW.after_json::jsonb ->> 'retain_until') AS BIGINT)) AND (NOT (h.retain_until IS NOT DISTINCT FROM CAST((NEW.after_json::jsonb ->> 'retain_until') AS BIGINT)) OR NOT (h.consent_settings_snapshot_at IS NOT DISTINCT FROM CAST((NEW.after_json::jsonb ->> 'consent_settings_snapshot_at') AS BIGINT)) OR NOT (h.record_retention_days_snapshot IS NOT DISTINCT FROM CAST((NEW.after_json::jsonb ->> 'record_retention_days_snapshot') AS BIGINT)) OR NOT (h.reconsent_interval_days_snapshot IS NOT DISTINCT FROM CAST((NEW.after_json::jsonb ->> 'reconsent_interval_days_snapshot') AS BIGINT)))))))) THEN RAISE EXCEPTION 'statement_consent_operation_finalize_guard'; END IF;
  RETURN NEW;
END;
$$;

--
-- Name: statement_consent_operation_insert_guard_fn(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.statement_consent_operation_insert_guard_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- Only terminal evidence may be rebound by the isolated importer transaction.
  IF NEW.is_terminal=1 AND NEW.status IN ('applied','rejected')
    AND NEW.tenant_id=(NULLIF(current_setting('authrim.statement_consent_restore',true),'')::jsonb ->> 'tenant_id')
    AND NEW.account_id=(NULLIF(current_setting('authrim.statement_consent_restore',true),'')::jsonb ->> 'account_id')
    AND NEW.physical_id=(NULLIF(current_setting('authrim.statement_consent_restore',true),'')::jsonb ->> 'physical_id')
    AND NEW.restore_epoch=(NULLIF(current_setting('authrim.statement_consent_restore',true),'')::jsonb ->> 'restore_epoch')
    AND NOT EXISTS (SELECT 1 FROM statement_consent_operations o WHERE o.tenant_id=NEW.tenant_id AND o.operation_id=NEW.operation_id)
  THEN RETURN NEW; END IF;

  IF NEW.status <> 'executing' OR NEW.is_terminal <> 0 OR EXISTS (SELECT 1 FROM statement_consent_operations o WHERE o.tenant_id = NEW.tenant_id AND (o.operation_id = NEW.operation_id OR (o.user_id = NEW.user_id AND o.statement_id = NEW.statement_id AND o.is_terminal = 0))) OR (NOT ((NEW.after_json::jsonb ->> 'tenant_id') IS NOT DISTINCT FROM NEW.tenant_id) OR NOT ((NEW.after_json::jsonb ->> 'user_id') IS NOT DISTINCT FROM NEW.user_id) OR NOT ((NEW.after_json::jsonb ->> 'statement_id') IS NOT DISTINCT FROM NEW.statement_id)
      OR (NEW.is_noop = 1 AND (NEW.action <> 'grant' OR (NEW.after_json)::jsonb <> (NEW.before_json)::jsonb OR (NEW.after_json::jsonb ->> 'status') <> 'granted'))
      OR (NEW.is_noop = 0 AND ((NEW.history_json::jsonb ->> 'id') <> ('sc_' || NEW.operation_id || ':' || NEW.tenant_id)
        OR NOT ((NEW.history_json::jsonb ->> 'tenant_id') IS NOT DISTINCT FROM NEW.tenant_id)
        OR NOT ((NEW.history_json::jsonb ->> 'user_id') IS NOT DISTINCT FROM NEW.user_id)
        OR NOT ((NEW.history_json::jsonb ->> 'statement_id') IS NOT DISTINCT FROM NEW.statement_id)
        OR NOT ((NEW.history_json::jsonb ->> 'status_before') IS NOT DISTINCT FROM (NEW.before_json::jsonb ->> 'status'))
        OR NOT ((NEW.history_json::jsonb ->> 'status_after') IS NOT DISTINCT FROM (NEW.after_json::jsonb ->> 'status'))
        OR NOT ((NEW.history_json::jsonb ->> 'version_id_after') IS NOT DISTINCT FROM (NEW.after_json::jsonb ->> 'version_id'))
        OR NOT ((NEW.history_json::jsonb ->> 'version_after') IS NOT DISTINCT FROM (NEW.after_json::jsonb ->> 'version'))
        OR (NEW.action = 'grant' AND ((NEW.after_json::jsonb ->> 'status') <> 'granted' OR (NEW.history_json::jsonb ->> 'action') NOT IN ('granted','version_upgraded')))
        OR (NEW.action = 'withdraw' AND ((NEW.after_json::jsonb ->> 'status') <> 'withdrawn' OR (NEW.history_json::jsonb ->> 'action') <> 'withdrawn'))
        OR (NEW.action = 'deny' AND ((NEW.after_json::jsonb ->> 'status') NOT IN ('denied','withdrawn') OR (NEW.history_json::jsonb ->> 'action') NOT IN ('denied','withdrawn')))))
      OR (NEW.before_json IS NOT NULL AND ((NEW.after_json::jsonb ->> 'id') <> (NEW.before_json::jsonb ->> 'id')
        OR CAST((NEW.after_json::jsonb ->> 'created_at') AS BIGINT) <> CAST((NEW.before_json::jsonb ->> 'created_at') AS BIGINT)
        OR CAST((NEW.after_json::jsonb ->> 'updated_at') AS BIGINT) < CAST((NEW.before_json::jsonb ->> 'updated_at') AS BIGINT))) OR (NEW.is_noop = 0 AND NOT (((NEW.history_json::jsonb ->> 'content_hash_after') IS NOT DISTINCT FROM (NEW.after_json::jsonb ->> 'content_hash')) AND ((NEW.history_json::jsonb ->> 'version_id_after') IS NOT DISTINCT FROM (NEW.after_json::jsonb ->> 'version_id')) AND ((NEW.history_json::jsonb ->> 'version_after') IS NOT DISTINCT FROM (NEW.after_json::jsonb ->> 'version')) AND ((NEW.history_json::jsonb ->> 'status_after') IS NOT DISTINCT FROM (NEW.after_json::jsonb ->> 'status')) AND ((NEW.history_json::jsonb ->> 'granted_at') IS NOT DISTINCT FROM (NEW.after_json::jsonb ->> 'granted_at')) AND ((NEW.history_json::jsonb ->> 'withdrawn_at') IS NOT DISTINCT FROM (NEW.after_json::jsonb ->> 'withdrawn_at')) AND ((NEW.history_json::jsonb ->> 'expires_at') IS NOT DISTINCT FROM (NEW.after_json::jsonb ->> 'expires_at')) AND ((NEW.history_json::jsonb ->> 'retain_until') IS NOT DISTINCT FROM (NEW.after_json::jsonb ->> 'retain_until')) AND ((NEW.history_json::jsonb ->> 'consent_settings_snapshot_at') IS NOT DISTINCT FROM (NEW.after_json::jsonb ->> 'consent_settings_snapshot_at')) AND ((NEW.history_json::jsonb ->> 'record_retention_days_snapshot') IS NOT DISTINCT FROM (NEW.after_json::jsonb ->> 'record_retention_days_snapshot')) AND ((NEW.history_json::jsonb ->> 'reconsent_interval_days_snapshot') IS NOT DISTINCT FROM (NEW.after_json::jsonb ->> 'reconsent_interval_days_snapshot')))) OR CASE WHEN (jsonb_typeof(NEW.after_json::jsonb -> 'created_at') = 'number' AND ((NEW.after_json::jsonb ->> 'created_at'))::numeric BETWEEN 0 AND 9007199254740991 AND mod(((NEW.after_json::jsonb ->> 'created_at'))::numeric,1)=0) AND (jsonb_typeof(NEW.after_json::jsonb -> 'updated_at') = 'number' AND ((NEW.after_json::jsonb ->> 'updated_at'))::numeric BETWEEN 0 AND 9007199254740991 AND mod(((NEW.after_json::jsonb ->> 'updated_at'))::numeric,1)=0) AND (jsonb_typeof(NEW.after_json::jsonb -> 'granted_at') = 'null' OR (jsonb_typeof(NEW.after_json::jsonb -> 'granted_at') = 'number' AND ((NEW.after_json::jsonb ->> 'granted_at'))::numeric BETWEEN 0 AND 9007199254740991 AND mod(((NEW.after_json::jsonb ->> 'granted_at'))::numeric,1)=0)) AND (jsonb_typeof(NEW.after_json::jsonb -> 'withdrawn_at') = 'null' OR (jsonb_typeof(NEW.after_json::jsonb -> 'withdrawn_at') = 'number' AND ((NEW.after_json::jsonb ->> 'withdrawn_at'))::numeric BETWEEN 0 AND 9007199254740991 AND mod(((NEW.after_json::jsonb ->> 'withdrawn_at'))::numeric,1)=0)) AND (jsonb_typeof(NEW.after_json::jsonb -> 'expires_at') = 'null' OR (jsonb_typeof(NEW.after_json::jsonb -> 'expires_at') = 'number' AND ((NEW.after_json::jsonb ->> 'expires_at'))::numeric BETWEEN 0 AND 9007199254740991 AND mod(((NEW.after_json::jsonb ->> 'expires_at'))::numeric,1)=0)) AND (jsonb_typeof(NEW.after_json::jsonb -> 'retain_until') = 'null' OR (jsonb_typeof(NEW.after_json::jsonb -> 'retain_until') = 'number' AND ((NEW.after_json::jsonb ->> 'retain_until'))::numeric BETWEEN 0 AND 9007199254740991 AND mod(((NEW.after_json::jsonb ->> 'retain_until'))::numeric,1)=0)) AND (jsonb_typeof(NEW.after_json::jsonb -> 'consent_settings_snapshot_at') = 'null' OR (jsonb_typeof(NEW.after_json::jsonb -> 'consent_settings_snapshot_at') = 'number' AND ((NEW.after_json::jsonb ->> 'consent_settings_snapshot_at'))::numeric BETWEEN 0 AND 9007199254740991 AND mod(((NEW.after_json::jsonb ->> 'consent_settings_snapshot_at'))::numeric,1)=0)) AND (jsonb_typeof(NEW.after_json::jsonb -> 'record_retention_days_snapshot') = 'null' OR (jsonb_typeof(NEW.after_json::jsonb -> 'record_retention_days_snapshot') = 'number' AND ((NEW.after_json::jsonb ->> 'record_retention_days_snapshot'))::numeric BETWEEN 0 AND 9007199254740991 AND mod(((NEW.after_json::jsonb ->> 'record_retention_days_snapshot'))::numeric,1)=0)) AND (jsonb_typeof(NEW.after_json::jsonb -> 'reconsent_interval_days_snapshot') = 'null' OR (jsonb_typeof(NEW.after_json::jsonb -> 'reconsent_interval_days_snapshot') = 'number' AND ((NEW.after_json::jsonb ->> 'reconsent_interval_days_snapshot'))::numeric BETWEEN 0 AND 9007199254740991 AND mod(((NEW.after_json::jsonb ->> 'reconsent_interval_days_snapshot'))::numeric,1)=0)) AND (NEW.is_noop=1 OR (jsonb_typeof(NEW.history_json::jsonb -> 'granted_at') = 'null' OR (jsonb_typeof(NEW.history_json::jsonb -> 'granted_at') = 'number' AND ((NEW.history_json::jsonb ->> 'granted_at'))::numeric BETWEEN 0 AND 9007199254740991 AND mod(((NEW.history_json::jsonb ->> 'granted_at'))::numeric,1)=0))) AND (NEW.is_noop=1 OR (jsonb_typeof(NEW.history_json::jsonb -> 'withdrawn_at') = 'null' OR (jsonb_typeof(NEW.history_json::jsonb -> 'withdrawn_at') = 'number' AND ((NEW.history_json::jsonb ->> 'withdrawn_at'))::numeric BETWEEN 0 AND 9007199254740991 AND mod(((NEW.history_json::jsonb ->> 'withdrawn_at'))::numeric,1)=0))) AND (NEW.is_noop=1 OR (jsonb_typeof(NEW.history_json::jsonb -> 'expires_at') = 'null' OR (jsonb_typeof(NEW.history_json::jsonb -> 'expires_at') = 'number' AND ((NEW.history_json::jsonb ->> 'expires_at'))::numeric BETWEEN 0 AND 9007199254740991 AND mod(((NEW.history_json::jsonb ->> 'expires_at'))::numeric,1)=0))) AND (NEW.is_noop=1 OR (jsonb_typeof(NEW.history_json::jsonb -> 'retain_until') = 'null' OR (jsonb_typeof(NEW.history_json::jsonb -> 'retain_until') = 'number' AND ((NEW.history_json::jsonb ->> 'retain_until'))::numeric BETWEEN 0 AND 9007199254740991 AND mod(((NEW.history_json::jsonb ->> 'retain_until'))::numeric,1)=0))) AND (NEW.is_noop=1 OR (jsonb_typeof(NEW.history_json::jsonb -> 'consent_settings_snapshot_at') = 'null' OR (jsonb_typeof(NEW.history_json::jsonb -> 'consent_settings_snapshot_at') = 'number' AND ((NEW.history_json::jsonb ->> 'consent_settings_snapshot_at'))::numeric BETWEEN 0 AND 9007199254740991 AND mod(((NEW.history_json::jsonb ->> 'consent_settings_snapshot_at'))::numeric,1)=0))) AND (NEW.is_noop=1 OR (jsonb_typeof(NEW.history_json::jsonb -> 'record_retention_days_snapshot') = 'null' OR (jsonb_typeof(NEW.history_json::jsonb -> 'record_retention_days_snapshot') = 'number' AND ((NEW.history_json::jsonb ->> 'record_retention_days_snapshot'))::numeric BETWEEN 0 AND 9007199254740991 AND mod(((NEW.history_json::jsonb ->> 'record_retention_days_snapshot'))::numeric,1)=0))) AND (NEW.is_noop=1 OR (jsonb_typeof(NEW.history_json::jsonb -> 'reconsent_interval_days_snapshot') = 'null' OR (jsonb_typeof(NEW.history_json::jsonb -> 'reconsent_interval_days_snapshot') = 'number' AND ((NEW.history_json::jsonb ->> 'reconsent_interval_days_snapshot'))::numeric BETWEEN 0 AND 9007199254740991 AND mod(((NEW.history_json::jsonb ->> 'reconsent_interval_days_snapshot'))::numeric,1)=0))) AND (NEW.is_noop=1 OR (jsonb_typeof(NEW.history_json::jsonb -> 'created_at') = 'number' AND ((NEW.history_json::jsonb ->> 'created_at'))::numeric BETWEEN 0 AND 9007199254740991 AND mod(((NEW.history_json::jsonb ->> 'created_at'))::numeric,1)=0)) THEN 0 ELSE 1 END = 1) OR NEW.admitted <> (CASE WHEN EXISTS (SELECT 1 FROM statement_consent_guards t JOIN statement_consent_guards s ON s.tenant_id = t.tenant_id
      WHERE t.tenant_id = NEW.tenant_id AND t.scope_kind = 'tenant' AND t.scope_key = '' AND t.mode = 'enforced'
        AND s.scope_kind = 'statement' AND s.scope_key = NEW.statement_id AND (s.mode = 'enforced' OR (NEW.action <> 'grant' AND s.mode = 'closed'))
        AND t.account_id = NEW.account_id AND s.account_id = NEW.account_id
        AND t.physical_id = NEW.physical_id AND s.physical_id = NEW.physical_id
        AND t.restore_epoch = NEW.restore_epoch AND s.restore_epoch = NEW.restore_epoch
        AND s.definition_generation = NEW.expected_definition_generation
        AND s.closed_generation = NEW.expected_closed_generation)
      AND EXISTS (SELECT 1 FROM statement_consent_key_states k WHERE k.tenant_id = NEW.tenant_id AND k.user_id = NEW.user_id
        AND k.statement_id = NEW.statement_id AND k.account_id = NEW.account_id
        AND k.physical_id = NEW.physical_id AND k.restore_epoch = NEW.restore_epoch
        AND k.revision = NEW.expected_revision AND k.withdrawal_generation = NEW.expected_withdrawal_generation)
      AND CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000) AS BIGINT) BETWEEN NEW.issued_at AND NEW.expires_at
      AND ((NEW.before_json IS NULL AND NOT EXISTS (SELECT 1 FROM user_consent_records r
        WHERE r.tenant_id = NEW.tenant_id AND r.user_id = NEW.user_id AND r.statement_id = NEW.statement_id))
        OR EXISTS (SELECT 1 FROM user_consent_records r WHERE r.tenant_id = NEW.tenant_id
          AND r.user_id = NEW.user_id AND r.statement_id = NEW.statement_id
          AND jsonb_build_object('id', r.id, 'tenant_id', r.tenant_id, 'user_id', r.user_id, 'statement_id', r.statement_id, 'version_id', r.version_id, 'version', r.version, 'status', r.status, 'granted_at', r.granted_at, 'withdrawn_at', r.withdrawn_at, 'expires_at', r.expires_at, 'client_id', r.client_id, 'receipt_id', r.receipt_id, 'created_at', r.created_at, 'updated_at', r.updated_at, 'retain_until', r.retain_until, 'consent_settings_snapshot_at', r.consent_settings_snapshot_at, 'record_retention_days_snapshot', r.record_retention_days_snapshot, 'reconsent_interval_days_snapshot', r.reconsent_interval_days_snapshot, 'content_hash', r.content_hash) = (NEW.before_json)::jsonb)) AND ((NEW.definition_json::jsonb ->> 'tenant_id')=NEW.tenant_id AND (NEW.definition_json::jsonb ->> 'statement_id')=NEW.statement_id AND CAST((NEW.definition_json::jsonb ->> 'definition_generation') AS BIGINT)=NEW.expected_definition_generation AND (NEW.definition_json::jsonb ->> 'version_id')=(NEW.after_json::jsonb ->> 'version_id') AND (NEW.definition_json::jsonb ->> 'version')=(NEW.after_json::jsonb ->> 'version') AND ((NEW.definition_json::jsonb ->> 'content_hash') IS NOT DISTINCT FROM (NEW.after_json::jsonb ->> 'content_hash')) AND (NEW.action<>'grant' OR (CAST((NEW.definition_json::jsonb ->> 'is_active') AS BIGINT)=1 AND (NEW.definition_json::jsonb ->> 'version_status')='active')))
      AND (NEW.is_noop = 1 OR NOT EXISTS (SELECT 1 FROM consent_item_history h WHERE h.id = (NEW.history_json::jsonb ->> 'id'))) THEN 1 ELSE 0 END) THEN RAISE EXCEPTION 'statement_consent_operation_insert_guard'; END IF;
  RETURN NEW;
END;
$$;

--
-- Name: statement_consent_retention_permit_immutable_fn(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.statement_consent_retention_permit_immutable_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN RAISE EXCEPTION 'statement_consent_retention_permit_immutable'; END;
$$;

--
-- Name: statement_consent_user_consent_records_delete_guard_fn(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.statement_consent_user_consent_records_delete_guard_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = OLD.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled')) AND NOT (EXISTS (SELECT 1 FROM statement_consent_retention_permits p
    JOIN statement_consent_guards g ON g.tenant_id=p.tenant_id AND g.scope_kind='tenant' AND g.scope_key=''
    WHERE p.tenant_id=OLD.tenant_id AND p.row_kind='record' AND p.row_id=OLD.id
      AND p.user_id=OLD.user_id AND p.statement_id=OLD.statement_id
      AND p.account_id=g.account_id AND p.physical_id=g.physical_id AND p.restore_epoch=g.restore_epoch
      AND CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000) AS BIGINT) BETWEEN p.issued_at AND p.expires_at AND p.cutoff_at<=CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000) AS BIGINT)
      AND OLD.status IN ('withdrawn','denied','expired')
      AND ((OLD.consent_settings_snapshot_at IS NOT NULL AND OLD.retain_until IS NOT NULL AND OLD.retain_until<p.cutoff_at)
        OR (OLD.consent_settings_snapshot_at IS NULL AND p.legacy_retention_days IS NOT NULL
          AND OLD.updated_at<p.cutoff_at-p.legacy_retention_days*86400000)))) THEN RAISE EXCEPTION 'statement_consent_user_consent_records_delete_guard'; END IF;
  RETURN OLD;
END;
$$;

--
-- Name: statement_consent_user_consent_records_insert_guard_fn(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.statement_consent_user_consent_records_insert_guard_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = NEW.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled')) AND NOT (EXISTS (SELECT 1 FROM statement_consent_operations o WHERE o.tenant_id = NEW.tenant_id AND o.user_id = NEW.user_id
              AND o.statement_id = NEW.statement_id AND o.status = 'executing' AND o.admitted = 1 AND o.is_noop = 0 AND CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000) AS BIGINT) BETWEEN o.issued_at AND o.expires_at
              AND jsonb_build_object('id', NEW.id, 'tenant_id', NEW.tenant_id, 'user_id', NEW.user_id, 'statement_id', NEW.statement_id, 'version_id', NEW.version_id, 'version', NEW.version, 'status', NEW.status, 'granted_at', NEW.granted_at, 'withdrawn_at', NEW.withdrawn_at, 'expires_at', NEW.expires_at, 'client_id', NEW.client_id, 'receipt_id', NEW.receipt_id, 'created_at', NEW.created_at, 'updated_at', NEW.updated_at, 'retain_until', NEW.retain_until, 'consent_settings_snapshot_at', NEW.consent_settings_snapshot_at, 'record_retention_days_snapshot', NEW.record_retention_days_snapshot, 'reconsent_interval_days_snapshot', NEW.reconsent_interval_days_snapshot, 'content_hash', NEW.content_hash) = (o.after_json)::jsonb)) THEN RAISE EXCEPTION 'statement_consent_user_consent_records_insert_guard'; END IF;
  RETURN NEW;
END;
$$;

--
-- Name: statement_consent_user_consent_records_update_guard_fn(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.statement_consent_user_consent_records_update_guard_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF ((EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = OLD.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled')) OR (EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = NEW.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled'))) AND NOT (EXISTS (SELECT 1 FROM statement_consent_operations o WHERE o.tenant_id = NEW.tenant_id AND o.user_id = NEW.user_id
              AND o.statement_id = NEW.statement_id AND o.status = 'executing' AND o.admitted = 1 AND o.is_noop = 0 AND CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000) AS BIGINT) BETWEEN o.issued_at AND o.expires_at
              AND jsonb_build_object('id', NEW.id, 'tenant_id', NEW.tenant_id, 'user_id', NEW.user_id, 'statement_id', NEW.statement_id, 'version_id', NEW.version_id, 'version', NEW.version, 'status', NEW.status, 'granted_at', NEW.granted_at, 'withdrawn_at', NEW.withdrawn_at, 'expires_at', NEW.expires_at, 'client_id', NEW.client_id, 'receipt_id', NEW.receipt_id, 'created_at', NEW.created_at, 'updated_at', NEW.updated_at, 'retain_until', NEW.retain_until, 'consent_settings_snapshot_at', NEW.consent_settings_snapshot_at, 'record_retention_days_snapshot', NEW.record_retention_days_snapshot, 'reconsent_interval_days_snapshot', NEW.reconsent_interval_days_snapshot, 'content_hash', NEW.content_hash) = (o.after_json)::jsonb) AND EXISTS (SELECT 1 FROM statement_consent_operations o WHERE o.tenant_id = OLD.tenant_id AND o.user_id = OLD.user_id AND o.statement_id = OLD.statement_id AND o.status = 'executing' AND jsonb_build_object('id', OLD.id, 'tenant_id', OLD.tenant_id, 'user_id', OLD.user_id, 'statement_id', OLD.statement_id, 'version_id', OLD.version_id, 'version', OLD.version, 'status', OLD.status, 'granted_at', OLD.granted_at, 'withdrawn_at', OLD.withdrawn_at, 'expires_at', OLD.expires_at, 'client_id', OLD.client_id, 'receipt_id', OLD.receipt_id, 'created_at', OLD.created_at, 'updated_at', OLD.updated_at, 'retain_until', OLD.retain_until, 'consent_settings_snapshot_at', OLD.consent_settings_snapshot_at, 'record_retention_days_snapshot', OLD.record_retention_days_snapshot, 'reconsent_interval_days_snapshot', OLD.reconsent_interval_days_snapshot, 'content_hash', OLD.content_hash) = (o.before_json)::jsonb)) THEN RAISE EXCEPTION 'statement_consent_user_consent_records_update_guard'; END IF;
  RETURN NEW;
END;
$$;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: account_creation_operations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_creation_operations (
    operation_id text NOT NULL,
    tenant_id text NOT NULL,
    actor_id text NOT NULL,
    idempotency_key text NOT NULL,
    allocation_idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    user_id text NOT NULL,
    account_id text NOT NULL,
    status text DEFAULT 'preparing'::text NOT NULL,
    publication_json text,
    last_error_code text,
    created_at bigint NOT NULL,
    completed_at bigint,
    updated_at bigint NOT NULL,
    CONSTRAINT account_creation_operations_check CHECK ((((status = 'succeeded'::text) AND (completed_at IS NOT NULL)) OR (status <> 'succeeded'::text))),
    CONSTRAINT account_creation_operations_publication_json_check CHECK (((publication_json IS NULL) OR ((publication_json IS JSON) AND (length(publication_json) <= 16384)))),
    CONSTRAINT account_creation_operations_request_hash_check CHECK ((length(request_hash) = 64)),
    CONSTRAINT account_creation_operations_status_check CHECK ((status = ANY (ARRAY['preparing'::text, 'reserved'::text, 'writing'::text, 'directory_pending'::text, 'succeeded'::text, 'blocked'::text, 'canceled'::text])))
);

--
-- Name: account_legal_hold_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_legal_hold_states (
    tenant_id text NOT NULL,
    account_id text NOT NULL,
    active_hold_id text,
    projection_state text DEFAULT 'inactive'::text NOT NULL,
    projection_generation bigint NOT NULL,
    updated_at bigint NOT NULL,
    CONSTRAINT account_legal_hold_states_check CHECK ((((projection_state = 'active'::text) AND (active_hold_id IS NOT NULL)) OR ((projection_state = 'inactive'::text) AND (active_hold_id IS NULL)))),
    CONSTRAINT account_legal_hold_states_projection_generation_check CHECK ((projection_generation >= 1)),
    CONSTRAINT account_legal_hold_states_projection_state_check CHECK ((projection_state = ANY (ARRAY['active'::text, 'inactive'::text])))
);

--
-- Name: account_lifecycle_event_outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_lifecycle_event_outbox (
    event_id text NOT NULL,
    tenant_id text NOT NULL,
    account_id text NOT NULL,
    operation_id text NOT NULL,
    event_type text NOT NULL,
    event_version bigint DEFAULT 1 NOT NULL,
    payload_json text NOT NULL,
    plugin_targets_json text,
    status text DEFAULT 'pending'::text NOT NULL,
    attempt_count bigint DEFAULT 0 NOT NULL,
    lease_owner text,
    lease_expires_at bigint,
    next_attempt_at bigint,
    last_error_code text,
    created_at bigint NOT NULL,
    succeeded_at bigint,
    updated_at bigint NOT NULL,
    CONSTRAINT account_lifecycle_event_outbox_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT account_lifecycle_event_outbox_check CHECK ((((status = 'leased'::text) AND (lease_owner IS NOT NULL) AND (lease_expires_at IS NOT NULL)) OR ((status <> 'leased'::text) AND (lease_owner IS NULL) AND (lease_expires_at IS NULL)))),
    CONSTRAINT account_lifecycle_event_outbox_check1 CHECK ((((status = 'retry'::text) AND (next_attempt_at IS NOT NULL) AND (last_error_code IS NOT NULL)) OR (status <> 'retry'::text))),
    CONSTRAINT account_lifecycle_event_outbox_check2 CHECK ((((status = 'succeeded'::text) AND (succeeded_at IS NOT NULL)) OR (status <> 'succeeded'::text))),
    CONSTRAINT account_lifecycle_event_outbox_event_type_check CHECK ((event_type = 'account.created'::text)),
    CONSTRAINT account_lifecycle_event_outbox_event_version_check CHECK ((event_version = 1)),
    CONSTRAINT account_lifecycle_event_outbox_payload_json_check CHECK (((payload_json IS JSON) AND (length(payload_json) <= 4096))),
    CONSTRAINT account_lifecycle_event_outbox_plugin_targets_json_check CHECK (((plugin_targets_json IS NULL) OR ((plugin_targets_json IS JSON) AND (length(plugin_targets_json) <= 4096)))),
    CONSTRAINT account_lifecycle_event_outbox_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'leased'::text, 'retry'::text, 'succeeded'::text, 'dead_letter'::text])))
);

--
-- Name: account_support_contexts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_support_contexts (
    tenant_id text NOT NULL,
    account_id text NOT NULL,
    context_json jsonb DEFAULT '{"schema_version": 1}'::jsonb NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    created_by text NOT NULL,
    updated_by text NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    CONSTRAINT account_support_contexts_account_id_check CHECK (((char_length(account_id) >= 1) AND (char_length(account_id) <= 256))),
    CONSTRAINT account_support_contexts_check CHECK ((updated_at >= created_at)),
    CONSTRAINT account_support_contexts_context_json_check CHECK (((jsonb_typeof(context_json) = 'object'::text) AND ((octet_length((context_json)::text) >= 20) AND (octet_length((context_json)::text) <= 32768)))),
    CONSTRAINT account_support_contexts_created_by_check CHECK (((char_length(created_by) >= 1) AND (char_length(created_by) <= 256))),
    CONSTRAINT account_support_contexts_tenant_id_check CHECK (((char_length(tenant_id) >= 1) AND (char_length(tenant_id) <= 256))),
    CONSTRAINT account_support_contexts_updated_by_check CHECK (((char_length(updated_by) >= 1) AND (char_length(updated_by) <= 256))),
    CONSTRAINT account_support_contexts_version_check CHECK ((version >= 1))
);

--
-- Name: account_webhook_outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_webhook_outbox (
    id text NOT NULL,
    tenant_id text NOT NULL,
    user_id text NOT NULL,
    event_type text NOT NULL,
    registration_state text NOT NULL,
    previous_registration_state text,
    changed_field text,
    occurred_at bigint NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at bigint DEFAULT 0 NOT NULL,
    lease_token text,
    lease_until bigint DEFAULT 0 NOT NULL,
    delivered_at bigint,
    CONSTRAINT account_webhook_outbox_registration_state_check CHECK ((registration_state = ANY (ARRAY['guest'::text, 'registered'::text])))
);

--
-- Name: application_launchers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.application_launchers (
    tenant_id text DEFAULT 'default'::text NOT NULL,
    id text NOT NULL,
    config_json text NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL
);

--
-- Name: assurance_evidence; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.assurance_evidence (
    id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    subject_id text,
    binding_id text,
    evidence_type text NOT NULL,
    issuer_ref text,
    assurance_framework text,
    assurance_level text,
    evidence_hash text,
    evidence_storage_ref text,
    verified_at bigint,
    expires_at bigint,
    revoked_at bigint,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    revoked_by text
);

--
-- Name: attribute_verifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attribute_verifications (
    id text NOT NULL,
    tenant_id text NOT NULL,
    user_id text NOT NULL,
    vp_request_id text,
    issuer_did text NOT NULL,
    credential_type text NOT NULL,
    format text NOT NULL,
    verification_result text NOT NULL,
    holder_binding_verified boolean DEFAULT false NOT NULL,
    issuer_trusted boolean DEFAULT false NOT NULL,
    status_valid boolean DEFAULT false NOT NULL,
    mapped_attribute_ids jsonb,
    verified_at bigint,
    expires_at bigint,
    created_at bigint DEFAULT 0 NOT NULL,
    updated_at bigint DEFAULT 0 NOT NULL,
    credential_profile_id text,
    credential_profile_version_id text,
    mapping_version_id text,
    mapping_snapshot_hash text,
    policy_version text,
    evidence_fingerprint text,
    status_checked_at bigint,
    status_fresh_until bigint,
    revalidate_after bigint,
    invalidated_at bigint,
    invalidation_reason text
);

--
-- Name: client_consent_overrides; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_consent_overrides (
    id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    client_id text NOT NULL,
    statement_id text NOT NULL,
    requirement text DEFAULT 'inherit'::text NOT NULL,
    min_version text,
    enforcement text,
    conditional_rules_json text,
    display_order bigint,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL
);

--
-- Name: client_trust_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_trust_policies (
    id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    name text NOT NULL,
    display_name text NOT NULL,
    description text,
    target_type text NOT NULL,
    target_id text DEFAULT ''::text NOT NULL,
    first_party bigint DEFAULT 0 NOT NULL,
    trusted bigint DEFAULT 0 NOT NULL,
    skip_authorization_consent bigint DEFAULT 0 NOT NULL,
    is_active bigint DEFAULT 1 NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL
);

--
-- Name: consent_item_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.consent_item_history (
    id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    user_id text NOT NULL,
    statement_id text NOT NULL,
    action text NOT NULL,
    version_id_before text,
    version_id_after text,
    version_before text,
    version_after text,
    status_before text,
    status_after text,
    granted_at bigint,
    withdrawn_at bigint,
    expires_at bigint,
    retain_until bigint,
    consent_settings_snapshot_at bigint,
    record_retention_days_snapshot bigint,
    reconsent_interval_days_snapshot bigint,
    ip_address_hash text,
    user_agent text,
    client_id text,
    metadata_json text,
    created_at bigint NOT NULL,
    content_hash_after text
);

--
-- Name: consent_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.consent_policies (
    id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    name text NOT NULL,
    display_name text NOT NULL,
    description text,
    is_active bigint DEFAULT 1 NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL
);

--
-- Name: consent_policy_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.consent_policy_items (
    id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    policy_id text NOT NULL,
    statement_id text NOT NULL,
    requirement text DEFAULT 'required'::text NOT NULL,
    version_mode text DEFAULT 'current'::text NOT NULL,
    version_id text,
    min_version text,
    checkbox_mode text DEFAULT 'required'::text NOT NULL,
    checkbox_default_checked bigint DEFAULT 0 NOT NULL,
    binding_type text,
    binding_value text,
    evidence_profile text,
    language_fallback text,
    display_order bigint DEFAULT 0 NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL
);

--
-- Name: consent_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.consent_records (
    id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    subject_user_id text NOT NULL,
    actor_user_id text,
    protocol text NOT NULL,
    consent_kind text NOT NULL,
    client_id text,
    saml_sp_id text,
    recipient_type text,
    recipient_id text,
    binding_type text NOT NULL,
    binding_key text,
    resource_type text,
    resource_id text,
    purpose_key text,
    statement_id text NOT NULL,
    statement_version text NOT NULL,
    policy_id text,
    flow_id text,
    flow_version_id text,
    flow_node_id text,
    decision text NOT NULL,
    selected_value text,
    selected_options_json jsonb,
    released_scopes_json jsonb,
    released_claims_json jsonb,
    released_attributes_json jsonb,
    status text DEFAULT 'active'::text NOT NULL,
    expires_at bigint,
    revoked_at bigint,
    evidence_json jsonb,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    CONSTRAINT consent_records_binding_type_check CHECK ((binding_type = ANY (ARRAY['subject'::text, 'identity_schema'::text, 'destination_field_mapping_set'::text, 'user_decision'::text]))),
    CONSTRAINT consent_records_consent_kind_check CHECK ((consent_kind = ANY (ARRAY['terms'::text, 'privacy'::text, 'attribute_release'::text, 'scope_claim_release'::text, 'form_confirmation'::text, 'custom'::text]))),
    CONSTRAINT consent_records_decision_check CHECK ((decision = ANY (ARRAY['accepted'::text, 'rejected'::text, 'once'::text, 'always'::text, 'selected'::text]))),
    CONSTRAINT consent_records_protocol_check CHECK ((protocol = ANY (ARRAY['oidc'::text, 'saml'::text, 'document'::text, 'custom'::text]))),
    CONSTRAINT consent_records_recipient_type_check CHECK ((recipient_type = ANY (ARRAY['oidc_client'::text, 'saml_sp'::text, 'tenant'::text, 'external_party'::text]))),
    CONSTRAINT consent_records_resource_type_check CHECK ((resource_type = ANY (ARRAY['userinfo'::text, 'id_token'::text, 'saml_attributes'::text, 'document'::text, 'custom'::text]))),
    CONSTRAINT consent_records_status_check CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text, 'expired'::text, 'superseded'::text])))
);

--
-- Name: consent_statement_localizations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.consent_statement_localizations (
    id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    version_id text NOT NULL,
    language text NOT NULL,
    title text NOT NULL,
    description text NOT NULL,
    processing_purpose text,
    withdrawal_impact text,
    document_url text,
    inline_content text,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL
);

--
-- Name: consent_statement_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.consent_statement_versions (
    id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    statement_id text NOT NULL,
    version text NOT NULL,
    content_type text DEFAULT 'url'::text NOT NULL,
    effective_at bigint NOT NULL,
    effective_until bigint,
    content_hash text,
    is_current bigint DEFAULT 0 NOT NULL,
    current_statement_guard text,
    status text DEFAULT 'draft'::text NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL
);

--
-- Name: consent_statements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.consent_statements (
    id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    slug text NOT NULL,
    category text DEFAULT 'custom'::text NOT NULL,
    legal_basis text DEFAULT 'consent'::text NOT NULL,
    processing_purpose text,
    display_order bigint DEFAULT 0 NOT NULL,
    is_active bigint DEFAULT 1 NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    record_retention_days bigint,
    withdrawal_allowed bigint DEFAULT 1 NOT NULL,
    withdrawal_impact text,
    reconsent_on_version_change bigint DEFAULT 1 NOT NULL,
    reconsent_interval_days bigint,
    definition_generation bigint DEFAULT 0 NOT NULL,
    closed_generation bigint DEFAULT 0 NOT NULL,
    retired_at bigint,
    CONSTRAINT consent_statements_closed_generation_check CHECK (((closed_generation >= 0) AND (closed_generation <= '9007199254740991'::bigint))),
    CONSTRAINT consent_statements_definition_generation_check CHECK (((definition_generation >= 0) AND (definition_generation <= '9007199254740991'::bigint)))
);

--
-- Name: contact_points; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contact_points (
    id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    subject_id text,
    account_id text,
    contact_type text NOT NULL,
    purpose text DEFAULT 'primary'::text NOT NULL,
    normalized_hash text,
    value_storage_ref text,
    display_label text,
    is_primary boolean DEFAULT false NOT NULL,
    verification_state text DEFAULT 'unverified'::text NOT NULL,
    lifecycle_state text DEFAULT 'active'::text NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    deleted_at bigint
);

--
-- Name: contact_verifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contact_verifications (
    id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    contact_point_id text NOT NULL,
    verification_type text NOT NULL,
    verification_state text NOT NULL,
    evidence_ref text,
    verified_at bigint,
    expires_at bigint,
    revoked_at bigint,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL
);

--
-- Name: custom_claim_schema_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.custom_claim_schema_history (
    id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    schema_id text NOT NULL,
    version integer NOT NULL,
    operation text NOT NULL,
    snapshot jsonb NOT NULL,
    changes jsonb NOT NULL,
    actor_id text,
    actor_type text,
    change_source text,
    created_at bigint NOT NULL,
    CONSTRAINT custom_claim_schema_history_actor_type_check CHECK (((actor_type IS NULL) OR (actor_type = ANY (ARRAY['user'::text, 'admin'::text, 'system'::text, 'api'::text])))),
    CONSTRAINT custom_claim_schema_history_change_source_check CHECK (((change_source IS NULL) OR (change_source = ANY (ARRAY['admin_api'::text, 'admin_ui'::text, 'migration'::text, 'rollback'::text])))),
    CONSTRAINT custom_claim_schema_history_operation_check CHECK ((operation = ANY (ARRAY['create'::text, 'update'::text, 'delete'::text, 'rename'::text, 'toggle_active'::text])))
);

--
-- Name: custom_claim_schemas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.custom_claim_schemas (
    id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    field_key text NOT NULL,
    active_field_key text,
    display_label text NOT NULL,
    field_type text DEFAULT 'string'::text NOT NULL,
    is_pii boolean DEFAULT false NOT NULL,
    is_required boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    validation_rules jsonb,
    include_in_id_token boolean DEFAULT false NOT NULL,
    include_in_userinfo boolean DEFAULT false NOT NULL,
    include_in_introspection boolean DEFAULT false NOT NULL,
    required_scopes jsonb,
    scope_mode text DEFAULT 'any'::text NOT NULL,
    is_searchable boolean DEFAULT true NOT NULL,
    is_exportable boolean DEFAULT true NOT NULL,
    is_vc_claim boolean DEFAULT false NOT NULL,
    claim_namespace text,
    description text,
    display_order integer DEFAULT 0 NOT NULL,
    schema_version integer DEFAULT 1 NOT NULL,
    operation_status text DEFAULT 'active'::text NOT NULL,
    operation_detail text,
    is_system boolean DEFAULT false NOT NULL,
    created_by text,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    show_on_registration boolean DEFAULT false NOT NULL,
    registration_required boolean DEFAULT false NOT NULL,
    registration_order integer DEFAULT 0 NOT NULL,
    registration_placeholder text,
    ui_group_key text,
    ui_group_label text,
    ui_group_order integer DEFAULT 0 NOT NULL,
    ui_field_order integer DEFAULT 0 NOT NULL,
    examples_json jsonb,
    cardinality text DEFAULT 'single'::text NOT NULL,
    CONSTRAINT custom_claim_schemas_cardinality_check CHECK ((cardinality = ANY (ARRAY['single'::text, 'multi'::text]))),
    CONSTRAINT custom_claim_schemas_scope_mode_check CHECK ((scope_mode = ANY (ARRAY['all'::text, 'any'::text])))
);

--
-- Name: directory_connector_instances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directory_connector_instances (
    id text NOT NULL,
    tenant_id text NOT NULL,
    connector_id text NOT NULL,
    instance_id text NOT NULL,
    display_name text,
    transport text NOT NULL,
    version text NOT NULL,
    started_at text NOT NULL,
    first_seen_at bigint NOT NULL,
    last_seen_at bigint NOT NULL,
    status text NOT NULL,
    health_status text NOT NULL,
    health_summary_json text DEFAULT '{}'::text NOT NULL,
    config_fingerprint text NOT NULL,
    config_categories_json text DEFAULT '[]'::text NOT NULL,
    drift_severity text DEFAULT 'none'::text NOT NULL,
    deactivated_at bigint,
    deactivated_by text,
    deactivation_reason text,
    updated_at bigint NOT NULL,
    release_channel text DEFAULT 'stable'::text NOT NULL,
    CONSTRAINT directory_connector_instances_drift_severity_check CHECK ((drift_severity = ANY (ARRAY['none'::text, 'warning'::text, 'critical'::text]))),
    CONSTRAINT directory_connector_instances_status_check CHECK ((status = ANY (ARRAY['connected'::text, 'disconnected'::text, 'stale'::text, 'version_mismatch'::text, 'unhealthy'::text, 'deactivated'::text])))
);

--
-- Name: directory_connector_status_episodes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directory_connector_status_episodes (
    id text NOT NULL,
    tenant_id text NOT NULL,
    connector_id text NOT NULL,
    instance_id text NOT NULL,
    status text NOT NULL,
    started_at bigint NOT NULL,
    ended_at bigint,
    last_seen_at bigint NOT NULL,
    reason text,
    acknowledged_at bigint,
    acknowledged_by text,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    CONSTRAINT directory_connector_status_episodes_status_check CHECK ((status = ANY (ARRAY['connected'::text, 'disconnected'::text, 'stale'::text, 'version_mismatch'::text, 'unhealthy'::text, 'deactivated'::text])))
);

--
-- Name: directory_identity_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directory_identity_links (
    id text NOT NULL,
    tenant_id text NOT NULL,
    connector_id text NOT NULL,
    directory_subject text NOT NULL,
    user_id text NOT NULL,
    latest_facts_json text DEFAULT '{}'::text NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    last_login_at bigint
);

--
-- Name: directory_jit_pending_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directory_jit_pending_users (
    id text NOT NULL,
    tenant_id text NOT NULL,
    connector_id text NOT NULL,
    directory_subject text NOT NULL,
    login_identifier text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    directory_facts_json text DEFAULT '{}'::text NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    decided_at bigint,
    decided_by text,
    decision_reason text,
    linked_user_id text,
    CONSTRAINT directory_jit_pending_users_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'linked'::text])))
);

--
-- Name: event_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.event_log (
    id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    event_type text NOT NULL,
    event_category text NOT NULL,
    result text NOT NULL,
    severity text DEFAULT 'info'::text NOT NULL,
    error_code text,
    error_message text,
    anonymized_user_id text,
    client_id text,
    session_id text,
    request_id text,
    duration_ms bigint,
    details_r2_key text,
    details_json text,
    retention_until bigint,
    created_at bigint NOT NULL
);

--
-- Name: field_usage_bindings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.field_usage_bindings (
    id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    field_key text NOT NULL,
    binding_type text NOT NULL,
    binding_id text NOT NULL,
    protection text DEFAULT 'warn'::text NOT NULL,
    reason text,
    source text DEFAULT 'admin'::text NOT NULL,
    metadata_json jsonb,
    is_active boolean DEFAULT true NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    CONSTRAINT field_usage_bindings_binding_type_check CHECK ((binding_type = ANY (ARRAY['authentication_method'::text, 'notification'::text, 'discovery'::text, 'consent'::text, 'policy'::text, 'protocol_output'::text, 'display'::text, 'ui'::text, 'custom'::text]))),
    CONSTRAINT field_usage_bindings_protection_check CHECK ((protection = ANY (ARRAY['none'::text, 'warn'::text, 'delete_blocked'::text]))),
    CONSTRAINT field_usage_bindings_source_check CHECK ((source = ANY (ARRAY['system'::text, 'admin'::text, 'derived'::text, 'migration'::text])))
);

--
-- Name: flow_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.flow_assignments (
    id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    target_type text NOT NULL,
    target_id text,
    flow_kind text NOT NULL,
    flow_id text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    CONSTRAINT flow_assignments_target_id_check CHECK ((((target_type = 'tenant'::text) AND (target_id IS NULL)) OR ((target_type = ANY (ARRAY['oidc_client'::text, 'saml_sp'::text, 'credential_profile'::text])) AND (target_id IS NOT NULL)))),
    CONSTRAINT flow_assignments_target_type_check CHECK ((target_type = ANY (ARRAY['tenant'::text, 'oidc_client'::text, 'saml_sp'::text, 'credential_profile'::text])))
);

--
-- Name: flow_audit_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.flow_audit_events (
    id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    interaction_id text NOT NULL,
    flow_id text NOT NULL,
    flow_version_id text NOT NULL,
    user_id text,
    client_id text,
    saml_sp_id text,
    node_id text,
    branch_handle_id text,
    event_type text NOT NULL,
    result text,
    error_code text,
    contract_hash text NOT NULL,
    metadata_json text,
    created_at bigint NOT NULL,
    method text,
    reason_code text,
    subject_hash text,
    inquiry_number text
);

--
-- Name: flow_interaction_steps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.flow_interaction_steps (
    id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    interaction_id text NOT NULL,
    node_id text NOT NULL,
    step_id text NOT NULL,
    state text NOT NULL,
    selected_handle text,
    state_json text,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    CONSTRAINT flow_interaction_steps_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'waiting_input'::text, 'processing'::text, 'completed'::text, 'skipped'::text, 'failed'::text])))
);

--
-- Name: flow_interactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.flow_interactions (
    id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    flow_id text NOT NULL,
    flow_version_id text NOT NULL,
    user_id text,
    client_id text,
    saml_sp_id text,
    state text NOT NULL,
    current_node_id text,
    current_step_id text,
    contract_hash text NOT NULL,
    signature text NOT NULL,
    expires_at bigint NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    completed_at bigint,
    context_json text,
    CONSTRAINT flow_interactions_state_check CHECK ((state = ANY (ARRAY['created'::text, 'active'::text, 'completed'::text, 'expired'::text, 'failed'::text])))
);

--
-- Name: flow_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.flow_versions (
    id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    flow_id text NOT NULL,
    version_number integer NOT NULL,
    schema_version text NOT NULL,
    runtime_snapshot_json text NOT NULL,
    editor_snapshot_json text,
    validation_result_json text NOT NULL,
    published_by text,
    published_at bigint NOT NULL,
    created_at bigint NOT NULL
);

--
-- Name: flows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.flows (
    id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    client_id text,
    profile_id text,
    name text NOT NULL,
    description text,
    graph_definition text,
    compiled_plan text,
    version text DEFAULT '1.0.0'::text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    is_builtin boolean DEFAULT false NOT NULL,
    created_by text,
    created_at bigint NOT NULL,
    updated_by text,
    updated_at bigint NOT NULL,
    slug text,
    display_name text,
    kind text DEFAULT 'login'::text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    draft_editor_json text,
    draft_runtime_base_json text,
    published_version_id text,
    deleted_at bigint,
    template_id text
);

--
-- Name: guest_account_lifecycle; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.guest_account_lifecycle (
    tenant_id text NOT NULL,
    user_id text NOT NULL,
    client_id text NOT NULL,
    phase text DEFAULT 'active'::text NOT NULL,
    created_at bigint NOT NULL,
    deletion_due_at bigint,
    policy_version text NOT NULL,
    retention_application_id text,
    upgrade_hold_until bigint,
    upgrade_operation_id text,
    upgrade_admission_floor bigint DEFAULT 0 NOT NULL,
    upgraded_at bigint,
    upgrade_finalized_at bigint,
    deletion_operation_id text,
    deletion_route_json text,
    deletion_started_at_ms bigint,
    deleted_at bigint,
    revision bigint DEFAULT 1 NOT NULL,
    updated_at bigint NOT NULL,
    CONSTRAINT guest_account_lifecycle_check CHECK (((deletion_due_at IS NULL) OR (deletion_due_at >= created_at))),
    CONSTRAINT guest_account_lifecycle_check1 CHECK (((upgrade_hold_until IS NULL) OR (upgrade_hold_until >= created_at))),
    CONSTRAINT guest_account_lifecycle_created_at_check CHECK ((created_at >= 0)),
    CONSTRAINT guest_account_lifecycle_phase_check CHECK ((phase = ANY (ARRAY['active'::text, 'upgrading'::text, 'registered'::text, 'deleting'::text, 'deleted'::text]))),
    CONSTRAINT guest_account_lifecycle_revision_check CHECK ((revision >= 1))
);

--
-- Name: guest_account_upgrades; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.guest_account_upgrades (
    id text NOT NULL,
    tenant_id text NOT NULL,
    guest_user_id text NOT NULL,
    upgraded_user_id text NOT NULL,
    upgrade_method text NOT NULL,
    provider_id text,
    preserve_sub integer DEFAULT 1 NOT NULL,
    upgraded_at bigint NOT NULL,
    data_migrated integer DEFAULT 0 NOT NULL,
    CONSTRAINT guest_account_upgrades_data_migrated_check CHECK ((data_migrated = ANY (ARRAY[0, 1]))),
    CONSTRAINT guest_account_upgrades_preserve_sub_check CHECK ((preserve_sub = 1))
);

--
-- Name: guest_core_mutation_epoch; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.guest_core_mutation_epoch (
    id integer NOT NULL,
    revision bigint NOT NULL,
    CONSTRAINT guest_core_mutation_epoch_id_check CHECK ((id = 1)),
    CONSTRAINT guest_core_mutation_epoch_revision_check CHECK ((revision >= 0))
);

--
-- Name: guest_deletion_audit_outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.guest_deletion_audit_outbox (
    audit_id text NOT NULL,
    tenant_id text NOT NULL,
    user_id text NOT NULL,
    operation_id text NOT NULL,
    actor_user_id text NOT NULL,
    ip_address text NOT NULL,
    user_agent text NOT NULL,
    metadata_json text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempt_count bigint DEFAULT 0 NOT NULL,
    next_attempt_at bigint NOT NULL,
    last_error_code text,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    succeeded_at bigint,
    execution_progress_json text,
    CONSTRAINT guest_deletion_audit_outbox_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT guest_deletion_audit_outbox_check CHECK ((((status = 'succeeded'::text) AND (succeeded_at IS NOT NULL)) OR ((status <> 'succeeded'::text) AND (succeeded_at IS NULL)))),
    CONSTRAINT guest_deletion_audit_outbox_execution_progress_json_check CHECK (((execution_progress_json IS NULL) OR (octet_length(execution_progress_json) <= 16384))),
    CONSTRAINT guest_deletion_audit_outbox_metadata_json_check CHECK ((length(metadata_json) <= 4096)),
    CONSTRAINT guest_deletion_audit_outbox_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'retry'::text, 'succeeded'::text])))
);

--
-- Name: guest_devices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.guest_devices (
    id text NOT NULL,
    tenant_id text NOT NULL,
    user_id text NOT NULL,
    resume_credential_hash text NOT NULL,
    expires_at bigint,
    created_at bigint NOT NULL,
    last_used_at bigint NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    CONSTRAINT anonymous_devices_device_id_hash_check CHECK ((length(resume_credential_hash) = 64))
);

--
-- Name: idempotency_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.idempotency_keys (
    id text NOT NULL,
    tenant_id text NOT NULL,
    actor_id text NOT NULL,
    method text NOT NULL,
    path text NOT NULL,
    resource_id text,
    idempotency_key text NOT NULL,
    body_hash text NOT NULL,
    response_status bigint NOT NULL,
    response_body text NOT NULL,
    created_at bigint NOT NULL,
    expires_at bigint NOT NULL
);

--
-- Name: identity_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.identity_accounts (
    id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    account_type text NOT NULL,
    lifecycle_state text DEFAULT 'active'::text NOT NULL,
    legacy_user_id text,
    primary_subject_id text,
    display_label text,
    metadata_json text,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    deleted_at bigint,
    registration_state text DEFAULT 'registered'::text NOT NULL,
    directory_publication_state text DEFAULT 'pending'::text NOT NULL,
    account_route_generation bigint,
    CONSTRAINT identity_accounts_account_route_generation_check CHECK ((account_route_generation >= 1)),
    CONSTRAINT identity_accounts_directory_publication_state_check CHECK ((directory_publication_state = ANY (ARRAY['pending'::text, 'active_pending_directory'::text, 'active'::text, 'disabled'::text]))),
    CONSTRAINT identity_accounts_registration_state_check CHECK ((registration_state = ANY (ARRAY['guest'::text, 'registered'::text])))
);

--
-- Name: identity_bindings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.identity_bindings (
    id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    subject_id text NOT NULL,
    account_id text,
    protocol text NOT NULL,
    source_id text NOT NULL,
    provider_subject_key_hash text NOT NULL,
    binding_kind text DEFAULT 'external_subject'::text NOT NULL,
    lifecycle_state text DEFAULT 'active'::text NOT NULL,
    assurance_level text,
    trust_context_snapshot_id text,
    metadata_json text,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    deleted_at bigint,
    last_seen_at bigint
);

--
-- Name: identity_providers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.identity_providers (
    id text NOT NULL,
    name text NOT NULL,
    provider_type text NOT NULL,
    config_json text NOT NULL,
    enabled integer DEFAULT 1,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL
);

--
-- Name: identity_resolution_candidates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.identity_resolution_candidates (
    id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    source_id text NOT NULL,
    candidate_subject_id text,
    candidate_account_id text,
    candidate_binding_id text,
    candidate_score integer DEFAULT 0 NOT NULL,
    risk_tier text,
    decision_state text DEFAULT 'pending'::text NOT NULL,
    reason_codes_json text,
    review_task_id text,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL
);

--
-- Name: identity_resolution_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.identity_resolution_events (
    id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    subject_id text,
    account_id text,
    binding_id text,
    source_id text NOT NULL,
    resolution_method text NOT NULL,
    outcome text NOT NULL,
    reason_codes_json text,
    trace_ref text,
    metadata_json text,
    created_at bigint NOT NULL
);

--
-- Name: identity_subjects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.identity_subjects (
    id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    subject_type text NOT NULL,
    lifecycle_state text DEFAULT 'active'::text NOT NULL,
    display_label text,
    primary_account_id text,
    risk_tier text,
    assurance_level text,
    metadata_json text,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    deleted_at bigint
);

--
-- Name: launcher_favorites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.launcher_favorites (
    tenant_id text DEFAULT 'default'::text NOT NULL,
    user_id text NOT NULL,
    launcher_id text NOT NULL,
    created_at bigint NOT NULL
);

--
-- Name: legal_hold_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.legal_hold_events (
    event_id text NOT NULL,
    hold_id text NOT NULL,
    tenant_id text NOT NULL,
    account_id text NOT NULL,
    event_type text NOT NULL,
    hold_version bigint NOT NULL,
    projection_generation bigint NOT NULL,
    actor_id text NOT NULL,
    reason_code text NOT NULL,
    case_reference text,
    effective_at bigint NOT NULL,
    created_at bigint NOT NULL,
    CONSTRAINT legal_hold_events_actor_id_check CHECK (((char_length(actor_id) >= 1) AND (char_length(actor_id) <= 256))),
    CONSTRAINT legal_hold_events_case_reference_check CHECK (((case_reference IS NULL) OR ((char_length(case_reference) >= 1) AND (char_length(case_reference) <= 256)))),
    CONSTRAINT legal_hold_events_check CHECK ((created_at >= effective_at)),
    CONSTRAINT legal_hold_events_event_id_check CHECK (((char_length(event_id) >= 1) AND (char_length(event_id) <= 256))),
    CONSTRAINT legal_hold_events_event_type_check CHECK ((event_type = ANY (ARRAY['created'::text, 'extended'::text, 'released'::text, 'expired'::text]))),
    CONSTRAINT legal_hold_events_hold_version_check CHECK ((hold_version >= 1)),
    CONSTRAINT legal_hold_events_projection_generation_check CHECK ((projection_generation >= 1)),
    CONSTRAINT legal_hold_events_reason_code_check CHECK (((char_length(reason_code) >= 1) AND (char_length(reason_code) <= 64)))
);

--
-- Name: legal_hold_projection_outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.legal_hold_projection_outbox (
    operation_id text NOT NULL,
    tenant_id text NOT NULL,
    hold_id text NOT NULL,
    account_id text NOT NULL,
    projection_generation bigint NOT NULL,
    hold_version bigint NOT NULL,
    projection_state text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempt_count bigint DEFAULT 0 NOT NULL,
    next_attempt_at bigint NOT NULL,
    lease_owner text,
    lease_expires_at bigint,
    last_error_code text,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    completed_at bigint,
    CONSTRAINT legal_hold_projection_outbox_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT legal_hold_projection_outbox_check CHECK ((((lease_owner IS NULL) AND (lease_expires_at IS NULL)) OR ((lease_owner IS NOT NULL) AND (lease_expires_at IS NOT NULL)))),
    CONSTRAINT legal_hold_projection_outbox_check1 CHECK ((((status = 'succeeded'::text) AND (completed_at IS NOT NULL)) OR (status <> 'succeeded'::text))),
    CONSTRAINT legal_hold_projection_outbox_check2 CHECK ((updated_at >= created_at)),
    CONSTRAINT legal_hold_projection_outbox_hold_version_check CHECK ((hold_version >= 1)),
    CONSTRAINT legal_hold_projection_outbox_operation_id_check CHECK (((char_length(operation_id) >= 1) AND (char_length(operation_id) <= 256))),
    CONSTRAINT legal_hold_projection_outbox_projection_generation_check CHECK ((projection_generation >= 1)),
    CONSTRAINT legal_hold_projection_outbox_projection_state_check CHECK ((projection_state = ANY (ARRAY['active'::text, 'inactive'::text]))),
    CONSTRAINT legal_hold_projection_outbox_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'succeeded'::text, 'blocked'::text])))
);

--
-- Name: legal_holds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.legal_holds (
    id text NOT NULL,
    tenant_id text NOT NULL,
    subject_type text DEFAULT 'account'::text NOT NULL,
    subject_id text NOT NULL,
    state text DEFAULT 'active'::text NOT NULL,
    reason_code text NOT NULL,
    case_reference text,
    expires_at bigint,
    version bigint DEFAULT 1 NOT NULL,
    created_by text NOT NULL,
    created_at bigint NOT NULL,
    released_by text,
    released_at bigint,
    release_reason text,
    updated_at bigint NOT NULL,
    CONSTRAINT legal_holds_case_reference_check CHECK (((case_reference IS NULL) OR ((char_length(case_reference) >= 1) AND (char_length(case_reference) <= 256)))),
    CONSTRAINT legal_holds_check CHECK (((expires_at IS NULL) OR (expires_at >= created_at))),
    CONSTRAINT legal_holds_check1 CHECK ((((state = 'active'::text) AND (released_by IS NULL) AND (released_at IS NULL) AND (release_reason IS NULL)) OR ((state = ANY (ARRAY['released'::text, 'expired'::text])) AND (released_by IS NOT NULL) AND (released_at IS NOT NULL) AND (release_reason IS NOT NULL)))),
    CONSTRAINT legal_holds_check2 CHECK (((released_at IS NULL) OR (released_at >= created_at))),
    CONSTRAINT legal_holds_check3 CHECK ((updated_at >= created_at)),
    CONSTRAINT legal_holds_created_by_check CHECK (((char_length(created_by) >= 1) AND (char_length(created_by) <= 256))),
    CONSTRAINT legal_holds_id_check CHECK (((char_length(id) >= 1) AND (char_length(id) <= 256))),
    CONSTRAINT legal_holds_reason_code_check CHECK (((char_length(reason_code) >= 1) AND (char_length(reason_code) <= 64))),
    CONSTRAINT legal_holds_release_reason_check CHECK (((release_reason IS NULL) OR ((char_length(release_reason) >= 1) AND (char_length(release_reason) <= 256)))),
    CONSTRAINT legal_holds_released_by_check CHECK (((released_by IS NULL) OR ((char_length(released_by) >= 1) AND (char_length(released_by) <= 256)))),
    CONSTRAINT legal_holds_state_check CHECK ((state = ANY (ARRAY['active'::text, 'released'::text, 'expired'::text]))),
    CONSTRAINT legal_holds_subject_id_check CHECK (((char_length(subject_id) >= 1) AND (char_length(subject_id) <= 256))),
    CONSTRAINT legal_holds_subject_type_check CHECK ((subject_type = 'account'::text)),
    CONSTRAINT legal_holds_tenant_id_check CHECK (((char_length(tenant_id) >= 1) AND (char_length(tenant_id) <= 256))),
    CONSTRAINT legal_holds_version_check CHECK ((version >= 1))
);

--
-- Name: log_chunk_manifests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.log_chunk_manifests (
    id text NOT NULL,
    tenant_key text NOT NULL,
    log_type text NOT NULL,
    plane text NOT NULL,
    bucket_start_at bigint NOT NULL,
    bucket_end_at bigint NOT NULL,
    shard text NOT NULL,
    manifest_object_key text NOT NULL,
    chunk_count integer NOT NULL,
    record_count integer NOT NULL,
    checksum_sha256 text,
    status text NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    CONSTRAINT log_chunk_manifests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'committed'::text, 'repair_needed'::text])))
);

--
-- Name: log_chunk_record_index; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.log_chunk_record_index (
    record_id text NOT NULL,
    tenant_key text NOT NULL,
    log_type text NOT NULL,
    plane text NOT NULL,
    surface text,
    object_catalog_id text NOT NULL,
    chunk_id text NOT NULL,
    line_number integer,
    block_offset integer,
    block_length integer,
    record_offset integer,
    record_length integer,
    event_at bigint NOT NULL,
    index_profile text NOT NULL,
    indexed_fields jsonb,
    status text NOT NULL,
    created_at bigint NOT NULL,
    CONSTRAINT log_chunk_record_index_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'committed'::text, 'deleted'::text])))
);

--
-- Name: log_iceberg_core_publications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.log_iceberg_core_publications (
    id text NOT NULL,
    tenant_id text NOT NULL,
    storage_generation text NOT NULL,
    record_id text NOT NULL,
    source_dataset text NOT NULL,
    payload_hmac text NOT NULL,
    source_digest text NOT NULL,
    source_token text NOT NULL,
    state text NOT NULL,
    body_prepared integer DEFAULT 0 NOT NULL,
    admission_expires_at bigint DEFAULT 0 NOT NULL,
    admission_completed_at bigint,
    lease_token text,
    lease_until bigint,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    CONSTRAINT log_iceberg_core_publications_admission_expires_at_check CHECK ((admission_expires_at >= 0)),
    CONSTRAINT log_iceberg_core_publications_body_prepared_check CHECK ((body_prepared = ANY (ARRAY[0, 1]))),
    CONSTRAINT log_iceberg_core_publications_check CHECK (((state <> ALL (ARRAY['committed'::text, 'published'::text])) OR ((body_prepared = 1) AND (admission_expires_at > 0)))),
    CONSTRAINT log_iceberg_core_publications_check1 CHECK (((admission_completed_at IS NULL) OR (state = ANY (ARRAY['published'::text, 'aborted'::text])))),
    CONSTRAINT log_iceberg_core_publications_check2 CHECK (((lease_token IS NULL) = (lease_until IS NULL))),
    CONSTRAINT log_iceberg_core_publications_payload_hmac_check CHECK ((length(payload_hmac) = 64)),
    CONSTRAINT log_iceberg_core_publications_record_id_check CHECK ((length(record_id) = 64)),
    CONSTRAINT log_iceberg_core_publications_source_digest_check CHECK ((length(source_digest) = 64)),
    CONSTRAINT log_iceberg_core_publications_state_check CHECK ((state = ANY (ARRAY['prepared'::text, 'committed'::text, 'published'::text, 'aborted'::text])))
);

--
-- Name: log_object_catalog; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.log_object_catalog (
    id text NOT NULL,
    tenant_key text NOT NULL,
    log_type text NOT NULL,
    plane text NOT NULL,
    surface text,
    object_key text NOT NULL,
    object_kind text NOT NULL,
    status text NOT NULL,
    record_count integer DEFAULT 0 NOT NULL,
    byte_count integer DEFAULT 0 NOT NULL,
    checksum_sha256 text,
    compression text,
    encryption_scope text,
    key_version integer,
    created_at bigint NOT NULL,
    committed_at bigint,
    deleted_at bigint,
    CONSTRAINT log_object_catalog_compression_check CHECK ((compression = ANY (ARRAY['none'::text, 'gzip_block'::text]))),
    CONSTRAINT log_object_catalog_object_kind_check CHECK ((object_kind = ANY (ARRAY['chunk'::text, 'manifest'::text, 'dlq_payload'::text, 'export_artifact'::text]))),
    CONSTRAINT log_object_catalog_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'committed'::text, 'orphan_candidate'::text, 'deleted'::text])))
);

--
-- Name: lookup_retention_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lookup_retention_policies (
    tenant_id text NOT NULL,
    retention_days integer DEFAULT 180 NOT NULL,
    policy_generation bigint DEFAULT 1 NOT NULL,
    updated_by text NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    CONSTRAINT lookup_retention_policies_check CHECK ((updated_at >= created_at)),
    CONSTRAINT lookup_retention_policies_policy_generation_check CHECK ((policy_generation >= 1)),
    CONSTRAINT lookup_retention_policies_retention_days_check CHECK (((retention_days >= 30) AND (retention_days <= 3650))),
    CONSTRAINT lookup_retention_policies_tenant_id_check CHECK (((char_length(tenant_id) >= 1) AND (char_length(tenant_id) <= 256))),
    CONSTRAINT lookup_retention_policies_updated_by_check CHECK (((char_length(updated_by) >= 1) AND (char_length(updated_by) <= 256)))
);

--
-- Name: lookup_retention_policy_projection_outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lookup_retention_policy_projection_outbox (
    operation_id text NOT NULL,
    tenant_id text NOT NULL,
    policy_generation bigint NOT NULL,
    retention_days integer NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    next_attempt_at bigint NOT NULL,
    lease_owner text,
    lease_expires_at bigint,
    last_error_code text,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    completed_at bigint,
    CONSTRAINT lookup_retention_policy_projection_outb_policy_generation_check CHECK ((policy_generation >= 1)),
    CONSTRAINT lookup_retention_policy_projection_outbox_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT lookup_retention_policy_projection_outbox_check CHECK ((((lease_owner IS NULL) AND (lease_expires_at IS NULL)) OR ((lease_owner IS NOT NULL) AND (lease_expires_at IS NOT NULL)))),
    CONSTRAINT lookup_retention_policy_projection_outbox_check1 CHECK ((((status = 'succeeded'::text) AND (completed_at IS NOT NULL)) OR (status <> 'succeeded'::text))),
    CONSTRAINT lookup_retention_policy_projection_outbox_check2 CHECK ((updated_at >= created_at)),
    CONSTRAINT lookup_retention_policy_projection_outbox_operation_id_check CHECK (((char_length(operation_id) >= 1) AND (char_length(operation_id) <= 256))),
    CONSTRAINT lookup_retention_policy_projection_outbox_retention_days_check CHECK (((retention_days >= 30) AND (retention_days <= 3650))),
    CONSTRAINT lookup_retention_policy_projection_outbox_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'succeeded'::text, 'blocked'::text])))
);

--
-- Name: oauth_client_consent_revocations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oauth_client_consent_revocations (
    tenant_id text NOT NULL,
    user_id text NOT NULL,
    client_id text NOT NULL,
    generation integer DEFAULT 0 NOT NULL,
    revoked_at bigint NOT NULL
);

--
-- Name: oauth_client_consents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oauth_client_consents (
    id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    user_id text NOT NULL,
    client_id text NOT NULL,
    scopes text NOT NULL,
    granted_at bigint NOT NULL,
    expires_at bigint,
    revoked_at bigint,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    consent_generation bigint DEFAULT 0 NOT NULL
);

--
-- Name: oauth_clients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oauth_clients (
    client_id text NOT NULL,
    client_name text NOT NULL,
    description text,
    redirect_uris text NOT NULL,
    grant_types text NOT NULL,
    response_types text NOT NULL,
    scope text,
    logo_uri text,
    client_uri text,
    policy_uri text,
    tos_uri text,
    contacts text,
    subject_type text DEFAULT 'public'::text,
    sector_identifier_uri text,
    token_endpoint_auth_method text DEFAULT 'client_secret_basic'::text,
    token_exchange_allowed integer DEFAULT 0,
    allowed_subject_token_clients text,
    allowed_token_exchange_resources text,
    delegation_mode text DEFAULT 'delegation'::text,
    client_credentials_allowed integer DEFAULT 0,
    allowed_scopes text,
    default_scope text,
    default_audience text,
    default_resource text,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    is_trusted integer DEFAULT 0,
    skip_consent integer DEFAULT 0,
    allow_claims_without_scope integer DEFAULT 0,
    claims_parameter_policy text,
    asc_enabled integer DEFAULT 1,
    asc_protected_request_required integer DEFAULT 1,
    asc_sao_enabled integer DEFAULT 1,
    asc_transformed_claims_enabled integer DEFAULT 1,
    asc_allowed_transformed_claims text,
    backchannel_token_delivery_mode text,
    backchannel_client_notification_endpoint text,
    backchannel_authentication_request_signing_alg text,
    backchannel_user_code_parameter integer DEFAULT 0,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    jwks text,
    jwks_uri text,
    userinfo_signed_response_alg text,
    post_logout_redirect_uris text,
    allowed_redirect_origins text,
    backchannel_logout_uri text,
    backchannel_logout_session_required integer DEFAULT 0,
    frontchannel_logout_uri text,
    frontchannel_logout_session_required integer DEFAULT 0,
    logout_webhook_uri text,
    logout_webhook_secret_encrypted text,
    registration_access_token_hash text,
    initiate_login_uri text,
    login_ui_url text,
    id_token_signed_response_alg text,
    request_object_signing_alg text,
    client_secret_hash text,
    software_id text,
    software_version text,
    requestable_scopes text,
    require_pkce integer DEFAULT 0,
    application_type text DEFAULT 'web'::text,
    trust_group text,
    trust_group_id text,
    browser_public_client_mode text,
    browser_refresh_token_policy text DEFAULT 'disabled'::text NOT NULL,
    native_sso_enabled integer,
    native_channel_allowed integer,
    allowed_channels text,
    device_secret_revoke_enabled integer,
    device_secret_revoke_trust_groups text,
    device_secret_introspection_enabled integer,
    device_secret_introspection_trust_groups text,
    identity_mapping text,
    attribute_release_consent text,
    authorization_signed_response_alg text,
    authorization_encrypted_response_alg text,
    authorization_encrypted_response_enc text,
    token_endpoint_auth_signing_alg text,
    agent_access_registration_mode text,
    agent_access_expires_at bigint,
    agent_access_last_used_at bigint,
    agent_access_registration_slot integer,
    client_metadata_url text,
    client_metadata_hash text,
    client_metadata_fetched_at bigint,
    tls_client_certificate_bound_access_tokens integer DEFAULT 0 NOT NULL,
    minimum_ial text,
    CONSTRAINT oauth_clients_agent_access_registration_mode_check CHECK (((agent_access_registration_mode IS NULL) OR (agent_access_registration_mode = ANY (ARRAY['restricted_dcr'::text, 'cimd'::text])))),
    CONSTRAINT oauth_clients_agent_access_registration_slot_check CHECK (((agent_access_registration_slot IS NULL) OR ((agent_access_registration_slot >= 0) AND (agent_access_registration_slot < 20)))),
    CONSTRAINT oauth_clients_minimum_ial_check CHECK (((minimum_ial IS NULL) OR (minimum_ial = ANY (ARRAY['IAL1'::text, 'IAL2'::text, 'IAL3'::text]))))
);

--
-- Name: oidc_scopes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oidc_scopes (
    id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    name text NOT NULL,
    display_name text NOT NULL,
    description text,
    scope_type text DEFAULT 'custom'::text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    localizations_json jsonb,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    CONSTRAINT oidc_scopes_scope_type_check CHECK ((scope_type = ANY (ARRAY['system'::text, 'custom'::text])))
);

--
-- Name: passkeys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.passkeys (
    id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    user_id text NOT NULL,
    credential_id text NOT NULL,
    public_key text NOT NULL,
    counter bigint DEFAULT 0 NOT NULL,
    transports text,
    device_name text,
    aaguid text,
    created_at bigint NOT NULL,
    last_used_at bigint,
    rp_id text
);

--
-- Name: profile_attribute_values; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profile_attribute_values (
    id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    profile_id text NOT NULL,
    catalog_entry_id text NOT NULL,
    value_type text NOT NULL,
    value_json text,
    value_storage_ref text,
    value_hash text,
    classification text DEFAULT 'internal'::text NOT NULL,
    purpose text,
    is_primary boolean DEFAULT false NOT NULL,
    display_order integer DEFAULT 0 NOT NULL,
    lifecycle_state text DEFAULT 'active'::text NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    deleted_at bigint
);

--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profiles (
    id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    subject_id text NOT NULL,
    profile_type text DEFAULT 'person'::text NOT NULL,
    lifecycle_state text DEFAULT 'active'::text NOT NULL,
    locale text,
    zoneinfo text,
    display_name_ref text,
    metadata_json text,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    deleted_at bigint
);

--
-- Name: provisioning_revocation_receipts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provisioning_revocation_receipts (
    tenant_id text NOT NULL,
    id text NOT NULL,
    account_id text NOT NULL,
    subject_id text,
    source_event_id text NOT NULL,
    target_id text NOT NULL,
    decision text NOT NULL,
    reason_codes_json text NOT NULL,
    created_at bigint NOT NULL
);

--
-- Name: relationships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.relationships (
    id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    relationship_type text NOT NULL,
    from_type text DEFAULT 'subject'::text NOT NULL,
    from_id text NOT NULL,
    to_type text DEFAULT 'subject'::text NOT NULL,
    to_id text NOT NULL,
    permission_level text DEFAULT 'full'::text NOT NULL,
    expires_at bigint,
    is_bidirectional boolean DEFAULT false NOT NULL,
    metadata_json text,
    evidence_type text DEFAULT 'manual'::text,
    evidence_ref text,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL
);

--
-- Name: role_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.role_assignments (
    id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    subject_id text NOT NULL,
    role_id text NOT NULL,
    scope_type text DEFAULT 'global'::text NOT NULL,
    scope_target text DEFAULT ''::text NOT NULL,
    expires_at bigint,
    assigned_by text,
    metadata_json text,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL
);

--
-- Name: roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.roles (
    id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    name text NOT NULL,
    description text,
    permissions_json text NOT NULL,
    role_type text DEFAULT 'custom'::text NOT NULL,
    hierarchy_level integer DEFAULT 0 NOT NULL,
    is_assignable boolean DEFAULT true NOT NULL,
    parent_role_id text,
    display_name text,
    is_system boolean DEFAULT false NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint,
    external_id text
);

--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    version integer NOT NULL,
    name text NOT NULL,
    applied_at bigint NOT NULL,
    checksum text NOT NULL,
    execution_time_ms integer,
    rollback_sql text
);

--
-- Name: screens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.screens (
    id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    screen_key text NOT NULL,
    display_name text NOT NULL,
    description text,
    screen_kind text NOT NULL,
    fields_json jsonb NOT NULL,
    localizations_json jsonb,
    is_active boolean DEFAULT true NOT NULL,
    is_system boolean DEFAULT false NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    settings_json jsonb,
    CONSTRAINT screens_screen_kind_check CHECK ((screen_kind = ANY (ARRAY['registration'::text, 'profile_completion'::text, 'login'::text, 'consent'::text, 'code_input'::text, 'account'::text, 'custom'::text])))
);

--
-- Name: service_group_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.service_group_audit (
    id text NOT NULL,
    tenant_id text NOT NULL,
    user_id text NOT NULL,
    rule_version bigint NOT NULL,
    generation bigint NOT NULL,
    event_type text NOT NULL,
    detail_json text NOT NULL,
    created_at bigint NOT NULL
);

--
-- Name: service_group_catalog; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.service_group_catalog (
    tenant_id text NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    plan_json text NOT NULL,
    updated_at bigint NOT NULL,
    write_token text NOT NULL
);

--
-- Name: service_group_epoch; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.service_group_epoch (
    tenant_id text NOT NULL,
    revision bigint DEFAULT 1 NOT NULL
);

--
-- Name: service_group_inputs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.service_group_inputs (
    tenant_id text NOT NULL,
    user_id text NOT NULL,
    revision bigint DEFAULT 1 NOT NULL
);

--
-- Name: service_group_manual; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.service_group_manual (
    tenant_id text NOT NULL,
    user_id text NOT NULL,
    group_id text NOT NULL
);

--
-- Name: service_group_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.service_group_results (
    tenant_id text NOT NULL,
    user_id text NOT NULL,
    generation bigint DEFAULT 0 NOT NULL,
    rule_version bigint DEFAULT 0 NOT NULL,
    core_version bigint DEFAULT '-1'::integer NOT NULL,
    pii_version bigint DEFAULT '-1'::integer NOT NULL,
    metadata_version bigint DEFAULT '-1'::integer NOT NULL,
    epoch bigint DEFAULT '-1'::integer NOT NULL,
    result_json text,
    route_version text DEFAULT ''::text NOT NULL,
    evaluated_at bigint,
    lease_token text,
    lease_until bigint DEFAULT 0 NOT NULL,
    error_code text,
    attempts bigint DEFAULT 0 NOT NULL
);

--
-- Name: service_group_revisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.service_group_revisions (
    tenant_id text NOT NULL,
    revision bigint NOT NULL,
    plan_json text NOT NULL,
    actor_id text NOT NULL,
    created_at bigint NOT NULL
);

--
-- Name: service_group_scans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.service_group_scans (
    tenant_id text NOT NULL,
    binding_ref text NOT NULL,
    rule_version bigint NOT NULL,
    cursor_id text DEFAULT ''::text NOT NULL,
    processed bigint DEFAULT 0 NOT NULL,
    failures bigint DEFAULT 0 NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    lease_token text,
    lease_until bigint DEFAULT 0 NOT NULL,
    updated_at bigint NOT NULL
);

--
-- Name: service_group_write_boundaries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.service_group_write_boundaries (
    id text NOT NULL,
    tenant_id text NOT NULL,
    user_id text NOT NULL,
    operation text NOT NULL,
    status text NOT NULL,
    created_at bigint NOT NULL
);

--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    id text NOT NULL,
    user_id text NOT NULL,
    expires_at bigint NOT NULL,
    created_at bigint NOT NULL,
    external_provider_id text,
    external_provider_sub text,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    external_provider_sid text
);

--
-- Name: sign_in_confirmation_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sign_in_confirmation_policies (
    id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    name text NOT NULL,
    display_name text NOT NULL,
    description text,
    trigger_type text DEFAULT 'login'::text NOT NULL,
    mode text DEFAULT 'disabled'::text NOT NULL,
    remember_duration_days bigint DEFAULT 365 NOT NULL,
    show_application_context bigint DEFAULT 1 NOT NULL,
    show_tenant_context bigint DEFAULT 1 NOT NULL,
    is_active bigint DEFAULT 1 NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL
);

--
-- Name: statement_consent_admissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.statement_consent_admissions (
    tenant_id text NOT NULL,
    operation_id text NOT NULL,
    payload_sha256 text NOT NULL,
    statement_id text NOT NULL,
    definition_generation bigint NOT NULL,
    physical_id text NOT NULL,
    restore_epoch text NOT NULL,
    issued_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    CONSTRAINT statement_consent_admissions_check CHECK (((expires_at >= issued_at) AND (expires_at <= '9007199254740991'::bigint))),
    CONSTRAINT statement_consent_admissions_definition_generation_check CHECK (((definition_generation >= 0) AND (definition_generation <= '9007199254740991'::bigint))),
    CONSTRAINT statement_consent_admissions_issued_at_check CHECK (((issued_at >= 0) AND (issued_at <= '9007199254740991'::bigint))),
    CONSTRAINT statement_consent_admissions_operation_id_check CHECK ((operation_id ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT statement_consent_admissions_payload_sha256_check CHECK ((payload_sha256 ~ '^[a-f0-9]{64}$'::text))
);

--
-- Name: statement_consent_guards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.statement_consent_guards (
    tenant_id text NOT NULL,
    scope_kind text NOT NULL,
    scope_key text NOT NULL,
    mode text DEFAULT 'disabled'::text NOT NULL,
    definition_generation bigint DEFAULT 0 NOT NULL,
    closed_generation bigint DEFAULT 0 NOT NULL,
    account_id text DEFAULT ''::text NOT NULL,
    physical_id text NOT NULL,
    restore_epoch text NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    CONSTRAINT statement_consent_guards_check CHECK (((updated_at >= created_at) AND (updated_at <= '9007199254740991'::bigint))),
    CONSTRAINT statement_consent_guards_check1 CHECK ((((scope_kind = 'tenant'::text) AND (scope_key = ''::text)) OR ((scope_kind = 'statement'::text) AND (length(scope_key) > 0)))),
    CONSTRAINT statement_consent_guards_closed_generation_check CHECK (((closed_generation >= 0) AND (closed_generation <= '9007199254740991'::bigint))),
    CONSTRAINT statement_consent_guards_created_at_check CHECK (((created_at >= 0) AND (created_at <= '9007199254740991'::bigint))),
    CONSTRAINT statement_consent_guards_definition_generation_check CHECK (((definition_generation >= 0) AND (definition_generation <= '9007199254740991'::bigint))),
    CONSTRAINT statement_consent_guards_mode_check CHECK ((mode = ANY (ARRAY['disabled'::text, 'enforced'::text, 'closed'::text]))),
    CONSTRAINT statement_consent_guards_scope_kind_check CHECK ((scope_kind = ANY (ARRAY['tenant'::text, 'statement'::text])))
);

--
-- Name: statement_consent_key_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.statement_consent_key_states (
    tenant_id text NOT NULL,
    user_id text NOT NULL,
    statement_id text NOT NULL,
    account_id text NOT NULL,
    physical_id text NOT NULL,
    restore_epoch text NOT NULL,
    revision bigint NOT NULL,
    withdrawal_generation bigint NOT NULL,
    last_operation_id text,
    updated_at bigint NOT NULL,
    CONSTRAINT statement_consent_key_states_revision_check CHECK (((revision >= 0) AND (revision <= '9007199254740991'::bigint))),
    CONSTRAINT statement_consent_key_states_updated_at_check CHECK (((updated_at >= 0) AND (updated_at <= '9007199254740991'::bigint))),
    CONSTRAINT statement_consent_key_states_withdrawal_generation_check CHECK (((withdrawal_generation >= 0) AND (withdrawal_generation <= '9007199254740991'::bigint)))
);

--
-- Name: statement_consent_operations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.statement_consent_operations (
    tenant_id text NOT NULL,
    operation_id text NOT NULL,
    attempt_id text NOT NULL,
    payload_sha256 text NOT NULL,
    actor_id text NOT NULL,
    actor_type text NOT NULL,
    action text NOT NULL,
    user_id text NOT NULL,
    account_id text NOT NULL,
    statement_id text NOT NULL,
    physical_id text NOT NULL,
    restore_epoch text NOT NULL,
    expected_revision bigint NOT NULL,
    expected_withdrawal_generation bigint NOT NULL,
    expected_definition_generation bigint NOT NULL,
    expected_closed_generation bigint NOT NULL,
    issued_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    effect_at bigint NOT NULL,
    definition_json text NOT NULL,
    before_json text,
    after_json text NOT NULL,
    history_json text,
    admitted integer NOT NULL,
    is_noop integer NOT NULL,
    status text DEFAULT 'executing'::text NOT NULL,
    is_terminal integer DEFAULT 0 NOT NULL,
    required_terminal integer DEFAULT 1 NOT NULL,
    CONSTRAINT statement_consent_operations_action_check CHECK ((action = ANY (ARRAY['grant'::text, 'deny'::text, 'withdraw'::text]))),
    CONSTRAINT statement_consent_operations_actor_id_check CHECK (((length(actor_id) >= 1) AND (length(actor_id) <= 512))),
    CONSTRAINT statement_consent_operations_actor_type_check CHECK (((length(actor_type) >= 1) AND (length(actor_type) <= 128))),
    CONSTRAINT statement_consent_operations_admitted_check CHECK ((admitted = ANY (ARRAY[0, 1]))),
    CONSTRAINT statement_consent_operations_after_json_check CHECK ((jsonb_typeof((after_json)::jsonb) = 'object'::text)),
    CONSTRAINT statement_consent_operations_attempt_id_check CHECK (((length(attempt_id) >= 1) AND (length(attempt_id) <= 128))),
    CONSTRAINT statement_consent_operations_before_json_check CHECK (((before_json IS NULL) OR (jsonb_typeof((before_json)::jsonb) = 'object'::text))),
    CONSTRAINT statement_consent_operations_check CHECK (((expires_at >= issued_at) AND (expires_at <= '9007199254740991'::bigint))),
    CONSTRAINT statement_consent_operations_check1 CHECK (((effect_at >= issued_at) AND (effect_at <= expires_at))),
    CONSTRAINT statement_consent_operations_check2 CHECK ((((status = 'executing'::text) AND (is_terminal = 0)) OR ((status = ANY (ARRAY['applied'::text, 'rejected'::text])) AND (is_terminal = 1)))),
    CONSTRAINT statement_consent_operations_check3 CHECK ((((is_noop = 1) AND (history_json IS NULL) AND (before_json IS NOT NULL)) OR ((is_noop = 0) AND (history_json IS NOT NULL)))),
    CONSTRAINT statement_consent_operations_definition_json_check CHECK ((jsonb_typeof((definition_json)::jsonb) = 'object'::text)),
    CONSTRAINT statement_consent_operations_expected_closed_generation_check CHECK (((expected_closed_generation >= 0) AND (expected_closed_generation <= '9007199254740991'::bigint))),
    CONSTRAINT statement_consent_operations_expected_definition_generati_check CHECK (((expected_definition_generation >= 0) AND (expected_definition_generation <= '9007199254740991'::bigint))),
    CONSTRAINT statement_consent_operations_expected_revision_check CHECK (((expected_revision >= 0) AND (expected_revision <= '9007199254740990'::bigint))),
    CONSTRAINT statement_consent_operations_expected_withdrawal_generati_check CHECK (((expected_withdrawal_generation >= 0) AND (expected_withdrawal_generation <= '9007199254740990'::bigint))),
    CONSTRAINT statement_consent_operations_history_json_check CHECK (((history_json IS NULL) OR (jsonb_typeof((history_json)::jsonb) = 'object'::text))),
    CONSTRAINT statement_consent_operations_is_noop_check CHECK ((is_noop = ANY (ARRAY[0, 1]))),
    CONSTRAINT statement_consent_operations_is_terminal_check CHECK ((is_terminal = ANY (ARRAY[0, 1]))),
    CONSTRAINT statement_consent_operations_issued_at_check CHECK (((issued_at >= 0) AND (issued_at <= '9007199254740991'::bigint))),
    CONSTRAINT statement_consent_operations_operation_id_check CHECK ((operation_id ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT statement_consent_operations_payload_sha256_check CHECK ((payload_sha256 ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT statement_consent_operations_required_terminal_check CHECK ((required_terminal = 1)),
    CONSTRAINT statement_consent_operations_status_check CHECK ((status = ANY (ARRAY['executing'::text, 'applied'::text, 'rejected'::text])))
);

--
-- Name: statement_consent_projection_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.statement_consent_projection_jobs (
    tenant_id text NOT NULL,
    statement_id text NOT NULL,
    definition_generation bigint NOT NULL,
    closed_generation bigint NOT NULL,
    mode text NOT NULL,
    targets_json text,
    cursor_binding_ref text,
    updated_at bigint NOT NULL,
    CONSTRAINT statement_consent_projection_jobs_closed_generation_check CHECK (((closed_generation >= 0) AND (closed_generation <= '9007199254740991'::bigint))),
    CONSTRAINT statement_consent_projection_jobs_definition_generation_check CHECK (((definition_generation >= 0) AND (definition_generation <= '9007199254740991'::bigint))),
    CONSTRAINT statement_consent_projection_jobs_mode_check CHECK ((mode = ANY (ARRAY['enforced'::text, 'closed'::text])))
);

--
-- Name: statement_consent_retention_permits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.statement_consent_retention_permits (
    tenant_id text NOT NULL,
    permit_id text NOT NULL,
    row_kind text NOT NULL,
    row_id text NOT NULL,
    user_id text NOT NULL,
    statement_id text NOT NULL,
    account_id text NOT NULL,
    physical_id text NOT NULL,
    restore_epoch text NOT NULL,
    cutoff_at bigint NOT NULL,
    legacy_retention_days bigint,
    issued_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    CONSTRAINT statement_consent_retention_permits_check CHECK (((expires_at >= issued_at) AND (expires_at <= '9007199254740991'::bigint))),
    CONSTRAINT statement_consent_retention_permits_cutoff_at_check CHECK (((cutoff_at >= 0) AND (cutoff_at <= '9007199254740991'::bigint))),
    CONSTRAINT statement_consent_retention_permits_issued_at_check CHECK (((issued_at >= 0) AND (issued_at <= '9007199254740991'::bigint))),
    CONSTRAINT statement_consent_retention_permits_legacy_retention_days_check CHECK (((legacy_retention_days >= 0) AND (legacy_retention_days <= ('9007199254740991'::bigint / 86400000)))),
    CONSTRAINT statement_consent_retention_permits_row_kind_check CHECK ((row_kind = ANY (ARRAY['record'::text, 'history'::text])))
);

--
-- Name: structured_attribute_values; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.structured_attribute_values (
    id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    owner_type text NOT NULL,
    owner_id text NOT NULL,
    catalog_entry_id text NOT NULL,
    canonical_json text NOT NULL,
    projected_index_json text,
    classification text DEFAULT 'internal'::text NOT NULL,
    lifecycle_state text DEFAULT 'active'::text NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    deleted_at bigint
);

--
-- Name: subject_account_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subject_account_links (
    id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    subject_id text NOT NULL,
    account_id text NOT NULL,
    link_type text DEFAULT 'primary'::text NOT NULL,
    lifecycle_state text DEFAULT 'active'::text NOT NULL,
    source_ref text,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    deleted_at bigint
);

--
-- Name: tenant_consent_requirements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_consent_requirements (
    id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    statement_id text NOT NULL,
    is_required bigint DEFAULT 0 NOT NULL,
    min_version text,
    enforcement text DEFAULT 'block'::text NOT NULL,
    show_deletion_link bigint DEFAULT 0 NOT NULL,
    deletion_url text,
    conditional_rules_json text,
    display_order bigint DEFAULT 0 NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL
);

--
-- Name: tenants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenants (
    id text NOT NULL,
    tenant_code text NOT NULL,
    tenant_key text NOT NULL,
    name text NOT NULL,
    description text,
    is_default boolean DEFAULT false NOT NULL,
    default_tenant_guard text,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    lifecycle_state text DEFAULT 'active'::text NOT NULL,
    isolation_policy text DEFAULT 'tenant_exclusive'::text NOT NULL,
    CONSTRAINT tenants_check CHECK ((((is_default = true) AND (default_tenant_guard = 'default'::text)) OR ((is_default = false) AND (default_tenant_guard IS NULL)))),
    CONSTRAINT tenants_isolation_policy_check CHECK ((isolation_policy = ANY (ARRAY['shared_pool'::text, 'tenant_exclusive'::text]))),
    CONSTRAINT tenants_lifecycle_state_check CHECK ((lifecycle_state = ANY (ARRAY['provisioning'::text, 'active'::text, 'suspended'::text, 'frozen'::text, 'migration_read_only'::text, 'deleting'::text, 'deleted'::text, 'restore_pending'::text, 'restore_validating'::text])))
);

--
-- Name: user_consent_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_consent_records (
    id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    user_id text NOT NULL,
    statement_id text NOT NULL,
    version_id text NOT NULL,
    version text NOT NULL,
    status text DEFAULT 'granted'::text NOT NULL,
    granted_at bigint,
    withdrawn_at bigint,
    expires_at bigint,
    retain_until bigint,
    consent_settings_snapshot_at bigint,
    record_retention_days_snapshot bigint,
    reconsent_interval_days_snapshot bigint,
    client_id text,
    ip_address_hash text,
    user_agent text,
    receipt_id text,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    content_hash text
);

--
-- Name: user_custom_fields; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_custom_fields (
    user_id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    field_name text NOT NULL,
    field_value text,
    field_type text,
    searchable boolean DEFAULT true NOT NULL
);

--
-- Name: user_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_roles (
    user_id text NOT NULL,
    role_id text NOT NULL,
    created_at bigint NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL
);

--
-- Name: user_verified_attributes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_verified_attributes (
    id text NOT NULL,
    tenant_id text NOT NULL,
    user_id text NOT NULL,
    attribute_name text NOT NULL,
    attribute_value text NOT NULL,
    source_type text DEFAULT 'vc'::text NOT NULL,
    issuer_did text,
    verification_id text,
    verified_at bigint,
    expires_at bigint,
    created_at bigint DEFAULT 0 NOT NULL,
    updated_at bigint DEFAULT 0 NOT NULL,
    revalidate_after bigint
);

--
-- Name: users_core; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users_core (
    id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    email_verified boolean DEFAULT false NOT NULL,
    phone_number_verified boolean DEFAULT false NOT NULL,
    email_domain_hash text,
    email_domain_hash_version integer DEFAULT 1 NOT NULL,
    password_hash text,
    is_active boolean DEFAULT true NOT NULL,
    user_type text DEFAULT 'end_user'::text NOT NULL,
    pii_partition text DEFAULT 'default'::text NOT NULL,
    pii_status text DEFAULT 'pending'::text NOT NULL,
    external_id text,
    status text DEFAULT 'active'::text NOT NULL,
    lifecycle_state text DEFAULT 'active'::text NOT NULL,
    suspended_at bigint,
    suspended_until bigint,
    locked_at bigint,
    locked_until bigint,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    last_login_at bigint,
    CONSTRAINT users_core_lifecycle_state_check CHECK ((lifecycle_state = ANY (ARRAY['invited'::text, 'pending_verification'::text, 'provisioning'::text, 'incomplete'::text, 'active'::text, 'dormant'::text, 'archived'::text, 'deprovisioned'::text]))),
    CONSTRAINT users_core_status_check CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text, 'locked'::text])))
);

--
-- Name: web_origin_registry; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.web_origin_registry (
    id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    client_id text NOT NULL,
    origin text NOT NULL,
    cors_allowed integer DEFAULT 1 NOT NULL,
    csp_frame_ancestors text,
    handoff_allowed integer DEFAULT 1 NOT NULL,
    iframe_allowed integer DEFAULT 0 NOT NULL,
    environment text,
    is_active integer DEFAULT 1 NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL
);

--
-- Name: webhook_configs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.webhook_configs (
    id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    client_id text,
    scope text DEFAULT 'tenant'::text NOT NULL,
    name text NOT NULL,
    url text NOT NULL,
    events text NOT NULL,
    secret_encrypted text,
    headers text,
    retry_policy text NOT NULL,
    timeout_ms integer DEFAULT 10000 NOT NULL,
    active integer DEFAULT 1 NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    last_success_at text,
    last_failure_at text,
    payload_fields text DEFAULT '[]'::text NOT NULL,
    registration_states text DEFAULT '[]'::text NOT NULL
);

--
-- Data for Name: account_creation_operations; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: account_legal_hold_states; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: account_lifecycle_event_outbox; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: account_support_contexts; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: account_webhook_outbox; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: application_launchers; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: assurance_evidence; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: attribute_verifications; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: client_consent_overrides; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: client_trust_policies; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: consent_item_history; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: consent_policies; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: consent_policy_items; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: consent_records; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: consent_statement_localizations; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: consent_statement_versions; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: consent_statements; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: contact_points; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: contact_verifications; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: custom_claim_schema_history; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: custom_claim_schemas; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: directory_connector_instances; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: directory_connector_status_episodes; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: directory_identity_links; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: directory_jit_pending_users; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: event_log; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: field_usage_bindings; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: flow_assignments; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.flow_assignments VALUES ('flow-assignment-default-login', 'default', 'tenant', NULL, 'login', 'flow-default-login-no-consent', true, __AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_SECONDS__);
INSERT INTO public.flow_assignments VALUES ('flow-assignment-default-registration', 'default', 'tenant', NULL, 'registration', 'flow-default-registration-no-consent', true, __AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_SECONDS__);

--
-- Data for Name: flow_audit_events; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: flow_interaction_steps; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: flow_interactions; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: flow_versions; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.flow_versions VALUES ('flow-version-default-login-no-consent-v1', 'default', 'flow-default-login-no-consent', 1, 'authrim.login_ui.contract.v1', '{"flow_kind":"login","flow_id":"flow-default-login-no-consent","ui":{"steps":[{"id":"request:step","source_node_id":"request","component":"interaction_context","render":false,"config":{"ui_kind":"start"}},{"id":"session-check:step","source_node_id":"session-check","component":"session_check","render":false,"config":{"ui_kind":"session"}},{"id":"authentication:step","source_node_id":"authentication","component":"authentication_method_selector","render":true,"config":{"ui_kind":"authentication","authentication_profile_ref":"default","screen_ref":"login","outputs":[{"id":"mail_otp","label":"Email OTP"},{"id":"totp","label":"Authenticator app"},{"id":"passkey","label":"Passkey"},{"id":"facebook","label":"Facebook"}]}},{"id":"saml-attribute-release-complete:step","source_node_id":"saml-attribute-release-complete","component":"completion","render":true,"config":{"ui_kind":"end","completion_block":{"id":"saml-attribute-release-completion","label":"SAML Attribute Release Completion","protocol":"saml","purpose":"attribute_release","role":"output"}}},{"id":"oidc-authorization-complete:step","source_node_id":"oidc-authorization-complete","component":"completion","render":true,"config":{"ui_kind":"end","completion_block":{"id":"oidc-authorization-completion","label":"OIDC Authorization Completion","protocol":"oidc","purpose":"authorization","role":"output"}}}]}}', '{"nodes":[{"id":"request","type":"entry","title":"Login Request","position":{"x":360,"y":0},"config":{"ui_kind":"start"}},{"id":"session-check","type":"session_check","title":"Session Check","position":{"x":360,"y":144},"config":{"ui_kind":"session"}},{"id":"authentication","type":"authentication","title":"Authentication Method","position":{"x":522,"y":288},"config":{"ui_kind":"authentication","authentication_profile_ref":"default","screen_ref":"login","outputs":[{"id":"mail_otp","label":"Email OTP"},{"id":"totp","label":"Authenticator app"},{"id":"passkey","label":"Passkey"},{"id":"facebook","label":"Facebook"}]}},{"id":"saml-attribute-release-complete","type":"complete","title":"Complete","position":{"x":108,"y":612},"config":{"ui_kind":"end","completion_block":{"id":"saml-attribute-release-completion","label":"SAML Attribute Release Completion","protocol":"saml","purpose":"attribute_release","role":"output"}}},{"id":"oidc-authorization-complete","type":"complete","title":"Complete","position":{"x":594,"y":612},"config":{"ui_kind":"end","completion_block":{"id":"oidc-authorization-completion","label":"OIDC Authorization Completion","protocol":"oidc","purpose":"authorization","role":"output"}}}],"edges":[{"id":"request:next->session-check","source":"request","source_handle":"next","target":"session-check"},{"id":"session-check:continue->saml-attribute-release-complete","source":"session-check","source_handle":"continue","target":"saml-attribute-release-complete"},{"id":"session-check:continue->oidc-authorization-complete","source":"session-check","source_handle":"continue","target":"oidc-authorization-complete"},{"id":"session-check:authenticate->authentication","source":"session-check","source_handle":"authenticate","target":"authentication"},{"id":"authentication:mail_otp->saml-attribute-release-complete","source":"authentication","source_handle":"mail_otp","target":"saml-attribute-release-complete"},{"id":"authentication:mail_otp->oidc-authorization-complete","source":"authentication","source_handle":"mail_otp","target":"oidc-authorization-complete"},{"id":"authentication:totp->saml-attribute-release-complete","source":"authentication","source_handle":"totp","target":"saml-attribute-release-complete"},{"id":"authentication:totp->oidc-authorization-complete","source":"authentication","source_handle":"totp","target":"oidc-authorization-complete"},{"id":"authentication:passkey->saml-attribute-release-complete","source":"authentication","source_handle":"passkey","target":"saml-attribute-release-complete"},{"id":"authentication:passkey->oidc-authorization-complete","source":"authentication","source_handle":"passkey","target":"oidc-authorization-complete"},{"id":"authentication:facebook->saml-attribute-release-complete","source":"authentication","source_handle":"facebook","target":"saml-attribute-release-complete"},{"id":"authentication:facebook->oidc-authorization-complete","source":"authentication","source_handle":"facebook","target":"oidc-authorization-complete"}],"viewport":{"x":36,"y":36,"zoom":1}}', '{"valid":true,"errors":[],"warnings":[],"issues":[]}', 'system', __AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_SECONDS__);
INSERT INTO public.flow_versions VALUES ('flow-version-default-registration-no-consent-v1', 'default', 'flow-default-registration-no-consent', 1, 'authrim.login_ui.contract.v1', '{"flow_kind":"registration","flow_id":"flow-default-registration-no-consent","ui":{"steps":[{"id":"request:step","source_node_id":"request","component":"interaction_context","render":false,"config":{"ui_kind":"start"}},{"id":"registration-method:step","source_node_id":"registration-method","component":"registration_method_selector","render":true,"config":{"ui_kind":"registration","authentication_profile_ref":"default","screen_ref":"registration","outputs":[{"id":"mail_otp","label":"Email OTP"},{"id":"totp","label":"Authenticator app"},{"id":"passkey","label":"Passkey"},{"id":"facebook","label":"Facebook"}]}},{"id":"account-create:step","source_node_id":"account-create","component":"account_action","render":false,"config":{"ui_kind":"account"}},{"id":"output:step","source_node_id":"output","component":"completion","render":true,"config":{"ui_kind":"end"}}]}}', '{"nodes":[{"id":"request","type":"entry","title":"Registration Request","position":{"x":360,"y":0},"config":{"ui_kind":"start"}},{"id":"registration-method","type":"registration","title":"Registration Method","position":{"x":360,"y":144},"config":{"ui_kind":"registration","authentication_profile_ref":"default","screen_ref":"registration","outputs":[{"id":"mail_otp","label":"Email OTP"},{"id":"totp","label":"Authenticator app"},{"id":"passkey","label":"Passkey"},{"id":"facebook","label":"Facebook"}]}},{"id":"account-create","type":"account_action","title":"Account Creation","position":{"x":360,"y":288},"config":{"ui_kind":"account"}},{"id":"output","type":"complete","title":"Complete","position":{"x":360,"y":432},"config":{"ui_kind":"end"}}],"edges":[{"id":"request:next->registration-method","source":"request","source_handle":"next","target":"registration-method"},{"id":"registration-method:mail_otp->account-create","source":"registration-method","source_handle":"mail_otp","target":"account-create"},{"id":"registration-method:totp->account-create","source":"registration-method","source_handle":"totp","target":"account-create"},{"id":"registration-method:passkey->account-create","source":"registration-method","source_handle":"passkey","target":"account-create"},{"id":"registration-method:facebook->account-create","source":"registration-method","source_handle":"facebook","target":"account-create"},{"id":"account-create:completed->output","source":"account-create","source_handle":"completed","target":"output"}],"viewport":{"x":36,"y":36,"zoom":1}}', '{"valid":true,"errors":[],"warnings":[],"issues":[]}', 'system', __AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_SECONDS__);
INSERT INTO public.flow_versions VALUES ('flow-version-saml-sp-oidc-rp-v1', 'default', 'flow-saml-sp-oidc-rp', 1, 'authrim.login_ui.contract.v1', '{"flow_kind":"login","flow_id":"flow-saml-sp-oidc-rp","ui":{"steps":[{"id":"request:step","source_node_id":"request","component":"interaction_context","render":false,"config":{"ui_kind":"entry"}},{"id":"session-check:step","source_node_id":"session-check","component":"session_check","render":false,"config":{"ui_kind":"session"}},{"id":"authentication:step","source_node_id":"authentication","component":"authentication_method_selector","render":true,"config":{"ui_kind":"authentication","authentication_profile_ref":"default","screen_ref":"login","outputs":[{"id":"mail_otp","label":"Email OTP"},{"id":"totp","label":"Authenticator app"},{"id":"passkey","label":"Passkey"},{"id":"facebook","label":"Facebook"}]}},{"id":"protocol-condition:step","source_node_id":"protocol-condition","component":"condition","render":false,"config":{"ui_kind":"condition","conditions":{"rows":[{"id":"saml","label":"SAML","condition":{"type":"protocol","value":"saml"},"output_handle":"saml"},{"id":"oidc","label":"OIDC","condition":{"type":"protocol","value":"oidc"},"output_handle":"oidc"}],"otherwise":{"terminal_error":{"error":"unsupported_protocol","message":"This Flow accepts only SAML and OIDC login requests."}}}}},{"id":"saml-complete:step","source_node_id":"saml-complete","component":"completion","render":true,"config":{"ui_kind":"complete","completion_block":{"id":"saml-attribute-release-completion","label":"SAML Attribute Release Completion","protocol":"saml","purpose":"attribute_release","role":"output"}}},{"id":"oidc-complete:step","source_node_id":"oidc-complete","component":"completion","render":true,"config":{"ui_kind":"complete","completion_block":{"id":"oidc-authorization-completion","label":"OIDC Authorization Completion","protocol":"oidc","purpose":"authorization","role":"output"}}}]}}', '{"nodes":[{"id":"request","type":"entry","title":"Login Request","position":{"x":360,"y":0},"config":{"ui_kind":"entry"}},{"id":"session-check","type":"session_check","title":"Session Check","position":{"x":360,"y":144},"config":{"ui_kind":"session"}},{"id":"authentication","type":"authentication","title":"Authentication Method","position":{"x":520,"y":288},"config":{"ui_kind":"authentication","authentication_profile_ref":"default","screen_ref":"login","outputs":[{"id":"mail_otp","label":"Email OTP"},{"id":"totp","label":"Authenticator app"},{"id":"passkey","label":"Passkey"},{"id":"facebook","label":"Facebook"}]}},{"id":"protocol-condition","type":"condition","title":"Protocol Branch","position":{"x":360,"y":432},"config":{"ui_kind":"condition","conditions":{"rows":[{"id":"saml","label":"SAML","condition":{"type":"protocol","value":"saml"},"output_handle":"saml"},{"id":"oidc","label":"OIDC","condition":{"type":"protocol","value":"oidc"},"output_handle":"oidc"}],"otherwise":{"terminal_error":{"error":"unsupported_protocol","message":"This Flow accepts only SAML and OIDC login requests."}}}}},{"id":"saml-complete","type":"complete","title":"SAML End","position":{"x":120,"y":600},"config":{"ui_kind":"complete","completion_block":{"id":"saml-attribute-release-completion","label":"SAML Attribute Release Completion","protocol":"saml","purpose":"attribute_release","role":"output"}}},{"id":"oidc-complete","type":"complete","title":"OIDC End","position":{"x":600,"y":600},"config":{"ui_kind":"complete","completion_block":{"id":"oidc-authorization-completion","label":"OIDC Authorization Completion","protocol":"oidc","purpose":"authorization","role":"output"}}}],"edges":[{"id":"request:next->session-check","source":"request","source_handle":"next","target":"session-check"},{"id":"session-check:continue->protocol-condition","source":"session-check","source_handle":"continue","target":"protocol-condition"},{"id":"session-check:authenticate->authentication","source":"session-check","source_handle":"authenticate","target":"authentication"},{"id":"authentication:mail_otp->protocol-condition","source":"authentication","source_handle":"mail_otp","target":"protocol-condition"},{"id":"authentication:totp->protocol-condition","source":"authentication","source_handle":"totp","target":"protocol-condition"},{"id":"authentication:passkey->protocol-condition","source":"authentication","source_handle":"passkey","target":"protocol-condition"},{"id":"authentication:facebook->protocol-condition","source":"authentication","source_handle":"facebook","target":"protocol-condition"},{"id":"protocol-condition:saml->saml-complete","source":"protocol-condition","source_handle":"saml","target":"saml-complete"},{"id":"protocol-condition:oidc->oidc-complete","source":"protocol-condition","source_handle":"oidc","target":"oidc-complete"}],"viewport":{"x":36,"y":36,"zoom":1}}', '{"valid":true,"errors":[],"warnings":[],"issues":[]}', 'system', __AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_SECONDS__);

--
-- Data for Name: flows; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.flows VALUES ('flow-default-registration-no-consent', 'default', NULL, 'human-basic', 'Registration (No consent)', NULL, '{"nodes":[{"id":"request","type":"entry","title":"Registration Request","position":{"x":360,"y":0},"config":{"ui_kind":"start"}},{"id":"registration-method","type":"registration","title":"Registration Method","position":{"x":360,"y":144},"config":{"ui_kind":"registration","authentication_profile_ref":"default","screen_ref":"registration","outputs":[{"id":"mail_otp","label":"Email OTP"},{"id":"totp","label":"Authenticator app"},{"id":"passkey","label":"Passkey"},{"id":"facebook","label":"Facebook"}]}},{"id":"account-create","type":"account_action","title":"Account Creation","position":{"x":360,"y":288},"config":{"ui_kind":"account"}},{"id":"output","type":"complete","title":"Complete","position":{"x":360,"y":432},"config":{"ui_kind":"end"}}],"edges":[{"id":"request:next->registration-method","source":"request","source_handle":"next","target":"registration-method"},{"id":"registration-method:mail_otp->account-create","source":"registration-method","source_handle":"mail_otp","target":"account-create"},{"id":"registration-method:totp->account-create","source":"registration-method","source_handle":"totp","target":"account-create"},{"id":"registration-method:passkey->account-create","source":"registration-method","source_handle":"passkey","target":"account-create"},{"id":"registration-method:facebook->account-create","source":"registration-method","source_handle":"facebook","target":"account-create"},{"id":"account-create:completed->output","source":"account-create","source_handle":"completed","target":"output"}],"viewport":{"x":36,"y":36,"zoom":1}}', '{"flow_kind":"registration","flow_id":"flow-default-registration-no-consent","ui":{"steps":[{"id":"request:step","source_node_id":"request","component":"interaction_context","render":false,"config":{"ui_kind":"start"}},{"id":"registration-method:step","source_node_id":"registration-method","component":"registration_method_selector","render":true,"config":{"ui_kind":"registration","authentication_profile_ref":"default","screen_ref":"registration","outputs":[{"id":"mail_otp","label":"Email OTP"},{"id":"totp","label":"Authenticator app"},{"id":"passkey","label":"Passkey"},{"id":"facebook","label":"Facebook"}]}},{"id":"account-create:step","source_node_id":"account-create","component":"account_action","render":false,"config":{"ui_kind":"account"}},{"id":"output:step","source_node_id":"output","component":"completion","render":true,"config":{"ui_kind":"end"}}]}}', '1.0.0', true, false, 'system', __AUTHRIM_NOW_EPOCH_SECONDS__, 'system', __AUTHRIM_NOW_EPOCH_SECONDS__, 'default-registration-no-consent', 'Registration (No consent)', 'registration', 'published', '{"nodes":[{"id":"request","type":"entry","title":"Registration Request","position":{"x":360,"y":0},"config":{"ui_kind":"start"}},{"id":"registration-method","type":"registration","title":"Registration Method","position":{"x":360,"y":144},"config":{"ui_kind":"registration","authentication_profile_ref":"default","screen_ref":"registration","outputs":[{"id":"mail_otp","label":"Email OTP"},{"id":"totp","label":"Authenticator app"},{"id":"passkey","label":"Passkey"},{"id":"facebook","label":"Facebook"}]}},{"id":"account-create","type":"account_action","title":"Account Creation","position":{"x":360,"y":288},"config":{"ui_kind":"account"}},{"id":"output","type":"complete","title":"Complete","position":{"x":360,"y":432},"config":{"ui_kind":"end"}}],"edges":[{"id":"request:next->registration-method","source":"request","source_handle":"next","target":"registration-method"},{"id":"registration-method:mail_otp->account-create","source":"registration-method","source_handle":"mail_otp","target":"account-create"},{"id":"registration-method:totp->account-create","source":"registration-method","source_handle":"totp","target":"account-create"},{"id":"registration-method:passkey->account-create","source":"registration-method","source_handle":"passkey","target":"account-create"},{"id":"registration-method:facebook->account-create","source":"registration-method","source_handle":"facebook","target":"account-create"},{"id":"account-create:completed->output","source":"account-create","source_handle":"completed","target":"output"}],"viewport":{"x":36,"y":36,"zoom":1}}', '{"flow_kind":"registration","flow_id":"flow-default-registration-no-consent","ui":{"steps":[{"id":"request:step","source_node_id":"request","component":"interaction_context","render":false,"config":{"ui_kind":"start"}},{"id":"registration-method:step","source_node_id":"registration-method","component":"registration_method_selector","render":true,"config":{"ui_kind":"registration","authentication_profile_ref":"default","screen_ref":"registration","outputs":[{"id":"mail_otp","label":"Email OTP"},{"id":"totp","label":"Authenticator app"},{"id":"passkey","label":"Passkey"},{"id":"facebook","label":"Facebook"}]}},{"id":"account-create:step","source_node_id":"account-create","component":"account_action","render":false,"config":{"ui_kind":"account"}},{"id":"output:step","source_node_id":"output","component":"completion","render":true,"config":{"ui_kind":"end"}}]}}', 'flow-version-default-registration-no-consent-v1', NULL, 'default-registration-no-consent');
INSERT INTO public.flows VALUES ('flow-saml-sp-oidc-rp', 'default', NULL, 'human-basic', 'SAML SP/OIDC RP Flow', 'No-consent login Flow that branches to SAML or OIDC completion after authentication.', '{"nodes":[{"id":"request","type":"entry","title":"Login Request","position":{"x":360,"y":0},"config":{"ui_kind":"entry"}},{"id":"session-check","type":"session_check","title":"Session Check","position":{"x":360,"y":144},"config":{"ui_kind":"session"}},{"id":"authentication","type":"authentication","title":"Authentication Method","position":{"x":520,"y":288},"config":{"ui_kind":"authentication","authentication_profile_ref":"default","screen_ref":"login","outputs":[{"id":"mail_otp","label":"Email OTP"},{"id":"totp","label":"Authenticator app"},{"id":"passkey","label":"Passkey"},{"id":"facebook","label":"Facebook"}]}},{"id":"protocol-condition","type":"condition","title":"Protocol Branch","position":{"x":360,"y":432},"config":{"ui_kind":"condition","conditions":{"rows":[{"id":"saml","label":"SAML","condition":{"type":"protocol","value":"saml"},"output_handle":"saml"},{"id":"oidc","label":"OIDC","condition":{"type":"protocol","value":"oidc"},"output_handle":"oidc"}],"otherwise":{"terminal_error":{"error":"unsupported_protocol","message":"This Flow accepts only SAML and OIDC login requests."}}}}},{"id":"saml-complete","type":"complete","title":"SAML End","position":{"x":120,"y":600},"config":{"ui_kind":"complete","completion_block":{"id":"saml-attribute-release-completion","label":"SAML Attribute Release Completion","protocol":"saml","purpose":"attribute_release","role":"output"}}},{"id":"oidc-complete","type":"complete","title":"OIDC End","position":{"x":600,"y":600},"config":{"ui_kind":"complete","completion_block":{"id":"oidc-authorization-completion","label":"OIDC Authorization Completion","protocol":"oidc","purpose":"authorization","role":"output"}}}],"edges":[{"id":"request:next->session-check","source":"request","source_handle":"next","target":"session-check"},{"id":"session-check:continue->protocol-condition","source":"session-check","source_handle":"continue","target":"protocol-condition"},{"id":"session-check:authenticate->authentication","source":"session-check","source_handle":"authenticate","target":"authentication"},{"id":"authentication:mail_otp->protocol-condition","source":"authentication","source_handle":"mail_otp","target":"protocol-condition"},{"id":"authentication:totp->protocol-condition","source":"authentication","source_handle":"totp","target":"protocol-condition"},{"id":"authentication:passkey->protocol-condition","source":"authentication","source_handle":"passkey","target":"protocol-condition"},{"id":"authentication:facebook->protocol-condition","source":"authentication","source_handle":"facebook","target":"protocol-condition"},{"id":"protocol-condition:saml->saml-complete","source":"protocol-condition","source_handle":"saml","target":"saml-complete"},{"id":"protocol-condition:oidc->oidc-complete","source":"protocol-condition","source_handle":"oidc","target":"oidc-complete"}],"viewport":{"x":36,"y":36,"zoom":1}}', '{"flow_kind":"login","flow_id":"flow-saml-sp-oidc-rp","ui":{"steps":[{"id":"request:step","source_node_id":"request","component":"interaction_context","render":false,"config":{"ui_kind":"entry"}},{"id":"session-check:step","source_node_id":"session-check","component":"session_check","render":false,"config":{"ui_kind":"session"}},{"id":"authentication:step","source_node_id":"authentication","component":"authentication_method_selector","render":true,"config":{"ui_kind":"authentication","authentication_profile_ref":"default","screen_ref":"login","outputs":[{"id":"mail_otp","label":"Email OTP"},{"id":"totp","label":"Authenticator app"},{"id":"passkey","label":"Passkey"},{"id":"facebook","label":"Facebook"}]}},{"id":"protocol-condition:step","source_node_id":"protocol-condition","component":"condition","render":false,"config":{"ui_kind":"condition","conditions":{"rows":[{"id":"saml","label":"SAML","condition":{"type":"protocol","value":"saml"},"output_handle":"saml"},{"id":"oidc","label":"OIDC","condition":{"type":"protocol","value":"oidc"},"output_handle":"oidc"}],"otherwise":{"terminal_error":{"error":"unsupported_protocol","message":"This Flow accepts only SAML and OIDC login requests."}}}}},{"id":"saml-complete:step","source_node_id":"saml-complete","component":"completion","render":true,"config":{"ui_kind":"complete","completion_block":{"id":"saml-attribute-release-completion","label":"SAML Attribute Release Completion","protocol":"saml","purpose":"attribute_release","role":"output"}}},{"id":"oidc-complete:step","source_node_id":"oidc-complete","component":"completion","render":true,"config":{"ui_kind":"complete","completion_block":{"id":"oidc-authorization-completion","label":"OIDC Authorization Completion","protocol":"oidc","purpose":"authorization","role":"output"}}}]}}', '1.0.0', true, false, 'system', __AUTHRIM_NOW_EPOCH_SECONDS__, 'system', __AUTHRIM_NOW_EPOCH_SECONDS__, 'saml-sp-oidc-rp', 'SAML SP/OIDC RP Flow', 'login', 'published', '{"nodes":[{"id":"request","type":"entry","title":"Login Request","position":{"x":360,"y":0},"config":{"ui_kind":"entry"}},{"id":"session-check","type":"session_check","title":"Session Check","position":{"x":360,"y":144},"config":{"ui_kind":"session"}},{"id":"authentication","type":"authentication","title":"Authentication Method","position":{"x":520,"y":288},"config":{"ui_kind":"authentication","authentication_profile_ref":"default","screen_ref":"login","outputs":[{"id":"mail_otp","label":"Email OTP"},{"id":"totp","label":"Authenticator app"},{"id":"passkey","label":"Passkey"},{"id":"facebook","label":"Facebook"}]}},{"id":"protocol-condition","type":"condition","title":"Protocol Branch","position":{"x":360,"y":432},"config":{"ui_kind":"condition","conditions":{"rows":[{"id":"saml","label":"SAML","condition":{"type":"protocol","value":"saml"},"output_handle":"saml"},{"id":"oidc","label":"OIDC","condition":{"type":"protocol","value":"oidc"},"output_handle":"oidc"}],"otherwise":{"terminal_error":{"error":"unsupported_protocol","message":"This Flow accepts only SAML and OIDC login requests."}}}}},{"id":"saml-complete","type":"complete","title":"SAML End","position":{"x":120,"y":600},"config":{"ui_kind":"complete","completion_block":{"id":"saml-attribute-release-completion","label":"SAML Attribute Release Completion","protocol":"saml","purpose":"attribute_release","role":"output"}}},{"id":"oidc-complete","type":"complete","title":"OIDC End","position":{"x":600,"y":600},"config":{"ui_kind":"complete","completion_block":{"id":"oidc-authorization-completion","label":"OIDC Authorization Completion","protocol":"oidc","purpose":"authorization","role":"output"}}}],"edges":[{"id":"request:next->session-check","source":"request","source_handle":"next","target":"session-check"},{"id":"session-check:continue->protocol-condition","source":"session-check","source_handle":"continue","target":"protocol-condition"},{"id":"session-check:authenticate->authentication","source":"session-check","source_handle":"authenticate","target":"authentication"},{"id":"authentication:mail_otp->protocol-condition","source":"authentication","source_handle":"mail_otp","target":"protocol-condition"},{"id":"authentication:totp->protocol-condition","source":"authentication","source_handle":"totp","target":"protocol-condition"},{"id":"authentication:passkey->protocol-condition","source":"authentication","source_handle":"passkey","target":"protocol-condition"},{"id":"authentication:facebook->protocol-condition","source":"authentication","source_handle":"facebook","target":"protocol-condition"},{"id":"protocol-condition:saml->saml-complete","source":"protocol-condition","source_handle":"saml","target":"saml-complete"},{"id":"protocol-condition:oidc->oidc-complete","source":"protocol-condition","source_handle":"oidc","target":"oidc-complete"}],"viewport":{"x":36,"y":36,"zoom":1}}', '{"flow_kind":"login","flow_id":"flow-saml-sp-oidc-rp","ui":{"steps":[{"id":"request:step","source_node_id":"request","component":"interaction_context","render":false,"config":{"ui_kind":"entry"}},{"id":"session-check:step","source_node_id":"session-check","component":"session_check","render":false,"config":{"ui_kind":"session"}},{"id":"authentication:step","source_node_id":"authentication","component":"authentication_method_selector","render":true,"config":{"ui_kind":"authentication","authentication_profile_ref":"default","screen_ref":"login","outputs":[{"id":"mail_otp","label":"Email OTP"},{"id":"totp","label":"Authenticator app"},{"id":"passkey","label":"Passkey"},{"id":"facebook","label":"Facebook"}]}},{"id":"protocol-condition:step","source_node_id":"protocol-condition","component":"condition","render":false,"config":{"ui_kind":"condition","conditions":{"rows":[{"id":"saml","label":"SAML","condition":{"type":"protocol","value":"saml"},"output_handle":"saml"},{"id":"oidc","label":"OIDC","condition":{"type":"protocol","value":"oidc"},"output_handle":"oidc"}],"otherwise":{"terminal_error":{"error":"unsupported_protocol","message":"This Flow accepts only SAML and OIDC login requests."}}}}},{"id":"saml-complete:step","source_node_id":"saml-complete","component":"completion","render":true,"config":{"ui_kind":"complete","completion_block":{"id":"saml-attribute-release-completion","label":"SAML Attribute Release Completion","protocol":"saml","purpose":"attribute_release","role":"output"}}},{"id":"oidc-complete:step","source_node_id":"oidc-complete","component":"completion","render":true,"config":{"ui_kind":"complete","completion_block":{"id":"oidc-authorization-completion","label":"OIDC Authorization Completion","protocol":"oidc","purpose":"authorization","role":"output"}}}]}}', 'flow-version-saml-sp-oidc-rp-v1', NULL, 'saml-sp-oidc-rp');
INSERT INTO public.flows VALUES ('flow-default-login-no-consent', 'default', NULL, 'human-basic', 'Authentication-only Login', NULL, '{"nodes":[{"id":"request","type":"entry","title":"Login Request","position":{"x":360,"y":0},"config":{"ui_kind":"start"}},{"id":"session-check","type":"session_check","title":"Session Check","position":{"x":360,"y":144},"config":{"ui_kind":"session"}},{"id":"authentication","type":"authentication","title":"Authentication Method","position":{"x":522,"y":288},"config":{"ui_kind":"authentication","authentication_profile_ref":"default","screen_ref":"login","outputs":[{"id":"mail_otp","label":"Email OTP"},{"id":"totp","label":"Authenticator app"},{"id":"passkey","label":"Passkey"},{"id":"facebook","label":"Facebook"}]}},{"id":"saml-attribute-release-complete","type":"complete","title":"Complete","position":{"x":108,"y":612},"config":{"ui_kind":"end","completion_block":{"id":"saml-attribute-release-completion","label":"SAML Attribute Release Completion","protocol":"saml","purpose":"attribute_release","role":"output"}}},{"id":"oidc-authorization-complete","type":"complete","title":"Complete","position":{"x":594,"y":612},"config":{"ui_kind":"end","completion_block":{"id":"oidc-authorization-completion","label":"OIDC Authorization Completion","protocol":"oidc","purpose":"authorization","role":"output"}}}],"edges":[{"id":"request:next->session-check","source":"request","source_handle":"next","target":"session-check"},{"id":"session-check:continue->saml-attribute-release-complete","source":"session-check","source_handle":"continue","target":"saml-attribute-release-complete"},{"id":"session-check:continue->oidc-authorization-complete","source":"session-check","source_handle":"continue","target":"oidc-authorization-complete"},{"id":"session-check:authenticate->authentication","source":"session-check","source_handle":"authenticate","target":"authentication"},{"id":"authentication:mail_otp->saml-attribute-release-complete","source":"authentication","source_handle":"mail_otp","target":"saml-attribute-release-complete"},{"id":"authentication:mail_otp->oidc-authorization-complete","source":"authentication","source_handle":"mail_otp","target":"oidc-authorization-complete"},{"id":"authentication:totp->saml-attribute-release-complete","source":"authentication","source_handle":"totp","target":"saml-attribute-release-complete"},{"id":"authentication:totp->oidc-authorization-complete","source":"authentication","source_handle":"totp","target":"oidc-authorization-complete"},{"id":"authentication:passkey->saml-attribute-release-complete","source":"authentication","source_handle":"passkey","target":"saml-attribute-release-complete"},{"id":"authentication:passkey->oidc-authorization-complete","source":"authentication","source_handle":"passkey","target":"oidc-authorization-complete"},{"id":"authentication:facebook->saml-attribute-release-complete","source":"authentication","source_handle":"facebook","target":"saml-attribute-release-complete"},{"id":"authentication:facebook->oidc-authorization-complete","source":"authentication","source_handle":"facebook","target":"oidc-authorization-complete"}],"viewport":{"x":36,"y":36,"zoom":1}}', '{"flow_kind":"login","flow_id":"flow-default-login-no-consent","ui":{"steps":[{"id":"request:step","source_node_id":"request","component":"interaction_context","render":false,"config":{"ui_kind":"start"}},{"id":"session-check:step","source_node_id":"session-check","component":"session_check","render":false,"config":{"ui_kind":"session"}},{"id":"authentication:step","source_node_id":"authentication","component":"authentication_method_selector","render":true,"config":{"ui_kind":"authentication","authentication_profile_ref":"default","screen_ref":"login","outputs":[{"id":"mail_otp","label":"Email OTP"},{"id":"totp","label":"Authenticator app"},{"id":"passkey","label":"Passkey"},{"id":"facebook","label":"Facebook"}]}},{"id":"saml-attribute-release-complete:step","source_node_id":"saml-attribute-release-complete","component":"completion","render":true,"config":{"ui_kind":"end","completion_block":{"id":"saml-attribute-release-completion","label":"SAML Attribute Release Completion","protocol":"saml","purpose":"attribute_release","role":"output"}}},{"id":"oidc-authorization-complete:step","source_node_id":"oidc-authorization-complete","component":"completion","render":true,"config":{"ui_kind":"end","completion_block":{"id":"oidc-authorization-completion","label":"OIDC Authorization Completion","protocol":"oidc","purpose":"authorization","role":"output"}}}]}}', '1.0.0', true, false, 'system', __AUTHRIM_NOW_EPOCH_SECONDS__, 'system', __AUTHRIM_NOW_EPOCH_SECONDS__, 'default-login-no-consent', 'Authentication-only Login', 'login', 'published', '{"nodes":[{"id":"request","type":"entry","title":"Login Request","position":{"x":360,"y":0},"config":{"ui_kind":"start"}},{"id":"session-check","type":"session_check","title":"Session Check","position":{"x":360,"y":144},"config":{"ui_kind":"session"}},{"id":"authentication","type":"authentication","title":"Authentication Method","position":{"x":522,"y":288},"config":{"ui_kind":"authentication","authentication_profile_ref":"default","screen_ref":"login","outputs":[{"id":"mail_otp","label":"Email OTP"},{"id":"totp","label":"Authenticator app"},{"id":"passkey","label":"Passkey"},{"id":"facebook","label":"Facebook"}]}},{"id":"saml-attribute-release-complete","type":"complete","title":"Complete","position":{"x":108,"y":612},"config":{"ui_kind":"end","completion_block":{"id":"saml-attribute-release-completion","label":"SAML Attribute Release Completion","protocol":"saml","purpose":"attribute_release","role":"output"}}},{"id":"oidc-authorization-complete","type":"complete","title":"Complete","position":{"x":594,"y":612},"config":{"ui_kind":"end","completion_block":{"id":"oidc-authorization-completion","label":"OIDC Authorization Completion","protocol":"oidc","purpose":"authorization","role":"output"}}}],"edges":[{"id":"request:next->session-check","source":"request","source_handle":"next","target":"session-check"},{"id":"session-check:continue->saml-attribute-release-complete","source":"session-check","source_handle":"continue","target":"saml-attribute-release-complete"},{"id":"session-check:continue->oidc-authorization-complete","source":"session-check","source_handle":"continue","target":"oidc-authorization-complete"},{"id":"session-check:authenticate->authentication","source":"session-check","source_handle":"authenticate","target":"authentication"},{"id":"authentication:mail_otp->saml-attribute-release-complete","source":"authentication","source_handle":"mail_otp","target":"saml-attribute-release-complete"},{"id":"authentication:mail_otp->oidc-authorization-complete","source":"authentication","source_handle":"mail_otp","target":"oidc-authorization-complete"},{"id":"authentication:totp->saml-attribute-release-complete","source":"authentication","source_handle":"totp","target":"saml-attribute-release-complete"},{"id":"authentication:totp->oidc-authorization-complete","source":"authentication","source_handle":"totp","target":"oidc-authorization-complete"},{"id":"authentication:passkey->saml-attribute-release-complete","source":"authentication","source_handle":"passkey","target":"saml-attribute-release-complete"},{"id":"authentication:passkey->oidc-authorization-complete","source":"authentication","source_handle":"passkey","target":"oidc-authorization-complete"},{"id":"authentication:facebook->saml-attribute-release-complete","source":"authentication","source_handle":"facebook","target":"saml-attribute-release-complete"},{"id":"authentication:facebook->oidc-authorization-complete","source":"authentication","source_handle":"facebook","target":"oidc-authorization-complete"}],"viewport":{"x":36,"y":36,"zoom":1}}', '{"flow_kind":"login","flow_id":"flow-default-login-no-consent","ui":{"steps":[{"id":"request:step","source_node_id":"request","component":"interaction_context","render":false,"config":{"ui_kind":"start"}},{"id":"session-check:step","source_node_id":"session-check","component":"session_check","render":false,"config":{"ui_kind":"session"}},{"id":"authentication:step","source_node_id":"authentication","component":"authentication_method_selector","render":true,"config":{"ui_kind":"authentication","authentication_profile_ref":"default","screen_ref":"login","outputs":[{"id":"mail_otp","label":"Email OTP"},{"id":"totp","label":"Authenticator app"},{"id":"passkey","label":"Passkey"},{"id":"facebook","label":"Facebook"}]}},{"id":"saml-attribute-release-complete:step","source_node_id":"saml-attribute-release-complete","component":"completion","render":true,"config":{"ui_kind":"end","completion_block":{"id":"saml-attribute-release-completion","label":"SAML Attribute Release Completion","protocol":"saml","purpose":"attribute_release","role":"output"}}},{"id":"oidc-authorization-complete:step","source_node_id":"oidc-authorization-complete","component":"completion","render":true,"config":{"ui_kind":"end","completion_block":{"id":"oidc-authorization-completion","label":"OIDC Authorization Completion","protocol":"oidc","purpose":"authorization","role":"output"}}}]}}', 'flow-version-default-login-no-consent-v1', NULL, 'default-login-no-consent');

--
-- Data for Name: guest_account_lifecycle; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: guest_account_upgrades; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: guest_core_mutation_epoch; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.guest_core_mutation_epoch VALUES (1, 0);

--
-- Data for Name: guest_deletion_audit_outbox; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: guest_devices; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: idempotency_keys; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: identity_accounts; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: identity_bindings; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: identity_providers; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: identity_resolution_candidates; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: identity_resolution_events; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: identity_subjects; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: launcher_favorites; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: legal_hold_events; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: legal_hold_projection_outbox; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: legal_holds; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: log_chunk_manifests; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: log_chunk_record_index; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: log_iceberg_core_publications; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: log_object_catalog; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: lookup_retention_policies; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: lookup_retention_policy_projection_outbox; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: oauth_client_consent_revocations; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: oauth_client_consents; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: oauth_clients; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: oidc_scopes; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.oidc_scopes VALUES ('scope-openid-default', 'default', 'openid', 'OpenID', 'Sign in with an OpenID Connect identity.', 'system', true, NULL, 0, 0);
INSERT INTO public.oidc_scopes VALUES ('scope-profile-default', 'default', 'profile', 'Profile', 'Access basic profile claims such as name and preferred username.', 'system', true, NULL, 0, 0);
INSERT INTO public.oidc_scopes VALUES ('scope-email-default', 'default', 'email', 'Email', 'Access email address and email verification status.', 'system', true, NULL, 0, 0);
INSERT INTO public.oidc_scopes VALUES ('scope-vc-attribute-default', 'default', 'vc.attribute', 'Verified attributes', 'Present and read verified attributes through the VC attribute-elevation service.', 'system', true, NULL, 0, 0);

--
-- Data for Name: passkeys; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: profile_attribute_values; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: profiles; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: provisioning_revocation_receipts; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: relationships; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: role_assignments; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: roles; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: schema_migrations; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: screens; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.screens VALUES ('screen-registration-default', 'default', 'registration', 'Registration', 'Default registration screen.', 'registration', '[{"field": "heading.registration", "label": "Create your account", "order": 0, "required": false, "block_type": "heading"}, {"field": "auth.passkey", "label": "Create Account with Passkey", "order": 10, "required": false, "block_type": "auth_widget", "auth_method": "passkey"}]', '{"de": {"fields": {"heading.registration-0": {"label": "Konto erstellen"}}}, "en": {"fields": {"heading.registration-0": {"label": "Create your account"}}}, "es": {"fields": {"heading.registration-0": {"label": "Crea tu cuenta"}}}, "fr": {"fields": {"heading.registration-0": {"label": "Créez votre compte"}}}, "id": {"fields": {"heading.registration-0": {"label": "Buat akun Anda"}}}, "ja": {"fields": {"heading.registration-0": {"label": "アカウントを作成"}}}, "ko": {"fields": {"heading.registration-0": {"label": "계정 만들기"}}}, "pt": {"fields": {"heading.registration-0": {"label": "Crie sua conta"}}}, "ru": {"fields": {"heading.registration-0": {"label": "Создайте учетную запись"}}}, "zh-CN": {"fields": {"heading.registration-0": {"label": "创建你的账户"}}}, "zh-TW": {"fields": {"heading.registration-0": {"label": "建立你的帳戶"}}}}', true, true, 0, 0, '{"canvas_layout": "narrow"}');
INSERT INTO public.screens VALUES ('screen-profile-completion-default', 'default', 'profile_completion', 'Profile completion', 'Default profile completion screen.', 'profile_completion', '[{"field": "name", "label": "Name", "required": true}, {"field": "preferred_username", "label": "Preferred username", "required": false}]', NULL, true, true, 0, 0, '{"canvas_layout": "narrow"}');
INSERT INTO public.screens VALUES ('screen-login-default', 'default', 'login', 'Login', 'Default login screen.', 'login', '[{"field": "heading.login", "label": "Sign in", "order": 0, "required": false, "block_type": "heading"}, {"field": "auth.passkey", "label": "Sign in with Passkey", "order": 10, "required": false, "block_type": "auth_widget", "auth_method": "passkey"}, {"text": "or", "field": "divider.or", "label": "or", "order": 20, "required": false, "block_type": "divider", "display_condition": {"mode": "feature_enabled", "feature": "mail_otp"}}, {"field": "auth.mail_otp", "label": "Send code by email", "order": 30, "required": false, "block_type": "auth_widget", "auth_method": "mail_otp"}, {"field": "auth.totp", "label": "Sign in with authenticator app", "order": 35, "required": false, "block_type": "auth_widget", "auth_method": "totp"}, {"text": "Continue with another account", "field": "divider.other_accounts", "label": "Continue with another account", "order": 40, "required": false, "block_type": "divider", "display_condition": {"mode": "feature_enabled", "feature": "external_idp"}}, {"field": "auth.external_idp", "label": "Ext. IdP", "order": 50, "required": false, "block_type": "auth_widget", "auth_method": "external_idp", "external_idp_show_action_text": false}, {"text": "or", "field": "divider.directory_password", "label": "or", "order": 55, "required": false, "block_type": "divider", "display_condition": {"mode": "feature_enabled", "feature": "directory_password"}}, {"field": "auth.directory_password", "label": "Sign in with directory password", "order": 60, "required": false, "block_type": "auth_widget", "auth_method": "directory_password"}]', '{"de": {"fields": {"heading.login-0": {"label": "Anmelden"}}}, "en": {"fields": {"heading.login-0": {"label": "Sign in"}}}, "es": {"fields": {"heading.login-0": {"label": "Iniciar sesión"}}}, "fr": {"fields": {"heading.login-0": {"label": "Se connecter"}}}, "id": {"fields": {"heading.login-0": {"label": "Masuk"}}}, "ja": {"fields": {"heading.login-0": {"label": "ログイン"}}}, "ko": {"fields": {"heading.login-0": {"label": "로그인"}}}, "pt": {"fields": {"heading.login-0": {"label": "Entrar"}}}, "ru": {"fields": {"heading.login-0": {"label": "Войти"}}}, "zh-CN": {"fields": {"heading.login-0": {"label": "登录"}}}, "zh-TW": {"fields": {"heading.login-0": {"label": "登入"}}}}', true, true, 0, 0, '{"canvas_layout": "narrow"}');
INSERT INTO public.screens VALUES ('screen-code-input-default', 'default', 'code_input', 'Code input', 'Default code input screen.', 'code_input', '[{"field": "heading.code_input", "label": "Enter verification code", "order": 0, "required": false, "block_type": "heading"}, {"text": "Enter the code from your email or authenticator app.", "field": "auth.code_input", "label": "Authentication code", "order": 10, "required": true, "block_type": "code_input_widget", "auth_method": "mail_otp", "code_input_mode": "auto"}]', '{"de": {"fields": {"heading.code_input-0": {"label": "Bestätigungscode eingeben"}}}, "en": {"fields": {"heading.code_input-0": {"label": "Enter verification code"}}}, "es": {"fields": {"heading.code_input-0": {"label": "Introduce el código de verificación"}}}, "fr": {"fields": {"heading.code_input-0": {"label": "Saisissez le code de vérification"}}}, "id": {"fields": {"heading.code_input-0": {"label": "Masukkan kode verifikasi"}}}, "ja": {"fields": {"heading.code_input-0": {"label": "認証コードを入力"}}}, "ko": {"fields": {"heading.code_input-0": {"label": "인증 코드를 입력하세요"}}}, "pt": {"fields": {"heading.code_input-0": {"label": "Insira o código de verificação"}}}, "ru": {"fields": {"heading.code_input-0": {"label": "Введите код подтверждения"}}}, "zh-CN": {"fields": {"heading.code_input-0": {"label": "输入验证码"}}}, "zh-TW": {"fields": {"heading.code_input-0": {"label": "輸入驗證碼"}}}}', true, true, 0, 0, '{"canvas_layout": "narrow"}');

--
-- Data for Name: service_group_audit; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: service_group_catalog; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: service_group_epoch; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: service_group_inputs; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: service_group_manual; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: service_group_results; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: service_group_revisions; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: service_group_scans; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: service_group_write_boundaries; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: sessions; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: sign_in_confirmation_policies; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: statement_consent_admissions; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: statement_consent_guards; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: statement_consent_key_states; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: statement_consent_operations; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: statement_consent_projection_jobs; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: statement_consent_retention_permits; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: structured_attribute_values; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: subject_account_links; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: tenant_consent_requirements; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: tenants; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: user_consent_records; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: user_custom_fields; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: user_roles; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: user_verified_attributes; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: users_core; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: web_origin_registry; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: webhook_configs; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Name: account_creation_operations account_creation_operations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_creation_operations
    ADD CONSTRAINT account_creation_operations_pkey PRIMARY KEY (operation_id);

--
-- Name: account_creation_operations account_creation_operations_tenant_id_account_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_creation_operations
    ADD CONSTRAINT account_creation_operations_tenant_id_account_id_key UNIQUE (tenant_id, account_id);

--
-- Name: account_creation_operations account_creation_operations_tenant_id_actor_id_idempotency__key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_creation_operations
    ADD CONSTRAINT account_creation_operations_tenant_id_actor_id_idempotency__key UNIQUE (tenant_id, actor_id, idempotency_key);

--
-- Name: account_legal_hold_states account_legal_hold_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_legal_hold_states
    ADD CONSTRAINT account_legal_hold_states_pkey PRIMARY KEY (tenant_id, account_id);

--
-- Name: account_lifecycle_event_outbox account_lifecycle_event_outbo_tenant_id_operation_id_event__key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_lifecycle_event_outbox
    ADD CONSTRAINT account_lifecycle_event_outbo_tenant_id_operation_id_event__key UNIQUE (tenant_id, operation_id, event_type);

--
-- Name: account_lifecycle_event_outbox account_lifecycle_event_outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_lifecycle_event_outbox
    ADD CONSTRAINT account_lifecycle_event_outbox_pkey PRIMARY KEY (event_id);

--
-- Name: account_support_contexts account_support_contexts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_support_contexts
    ADD CONSTRAINT account_support_contexts_pkey PRIMARY KEY (tenant_id, account_id);

--
-- Name: account_webhook_outbox account_webhook_outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_webhook_outbox
    ADD CONSTRAINT account_webhook_outbox_pkey PRIMARY KEY (id);

--
-- Name: guest_devices anonymous_devices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guest_devices
    ADD CONSTRAINT anonymous_devices_pkey PRIMARY KEY (id);

--
-- Name: application_launchers application_launchers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.application_launchers
    ADD CONSTRAINT application_launchers_pkey PRIMARY KEY (tenant_id, id);

--
-- Name: assurance_evidence assurance_evidence_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assurance_evidence
    ADD CONSTRAINT assurance_evidence_pkey PRIMARY KEY (id);

--
-- Name: attribute_verifications attribute_verifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attribute_verifications
    ADD CONSTRAINT attribute_verifications_pkey PRIMARY KEY (id);

--
-- Name: client_consent_overrides client_consent_overrides_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_consent_overrides
    ADD CONSTRAINT client_consent_overrides_pkey PRIMARY KEY (id);

--
-- Name: client_consent_overrides client_consent_overrides_tenant_id_client_id_statement_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_consent_overrides
    ADD CONSTRAINT client_consent_overrides_tenant_id_client_id_statement_id_key UNIQUE (tenant_id, client_id, statement_id);

--
-- Name: client_trust_policies client_trust_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_trust_policies
    ADD CONSTRAINT client_trust_policies_pkey PRIMARY KEY (id);

--
-- Name: client_trust_policies client_trust_policies_unique_name; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_trust_policies
    ADD CONSTRAINT client_trust_policies_unique_name UNIQUE (tenant_id, name);

--
-- Name: client_trust_policies client_trust_policies_unique_target; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_trust_policies
    ADD CONSTRAINT client_trust_policies_unique_target UNIQUE (tenant_id, target_type, target_id);

--
-- Name: consent_item_history consent_item_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consent_item_history
    ADD CONSTRAINT consent_item_history_pkey PRIMARY KEY (id);

--
-- Name: consent_policies consent_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consent_policies
    ADD CONSTRAINT consent_policies_pkey PRIMARY KEY (id);

--
-- Name: consent_policies consent_policies_unique_name; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consent_policies
    ADD CONSTRAINT consent_policies_unique_name UNIQUE (tenant_id, name);

--
-- Name: consent_policy_items consent_policy_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consent_policy_items
    ADD CONSTRAINT consent_policy_items_pkey PRIMARY KEY (id);

--
-- Name: consent_policy_items consent_policy_items_unique_statement; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consent_policy_items
    ADD CONSTRAINT consent_policy_items_unique_statement UNIQUE (tenant_id, policy_id, statement_id);

--
-- Name: consent_records consent_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consent_records
    ADD CONSTRAINT consent_records_pkey PRIMARY KEY (id);

--
-- Name: consent_statement_localizations consent_statement_localizations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consent_statement_localizations
    ADD CONSTRAINT consent_statement_localizations_pkey PRIMARY KEY (id);

--
-- Name: consent_statement_localizations consent_statement_localizations_unique_language; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consent_statement_localizations
    ADD CONSTRAINT consent_statement_localizations_unique_language UNIQUE (version_id, language);

--
-- Name: consent_statement_versions consent_statement_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consent_statement_versions
    ADD CONSTRAINT consent_statement_versions_pkey PRIMARY KEY (id);

--
-- Name: consent_statement_versions consent_statement_versions_unique_version; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consent_statement_versions
    ADD CONSTRAINT consent_statement_versions_unique_version UNIQUE (tenant_id, statement_id, version);

--
-- Name: consent_statements consent_statements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consent_statements
    ADD CONSTRAINT consent_statements_pkey PRIMARY KEY (id);

--
-- Name: consent_statements consent_statements_unique_slug; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consent_statements
    ADD CONSTRAINT consent_statements_unique_slug UNIQUE (tenant_id, slug);

--
-- Name: contact_points contact_points_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_points
    ADD CONSTRAINT contact_points_pkey PRIMARY KEY (id);

--
-- Name: contact_verifications contact_verifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_verifications
    ADD CONSTRAINT contact_verifications_pkey PRIMARY KEY (id);

--
-- Name: custom_claim_schema_history custom_claim_schema_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_claim_schema_history
    ADD CONSTRAINT custom_claim_schema_history_pkey PRIMARY KEY (id);

--
-- Name: custom_claim_schema_history custom_claim_schema_history_unique_version; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_claim_schema_history
    ADD CONSTRAINT custom_claim_schema_history_unique_version UNIQUE (tenant_id, schema_id, version);

--
-- Name: custom_claim_schemas custom_claim_schemas_active_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_claim_schemas
    ADD CONSTRAINT custom_claim_schemas_active_key UNIQUE (tenant_id, active_field_key);

--
-- Name: custom_claim_schemas custom_claim_schemas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_claim_schemas
    ADD CONSTRAINT custom_claim_schemas_pkey PRIMARY KEY (id);

--
-- Name: directory_connector_instances directory_connector_instances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directory_connector_instances
    ADD CONSTRAINT directory_connector_instances_pkey PRIMARY KEY (id);

--
-- Name: directory_connector_instances directory_connector_instances_tenant_id_connector_id_instan_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directory_connector_instances
    ADD CONSTRAINT directory_connector_instances_tenant_id_connector_id_instan_key UNIQUE (tenant_id, connector_id, instance_id);

--
-- Name: directory_connector_status_episodes directory_connector_status_episodes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directory_connector_status_episodes
    ADD CONSTRAINT directory_connector_status_episodes_pkey PRIMARY KEY (id);

--
-- Name: directory_identity_links directory_identity_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directory_identity_links
    ADD CONSTRAINT directory_identity_links_pkey PRIMARY KEY (id);

--
-- Name: directory_identity_links directory_identity_links_tenant_id_connector_id_directory_s_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directory_identity_links
    ADD CONSTRAINT directory_identity_links_tenant_id_connector_id_directory_s_key UNIQUE (tenant_id, connector_id, directory_subject);

--
-- Name: directory_jit_pending_users directory_jit_pending_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directory_jit_pending_users
    ADD CONSTRAINT directory_jit_pending_users_pkey PRIMARY KEY (id);

--
-- Name: directory_jit_pending_users directory_jit_pending_users_tenant_id_connector_id_director_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directory_jit_pending_users
    ADD CONSTRAINT directory_jit_pending_users_tenant_id_connector_id_director_key UNIQUE (tenant_id, connector_id, directory_subject);

--
-- Name: event_log event_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_log
    ADD CONSTRAINT event_log_pkey PRIMARY KEY (id);

--
-- Name: field_usage_bindings field_usage_bindings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.field_usage_bindings
    ADD CONSTRAINT field_usage_bindings_pkey PRIMARY KEY (id);

--
-- Name: field_usage_bindings field_usage_bindings_unique_binding; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.field_usage_bindings
    ADD CONSTRAINT field_usage_bindings_unique_binding UNIQUE (tenant_id, field_key, binding_type, binding_id);

--
-- Name: flow_assignments flow_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flow_assignments
    ADD CONSTRAINT flow_assignments_pkey PRIMARY KEY (id);

--
-- Name: flow_audit_events flow_audit_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flow_audit_events
    ADD CONSTRAINT flow_audit_events_pkey PRIMARY KEY (id);

--
-- Name: flow_interaction_steps flow_interaction_steps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flow_interaction_steps
    ADD CONSTRAINT flow_interaction_steps_pkey PRIMARY KEY (id);

--
-- Name: flow_interactions flow_interactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flow_interactions
    ADD CONSTRAINT flow_interactions_pkey PRIMARY KEY (id);

--
-- Name: flow_versions flow_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flow_versions
    ADD CONSTRAINT flow_versions_pkey PRIMARY KEY (id);

--
-- Name: flow_versions flow_versions_unique_version; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flow_versions
    ADD CONSTRAINT flow_versions_unique_version UNIQUE (tenant_id, flow_id, version_number);

--
-- Name: flows flows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flows
    ADD CONSTRAINT flows_pkey PRIMARY KEY (id);

--
-- Name: guest_account_lifecycle guest_account_lifecycle_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guest_account_lifecycle
    ADD CONSTRAINT guest_account_lifecycle_pkey PRIMARY KEY (tenant_id, user_id);

--
-- Name: guest_account_upgrades guest_account_upgrades_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guest_account_upgrades
    ADD CONSTRAINT guest_account_upgrades_pkey PRIMARY KEY (id);

--
-- Name: guest_core_mutation_epoch guest_core_mutation_epoch_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guest_core_mutation_epoch
    ADD CONSTRAINT guest_core_mutation_epoch_pkey PRIMARY KEY (id);

--
-- Name: guest_deletion_audit_outbox guest_deletion_audit_outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guest_deletion_audit_outbox
    ADD CONSTRAINT guest_deletion_audit_outbox_pkey PRIMARY KEY (audit_id);

--
-- Name: guest_deletion_audit_outbox guest_deletion_audit_outbox_tenant_id_operation_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guest_deletion_audit_outbox
    ADD CONSTRAINT guest_deletion_audit_outbox_tenant_id_operation_id_key UNIQUE (tenant_id, operation_id);

--
-- Name: idempotency_keys idempotency_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idempotency_keys
    ADD CONSTRAINT idempotency_keys_pkey PRIMARY KEY (id);

--
-- Name: identity_accounts identity_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_accounts
    ADD CONSTRAINT identity_accounts_pkey PRIMARY KEY (id);

--
-- Name: identity_bindings identity_bindings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_bindings
    ADD CONSTRAINT identity_bindings_pkey PRIMARY KEY (id);

--
-- Name: identity_bindings identity_bindings_unique_provider_subject; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_bindings
    ADD CONSTRAINT identity_bindings_unique_provider_subject UNIQUE (tenant_id, protocol, source_id, provider_subject_key_hash);

--
-- Name: identity_providers identity_providers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_providers
    ADD CONSTRAINT identity_providers_pkey PRIMARY KEY (id);

--
-- Name: identity_resolution_candidates identity_resolution_candidates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_resolution_candidates
    ADD CONSTRAINT identity_resolution_candidates_pkey PRIMARY KEY (id);

--
-- Name: identity_resolution_events identity_resolution_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_resolution_events
    ADD CONSTRAINT identity_resolution_events_pkey PRIMARY KEY (id);

--
-- Name: identity_subjects identity_subjects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_subjects
    ADD CONSTRAINT identity_subjects_pkey PRIMARY KEY (id);

--
-- Name: launcher_favorites launcher_favorites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.launcher_favorites
    ADD CONSTRAINT launcher_favorites_pkey PRIMARY KEY (tenant_id, user_id, launcher_id);

--
-- Name: legal_hold_events legal_hold_events_hold_id_hold_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.legal_hold_events
    ADD CONSTRAINT legal_hold_events_hold_id_hold_version_key UNIQUE (hold_id, hold_version);

--
-- Name: legal_hold_events legal_hold_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.legal_hold_events
    ADD CONSTRAINT legal_hold_events_pkey PRIMARY KEY (event_id);

--
-- Name: legal_hold_events legal_hold_events_tenant_id_account_id_projection_generatio_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.legal_hold_events
    ADD CONSTRAINT legal_hold_events_tenant_id_account_id_projection_generatio_key UNIQUE (tenant_id, account_id, projection_generation);

--
-- Name: legal_hold_projection_outbox legal_hold_projection_outbox_hold_id_hold_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.legal_hold_projection_outbox
    ADD CONSTRAINT legal_hold_projection_outbox_hold_id_hold_version_key UNIQUE (hold_id, hold_version);

--
-- Name: legal_hold_projection_outbox legal_hold_projection_outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.legal_hold_projection_outbox
    ADD CONSTRAINT legal_hold_projection_outbox_pkey PRIMARY KEY (operation_id);

--
-- Name: legal_hold_projection_outbox legal_hold_projection_outbox_tenant_id_account_id_projectio_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.legal_hold_projection_outbox
    ADD CONSTRAINT legal_hold_projection_outbox_tenant_id_account_id_projectio_key UNIQUE (tenant_id, account_id, projection_generation);

--
-- Name: legal_holds legal_holds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.legal_holds
    ADD CONSTRAINT legal_holds_pkey PRIMARY KEY (id);

--
-- Name: log_chunk_manifests log_chunk_manifests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.log_chunk_manifests
    ADD CONSTRAINT log_chunk_manifests_pkey PRIMARY KEY (id);

--
-- Name: log_chunk_record_index log_chunk_record_index_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.log_chunk_record_index
    ADD CONSTRAINT log_chunk_record_index_pkey PRIMARY KEY (tenant_key, log_type, plane, record_id);

--
-- Name: log_iceberg_core_publications log_iceberg_core_publications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.log_iceberg_core_publications
    ADD CONSTRAINT log_iceberg_core_publications_pkey PRIMARY KEY (id);

--
-- Name: log_object_catalog log_object_catalog_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.log_object_catalog
    ADD CONSTRAINT log_object_catalog_pkey PRIMARY KEY (id);

--
-- Name: lookup_retention_policies lookup_retention_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lookup_retention_policies
    ADD CONSTRAINT lookup_retention_policies_pkey PRIMARY KEY (tenant_id);

--
-- Name: lookup_retention_policy_projection_outbox lookup_retention_policy_project_tenant_id_policy_generation_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lookup_retention_policy_projection_outbox
    ADD CONSTRAINT lookup_retention_policy_project_tenant_id_policy_generation_key UNIQUE (tenant_id, policy_generation);

--
-- Name: lookup_retention_policy_projection_outbox lookup_retention_policy_projection_outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lookup_retention_policy_projection_outbox
    ADD CONSTRAINT lookup_retention_policy_projection_outbox_pkey PRIMARY KEY (operation_id);

--
-- Name: oauth_client_consent_revocations oauth_client_consent_revocations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_client_consent_revocations
    ADD CONSTRAINT oauth_client_consent_revocations_pkey PRIMARY KEY (tenant_id, user_id, client_id);

--
-- Name: oauth_client_consents oauth_client_consents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_client_consents
    ADD CONSTRAINT oauth_client_consents_pkey PRIMARY KEY (id);

--
-- Name: oauth_client_consents oauth_client_consents_unique_client; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_client_consents
    ADD CONSTRAINT oauth_client_consents_unique_client UNIQUE (tenant_id, user_id, client_id);

--
-- Name: oauth_clients oauth_clients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_clients
    ADD CONSTRAINT oauth_clients_pkey PRIMARY KEY (tenant_id, client_id);

--
-- Name: oidc_scopes oidc_scopes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oidc_scopes
    ADD CONSTRAINT oidc_scopes_pkey PRIMARY KEY (id);

--
-- Name: oidc_scopes oidc_scopes_tenant_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oidc_scopes
    ADD CONSTRAINT oidc_scopes_tenant_id_name_key UNIQUE (tenant_id, name);

--
-- Name: passkeys passkeys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.passkeys
    ADD CONSTRAINT passkeys_pkey PRIMARY KEY (id);

--
-- Name: passkeys passkeys_unique_credential; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.passkeys
    ADD CONSTRAINT passkeys_unique_credential UNIQUE (tenant_id, credential_id);

--
-- Name: profile_attribute_values profile_attribute_values_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profile_attribute_values
    ADD CONSTRAINT profile_attribute_values_pkey PRIMARY KEY (id);

--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);

--
-- Name: profiles profiles_unique_subject_type; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_unique_subject_type UNIQUE (tenant_id, subject_id, profile_type);

--
-- Name: provisioning_revocation_receipts provisioning_revocation_receipts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provisioning_revocation_receipts
    ADD CONSTRAINT provisioning_revocation_receipts_pkey PRIMARY KEY (tenant_id, id);

--
-- Name: relationships relationships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.relationships
    ADD CONSTRAINT relationships_pkey PRIMARY KEY (id);

--
-- Name: role_assignments role_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_assignments
    ADD CONSTRAINT role_assignments_pkey PRIMARY KEY (id);

--
-- Name: roles roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (id);

--
-- Name: roles roles_unique_name; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_unique_name UNIQUE (tenant_id, name);

--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);

--
-- Name: screens screens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.screens
    ADD CONSTRAINT screens_pkey PRIMARY KEY (id);

--
-- Name: screens screens_tenant_id_screen_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.screens
    ADD CONSTRAINT screens_tenant_id_screen_key_key UNIQUE (tenant_id, screen_key);

--
-- Name: service_group_audit service_group_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_group_audit
    ADD CONSTRAINT service_group_audit_pkey PRIMARY KEY (id);

--
-- Name: service_group_catalog service_group_catalog_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_group_catalog
    ADD CONSTRAINT service_group_catalog_pkey PRIMARY KEY (tenant_id);

--
-- Name: service_group_epoch service_group_epoch_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_group_epoch
    ADD CONSTRAINT service_group_epoch_pkey PRIMARY KEY (tenant_id);

--
-- Name: service_group_inputs service_group_inputs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_group_inputs
    ADD CONSTRAINT service_group_inputs_pkey PRIMARY KEY (tenant_id, user_id);

--
-- Name: service_group_manual service_group_manual_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_group_manual
    ADD CONSTRAINT service_group_manual_pkey PRIMARY KEY (tenant_id, user_id, group_id);

--
-- Name: service_group_results service_group_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_group_results
    ADD CONSTRAINT service_group_results_pkey PRIMARY KEY (tenant_id, user_id);

--
-- Name: service_group_revisions service_group_revisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_group_revisions
    ADD CONSTRAINT service_group_revisions_pkey PRIMARY KEY (tenant_id, revision);

--
-- Name: service_group_scans service_group_scans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_group_scans
    ADD CONSTRAINT service_group_scans_pkey PRIMARY KEY (tenant_id, binding_ref);

--
-- Name: service_group_write_boundaries service_group_write_boundaries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_group_write_boundaries
    ADD CONSTRAINT service_group_write_boundaries_pkey PRIMARY KEY (id);

--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);

--
-- Name: sign_in_confirmation_policies sign_in_confirmation_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sign_in_confirmation_policies
    ADD CONSTRAINT sign_in_confirmation_policies_pkey PRIMARY KEY (id);

--
-- Name: sign_in_confirmation_policies sign_in_confirmation_policies_unique_name; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sign_in_confirmation_policies
    ADD CONSTRAINT sign_in_confirmation_policies_unique_name UNIQUE (tenant_id, name);

--
-- Name: sign_in_confirmation_policies sign_in_confirmation_policies_unique_trigger; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sign_in_confirmation_policies
    ADD CONSTRAINT sign_in_confirmation_policies_unique_trigger UNIQUE (tenant_id, trigger_type);

--
-- Name: statement_consent_admissions statement_consent_admissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statement_consent_admissions
    ADD CONSTRAINT statement_consent_admissions_pkey PRIMARY KEY (tenant_id, operation_id);

--
-- Name: statement_consent_guards statement_consent_guards_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statement_consent_guards
    ADD CONSTRAINT statement_consent_guards_pkey PRIMARY KEY (tenant_id, scope_kind, scope_key);

--
-- Name: statement_consent_key_states statement_consent_key_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statement_consent_key_states
    ADD CONSTRAINT statement_consent_key_states_pkey PRIMARY KEY (tenant_id, user_id, statement_id);

--
-- Name: statement_consent_operations statement_consent_operations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statement_consent_operations
    ADD CONSTRAINT statement_consent_operations_pkey PRIMARY KEY (tenant_id, operation_id);

--
-- Name: statement_consent_operations statement_consent_operations_tenant_id_operation_id_is_term_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statement_consent_operations
    ADD CONSTRAINT statement_consent_operations_tenant_id_operation_id_is_term_key UNIQUE (tenant_id, operation_id, is_terminal);

--
-- Name: statement_consent_projection_jobs statement_consent_projection_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statement_consent_projection_jobs
    ADD CONSTRAINT statement_consent_projection_jobs_pkey PRIMARY KEY (tenant_id, statement_id);

--
-- Name: statement_consent_retention_permits statement_consent_retention_permits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statement_consent_retention_permits
    ADD CONSTRAINT statement_consent_retention_permits_pkey PRIMARY KEY (tenant_id, permit_id);

--
-- Name: structured_attribute_values structured_attribute_values_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.structured_attribute_values
    ADD CONSTRAINT structured_attribute_values_pkey PRIMARY KEY (id);

--
-- Name: subject_account_links subject_account_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subject_account_links
    ADD CONSTRAINT subject_account_links_pkey PRIMARY KEY (id);

--
-- Name: subject_account_links subject_account_links_unique_link; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subject_account_links
    ADD CONSTRAINT subject_account_links_unique_link UNIQUE (tenant_id, subject_id, account_id, link_type);

--
-- Name: tenant_consent_requirements tenant_consent_requirements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_consent_requirements
    ADD CONSTRAINT tenant_consent_requirements_pkey PRIMARY KEY (id);

--
-- Name: tenant_consent_requirements tenant_consent_requirements_tenant_id_statement_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_consent_requirements
    ADD CONSTRAINT tenant_consent_requirements_tenant_id_statement_id_key UNIQUE (tenant_id, statement_id);

--
-- Name: tenants tenants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_pkey PRIMARY KEY (id);

--
-- Name: tenants tenants_tenant_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_tenant_code_key UNIQUE (tenant_code);

--
-- Name: tenants tenants_tenant_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_tenant_key_key UNIQUE (tenant_key);

--
-- Name: user_consent_records user_consent_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_consent_records
    ADD CONSTRAINT user_consent_records_pkey PRIMARY KEY (id);

--
-- Name: user_consent_records user_consent_records_unique_statement; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_consent_records
    ADD CONSTRAINT user_consent_records_unique_statement UNIQUE (tenant_id, user_id, statement_id);

--
-- Name: user_custom_fields user_custom_fields_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_custom_fields
    ADD CONSTRAINT user_custom_fields_pk PRIMARY KEY (tenant_id, user_id, field_name);

--
-- Name: user_roles user_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_pkey PRIMARY KEY (tenant_id, user_id, role_id);

--
-- Name: user_verified_attributes user_verified_attributes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_verified_attributes
    ADD CONSTRAINT user_verified_attributes_pkey PRIMARY KEY (id);

--
-- Name: user_verified_attributes user_verified_attributes_tenant_id_user_id_attribute_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_verified_attributes
    ADD CONSTRAINT user_verified_attributes_tenant_id_user_id_attribute_name_key UNIQUE (tenant_id, user_id, attribute_name);

--
-- Name: users_core users_core_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users_core
    ADD CONSTRAINT users_core_pkey PRIMARY KEY (id);

--
-- Name: web_origin_registry web_origin_registry_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.web_origin_registry
    ADD CONSTRAINT web_origin_registry_pkey PRIMARY KEY (id);

--
-- Name: web_origin_registry web_origin_registry_tenant_id_client_id_origin_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.web_origin_registry
    ADD CONSTRAINT web_origin_registry_tenant_id_client_id_origin_key UNIQUE (tenant_id, client_id, origin);

--
-- Name: webhook_configs webhook_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_configs
    ADD CONSTRAINT webhook_configs_pkey PRIMARY KEY (id);

--
-- Name: idx_account_creation_operations_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_account_creation_operations_status ON public.account_creation_operations USING btree (status, updated_at);

--
-- Name: idx_account_lifecycle_event_outbox_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_account_lifecycle_event_outbox_due ON public.account_lifecycle_event_outbox USING btree (status, next_attempt_at, created_at, event_id);

--
-- Name: idx_account_webhook_outbox_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_account_webhook_outbox_due ON public.account_webhook_outbox USING btree (tenant_id, delivered_at, next_attempt_at, lease_until);

--
-- Name: idx_application_launchers_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_application_launchers_updated ON public.application_launchers USING btree (tenant_id, updated_at, id);

--
-- Name: idx_assurance_evidence_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_assurance_evidence_subject ON public.assurance_evidence USING btree (tenant_id, subject_id, evidence_type, expires_at);

--
-- Name: idx_attribute_verifications_runtime_validity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_attribute_verifications_runtime_validity ON public.attribute_verifications USING btree (tenant_id, verification_result, invalidated_at, revalidate_after);

--
-- Name: idx_cco_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cco_client ON public.client_consent_overrides USING btree (tenant_id, client_id);

--
-- Name: idx_client_trust_policies_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_client_trust_policies_target ON public.client_trust_policies USING btree (tenant_id, target_type, target_id);

--
-- Name: idx_consent_item_history_retain_until; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_consent_item_history_retain_until ON public.consent_item_history USING btree (retain_until);

--
-- Name: idx_consent_item_history_statement; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_consent_item_history_statement ON public.consent_item_history USING btree (statement_id, created_at);

--
-- Name: idx_consent_item_history_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_consent_item_history_user ON public.consent_item_history USING btree (tenant_id, user_id, created_at);

--
-- Name: idx_consent_policy_items_policy; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_consent_policy_items_policy ON public.consent_policy_items USING btree (tenant_id, policy_id, display_order);

--
-- Name: idx_consent_records_flow; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_consent_records_flow ON public.consent_records USING btree (tenant_id, flow_id, flow_version_id, created_at);

--
-- Name: idx_consent_records_recipient; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_consent_records_recipient ON public.consent_records USING btree (tenant_id, recipient_type, recipient_id, created_at);

--
-- Name: idx_consent_records_statement; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_consent_records_statement ON public.consent_records USING btree (tenant_id, subject_user_id, statement_id, statement_version, status);

--
-- Name: idx_consent_records_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_consent_records_subject ON public.consent_records USING btree (tenant_id, subject_user_id, created_at);

--
-- Name: idx_consent_statement_localizations_version; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_consent_statement_localizations_version ON public.consent_statement_localizations USING btree (version_id, language);

--
-- Name: idx_consent_statement_versions_effective; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_consent_statement_versions_effective ON public.consent_statement_versions USING btree (effective_at);

--
-- Name: idx_consent_statement_versions_statement; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_consent_statement_versions_statement ON public.consent_statement_versions USING btree (tenant_id, statement_id, is_current);

--
-- Name: idx_contact_points_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contact_points_lookup ON public.contact_points USING btree (tenant_id, contact_type, normalized_hash);

--
-- Name: idx_contact_points_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contact_points_subject ON public.contact_points USING btree (tenant_id, subject_id, contact_type, lifecycle_state);

--
-- Name: idx_contact_verifications_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contact_verifications_contact ON public.contact_verifications USING btree (tenant_id, contact_point_id, verification_state);

--
-- Name: idx_csv_unique_current; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_csv_unique_current ON public.consent_statement_versions USING btree (tenant_id, current_statement_guard);

--
-- Name: idx_custom_claim_schema_history_cleanup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_custom_claim_schema_history_cleanup ON public.custom_claim_schema_history USING btree (tenant_id, created_at);

--
-- Name: idx_custom_claim_schema_history_schema; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_custom_claim_schema_history_schema ON public.custom_claim_schema_history USING btree (tenant_id, schema_id, version DESC);

--
-- Name: idx_custom_claim_schemas_operation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_custom_claim_schemas_operation ON public.custom_claim_schemas USING btree (tenant_id, operation_status);

--
-- Name: idx_custom_claim_schemas_tenant_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_custom_claim_schemas_tenant_active ON public.custom_claim_schemas USING btree (tenant_id, is_active, display_order);

--
-- Name: idx_custom_claim_schemas_tenant_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_custom_claim_schemas_tenant_key ON public.custom_claim_schemas USING btree (tenant_id, field_key);

--
-- Name: idx_directory_connector_instances_connector; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_directory_connector_instances_connector ON public.directory_connector_instances USING btree (tenant_id, connector_id, status, last_seen_at);

--
-- Name: idx_directory_connector_status_episodes_current; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_directory_connector_status_episodes_current ON public.directory_connector_status_episodes USING btree (tenant_id, connector_id, instance_id, ended_at);

--
-- Name: idx_directory_connector_status_episodes_recent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_directory_connector_status_episodes_recent ON public.directory_connector_status_episodes USING btree (tenant_id, connector_id, started_at);

--
-- Name: idx_directory_identity_links_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_directory_identity_links_user ON public.directory_identity_links USING btree (tenant_id, user_id);

--
-- Name: idx_directory_jit_pending_users_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_directory_jit_pending_users_status ON public.directory_jit_pending_users USING btree (tenant_id, status, updated_at);

--
-- Name: idx_event_log_tenant_anon_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_event_log_tenant_anon_created ON public.event_log USING btree (tenant_id, anonymized_user_id, created_at DESC);

--
-- Name: idx_event_log_tenant_category_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_event_log_tenant_category_created ON public.event_log USING btree (tenant_id, event_category, created_at DESC);

--
-- Name: idx_event_log_tenant_client_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_event_log_tenant_client_created ON public.event_log USING btree (tenant_id, client_id, created_at DESC);

--
-- Name: idx_event_log_tenant_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_event_log_tenant_created ON public.event_log USING btree (tenant_id, created_at DESC);

--
-- Name: idx_event_log_tenant_retention; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_event_log_tenant_retention ON public.event_log USING btree (tenant_id, retention_until, created_at, id);

--
-- Name: idx_event_log_tenant_type_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_event_log_tenant_type_created ON public.event_log USING btree (tenant_id, event_type, created_at DESC);

--
-- Name: idx_field_usage_bindings_binding; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_field_usage_bindings_binding ON public.field_usage_bindings USING btree (tenant_id, binding_type, binding_id, is_active);

--
-- Name: idx_field_usage_bindings_protection; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_field_usage_bindings_protection ON public.field_usage_bindings USING btree (tenant_id, protection, is_active);

--
-- Name: idx_field_usage_bindings_tenant_field; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_field_usage_bindings_tenant_field ON public.field_usage_bindings USING btree (tenant_id, field_key, is_active);

--
-- Name: idx_flow_assignments_flow; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_flow_assignments_flow ON public.flow_assignments USING btree (tenant_id, flow_id);

--
-- Name: idx_flow_assignments_target; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_flow_assignments_target ON public.flow_assignments USING btree (tenant_id, target_type, target_id, flow_kind) WHERE (target_id IS NOT NULL);

--
-- Name: idx_flow_assignments_target_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_flow_assignments_target_unique ON public.flow_assignments USING btree (tenant_id, target_type, target_id, flow_kind) WHERE (target_id IS NOT NULL);

--
-- Name: idx_flow_assignments_tenant_default; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_flow_assignments_tenant_default ON public.flow_assignments USING btree (tenant_id, flow_kind) WHERE ((target_type = 'tenant'::text) AND (target_id IS NULL));

--
-- Name: idx_flow_assignments_tenant_default_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_flow_assignments_tenant_default_unique ON public.flow_assignments USING btree (tenant_id, flow_kind) WHERE ((target_type = 'tenant'::text) AND (target_id IS NULL));

--
-- Name: idx_flow_audit_events_flow; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_flow_audit_events_flow ON public.flow_audit_events USING btree (tenant_id, flow_id, flow_version_id, created_at);

--
-- Name: idx_flow_audit_events_inquiry; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_flow_audit_events_inquiry ON public.flow_audit_events USING btree (tenant_id, inquiry_number) WHERE (inquiry_number IS NOT NULL);

--
-- Name: idx_flow_audit_events_interaction; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_flow_audit_events_interaction ON public.flow_audit_events USING btree (tenant_id, interaction_id, created_at);

--
-- Name: idx_flow_audit_events_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_flow_audit_events_subject ON public.flow_audit_events USING btree (tenant_id, subject_hash, created_at) WHERE (subject_hash IS NOT NULL);

--
-- Name: idx_flow_interaction_steps_node; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_flow_interaction_steps_node ON public.flow_interaction_steps USING btree (tenant_id, interaction_id, node_id);

--
-- Name: idx_flow_interaction_steps_state; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_flow_interaction_steps_state ON public.flow_interaction_steps USING btree (tenant_id, interaction_id, state);

--
-- Name: idx_flow_interactions_expiration; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_flow_interactions_expiration ON public.flow_interactions USING btree (tenant_id, expires_at);

--
-- Name: idx_flow_interactions_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_flow_interactions_lookup ON public.flow_interactions USING btree (tenant_id, id);

--
-- Name: idx_flow_interactions_state_expiration; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_flow_interactions_state_expiration ON public.flow_interactions USING btree (tenant_id, state, expires_at);

--
-- Name: idx_flow_interactions_state_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_flow_interactions_state_updated ON public.flow_interactions USING btree (tenant_id, state, updated_at, id);

--
-- Name: idx_flow_versions_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_flow_versions_lookup ON public.flow_versions USING btree (tenant_id, flow_id, version_number);

--
-- Name: idx_flow_versions_published; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_flow_versions_published ON public.flow_versions USING btree (tenant_id, flow_id, published_at);

--
-- Name: idx_flows_runtime_kind_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_flows_runtime_kind_status ON public.flows USING btree (tenant_id, kind, status);

--
-- Name: idx_flows_runtime_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_flows_runtime_slug ON public.flows USING btree (tenant_id, slug) WHERE (deleted_at IS NULL);

--
-- Name: idx_flows_template_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_flows_template_id ON public.flows USING btree (tenant_id, template_id);

--
-- Name: idx_guest_account_upgrades_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_guest_account_upgrades_target ON public.guest_account_upgrades USING btree (tenant_id, upgraded_user_id, upgraded_at);

--
-- Name: idx_guest_account_upgrades_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_guest_account_upgrades_user ON public.guest_account_upgrades USING btree (tenant_id, guest_user_id, upgraded_at);

--
-- Name: idx_guest_deletion_audit_outbox_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_guest_deletion_audit_outbox_due ON public.guest_deletion_audit_outbox USING btree (tenant_id, status, next_attempt_at, created_at);

--
-- Name: idx_guest_devices_active_resume_credential; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_guest_devices_active_resume_credential ON public.guest_devices USING btree (tenant_id, resume_credential_hash) WHERE (is_active = true);

--
-- Name: idx_guest_devices_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_guest_devices_expiry ON public.guest_devices USING btree (tenant_id, is_active, expires_at) WHERE (expires_at IS NOT NULL);

--
-- Name: idx_guest_devices_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_guest_devices_user ON public.guest_devices USING btree (tenant_id, user_id, is_active, last_used_at DESC);

--
-- Name: idx_guest_erasure_guest_devices_page; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_guest_erasure_guest_devices_page ON public.guest_devices USING btree (tenant_id, user_id, id);

--
-- Name: idx_guest_erasure_passkeys_page; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_guest_erasure_passkeys_page ON public.passkeys USING btree (tenant_id, user_id, id);

--
-- Name: idx_guest_lifecycle_cleanup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_guest_lifecycle_cleanup ON public.guest_account_lifecycle USING btree (tenant_id, phase, deletion_due_at, user_id);

--
-- Name: idx_guest_lifecycle_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_guest_lifecycle_created ON public.guest_account_lifecycle USING btree (tenant_id, created_at, user_id);

--
-- Name: idx_idempotency_keys_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_idempotency_keys_expires ON public.idempotency_keys USING btree (expires_at);

--
-- Name: idx_idempotency_keys_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_idempotency_keys_lookup ON public.idempotency_keys USING btree (tenant_id, actor_id, idempotency_key);

--
-- Name: idx_identity_accounts_legacy_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_identity_accounts_legacy_user ON public.identity_accounts USING btree (tenant_id, legacy_user_id);

--
-- Name: idx_identity_accounts_primary_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_identity_accounts_primary_subject ON public.identity_accounts USING btree (tenant_id, primary_subject_id);

--
-- Name: idx_identity_accounts_registration_state; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_identity_accounts_registration_state ON public.identity_accounts USING btree (tenant_id, registration_state);

--
-- Name: idx_identity_accounts_tenant_state; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_identity_accounts_tenant_state ON public.identity_accounts USING btree (tenant_id, account_type, lifecycle_state);

--
-- Name: idx_identity_bindings_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_identity_bindings_subject ON public.identity_bindings USING btree (tenant_id, subject_id, lifecycle_state);

--
-- Name: idx_identity_providers_saml_entity_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_identity_providers_saml_entity_id ON public.identity_providers USING btree (tenant_id, provider_type, (
CASE
    WHEN (config_json IS JSON) THEN
    CASE
        WHEN (jsonb_typeof(((config_json)::jsonb -> 'entityId'::text)) = 'string'::text) THEN ((config_json)::jsonb ->> 'entityId'::text)
        ELSE NULL::text
    END
    ELSE NULL::text
END)) WHERE (provider_type = ANY (ARRAY['saml_idp'::text, 'saml_sp'::text]));

--
-- Name: idx_identity_providers_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_identity_providers_type ON public.identity_providers USING btree (provider_type);

--
-- Name: idx_identity_resolution_candidates_state; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_identity_resolution_candidates_state ON public.identity_resolution_candidates USING btree (tenant_id, decision_state, created_at);

--
-- Name: idx_identity_resolution_events_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_identity_resolution_events_subject ON public.identity_resolution_events USING btree (tenant_id, subject_id, created_at);

--
-- Name: idx_identity_subjects_tenant_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_identity_subjects_tenant_type ON public.identity_subjects USING btree (tenant_id, subject_type, lifecycle_state);

--
-- Name: idx_launcher_favorites_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_launcher_favorites_user ON public.launcher_favorites USING btree (tenant_id, user_id, created_at, launcher_id);

--
-- Name: idx_legal_hold_events_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_legal_hold_events_account ON public.legal_hold_events USING btree (tenant_id, account_id, created_at DESC, event_id DESC);

--
-- Name: idx_legal_hold_projection_outbox_runnable; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_legal_hold_projection_outbox_runnable ON public.legal_hold_projection_outbox USING btree (status, next_attempt_at, tenant_id, operation_id);

--
-- Name: idx_legal_holds_account_history; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_legal_holds_account_history ON public.legal_holds USING btree (tenant_id, subject_id, created_at DESC, id DESC);

--
-- Name: idx_legal_holds_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_legal_holds_expiry ON public.legal_holds USING btree (state, expires_at, tenant_id, id) WHERE ((state = 'active'::text) AND (expires_at IS NOT NULL));

--
-- Name: idx_legal_holds_one_active_account; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_legal_holds_one_active_account ON public.legal_holds USING btree (tenant_id, subject_type, subject_id) WHERE (state = 'active'::text);

--
-- Name: idx_log_chunk_manifests_bucket; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_log_chunk_manifests_bucket ON public.log_chunk_manifests USING btree (tenant_key, log_type, plane, bucket_start_at, shard);

--
-- Name: idx_log_chunk_record_index_object; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_log_chunk_record_index_object ON public.log_chunk_record_index USING btree (object_catalog_id);

--
-- Name: idx_log_chunk_record_index_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_log_chunk_record_index_status ON public.log_chunk_record_index USING btree (status, created_at);

--
-- Name: idx_log_chunk_record_index_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_log_chunk_record_index_time ON public.log_chunk_record_index USING btree (tenant_key, log_type, plane, event_at);

--
-- Name: idx_log_iceberg_core_publications_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_log_iceberg_core_publications_pending ON public.log_iceberg_core_publications USING btree (tenant_id, state, updated_at, id);

--
-- Name: idx_log_object_catalog_object_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_log_object_catalog_object_key ON public.log_object_catalog USING btree (object_key);

--
-- Name: idx_log_object_catalog_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_log_object_catalog_status ON public.log_object_catalog USING btree (status, created_at);

--
-- Name: idx_log_object_catalog_tenant_type_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_log_object_catalog_tenant_type_time ON public.log_object_catalog USING btree (tenant_key, log_type, plane, created_at);

--
-- Name: idx_lookup_retention_policy_projection_outbox_runnable; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lookup_retention_policy_projection_outbox_runnable ON public.lookup_retention_policy_projection_outbox USING btree (status, next_attempt_at, tenant_id, policy_generation);

--
-- Name: idx_oauth_client_consents_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_oauth_client_consents_client ON public.oauth_client_consents USING btree (tenant_id, client_id);

--
-- Name: idx_oauth_client_consents_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_oauth_client_consents_user ON public.oauth_client_consents USING btree (tenant_id, user_id);

--
-- Name: idx_oauth_clients_agent_access_lifecycle; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_oauth_clients_agent_access_lifecycle ON public.oauth_clients USING btree (tenant_id, agent_access_registration_mode, agent_access_expires_at);

--
-- Name: idx_oauth_clients_agent_access_registration_slot; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_oauth_clients_agent_access_registration_slot ON public.oauth_clients USING btree (tenant_id, agent_access_registration_slot) WHERE ((agent_access_registration_mode = 'restricted_dcr'::text) AND (agent_access_registration_slot IS NOT NULL));

--
-- Name: idx_oauth_clients_application_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_oauth_clients_application_type ON public.oauth_clients USING btree (tenant_id, application_type);

--
-- Name: idx_oauth_clients_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_oauth_clients_tenant_id ON public.oauth_clients USING btree (tenant_id);

--
-- Name: idx_oauth_clients_trust_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_oauth_clients_trust_group ON public.oauth_clients USING btree (tenant_id, trust_group);

--
-- Name: idx_oidc_scopes_enabled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_oidc_scopes_enabled ON public.oidc_scopes USING btree (tenant_id, enabled, name);

--
-- Name: idx_passkeys_credential; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_passkeys_credential ON public.passkeys USING btree (tenant_id, credential_id);

--
-- Name: idx_passkeys_routing_authority; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_passkeys_routing_authority ON public.passkeys USING btree (tenant_id, created_at, id) WHERE (rp_id IS NOT NULL);

--
-- Name: idx_passkeys_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_passkeys_user ON public.passkeys USING btree (tenant_id, user_id);

--
-- Name: idx_profile_attribute_values_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_profile_attribute_values_hash ON public.profile_attribute_values USING btree (tenant_id, catalog_entry_id, value_hash, lifecycle_state);

--
-- Name: idx_profile_attribute_values_profile; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_profile_attribute_values_profile ON public.profile_attribute_values USING btree (tenant_id, profile_id, catalog_entry_id, lifecycle_state);

--
-- Name: idx_provisioning_revocation_receipts_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_provisioning_revocation_receipts_account ON public.provisioning_revocation_receipts USING btree (tenant_id, account_id, source_event_id, id);

--
-- Name: idx_relationships_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_relationships_expires ON public.relationships USING btree (tenant_id, expires_at);

--
-- Name: idx_relationships_from; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_relationships_from ON public.relationships USING btree (tenant_id, from_type, from_id, relationship_type);

--
-- Name: idx_relationships_to; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_relationships_to ON public.relationships USING btree (tenant_id, to_type, to_id, relationship_type);

--
-- Name: idx_role_assignments_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_role_assignments_expires ON public.role_assignments USING btree (tenant_id, expires_at);

--
-- Name: idx_role_assignments_role; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_role_assignments_role ON public.role_assignments USING btree (tenant_id, role_id);

--
-- Name: idx_role_assignments_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_role_assignments_subject ON public.role_assignments USING btree (tenant_id, subject_id, scope_type, scope_target);

--
-- Name: idx_roles_tenant_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_roles_tenant_type ON public.roles USING btree (tenant_id, role_type);

--
-- Name: idx_screens_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_screens_kind ON public.screens USING btree (tenant_id, screen_kind, is_active);

--
-- Name: idx_service_group_audit_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_service_group_audit_subject ON public.service_group_audit USING btree (tenant_id, user_id, created_at);

--
-- Name: idx_service_group_write_boundaries_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_service_group_write_boundaries_subject ON public.service_group_write_boundaries USING btree (tenant_id, user_id);

--
-- Name: idx_sessions_external_provider_sid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sessions_external_provider_sid ON public.sessions USING btree (tenant_id, external_provider_id, external_provider_sid) WHERE (external_provider_sid IS NOT NULL);

--
-- Name: idx_statement_consent_one_executing_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_statement_consent_one_executing_key ON public.statement_consent_operations USING btree (tenant_id, user_id, statement_id) WHERE (is_terminal = 0);

--
-- Name: idx_structured_attribute_values_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_structured_attribute_values_owner ON public.structured_attribute_values USING btree (tenant_id, owner_type, owner_id, catalog_entry_id);

--
-- Name: idx_subject_account_links_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subject_account_links_account ON public.subject_account_links USING btree (tenant_id, account_id, lifecycle_state);

--
-- Name: idx_tcr_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tcr_tenant ON public.tenant_consent_requirements USING btree (tenant_id, id);

--
-- Name: idx_tenants_is_default; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_tenants_is_default ON public.tenants USING btree (default_tenant_guard);

--
-- Name: idx_ucr_statement; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ucr_statement ON public.user_consent_records USING btree (tenant_id, statement_id);

--
-- Name: idx_user_consent_records_retain_until; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_consent_records_retain_until ON public.user_consent_records USING btree (retain_until);

--
-- Name: idx_user_consent_records_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_consent_records_status ON public.user_consent_records USING btree (tenant_id, status, expires_at);

--
-- Name: idx_user_consent_records_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_consent_records_user ON public.user_consent_records USING btree (tenant_id, user_id);

--
-- Name: idx_user_custom_fields_search; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_custom_fields_search ON public.user_custom_fields USING btree (tenant_id, field_name, field_value);

--
-- Name: idx_user_roles_role; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_roles_role ON public.user_roles USING btree (tenant_id, role_id, created_at);

--
-- Name: idx_users_core_domain_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_core_domain_hash ON public.users_core USING btree (tenant_id, email_domain_hash, email_domain_hash_version);

--
-- Name: idx_users_core_external_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_core_external_id ON public.users_core USING btree (tenant_id, external_id);

--
-- Name: idx_users_core_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_core_status ON public.users_core USING btree (tenant_id, status);

--
-- Name: idx_users_core_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_core_tenant ON public.users_core USING btree (tenant_id);

--
-- Name: idx_users_core_tenant_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_core_tenant_active ON public.users_core USING btree (tenant_id, is_active);

--
-- Name: idx_web_origin_registry_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_web_origin_registry_client ON public.web_origin_registry USING btree (tenant_id, client_id, is_active);

--
-- Name: idx_web_origin_registry_origin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_web_origin_registry_origin ON public.web_origin_registry USING btree (tenant_id, origin, is_active);

--
-- Name: contact_points account_webhook_contact_points_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER account_webhook_contact_points_delete AFTER DELETE ON public.contact_points FOR EACH ROW EXECUTE FUNCTION public.authrim_account_webhook_contact_points_delete();

--
-- Name: contact_points account_webhook_contact_points_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER account_webhook_contact_points_insert AFTER INSERT ON public.contact_points FOR EACH ROW EXECUTE FUNCTION public.authrim_account_webhook_contact_points_insert();

--
-- Name: contact_points account_webhook_contact_points_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER account_webhook_contact_points_update AFTER UPDATE ON public.contact_points FOR EACH ROW EXECUTE FUNCTION public.authrim_account_webhook_contact_points_update();

--
-- Name: identity_accounts account_webhook_created_activate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER account_webhook_created_activate AFTER UPDATE ON public.identity_accounts FOR EACH ROW EXECUTE FUNCTION public.authrim_account_webhook_created_activate();

--
-- Name: identity_accounts account_webhook_created_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER account_webhook_created_insert AFTER INSERT ON public.identity_accounts FOR EACH ROW EXECUTE FUNCTION public.authrim_account_webhook_created_insert();

--
-- Name: identity_accounts account_webhook_deleted; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER account_webhook_deleted AFTER UPDATE ON public.identity_accounts FOR EACH ROW EXECUTE FUNCTION public.authrim_account_webhook_deleted();

--
-- Name: guest_account_lifecycle account_webhook_guest_committed; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER account_webhook_guest_committed AFTER UPDATE ON public.guest_account_lifecycle FOR EACH ROW EXECUTE FUNCTION public.authrim_account_webhook_guest_committed();

--
-- Name: guest_account_lifecycle account_webhook_guest_retention; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER account_webhook_guest_retention AFTER UPDATE ON public.guest_account_lifecycle FOR EACH ROW EXECUTE FUNCTION public.account_webhook_guest_retention_fn();

--
-- Name: profile_attribute_values account_webhook_profile_attribute_values_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER account_webhook_profile_attribute_values_delete AFTER DELETE ON public.profile_attribute_values FOR EACH ROW EXECUTE FUNCTION public.authrim_account_webhook_profile_attribute_values_delete();

--
-- Name: profile_attribute_values account_webhook_profile_attribute_values_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER account_webhook_profile_attribute_values_insert AFTER INSERT ON public.profile_attribute_values FOR EACH ROW EXECUTE FUNCTION public.authrim_account_webhook_profile_attribute_values_insert();

--
-- Name: profile_attribute_values account_webhook_profile_attribute_values_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER account_webhook_profile_attribute_values_update AFTER UPDATE ON public.profile_attribute_values FOR EACH ROW EXECUTE FUNCTION public.authrim_account_webhook_profile_attribute_values_update();

--
-- Name: profiles account_webhook_profiles_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER account_webhook_profiles_delete AFTER DELETE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.authrim_account_webhook_profiles_delete();

--
-- Name: profiles account_webhook_profiles_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER account_webhook_profiles_insert AFTER INSERT ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.authrim_account_webhook_profiles_insert();

--
-- Name: profiles account_webhook_profiles_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER account_webhook_profiles_update AFTER UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.authrim_account_webhook_profiles_update();

--
-- Name: identity_accounts account_webhook_registration; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER account_webhook_registration AFTER UPDATE ON public.identity_accounts FOR EACH ROW EXECUTE FUNCTION public.authrim_account_webhook_registration();

--
-- Name: identity_accounts account_webhook_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER account_webhook_updated AFTER UPDATE ON public.identity_accounts FOR EACH ROW EXECUTE FUNCTION public.authrim_account_webhook_updated();

--
-- Name: user_custom_fields account_webhook_user_custom_fields_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER account_webhook_user_custom_fields_delete AFTER DELETE ON public.user_custom_fields FOR EACH ROW EXECUTE FUNCTION public.authrim_account_webhook_user_custom_fields_delete();

--
-- Name: user_custom_fields account_webhook_user_custom_fields_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER account_webhook_user_custom_fields_insert AFTER INSERT ON public.user_custom_fields FOR EACH ROW EXECUTE FUNCTION public.authrim_account_webhook_user_custom_fields_insert();

--
-- Name: user_custom_fields account_webhook_user_custom_fields_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER account_webhook_user_custom_fields_update AFTER UPDATE ON public.user_custom_fields FOR EACH ROW EXECUTE FUNCTION public.authrim_account_webhook_user_custom_fields_update();

--
-- Name: contact_points sg_contact_points_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sg_contact_points_delete AFTER DELETE ON public.contact_points FOR EACH ROW EXECUTE FUNCTION public.sg_contact_points_delete_fn();

--
-- Name: contact_points sg_contact_points_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sg_contact_points_insert AFTER INSERT ON public.contact_points FOR EACH ROW EXECUTE FUNCTION public.sg_contact_points_insert_fn();

--
-- Name: contact_points sg_contact_points_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sg_contact_points_update AFTER UPDATE ON public.contact_points FOR EACH ROW EXECUTE FUNCTION public.sg_contact_points_update_fn();

--
-- Name: custom_claim_schemas sg_epoch_custom_claim_schemas_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sg_epoch_custom_claim_schemas_delete AFTER DELETE ON public.custom_claim_schemas FOR EACH ROW EXECUTE FUNCTION public.sg_epoch_custom_claim_schemas_delete_fn();

--
-- Name: custom_claim_schemas sg_epoch_custom_claim_schemas_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sg_epoch_custom_claim_schemas_insert AFTER INSERT ON public.custom_claim_schemas FOR EACH ROW EXECUTE FUNCTION public.sg_epoch_custom_claim_schemas_insert_fn();

--
-- Name: custom_claim_schemas sg_epoch_custom_claim_schemas_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sg_epoch_custom_claim_schemas_update AFTER UPDATE ON public.custom_claim_schemas FOR EACH ROW EXECUTE FUNCTION public.sg_epoch_custom_claim_schemas_update_fn();

--
-- Name: roles sg_epoch_roles_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sg_epoch_roles_delete AFTER DELETE ON public.roles FOR EACH ROW EXECUTE FUNCTION public.sg_epoch_roles_delete_fn();

--
-- Name: roles sg_epoch_roles_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sg_epoch_roles_insert AFTER INSERT ON public.roles FOR EACH ROW EXECUTE FUNCTION public.sg_epoch_roles_insert_fn();

--
-- Name: roles sg_epoch_roles_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sg_epoch_roles_update AFTER UPDATE ON public.roles FOR EACH ROW EXECUTE FUNCTION public.sg_epoch_roles_update_fn();

--
-- Name: identity_accounts sg_identity_accounts_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sg_identity_accounts_delete AFTER DELETE ON public.identity_accounts FOR EACH ROW EXECUTE FUNCTION public.sg_identity_accounts_delete_fn();

--
-- Name: identity_accounts sg_identity_accounts_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sg_identity_accounts_insert AFTER INSERT ON public.identity_accounts FOR EACH ROW EXECUTE FUNCTION public.sg_identity_accounts_insert_fn();

--
-- Name: identity_accounts sg_identity_accounts_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sg_identity_accounts_update AFTER UPDATE ON public.identity_accounts FOR EACH ROW EXECUTE FUNCTION public.sg_identity_accounts_update_fn();

--
-- Name: service_group_manual sg_service_group_manual_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sg_service_group_manual_delete AFTER DELETE ON public.service_group_manual FOR EACH ROW EXECUTE FUNCTION public.sg_service_group_manual_delete_fn();

--
-- Name: service_group_manual sg_service_group_manual_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sg_service_group_manual_insert AFTER INSERT ON public.service_group_manual FOR EACH ROW EXECUTE FUNCTION public.sg_service_group_manual_insert_fn();

--
-- Name: service_group_manual sg_service_group_manual_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sg_service_group_manual_update AFTER UPDATE ON public.service_group_manual FOR EACH ROW EXECUTE FUNCTION public.sg_service_group_manual_update_fn();

--
-- Name: user_custom_fields sg_user_custom_fields_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sg_user_custom_fields_delete AFTER DELETE ON public.user_custom_fields FOR EACH ROW EXECUTE FUNCTION public.sg_user_custom_fields_delete_fn();

--
-- Name: user_custom_fields sg_user_custom_fields_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sg_user_custom_fields_insert AFTER INSERT ON public.user_custom_fields FOR EACH ROW EXECUTE FUNCTION public.sg_user_custom_fields_insert_fn();

--
-- Name: user_custom_fields sg_user_custom_fields_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sg_user_custom_fields_update AFTER UPDATE ON public.user_custom_fields FOR EACH ROW EXECUTE FUNCTION public.sg_user_custom_fields_update_fn();

--
-- Name: user_roles sg_user_roles_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sg_user_roles_delete AFTER DELETE ON public.user_roles FOR EACH ROW EXECUTE FUNCTION public.sg_user_roles_delete_fn();

--
-- Name: user_roles sg_user_roles_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sg_user_roles_insert AFTER INSERT ON public.user_roles FOR EACH ROW EXECUTE FUNCTION public.sg_user_roles_insert_fn();

--
-- Name: user_roles sg_user_roles_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sg_user_roles_update AFTER UPDATE ON public.user_roles FOR EACH ROW EXECUTE FUNCTION public.sg_user_roles_update_fn();

--
-- Name: service_group_write_boundaries sg_write_boundary_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sg_write_boundary_delete AFTER DELETE ON public.service_group_write_boundaries FOR EACH ROW EXECUTE FUNCTION public.sg_write_boundary_delete_fn();

--
-- Name: service_group_write_boundaries sg_write_boundary_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sg_write_boundary_insert AFTER INSERT ON public.service_group_write_boundaries FOR EACH ROW EXECUTE FUNCTION public.sg_write_boundary_insert_fn();

--
-- Name: statement_consent_admissions statement_consent_admission_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER statement_consent_admission_immutable BEFORE UPDATE ON public.statement_consent_admissions FOR EACH ROW EXECUTE FUNCTION public.statement_consent_admission_immutable_fn();

--
-- Name: statement_consent_admissions statement_consent_admissions_replace_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER statement_consent_admissions_replace_guard BEFORE INSERT ON public.statement_consent_admissions FOR EACH ROW EXECUTE FUNCTION public.statement_consent_admissions_replace_guard_fn();

--
-- Name: consent_item_history statement_consent_consent_item_history_delete_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER statement_consent_consent_item_history_delete_guard BEFORE DELETE ON public.consent_item_history FOR EACH ROW EXECUTE FUNCTION public.statement_consent_consent_item_history_delete_guard_fn();

--
-- Name: consent_item_history statement_consent_consent_item_history_insert_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER statement_consent_consent_item_history_insert_guard BEFORE INSERT ON public.consent_item_history FOR EACH ROW EXECUTE FUNCTION public.statement_consent_consent_item_history_insert_guard_fn();

--
-- Name: consent_item_history statement_consent_consent_item_history_update_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER statement_consent_consent_item_history_update_guard BEFORE UPDATE ON public.consent_item_history FOR EACH ROW EXECUTE FUNCTION public.statement_consent_consent_item_history_update_guard_fn();

--
-- Name: statement_consent_guards statement_consent_guard_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER statement_consent_guard_delete BEFORE DELETE ON public.statement_consent_guards FOR EACH ROW EXECUTE FUNCTION public.statement_consent_guard_delete_fn();

--
-- Name: statement_consent_guards statement_consent_guard_monotonic; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER statement_consent_guard_monotonic BEFORE UPDATE ON public.statement_consent_guards FOR EACH ROW EXECUTE FUNCTION public.statement_consent_guard_monotonic_fn();

--
-- Name: statement_consent_guards statement_consent_guards_replace_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER statement_consent_guards_replace_guard BEFORE INSERT ON public.statement_consent_guards FOR EACH ROW EXECUTE FUNCTION public.statement_consent_guards_replace_guard_fn();

--
-- Name: statement_consent_key_states statement_consent_key_delete_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER statement_consent_key_delete_guard BEFORE DELETE ON public.statement_consent_key_states FOR EACH ROW EXECUTE FUNCTION public.statement_consent_key_delete_guard_fn();

--
-- Name: statement_consent_key_states statement_consent_key_states_replace_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER statement_consent_key_states_replace_guard BEFORE INSERT ON public.statement_consent_key_states FOR EACH ROW EXECUTE FUNCTION public.statement_consent_key_states_replace_guard_fn();

--
-- Name: statement_consent_key_states statement_consent_key_update_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER statement_consent_key_update_guard BEFORE UPDATE ON public.statement_consent_key_states FOR EACH ROW EXECUTE FUNCTION public.statement_consent_key_update_guard_fn();

--
-- Name: statement_consent_operations statement_consent_operation_delete_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER statement_consent_operation_delete_guard BEFORE DELETE ON public.statement_consent_operations FOR EACH ROW EXECUTE FUNCTION public.statement_consent_operation_delete_guard_fn();

--
-- Name: statement_consent_operations statement_consent_operation_finalize_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER statement_consent_operation_finalize_guard BEFORE UPDATE ON public.statement_consent_operations FOR EACH ROW EXECUTE FUNCTION public.statement_consent_operation_finalize_guard_fn();

--
-- Name: statement_consent_operations statement_consent_operation_insert_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER statement_consent_operation_insert_guard BEFORE INSERT ON public.statement_consent_operations FOR EACH ROW EXECUTE FUNCTION public.statement_consent_operation_insert_guard_fn();

--
-- Name: statement_consent_retention_permits statement_consent_retention_permit_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER statement_consent_retention_permit_immutable BEFORE UPDATE ON public.statement_consent_retention_permits FOR EACH ROW EXECUTE FUNCTION public.statement_consent_retention_permit_immutable_fn();

--
-- Name: user_consent_records statement_consent_user_consent_records_delete_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER statement_consent_user_consent_records_delete_guard BEFORE DELETE ON public.user_consent_records FOR EACH ROW EXECUTE FUNCTION public.statement_consent_user_consent_records_delete_guard_fn();

--
-- Name: user_consent_records statement_consent_user_consent_records_insert_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER statement_consent_user_consent_records_insert_guard BEFORE INSERT ON public.user_consent_records FOR EACH ROW EXECUTE FUNCTION public.statement_consent_user_consent_records_insert_guard_fn();

--
-- Name: user_consent_records statement_consent_user_consent_records_update_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER statement_consent_user_consent_records_update_guard BEFORE UPDATE ON public.user_consent_records FOR EACH ROW EXECUTE FUNCTION public.statement_consent_user_consent_records_update_guard_fn();

--
-- Name: account_creation_operations trg_account_creation_operation_status_transition; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_account_creation_operation_status_transition BEFORE UPDATE OF status ON public.account_creation_operations FOR EACH ROW EXECUTE FUNCTION public.authrim_account_creation_operation_status_transition();

--
-- Name: account_lifecycle_event_outbox trg_account_lifecycle_event_outbox_initial_state; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_account_lifecycle_event_outbox_initial_state BEFORE INSERT ON public.account_lifecycle_event_outbox FOR EACH ROW EXECUTE FUNCTION public.authrim_account_lifecycle_event_outbox_initial_state();

--
-- Name: account_lifecycle_event_outbox trg_account_lifecycle_event_outbox_status_transition; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_account_lifecycle_event_outbox_status_transition BEFORE UPDATE OF status ON public.account_lifecycle_event_outbox FOR EACH ROW EXECUTE FUNCTION public.authrim_account_lifecycle_event_outbox_status_transition();

--
-- Name: account_support_contexts trg_account_support_context_account_tenant_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_account_support_context_account_tenant_insert BEFORE INSERT ON public.account_support_contexts FOR EACH ROW EXECUTE FUNCTION public.authrim_support_context_validate_account();

--
-- Name: account_support_contexts trg_account_support_context_active_hold_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_account_support_context_active_hold_delete BEFORE DELETE ON public.account_support_contexts FOR EACH ROW EXECUTE FUNCTION public.authrim_support_context_active_hold_delete();

--
-- Name: account_support_contexts trg_account_support_context_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_account_support_context_version BEFORE UPDATE ON public.account_support_contexts FOR EACH ROW EXECUTE FUNCTION public.authrim_support_context_validate_update();

--
-- Name: identity_accounts trg_guest_core_accounts; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_guest_core_accounts BEFORE INSERT OR DELETE OR UPDATE ON public.identity_accounts FOR EACH ROW EXECUTE FUNCTION public.authrim_guest_core_source_guard();

--
-- Name: guest_account_lifecycle trg_guest_core_boundary; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_guest_core_boundary BEFORE INSERT OR DELETE OR UPDATE ON public.guest_account_lifecycle FOR EACH ROW EXECUTE FUNCTION public.authrim_guest_core_boundary_guard();

--
-- Name: guest_devices trg_guest_core_devices; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_guest_core_devices BEFORE INSERT OR DELETE OR UPDATE ON public.guest_devices FOR EACH ROW EXECUTE FUNCTION public.authrim_guest_core_source_guard();

--
-- Name: legal_holds trg_guest_core_hold; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_guest_core_hold BEFORE INSERT OR UPDATE ON public.legal_holds FOR EACH ROW EXECUTE FUNCTION public.authrim_guest_core_hold_guard();

--
-- Name: passkeys trg_guest_core_passkeys; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_guest_core_passkeys BEFORE INSERT OR DELETE OR UPDATE ON public.passkeys FOR EACH ROW EXECUTE FUNCTION public.authrim_guest_core_source_guard();

--
-- Name: profiles trg_guest_core_profiles; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_guest_core_profiles BEFORE INSERT OR DELETE OR UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.authrim_guest_core_parent_epoch_guard();

--
-- Name: identity_subjects trg_guest_core_subjects; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_guest_core_subjects BEFORE INSERT OR DELETE OR UPDATE ON public.identity_subjects FOR EACH ROW EXECUTE FUNCTION public.authrim_guest_core_parent_epoch_guard();

--
-- Name: identity_accounts trg_identity_accounts_active_hold_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_identity_accounts_active_hold_delete BEFORE DELETE ON public.identity_accounts FOR EACH ROW EXECUTE FUNCTION public.authrim_identity_account_active_hold_delete();

--
-- Name: identity_accounts trg_identity_accounts_legal_hold_state_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_identity_accounts_legal_hold_state_insert AFTER INSERT ON public.identity_accounts FOR EACH ROW EXECUTE FUNCTION public.authrim_identity_account_legal_hold_state_insert();

--
-- Name: legal_hold_events trg_legal_hold_events_immutable_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_legal_hold_events_immutable_delete BEFORE DELETE ON public.legal_hold_events FOR EACH ROW EXECUTE FUNCTION public.authrim_legal_hold_event_immutable();

--
-- Name: legal_hold_events trg_legal_hold_events_immutable_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_legal_hold_events_immutable_update BEFORE UPDATE ON public.legal_hold_events FOR EACH ROW EXECUTE FUNCTION public.authrim_legal_hold_event_immutable();

--
-- Name: legal_holds trg_legal_holds_account_tenant_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_legal_holds_account_tenant_insert BEFORE INSERT ON public.legal_holds FOR EACH ROW EXECUTE FUNCTION public.authrim_legal_hold_validate_account();

--
-- Name: legal_holds trg_legal_holds_immutable_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_legal_holds_immutable_delete BEFORE DELETE ON public.legal_holds FOR EACH ROW EXECUTE FUNCTION public.authrim_legal_hold_forbid_delete();

--
-- Name: legal_holds trg_legal_holds_projection_state_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_legal_holds_projection_state_insert AFTER INSERT ON public.legal_holds FOR EACH ROW EXECUTE FUNCTION public.authrim_legal_hold_projection_state_change();

--
-- Name: legal_holds trg_legal_holds_projection_state_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_legal_holds_projection_state_update AFTER UPDATE OF state ON public.legal_holds FOR EACH ROW EXECUTE FUNCTION public.authrim_legal_hold_projection_state_change();

--
-- Name: legal_holds trg_legal_holds_transition; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_legal_holds_transition BEFORE UPDATE ON public.legal_holds FOR EACH ROW EXECUTE FUNCTION public.authrim_legal_hold_validate_update();

--
-- Name: tenants trg_tenants_lookup_retention_policy_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_tenants_lookup_retention_policy_insert AFTER INSERT ON public.tenants FOR EACH ROW EXECUTE FUNCTION public.authrim_tenant_lookup_retention_policy_insert();

--
-- Name: account_lifecycle_event_outbox account_lifecycle_event_outbox_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_lifecycle_event_outbox
    ADD CONSTRAINT account_lifecycle_event_outbox_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.identity_accounts(id) ON DELETE CASCADE;

--
-- Name: account_support_contexts account_support_contexts_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_support_contexts
    ADD CONSTRAINT account_support_contexts_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.identity_accounts(id) ON DELETE CASCADE;

--
-- Name: client_consent_overrides client_consent_overrides_statement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_consent_overrides
    ADD CONSTRAINT client_consent_overrides_statement_id_fkey FOREIGN KEY (statement_id) REFERENCES public.consent_statements(id) ON DELETE CASCADE;

--
-- Name: consent_policy_items consent_policy_items_policy_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consent_policy_items
    ADD CONSTRAINT consent_policy_items_policy_fk FOREIGN KEY (policy_id) REFERENCES public.consent_policies(id) ON DELETE CASCADE;

--
-- Name: consent_statement_localizations consent_statement_localizations_version_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consent_statement_localizations
    ADD CONSTRAINT consent_statement_localizations_version_fk FOREIGN KEY (version_id) REFERENCES public.consent_statement_versions(id) ON DELETE CASCADE;

--
-- Name: consent_statement_versions consent_statement_versions_statement_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consent_statement_versions
    ADD CONSTRAINT consent_statement_versions_statement_fk FOREIGN KEY (statement_id) REFERENCES public.consent_statements(id) ON DELETE CASCADE;

--
-- Name: contact_points contact_points_account_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_points
    ADD CONSTRAINT contact_points_account_fk FOREIGN KEY (account_id) REFERENCES public.identity_accounts(id) ON DELETE CASCADE;

--
-- Name: contact_points contact_points_subject_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_points
    ADD CONSTRAINT contact_points_subject_fk FOREIGN KEY (subject_id) REFERENCES public.identity_subjects(id) ON DELETE CASCADE;

--
-- Name: contact_verifications contact_verifications_contact_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_verifications
    ADD CONSTRAINT contact_verifications_contact_fk FOREIGN KEY (contact_point_id) REFERENCES public.contact_points(id) ON DELETE CASCADE;

--
-- Name: flow_assignments flow_assignments_flow_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flow_assignments
    ADD CONSTRAINT flow_assignments_flow_fk FOREIGN KEY (flow_id) REFERENCES public.flows(id) ON DELETE CASCADE;

--
-- Name: flow_interaction_steps flow_interaction_steps_interaction_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flow_interaction_steps
    ADD CONSTRAINT flow_interaction_steps_interaction_fk FOREIGN KEY (interaction_id) REFERENCES public.flow_interactions(id) ON DELETE CASCADE;

--
-- Name: flow_interactions flow_interactions_flow_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flow_interactions
    ADD CONSTRAINT flow_interactions_flow_fk FOREIGN KEY (flow_id) REFERENCES public.flows(id) ON DELETE CASCADE;

--
-- Name: flow_interactions flow_interactions_version_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flow_interactions
    ADD CONSTRAINT flow_interactions_version_fk FOREIGN KEY (flow_version_id) REFERENCES public.flow_versions(id) ON DELETE CASCADE;

--
-- Name: flow_versions flow_versions_flow_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flow_versions
    ADD CONSTRAINT flow_versions_flow_fk FOREIGN KEY (flow_id) REFERENCES public.flows(id) ON DELETE CASCADE;

--
-- Name: idempotency_keys idempotency_keys_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idempotency_keys
    ADD CONSTRAINT idempotency_keys_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

--
-- Name: identity_accounts identity_accounts_subject_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_accounts
    ADD CONSTRAINT identity_accounts_subject_fk FOREIGN KEY (primary_subject_id) REFERENCES public.identity_subjects(id) ON DELETE SET NULL;

--
-- Name: identity_bindings identity_bindings_account_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_bindings
    ADD CONSTRAINT identity_bindings_account_fk FOREIGN KEY (account_id) REFERENCES public.identity_accounts(id) ON DELETE SET NULL;

--
-- Name: identity_bindings identity_bindings_subject_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_bindings
    ADD CONSTRAINT identity_bindings_subject_fk FOREIGN KEY (subject_id) REFERENCES public.identity_subjects(id) ON DELETE CASCADE;

--
-- Name: identity_resolution_events identity_resolution_events_account_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_resolution_events
    ADD CONSTRAINT identity_resolution_events_account_fk FOREIGN KEY (account_id) REFERENCES public.identity_accounts(id) ON DELETE SET NULL;

--
-- Name: identity_resolution_events identity_resolution_events_binding_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_resolution_events
    ADD CONSTRAINT identity_resolution_events_binding_fk FOREIGN KEY (binding_id) REFERENCES public.identity_bindings(id) ON DELETE SET NULL;

--
-- Name: identity_resolution_events identity_resolution_events_subject_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_resolution_events
    ADD CONSTRAINT identity_resolution_events_subject_fk FOREIGN KEY (subject_id) REFERENCES public.identity_subjects(id) ON DELETE SET NULL;

--
-- Name: legal_hold_events legal_hold_events_hold_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.legal_hold_events
    ADD CONSTRAINT legal_hold_events_hold_id_fkey FOREIGN KEY (hold_id) REFERENCES public.legal_holds(id) ON DELETE CASCADE;

--
-- Name: legal_hold_projection_outbox legal_hold_projection_outbox_hold_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.legal_hold_projection_outbox
    ADD CONSTRAINT legal_hold_projection_outbox_hold_id_fkey FOREIGN KEY (hold_id) REFERENCES public.legal_holds(id) ON DELETE CASCADE;

--
-- Name: profile_attribute_values profile_attribute_values_profile_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profile_attribute_values
    ADD CONSTRAINT profile_attribute_values_profile_fk FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

--
-- Name: profiles profiles_subject_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_subject_fk FOREIGN KEY (subject_id) REFERENCES public.identity_subjects(id) ON DELETE CASCADE;

--
-- Name: role_assignments role_assignments_role_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_assignments
    ADD CONSTRAINT role_assignments_role_fk FOREIGN KEY (role_id) REFERENCES public.roles(id) ON DELETE CASCADE;

--
-- Name: role_assignments role_assignments_subject_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_assignments
    ADD CONSTRAINT role_assignments_subject_fk FOREIGN KEY (subject_id) REFERENCES public.users_core(id) ON DELETE CASCADE;

--
-- Name: roles roles_parent_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_parent_fk FOREIGN KEY (parent_role_id) REFERENCES public.roles(id);

--
-- Name: sessions sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users_core(id) ON DELETE CASCADE;

--
-- Name: statement_consent_operations statement_consent_operations_tenant_id_operation_id_requir_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statement_consent_operations
    ADD CONSTRAINT statement_consent_operations_tenant_id_operation_id_requir_fkey FOREIGN KEY (tenant_id, operation_id, required_terminal) REFERENCES public.statement_consent_operations(tenant_id, operation_id, is_terminal) DEFERRABLE INITIALLY DEFERRED;

--
-- Name: subject_account_links subject_account_links_account_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subject_account_links
    ADD CONSTRAINT subject_account_links_account_fk FOREIGN KEY (account_id) REFERENCES public.identity_accounts(id) ON DELETE CASCADE;

--
-- Name: subject_account_links subject_account_links_subject_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subject_account_links
    ADD CONSTRAINT subject_account_links_subject_fk FOREIGN KEY (subject_id) REFERENCES public.identity_subjects(id) ON DELETE CASCADE;

--
-- Name: tenant_consent_requirements tenant_consent_requirements_statement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_consent_requirements
    ADD CONSTRAINT tenant_consent_requirements_statement_id_fkey FOREIGN KEY (statement_id) REFERENCES public.consent_statements(id) ON DELETE CASCADE;

--
-- Name: user_custom_fields user_custom_fields_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_custom_fields
    ADD CONSTRAINT user_custom_fields_user_fk FOREIGN KEY (user_id) REFERENCES public.users_core(id) ON DELETE CASCADE;

--
-- Name: user_roles user_roles_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id) ON DELETE CASCADE;

--
-- Name: user_roles user_roles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users_core(id) ON DELETE CASCADE;

--
-- Name: user_verified_attributes user_verified_attributes_verification_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_verified_attributes
    ADD CONSTRAINT user_verified_attributes_verification_id_fkey FOREIGN KEY (verification_id) REFERENCES public.attribute_verifications(id);

--
-- Name: web_origin_registry web_origin_registry_tenant_id_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.web_origin_registry
    ADD CONSTRAINT web_origin_registry_tenant_id_client_id_fkey FOREIGN KEY (tenant_id, client_id) REFERENCES public.oauth_clients(tenant_id, client_id) ON DELETE CASCADE;

--
-- PostgreSQL database dump complete
--
