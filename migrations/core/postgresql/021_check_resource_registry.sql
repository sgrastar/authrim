-- Migration: 021_check_resource_registry.sql
-- Description: The resource registry of self-contract Check API requests (see the D1 migration
--              of the same name for the tables and columns; times are UNIX milliseconds).
-- Author: @authrim
-- Date: 2026-11-28

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

CREATE TABLE check_resource_types (
  tenant_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  relations_json TEXT NOT NULL DEFAULT '{}',
  row_token TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, resource_type)
);

CREATE TABLE check_resources (
  tenant_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  owner_id TEXT,
  group_id TEXT,
  attributes_json TEXT,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, resource_type, resource_id)
);
