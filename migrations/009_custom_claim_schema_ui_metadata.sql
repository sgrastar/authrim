-- =============================================================================
-- Authrim Core: Custom Claim Schema UI Metadata
-- =============================================================================
-- Adds persistent grouping metadata for the Custom Claims schema table.
-- The Admin UI uses this to render OIDC/system/custom virtual fields with the
-- same group semantics as the Identity Mapping canonical catalog.

ALTER TABLE custom_claim_schemas
  ADD COLUMN ui_group_key TEXT;

ALTER TABLE custom_claim_schemas
  ADD COLUMN ui_group_label TEXT;

ALTER TABLE custom_claim_schemas
  ADD COLUMN ui_group_order INTEGER NOT NULL DEFAULT 0;

ALTER TABLE custom_claim_schemas
  ADD COLUMN ui_field_order INTEGER NOT NULL DEFAULT 0;

ALTER TABLE custom_claim_schemas
  ADD COLUMN examples_json TEXT CHECK(examples_json IS NULL OR json_valid(examples_json));
