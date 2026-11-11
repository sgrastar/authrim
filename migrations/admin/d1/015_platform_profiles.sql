-- Migration: 015_platform_profiles.sql
-- Description: Authentication method and session profiles the platform defines for every tenant,
--              and the tenant's own changes to them.
--              - platform_authentication_method_profiles / platform_session_profiles: the
--                platform's profiles (environment data, not any tenant's). `locked`: usable but
--                not changed by tenants (their changes are then set aside). `state`: 'deleting'
--                while one delete operation (`state_token`) checks that no tenant uses it (no new
--                reference is taken meanwhile); 'deleted' once it found none. A deleted profile
--                keeps its row: it is no longer listed nor named anew, but a Flow that came to
--                name it in a race still reads it rather than losing its profile.
--              - authentication_method_profiles / session_profiles gain base_profile_id and
--                base_version: a row with a base is a tenant's change to that platform profile (a
--                full copy made then, base_version the platform version it was copied from). It
--                is only ever reached through the platform profile's id; its own id is never a
--                profile of the tenant. Names and the per-tenant limit count only the tenant's own
--                profiles (no base).
-- Author: @authrim
-- Date: 2026-11-11
-- Issue: Platform profiles (PR3a)

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

CREATE TABLE platform_authentication_method_profiles (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  name_key TEXT NOT NULL,
  values_json TEXT NOT NULL CHECK (json_valid(values_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'deleting', 'deleted')),
  state_token TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_platform_auth_method_profiles_name
  ON platform_authentication_method_profiles(name_key) WHERE state <> 'deleted';

CREATE TABLE platform_session_profiles (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  name_key TEXT NOT NULL,
  values_json TEXT NOT NULL CHECK (json_valid(values_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'deleting', 'deleted')),
  state_token TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_platform_session_profiles_name
  ON platform_session_profiles(name_key) WHERE state <> 'deleted';

ALTER TABLE authentication_method_profiles ADD COLUMN base_profile_id TEXT;
ALTER TABLE authentication_method_profiles ADD COLUMN base_version INTEGER;
DROP INDEX idx_auth_method_profiles_tenant_name;
CREATE UNIQUE INDEX idx_auth_method_profiles_tenant_name
  ON authentication_method_profiles(tenant_id, name_key) WHERE base_profile_id IS NULL;
CREATE UNIQUE INDEX idx_auth_method_profiles_tenant_base
  ON authentication_method_profiles(tenant_id, base_profile_id) WHERE base_profile_id IS NOT NULL;

ALTER TABLE session_profiles ADD COLUMN base_profile_id TEXT;
ALTER TABLE session_profiles ADD COLUMN base_version INTEGER;
DROP INDEX idx_session_profiles_tenant_name;
CREATE UNIQUE INDEX idx_session_profiles_tenant_name
  ON session_profiles(tenant_id, name_key) WHERE base_profile_id IS NULL;
CREATE UNIQUE INDEX idx_session_profiles_tenant_base
  ON session_profiles(tenant_id, base_profile_id) WHERE base_profile_id IS NOT NULL;
