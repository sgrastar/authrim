-- Migration: Add selectable icon name for external IdP login buttons

ALTER TABLE upstream_providers ADD COLUMN icon_name TEXT;
