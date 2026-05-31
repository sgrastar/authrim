-- Add UI grouping and examples for field catalog entries.
-- These fields are metadata only; mapping edges still target individual catalog entries.

ALTER TABLE field_catalog_entries
  ADD COLUMN ui_group_key TEXT;

ALTER TABLE field_catalog_entries
  ADD COLUMN ui_group_label TEXT;

ALTER TABLE field_catalog_entries
  ADD COLUMN ui_group_order INTEGER NOT NULL DEFAULT 0;

ALTER TABLE field_catalog_entries
  ADD COLUMN ui_field_order INTEGER NOT NULL DEFAULT 0;

ALTER TABLE field_catalog_entries
  ADD COLUMN examples_json TEXT;

