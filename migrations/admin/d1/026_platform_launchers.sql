-- Migration: 026_platform_launchers.sql
-- Description: Application launchers the platform defines and shares with tenants.
--              - platform_launchers: the platform's launchers (environment data, not any
--                tenant's). `config_json` is the launcher itself (a plain link shown to everyone:
--                it names no tenant's application, user or group). `share_mode`: 'none' (not
--                shared yet), 'all' (every tenant) or 'selected' (the tenants in
--                platform_launcher_tenants). `tenant_change_allowed` off: tenants may neither
--                change nor hide it (a copy a tenant made earlier is kept, set aside). `version`
--                counts every change of the launcher itself (a move in the platform's
--                order, `sort_order`, is not one: tenants' copies are not of their place);
--                `write_token` is the last change's, so the rows a change
--                writes beside it are written only by the change that won.
--              - platform_launcher_tenants: the tenants a 'selected' launcher is shared with.
--              A tenant's own state of a shared launcher (its copy, whether it hides it, its place
--              in the order) is the tenant's: core shared_launcher_states (core migration 014).
-- Author: @authrim
-- Date: 2026-11-21
-- Issue: Platform launchers

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

CREATE TABLE platform_launchers (
  id TEXT PRIMARY KEY NOT NULL,
  config_json TEXT NOT NULL CHECK (json_valid(config_json)),
  share_mode TEXT NOT NULL DEFAULT 'none' CHECK (share_mode IN ('none', 'all', 'selected')),
  tenant_change_allowed INTEGER NOT NULL DEFAULT 1 CHECK (tenant_change_allowed IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 1000000),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  write_token TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE platform_launcher_tenants (
  launcher_id TEXT NOT NULL REFERENCES platform_launchers(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  PRIMARY KEY (launcher_id, tenant_id)
);
CREATE INDEX idx_platform_launcher_tenants_tenant
  ON platform_launcher_tenants(tenant_id, launcher_id);
