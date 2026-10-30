-- Authrim 0.5.0 semantic fresh-install baseline.
-- Logical stream: pii-postgresql.
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
-- Name: authrim_guest_pii_epoch_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.authrim_guest_pii_epoch_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
 IF TG_OP<>'UPDATE' OR NEW.id IS DISTINCT FROM OLD.id OR NEW.revision IS DISTINCT FROM OLD.revision+1 THEN
  RAISE EXCEPTION 'guest_pii_admission_immutable'; END IF;
 RETURN NEW;
END; $$;

--
-- Name: authrim_guest_pii_epoch_insert_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.authrim_guest_pii_epoch_insert_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM guest_pii_mutation_epoch) THEN RAISE EXCEPTION 'guest_pii_admission_immutable'; END IF;
 RETURN NEW;
END; $$;

--
-- Name: authrim_guest_pii_marker_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.authrim_guest_pii_marker_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
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

--
-- Name: authrim_guest_pii_source_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.authrim_guest_pii_source_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
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

--
-- Name: sg_identity_sensitive_values_delete_fn(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sg_identity_sensitive_values_delete_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT OLD.tenant_id, OLD.owner_id, 1 WHERE (OLD.owner_type = 'runtime_user') AND OLD.owner_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
 RETURN OLD; END; $$;

--
-- Name: sg_identity_sensitive_values_insert_fn(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sg_identity_sensitive_values_insert_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, NEW.owner_id, 1 WHERE (NEW.owner_type = 'runtime_user') AND NEW.owner_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
 RETURN NEW; END; $$;

--
-- Name: sg_identity_sensitive_values_update_fn(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sg_identity_sensitive_values_update_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, NEW.owner_id, 1 WHERE (NEW.owner_type = 'runtime_user') AND NEW.owner_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
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

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: account_webhook_delivery_fields; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_webhook_delivery_fields (
    tenant_id text NOT NULL,
    event_id text NOT NULL,
    webhook_id text NOT NULL,
    fields_json text NOT NULL,
    destination_url text NOT NULL,
    created_at bigint NOT NULL
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
-- Name: account_webhook_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_webhook_snapshots (
    id text NOT NULL,
    tenant_id text NOT NULL,
    user_id text NOT NULL,
    account_id text NOT NULL,
    event_type text NOT NULL,
    registration_state text NOT NULL,
    email_before_json text,
    email_after_json text,
    created_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    CONSTRAINT account_webhook_snapshots_registration_state_check CHECK ((registration_state = ANY (ARRAY['guest'::text, 'registered'::text])))
);

--
-- Name: audit_log_pii; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_log_pii (
    id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    user_id text,
    action text NOT NULL,
    target_user_id text,
    details jsonb,
    ip_address text,
    user_agent text,
    created_at bigint NOT NULL,
    exported_at bigint
);

--
-- Name: guest_pii_erasure_markers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.guest_pii_erasure_markers (
    schema_version integer NOT NULL,
    tenant_id text NOT NULL,
    user_id text NOT NULL,
    account_id text NOT NULL,
    account_route_generation bigint NOT NULL,
    state text NOT NULL,
    revision bigint NOT NULL,
    operation_id text,
    boundary_id text,
    source_started_at_ms bigint,
    permit_table text,
    permit_keys_json text,
    CONSTRAINT guest_pii_erasure_markers_account_id_check CHECK (((length(account_id) >= 1) AND (length(account_id) <= 512))),
    CONSTRAINT guest_pii_erasure_markers_account_route_generation_check CHECK (((account_route_generation >= 1) AND (account_route_generation <= '9007199254740991'::bigint))),
    CONSTRAINT guest_pii_erasure_markers_check CHECK ((((state = 'deleted'::text) AND (operation_id IS NULL) AND (boundary_id IS NULL) AND (source_started_at_ms IS NULL) AND (permit_table IS NULL) AND (permit_keys_json IS NULL)) OR ((state = 'erasing'::text) AND (operation_id IS NOT NULL) AND (boundary_id IS NOT NULL) AND (source_started_at_ms IS NOT NULL) AND ((length(operation_id) >= 1) AND (length(operation_id) <= 256)) AND (length(boundary_id) = 78) AND ((source_started_at_ms >= 1) AND (source_started_at_ms <= '9007199254740991'::bigint)) AND (((permit_table IS NULL) AND (permit_keys_json IS NULL)) OR ((permit_table IS NOT NULL) AND (permit_keys_json IS NOT NULL) AND (permit_table = ANY (ARRAY['users_pii'::text, 'identity_sensitive_values'::text, 'linked_identities'::text, 'subject_identifiers'::text, 'pairwise_subject_identifiers'::text, 'guest_upgrade_operations'::text, 'identity_identifier_replacement_challenges'::text, 'identity_identifier_replacement_operations'::text, 'identity_identifier_replacement_history'::text, 'identity_identifier_replacement_outbox'::text, 'external_identifier_unlink_operations'::text, 'user_anonymization_map'::text])) AND (length(permit_keys_json) <= 8192) AND (jsonb_typeof((permit_keys_json)::jsonb) = 'array'::text) AND ((jsonb_array_length((permit_keys_json)::jsonb) >= 1) AND (jsonb_array_length((permit_keys_json)::jsonb) <= 16))))))),
    CONSTRAINT guest_pii_erasure_markers_revision_check CHECK (((revision >= 1) AND (revision <= '9007199254740991'::bigint))),
    CONSTRAINT guest_pii_erasure_markers_schema_version_check CHECK ((schema_version = 1)),
    CONSTRAINT guest_pii_erasure_markers_state_check CHECK ((state = ANY (ARRAY['erasing'::text, 'deleted'::text]))),
    CONSTRAINT guest_pii_erasure_markers_tenant_id_check CHECK (((length(tenant_id) >= 1) AND (length(tenant_id) <= 256))),
    CONSTRAINT guest_pii_erasure_markers_user_id_check CHECK (((length(user_id) >= 1) AND (length(user_id) <= 256)))
);

--
-- Name: guest_pii_mutation_epoch; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.guest_pii_mutation_epoch (
    id integer NOT NULL,
    revision bigint NOT NULL,
    CONSTRAINT guest_pii_mutation_epoch_id_check CHECK ((id = 1)),
    CONSTRAINT guest_pii_mutation_epoch_revision_check CHECK (((revision >= 0) AND (revision <= '9007199254740991'::bigint)))
);

--
-- Name: guest_upgrade_operations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.guest_upgrade_operations (
    operation_id text NOT NULL,
    tenant_id text NOT NULL,
    user_id text NOT NULL,
    client_id text NOT NULL,
    initiating_session_id text NOT NULL,
    request_token_hash text NOT NULL,
    method text NOT NULL,
    state text DEFAULT 'awaiting_proof'::text NOT NULL,
    proof_payload_json text,
    challenge_verifier text,
    reservation_publication_json text,
    attempt_count bigint DEFAULT 0 NOT NULL,
    expires_at bigint NOT NULL,
    lease_owner text,
    lease_expires_at bigint,
    completed_at bigint,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    CONSTRAINT guest_upgrade_operations_attempt_count_check CHECK (((attempt_count >= 0) AND (attempt_count <= 5))),
    CONSTRAINT guest_upgrade_operations_check CHECK ((expires_at > created_at)),
    CONSTRAINT guest_upgrade_operations_method_check CHECK ((method = ANY (ARRAY['email'::text, 'passkey'::text]))),
    CONSTRAINT guest_upgrade_operations_state_check CHECK ((state = ANY (ARRAY['awaiting_proof'::text, 'verified'::text, 'committing'::text, 'completed'::text, 'canceled'::text])))
);

--
-- Name: identity_sensitive_values; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.identity_sensitive_values (
    id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    owner_type text NOT NULL,
    owner_id text NOT NULL,
    value_key text NOT NULL,
    value_json jsonb,
    value_hash text,
    classification text DEFAULT 'sensitive'::text NOT NULL,
    lifecycle_state text DEFAULT 'active'::text NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL
);

--
-- Name: linked_identities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.linked_identities (
    id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    user_id text NOT NULL,
    provider_id text NOT NULL,
    provider_user_id text NOT NULL,
    provider_email text,
    provider_name text,
    raw_attributes jsonb,
    linked_at bigint NOT NULL,
    last_used_at bigint,
    email_verified boolean DEFAULT false NOT NULL,
    access_token_encrypted text,
    refresh_token_encrypted text,
    token_expires_at bigint,
    raw_claims jsonb,
    profile_data jsonb,
    last_login_at bigint,
    updated_at bigint,
    provisioning_state text DEFAULT 'active'::text NOT NULL,
    CONSTRAINT linked_identities_provisioning_state_check CHECK ((provisioning_state = ANY (ARRAY['pending'::text, 'active'::text])))
);

--
-- Name: pairwise_subject_identifiers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pairwise_subject_identifiers (
    id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    user_id text NOT NULL,
    client_id text NOT NULL,
    sector_identifier text NOT NULL,
    subject text NOT NULL,
    created_at bigint NOT NULL
);

--
-- Name: pii_log_purge_operations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pii_log_purge_operations (
    id text NOT NULL,
    tenant_id text NOT NULL,
    user_id text NOT NULL,
    old_anonymized_user_id text NOT NULL,
    new_anonymized_user_id text,
    created_at bigint NOT NULL
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
-- Name: service_group_inputs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.service_group_inputs (
    tenant_id text NOT NULL,
    user_id text NOT NULL,
    revision bigint DEFAULT 1 NOT NULL
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
-- Name: subject_identifiers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subject_identifiers (
    id text NOT NULL,
    tenant_id text NOT NULL,
    subject_id text NOT NULL,
    identifier_type text NOT NULL,
    identifier_value text NOT NULL,
    is_primary boolean DEFAULT false NOT NULL,
    verified_at bigint,
    verification_method text,
    destination_type text DEFAULT 'global'::text NOT NULL,
    destination_id text DEFAULT 'default'::text NOT NULL,
    identifier_value_hash text,
    identifier_storage_ref text,
    lifecycle_state text DEFAULT 'active'::text NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL
);

--
-- Name: totp_backup_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.totp_backup_codes (
    id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    user_id text NOT NULL,
    credential_id text,
    code_hash text NOT NULL,
    code_prefix text NOT NULL,
    created_at bigint NOT NULL,
    used_at bigint
);

--
-- Name: totp_credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.totp_credentials (
    id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    user_id text NOT NULL,
    secret_encrypted text NOT NULL,
    secret_key_version bigint DEFAULT 1 NOT NULL,
    label text,
    algorithm text DEFAULT 'SHA1'::text NOT NULL,
    digits bigint DEFAULT 6 NOT NULL,
    period bigint DEFAULT 30 NOT NULL,
    "window" bigint DEFAULT 1 NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    last_used_time_step bigint,
    created_at bigint NOT NULL,
    activated_at bigint,
    last_used_at bigint,
    CONSTRAINT totp_credentials_algorithm_check CHECK ((algorithm = ANY (ARRAY['SHA1'::text, 'SHA256'::text]))),
    CONSTRAINT totp_credentials_digits_check CHECK ((digits = ANY (ARRAY[(6)::bigint, (8)::bigint]))),
    CONSTRAINT totp_credentials_period_check CHECK (((period >= 15) AND (period <= 300))),
    CONSTRAINT totp_credentials_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'active'::text, 'disabled'::text]))),
    CONSTRAINT totp_credentials_window_check CHECK ((("window" >= 0) AND ("window" <= 2)))
);

--
-- Name: users_pii; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users_pii (
    id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    pii_class text DEFAULT 'PROFILE'::text NOT NULL,
    email text NOT NULL,
    email_blind_index text,
    phone_number text,
    name text,
    given_name text,
    family_name text,
    middle_name text,
    nickname text,
    preferred_username text,
    profile text,
    picture text,
    website text,
    gender text,
    birthdate text,
    locale text,
    zoneinfo text,
    address_formatted text,
    address_street_address text,
    address_locality text,
    address_region text,
    address_postal_code text,
    address_country text,
    declared_residence text,
    custom_attributes_json jsonb,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL
);

--
-- Name: users_pii_tombstone; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users_pii_tombstone (
    id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    email_blind_index text,
    deleted_at bigint NOT NULL,
    deleted_by text,
    deletion_reason text,
    retention_until bigint NOT NULL,
    deletion_metadata jsonb,
    created_at bigint,
    updated_at bigint
);

--
-- Data for Name: account_webhook_delivery_fields; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: account_webhook_outbox; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: account_webhook_snapshots; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: audit_log_pii; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: guest_pii_erasure_markers; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: guest_pii_mutation_epoch; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.guest_pii_mutation_epoch VALUES (1, 0);

--
-- Data for Name: guest_upgrade_operations; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: identity_sensitive_values; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: linked_identities; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: pairwise_subject_identifiers; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: pii_log_purge_operations; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: schema_migrations; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: service_group_inputs; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: service_group_write_boundaries; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: subject_identifiers; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: totp_backup_codes; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: totp_credentials; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: users_pii; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: users_pii_tombstone; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Name: account_webhook_delivery_fields account_webhook_delivery_fields_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_webhook_delivery_fields
    ADD CONSTRAINT account_webhook_delivery_fields_pkey PRIMARY KEY (tenant_id, event_id, webhook_id);

--
-- Name: account_webhook_outbox account_webhook_outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_webhook_outbox
    ADD CONSTRAINT account_webhook_outbox_pkey PRIMARY KEY (id);

--
-- Name: account_webhook_snapshots account_webhook_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_webhook_snapshots
    ADD CONSTRAINT account_webhook_snapshots_pkey PRIMARY KEY (id);

--
-- Name: audit_log_pii audit_log_pii_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log_pii
    ADD CONSTRAINT audit_log_pii_pkey PRIMARY KEY (id);

--
-- Name: guest_pii_erasure_markers guest_pii_erasure_markers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guest_pii_erasure_markers
    ADD CONSTRAINT guest_pii_erasure_markers_pkey PRIMARY KEY (tenant_id, user_id);

--
-- Name: guest_pii_erasure_markers guest_pii_erasure_markers_tenant_id_account_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guest_pii_erasure_markers
    ADD CONSTRAINT guest_pii_erasure_markers_tenant_id_account_id_key UNIQUE (tenant_id, account_id);

--
-- Name: guest_pii_mutation_epoch guest_pii_mutation_epoch_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guest_pii_mutation_epoch
    ADD CONSTRAINT guest_pii_mutation_epoch_pkey PRIMARY KEY (id);

--
-- Name: guest_upgrade_operations guest_upgrade_operations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guest_upgrade_operations
    ADD CONSTRAINT guest_upgrade_operations_pkey PRIMARY KEY (operation_id);

--
-- Name: identity_sensitive_values identity_sensitive_values_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_sensitive_values
    ADD CONSTRAINT identity_sensitive_values_pkey PRIMARY KEY (id);

--
-- Name: identity_sensitive_values identity_sensitive_values_unique_owner_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_sensitive_values
    ADD CONSTRAINT identity_sensitive_values_unique_owner_key UNIQUE (tenant_id, owner_type, owner_id, value_key);

--
-- Name: linked_identities linked_identities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.linked_identities
    ADD CONSTRAINT linked_identities_pkey PRIMARY KEY (id);

--
-- Name: linked_identities linked_identities_unique_provider; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.linked_identities
    ADD CONSTRAINT linked_identities_unique_provider UNIQUE (tenant_id, provider_id, provider_user_id);

--
-- Name: pairwise_subject_identifiers pairwise_subject_identifiers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pairwise_subject_identifiers
    ADD CONSTRAINT pairwise_subject_identifiers_pkey PRIMARY KEY (id);

--
-- Name: pairwise_subject_identifiers pairwise_subject_identifiers_unique_sector; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pairwise_subject_identifiers
    ADD CONSTRAINT pairwise_subject_identifiers_unique_sector UNIQUE (tenant_id, user_id, sector_identifier);

--
-- Name: pii_log_purge_operations pii_log_purge_operations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pii_log_purge_operations
    ADD CONSTRAINT pii_log_purge_operations_pkey PRIMARY KEY (id);

--
-- Name: pii_log_purge_operations pii_log_purge_operations_tenant_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pii_log_purge_operations
    ADD CONSTRAINT pii_log_purge_operations_tenant_id_user_id_key UNIQUE (tenant_id, user_id);

--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);

--
-- Name: service_group_inputs service_group_inputs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_group_inputs
    ADD CONSTRAINT service_group_inputs_pkey PRIMARY KEY (tenant_id, user_id);

--
-- Name: service_group_write_boundaries service_group_write_boundaries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_group_write_boundaries
    ADD CONSTRAINT service_group_write_boundaries_pkey PRIMARY KEY (id);

--
-- Name: subject_identifiers subject_identifiers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subject_identifiers
    ADD CONSTRAINT subject_identifiers_pkey PRIMARY KEY (id);

--
-- Name: subject_identifiers subject_identifiers_unique_value; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subject_identifiers
    ADD CONSTRAINT subject_identifiers_unique_value UNIQUE (tenant_id, identifier_type, identifier_value);

--
-- Name: totp_backup_codes totp_backup_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.totp_backup_codes
    ADD CONSTRAINT totp_backup_codes_pkey PRIMARY KEY (id);

--
-- Name: totp_backup_codes totp_backup_codes_tenant_id_user_id_code_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.totp_backup_codes
    ADD CONSTRAINT totp_backup_codes_tenant_id_user_id_code_hash_key UNIQUE (tenant_id, user_id, code_hash);

--
-- Name: totp_credentials totp_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.totp_credentials
    ADD CONSTRAINT totp_credentials_pkey PRIMARY KEY (id);

--
-- Name: users_pii users_pii_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users_pii
    ADD CONSTRAINT users_pii_pkey PRIMARY KEY (id);

--
-- Name: users_pii_tombstone users_pii_tombstone_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users_pii_tombstone
    ADD CONSTRAINT users_pii_tombstone_pkey PRIMARY KEY (id);

--
-- Name: idx_account_webhook_outbox_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_account_webhook_outbox_due ON public.account_webhook_outbox USING btree (tenant_id, delivered_at, next_attempt_at, lease_until);

--
-- Name: idx_account_webhook_snapshot_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_account_webhook_snapshot_expiry ON public.account_webhook_snapshots USING btree (tenant_id, expires_at);

--
-- Name: idx_audit_pii_action; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_pii_action ON public.audit_log_pii USING btree (tenant_id, action);

--
-- Name: idx_audit_pii_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_pii_created ON public.audit_log_pii USING btree (tenant_id, created_at DESC);

--
-- Name: idx_audit_pii_exported; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_pii_exported ON public.audit_log_pii USING btree (tenant_id, exported_at);

--
-- Name: idx_audit_pii_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_pii_target ON public.audit_log_pii USING btree (tenant_id, target_user_id);

--
-- Name: idx_audit_pii_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_pii_user ON public.audit_log_pii USING btree (tenant_id, user_id);

--
-- Name: idx_guest_pii_linked_drain; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_guest_pii_linked_drain ON public.linked_identities USING btree (tenant_id, user_id, id);

--
-- Name: idx_guest_pii_pairwise_drain; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_guest_pii_pairwise_drain ON public.pairwise_subject_identifiers USING btree (tenant_id, user_id, id);

--
-- Name: idx_guest_pii_sensitive_drain; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_guest_pii_sensitive_drain ON public.identity_sensitive_values USING btree (tenant_id, owner_type, owner_id, id);

--
-- Name: idx_guest_pii_subject_drain; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_guest_pii_subject_drain ON public.subject_identifiers USING btree (tenant_id, subject_id, id);

--
-- Name: idx_guest_pii_upgrade_drain; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_guest_pii_upgrade_drain ON public.guest_upgrade_operations USING btree (tenant_id, user_id, operation_id);

--
-- Name: idx_guest_upgrade_operations_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_guest_upgrade_operations_account ON public.guest_upgrade_operations USING btree (tenant_id, user_id, created_at);

--
-- Name: idx_guest_upgrade_operations_recovery; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_guest_upgrade_operations_recovery ON public.guest_upgrade_operations USING btree (tenant_id, state, lease_expires_at, updated_at);

--
-- Name: idx_identity_sensitive_values_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_identity_sensitive_values_hash ON public.identity_sensitive_values USING btree (tenant_id, value_key, value_hash, lifecycle_state);

--
-- Name: idx_identity_sensitive_values_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_identity_sensitive_values_owner ON public.identity_sensitive_values USING btree (tenant_id, owner_type, owner_id, value_key, lifecycle_state);

--
-- Name: idx_linked_identities_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_linked_identities_email ON public.linked_identities USING btree (tenant_id, provider_email);

--
-- Name: idx_linked_identities_provider_sub; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_linked_identities_provider_sub ON public.linked_identities USING btree (tenant_id, provider_id, provider_user_id);

--
-- Name: idx_linked_identities_provisioning; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_linked_identities_provisioning ON public.linked_identities USING btree (tenant_id, provider_id, provider_user_id, provisioning_state);

--
-- Name: idx_linked_identities_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_linked_identities_user ON public.linked_identities USING btree (tenant_id, user_id);

--
-- Name: idx_pairwise_subject_identifiers_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pairwise_subject_identifiers_client ON public.pairwise_subject_identifiers USING btree (tenant_id, client_id);

--
-- Name: idx_pairwise_subject_identifiers_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pairwise_subject_identifiers_subject ON public.pairwise_subject_identifiers USING btree (tenant_id, subject);

--
-- Name: idx_pairwise_subject_identifiers_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pairwise_subject_identifiers_user ON public.pairwise_subject_identifiers USING btree (tenant_id, user_id);

--
-- Name: idx_pii_log_purge_operations_tenant_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pii_log_purge_operations_tenant_created ON public.pii_log_purge_operations USING btree (tenant_id, created_at, id);

--
-- Name: idx_service_group_write_boundaries_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_service_group_write_boundaries_subject ON public.service_group_write_boundaries USING btree (tenant_id, user_id);

--
-- Name: idx_subject_identifiers_destination; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subject_identifiers_destination ON public.subject_identifiers USING btree (tenant_id, subject_id, destination_type, lifecycle_state);

--
-- Name: idx_subject_identifiers_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subject_identifiers_hash ON public.subject_identifiers USING btree (tenant_id, identifier_type, identifier_value_hash, lifecycle_state);

--
-- Name: idx_subject_identifiers_primary; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subject_identifiers_primary ON public.subject_identifiers USING btree (tenant_id, subject_id, is_primary);

--
-- Name: idx_subject_identifiers_tenant_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subject_identifiers_tenant_subject ON public.subject_identifiers USING btree (tenant_id, subject_id);

--
-- Name: idx_totp_backup_codes_unused; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_totp_backup_codes_unused ON public.totp_backup_codes USING btree (tenant_id, user_id, used_at);

--
-- Name: idx_totp_backup_codes_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_totp_backup_codes_user ON public.totp_backup_codes USING btree (tenant_id, user_id);

--
-- Name: idx_totp_credentials_active_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_totp_credentials_active_user ON public.totp_credentials USING btree (tenant_id, user_id, status);

--
-- Name: idx_totp_credentials_tenant_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_totp_credentials_tenant_user ON public.totp_credentials USING btree (tenant_id, user_id);

--
-- Name: idx_users_pii_class; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_pii_class ON public.users_pii USING btree (tenant_id, pii_class);

--
-- Name: idx_users_pii_email; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_users_pii_email ON public.users_pii USING btree (tenant_id, email_blind_index);

--
-- Name: idx_users_pii_residence; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_pii_residence ON public.users_pii USING btree (tenant_id, declared_residence);

--
-- Name: idx_users_pii_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_pii_tenant ON public.users_pii USING btree (tenant_id);

--
-- Name: idx_users_pii_tombstone_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_pii_tombstone_email ON public.users_pii_tombstone USING btree (tenant_id, email_blind_index);

--
-- Name: idx_users_pii_tombstone_retention; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_pii_tombstone_retention ON public.users_pii_tombstone USING btree (tenant_id, retention_until);

--
-- Name: idx_users_pii_tombstone_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_pii_tombstone_tenant ON public.users_pii_tombstone USING btree (tenant_id);

--
-- Name: identity_sensitive_values sg_identity_sensitive_values_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sg_identity_sensitive_values_delete AFTER DELETE ON public.identity_sensitive_values FOR EACH ROW EXECUTE FUNCTION public.sg_identity_sensitive_values_delete_fn();

--
-- Name: identity_sensitive_values sg_identity_sensitive_values_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sg_identity_sensitive_values_insert AFTER INSERT ON public.identity_sensitive_values FOR EACH ROW EXECUTE FUNCTION public.sg_identity_sensitive_values_insert_fn();

--
-- Name: identity_sensitive_values sg_identity_sensitive_values_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sg_identity_sensitive_values_update AFTER UPDATE ON public.identity_sensitive_values FOR EACH ROW EXECUTE FUNCTION public.sg_identity_sensitive_values_update_fn();

--
-- Name: service_group_write_boundaries sg_write_boundary_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sg_write_boundary_delete AFTER DELETE ON public.service_group_write_boundaries FOR EACH ROW EXECUTE FUNCTION public.sg_write_boundary_delete_fn();

--
-- Name: service_group_write_boundaries sg_write_boundary_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sg_write_boundary_insert AFTER INSERT ON public.service_group_write_boundaries FOR EACH ROW EXECUTE FUNCTION public.sg_write_boundary_insert_fn();

--
-- Name: guest_pii_mutation_epoch trg_guest_pii_epoch_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_guest_pii_epoch_immutable BEFORE DELETE OR UPDATE ON public.guest_pii_mutation_epoch FOR EACH ROW EXECUTE FUNCTION public.authrim_guest_pii_epoch_guard();

--
-- Name: guest_pii_mutation_epoch trg_guest_pii_epoch_no_replace; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_guest_pii_epoch_no_replace BEFORE INSERT ON public.guest_pii_mutation_epoch FOR EACH ROW EXECUTE FUNCTION public.authrim_guest_pii_epoch_insert_guard();

--
-- Name: guest_upgrade_operations trg_guest_pii_guest_upgrade_operations; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_guest_pii_guest_upgrade_operations BEFORE INSERT OR DELETE OR UPDATE ON public.guest_upgrade_operations FOR EACH ROW EXECUTE FUNCTION public.authrim_guest_pii_source_guard();

--
-- Name: identity_sensitive_values trg_guest_pii_identity_sensitive_values; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_guest_pii_identity_sensitive_values BEFORE INSERT OR DELETE OR UPDATE ON public.identity_sensitive_values FOR EACH ROW EXECUTE FUNCTION public.authrim_guest_pii_source_guard();

--
-- Name: linked_identities trg_guest_pii_linked_identities; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_guest_pii_linked_identities BEFORE INSERT OR DELETE OR UPDATE ON public.linked_identities FOR EACH ROW EXECUTE FUNCTION public.authrim_guest_pii_source_guard();

--
-- Name: guest_pii_erasure_markers trg_guest_pii_marker_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_guest_pii_marker_guard BEFORE INSERT OR DELETE OR UPDATE ON public.guest_pii_erasure_markers FOR EACH ROW EXECUTE FUNCTION public.authrim_guest_pii_marker_guard();

--
-- Name: pairwise_subject_identifiers trg_guest_pii_pairwise_subject_identifiers; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_guest_pii_pairwise_subject_identifiers BEFORE INSERT OR DELETE OR UPDATE ON public.pairwise_subject_identifiers FOR EACH ROW EXECUTE FUNCTION public.authrim_guest_pii_source_guard();

--
-- Name: subject_identifiers trg_guest_pii_subject_identifiers; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_guest_pii_subject_identifiers BEFORE INSERT OR DELETE OR UPDATE ON public.subject_identifiers FOR EACH ROW EXECUTE FUNCTION public.authrim_guest_pii_source_guard();

--
-- Name: users_pii trg_guest_pii_users_pii; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_guest_pii_users_pii BEFORE INSERT OR DELETE OR UPDATE ON public.users_pii FOR EACH ROW EXECUTE FUNCTION public.authrim_guest_pii_source_guard();

--
-- PostgreSQL database dump complete
--
