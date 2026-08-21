-- Authrim 0.4.0 pre-1.0 semantic fresh-install baseline.
-- Logical stream: external-postgres-pii.
-- Generated from the final database state; do not append historical migration SQL here.
-- Pre-1.0 databases are not upgrade-compatible and must be recreated.
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

SET default_tablespace = '';

SET default_table_access_method = heap;

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
-- Name: subject_identifiers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subject_identifiers (
    id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    user_id text NOT NULL,
    client_id text NOT NULL,
    sector_identifier text NOT NULL,
    subject text NOT NULL,
    created_at bigint NOT NULL
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
-- Data for Name: audit_log_pii; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: identity_sensitive_values; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: linked_identities; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: schema_migrations; Type: TABLE DATA; Schema: public; Owner: -
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
-- Name: audit_log_pii audit_log_pii_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log_pii
    ADD CONSTRAINT audit_log_pii_pkey PRIMARY KEY (id);

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
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);

--
-- Name: subject_identifiers subject_identifiers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subject_identifiers
    ADD CONSTRAINT subject_identifiers_pkey PRIMARY KEY (id);

--
-- Name: subject_identifiers subject_identifiers_unique_sector; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subject_identifiers
    ADD CONSTRAINT subject_identifiers_unique_sector UNIQUE (tenant_id, user_id, sector_identifier);

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
-- Name: idx_subject_identifiers_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subject_identifiers_client ON public.subject_identifiers USING btree (tenant_id, client_id);

--
-- Name: idx_subject_identifiers_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subject_identifiers_subject ON public.subject_identifiers USING btree (tenant_id, subject);

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
-- PostgreSQL database dump complete
--
