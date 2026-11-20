-- Migration: 014_shared_launcher_states.sql
-- Description: A tenant's own state of each platform launcher shared with it (the platform's
--              launchers are admin migration 026). One row per tenant and platform launcher, made
--              when the tenant first hides, moves or changes it; the columns are written apart,
--              so a move does not undo a change made meanwhile.
--              - hidden: the tenant does not show it (used only while the platform allows tenants
--                to change it).
--              - sort_order: the tenant's place for it among its launchers (NULL: the platform's).
--              - copy_json: the tenant's copy of the launcher, a launcher's configuration as
--                application_launchers stores one (NULL: the platform's is shown). It is kept but
--                not used while the platform does not allow changes.
--              - copy_from_version: the platform launcher's version the copy was made from.
--              A row whose platform launcher is gone or no longer shared is not read.
-- Author: @authrim
-- Date: 2026-11-21

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

CREATE TABLE shared_launcher_states (
  tenant_id TEXT NOT NULL,
  launcher_id TEXT NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  sort_order INTEGER CHECK (sort_order IS NULL OR sort_order BETWEEN 0 AND 1000000),
  copy_json TEXT CHECK (copy_json IS NULL OR json_valid(copy_json)),
  copy_from_version INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, launcher_id),
  CHECK ((copy_json IS NULL) = (copy_from_version IS NULL))
);
