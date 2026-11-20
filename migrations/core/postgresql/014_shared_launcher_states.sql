-- Migration: 014_shared_launcher_states.sql
-- Description: A tenant's own state of each platform launcher shared with it (see the D1
--              migration of the same name for the columns).
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
  copy_json TEXT,
  copy_from_version BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, launcher_id),
  CHECK ((copy_json IS NULL) = (copy_from_version IS NULL))
);
