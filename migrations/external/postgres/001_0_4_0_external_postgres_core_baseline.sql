-- Authrim 0.4.0 semantic fresh-install baseline.
-- Logical stream: external-postgres-core.
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

SET default_tablespace = '';

SET default_table_access_method = heap;

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
-- Name: anonymous_devices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.anonymous_devices (
    id text NOT NULL,
    tenant_id text NOT NULL,
    user_id text NOT NULL,
    device_id_hash text NOT NULL,
    installation_id_hash text,
    fingerprint_hash text,
    device_platform text,
    device_stability text NOT NULL,
    expires_at bigint,
    created_at bigint NOT NULL,
    last_used_at bigint NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    CONSTRAINT anonymous_devices_device_id_hash_check CHECK ((length(device_id_hash) = 64)),
    CONSTRAINT anonymous_devices_device_platform_check CHECK (((device_platform IS NULL) OR (device_platform = ANY (ARRAY['ios'::text, 'android'::text, 'web'::text, 'other'::text])))),
    CONSTRAINT anonymous_devices_device_stability_check CHECK ((device_stability = ANY (ARRAY['session'::text, 'installation'::text, 'device'::text]))),
    CONSTRAINT anonymous_devices_fingerprint_hash_check CHECK (((fingerprint_hash IS NULL) OR (length(fingerprint_hash) = 64))),
    CONSTRAINT anonymous_devices_installation_id_hash_check CHECK (((installation_id_hash IS NULL) OR (length(installation_id_hash) = 64)))
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
    created_at bigint NOT NULL
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
    reconsent_interval_days bigint
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
    created_at bigint NOT NULL
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
    deleted_at bigint
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
    updated_at bigint NOT NULL
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
    updated_at bigint NOT NULL
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
-- Name: verified_attributes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.verified_attributes (
    id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    subject_id text NOT NULL,
    attribute_name text NOT NULL,
    attribute_value text,
    source text DEFAULT 'manual'::text NOT NULL,
    issuer text,
    credential_id text,
    verified_at bigint NOT NULL,
    expires_at bigint,
    revoked_at bigint,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL
);

--
-- Data for Name: account_legal_hold_states; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: account_support_contexts; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: anonymous_devices; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: application_launchers; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: attribute_verifications; Type: TABLE DATA; Schema: public; Owner: -
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
-- Data for Name: identity_accounts; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: identity_bindings; Type: TABLE DATA; Schema: public; Owner: -
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
-- Data for Name: log_object_catalog; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: lookup_retention_policies; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: lookup_retention_policy_projection_outbox; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: oauth_client_consents; Type: TABLE DATA; Schema: public; Owner: -
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
-- Data for Name: sessions; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: sign_in_confirmation_policies; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: structured_attribute_values; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: subject_account_links; Type: TABLE DATA; Schema: public; Owner: -
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
-- Data for Name: user_verified_attributes; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: users_core; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: verified_attributes; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Name: account_legal_hold_states account_legal_hold_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_legal_hold_states
    ADD CONSTRAINT account_legal_hold_states_pkey PRIMARY KEY (tenant_id, account_id);

--
-- Name: account_support_contexts account_support_contexts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_support_contexts
    ADD CONSTRAINT account_support_contexts_pkey PRIMARY KEY (tenant_id, account_id);

--
-- Name: anonymous_devices anonymous_devices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.anonymous_devices
    ADD CONSTRAINT anonymous_devices_pkey PRIMARY KEY (id);

--
-- Name: application_launchers application_launchers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.application_launchers
    ADD CONSTRAINT application_launchers_pkey PRIMARY KEY (tenant_id, id);

--
-- Name: attribute_verifications attribute_verifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attribute_verifications
    ADD CONSTRAINT attribute_verifications_pkey PRIMARY KEY (id);

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
-- Name: verified_attributes verified_attributes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verified_attributes
    ADD CONSTRAINT verified_attributes_pkey PRIMARY KEY (id);

--
-- Name: verified_attributes verified_attributes_unique_name; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verified_attributes
    ADD CONSTRAINT verified_attributes_unique_name UNIQUE (tenant_id, subject_id, attribute_name);

--
-- Name: idx_anonymous_devices_active_digest; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_anonymous_devices_active_digest ON public.anonymous_devices USING btree (tenant_id, device_id_hash) WHERE (is_active = true);

--
-- Name: idx_anonymous_devices_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_anonymous_devices_expiry ON public.anonymous_devices USING btree (tenant_id, is_active, expires_at) WHERE (expires_at IS NOT NULL);

--
-- Name: idx_anonymous_devices_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_anonymous_devices_user ON public.anonymous_devices USING btree (tenant_id, user_id, is_active, last_used_at DESC);

--
-- Name: idx_application_launchers_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_application_launchers_updated ON public.application_launchers USING btree (tenant_id, updated_at, id);

--
-- Name: idx_attribute_verifications_runtime_validity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_attribute_verifications_runtime_validity ON public.attribute_verifications USING btree (tenant_id, verification_result, invalidated_at, revalidate_after);

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
-- Name: idx_flow_audit_events_interaction; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_flow_audit_events_interaction ON public.flow_audit_events USING btree (tenant_id, interaction_id, created_at);

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
-- Name: idx_identity_accounts_legacy_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_identity_accounts_legacy_user ON public.identity_accounts USING btree (tenant_id, legacy_user_id);

--
-- Name: idx_identity_accounts_tenant_state; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_identity_accounts_tenant_state ON public.identity_accounts USING btree (tenant_id, account_type, lifecycle_state);

--
-- Name: idx_identity_bindings_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_identity_bindings_subject ON public.identity_bindings USING btree (tenant_id, subject_id, lifecycle_state);

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
-- Name: idx_sessions_external_provider_sid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sessions_external_provider_sid ON public.sessions USING btree (tenant_id, external_provider_id, external_provider_sid) WHERE (external_provider_sid IS NOT NULL);

--
-- Name: idx_structured_attribute_values_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_structured_attribute_values_owner ON public.structured_attribute_values USING btree (tenant_id, owner_type, owner_id, catalog_entry_id);

--
-- Name: idx_subject_account_links_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subject_account_links_account ON public.subject_account_links USING btree (tenant_id, account_id, lifecycle_state);

--
-- Name: idx_tenants_is_default; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_tenants_is_default ON public.tenants USING btree (default_tenant_guard);

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
-- Name: idx_verified_attributes_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_verified_attributes_name ON public.verified_attributes USING btree (tenant_id, attribute_name);

--
-- Name: idx_verified_attributes_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_verified_attributes_subject ON public.verified_attributes USING btree (tenant_id, subject_id);

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
-- Name: account_support_contexts account_support_contexts_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_support_contexts
    ADD CONSTRAINT account_support_contexts_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.identity_accounts(id) ON DELETE CASCADE;

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
-- Name: user_custom_fields user_custom_fields_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_custom_fields
    ADD CONSTRAINT user_custom_fields_user_fk FOREIGN KEY (user_id) REFERENCES public.users_core(id) ON DELETE CASCADE;

--
-- Name: user_verified_attributes user_verified_attributes_verification_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_verified_attributes
    ADD CONSTRAINT user_verified_attributes_verification_id_fkey FOREIGN KEY (verification_id) REFERENCES public.attribute_verifications(id);

--
-- PostgreSQL database dump complete
--
