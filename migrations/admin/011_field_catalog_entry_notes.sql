-- Add operator-facing notes for identity schema catalog entries.
-- Examples are already stored separately in examples_json.

ALTER TABLE field_catalog_entries
  ADD COLUMN note TEXT;
