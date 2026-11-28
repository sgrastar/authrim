-- Migration: 021_check_resource_registry.sql
-- Description: The resource registry of self-contract Check API requests (an end-user access
--              token asks only "may I do <action> on <type>:<id>"; what the resource is, is looked
--              up here, never taken from the request).
--              - check_resource_types: a tenant's settings for one resource type, kept by its
--                administrators (Admin API /api/admin/check-resource-types). relations_json maps
--                an action to the ReBAC relation that grants it on a resource of the type
--                ({"read":"viewer","write":"editor"}); an action it does not name has no relation.
--              - check_resources: what the tenant's application server has registered about one
--                resource (Check API /api/check/resources, with a chk_ key allowed the
--                `resources` operation): its owner, its group and its attributes (a JSON object,
--                at most 8 KiB). owner_id and group_id are the server's claim: their existence
--                is not checked. A row is replaced whole on every write.
--              check_resource_types.row_token is a random id given when the row is inserted (a
--              row deleted and inserted again gets another); revision counts the writes of the
--              row. An Admin API write is conditional on both as it read them, after the change
--              has been recorded in the admin audit log. created_at and updated_at are
--              UNIX milliseconds.
--              The primary keys cover every lookup (one resource, or one tenant's resources of
--              one type in id order). Holds no personal data beyond the ids and attributes the
--              application chooses to register.
-- Author: @authrim
-- Date: 2026-11-28

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

CREATE TABLE check_resource_types (
  tenant_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  relations_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(relations_json)),
  row_token TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, resource_type)
);

CREATE TABLE check_resources (
  tenant_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  owner_id TEXT,
  group_id TEXT,
  attributes_json TEXT CHECK (attributes_json IS NULL OR json_valid(attributes_json)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, resource_type, resource_id)
);
