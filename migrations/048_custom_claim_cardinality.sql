-- Add explicit cardinality to custom claim schemas.
-- Existing fields remain single-valued; multi-valued values are stored as JSON arrays.
ALTER TABLE custom_claim_schemas
  ADD COLUMN cardinality TEXT NOT NULL DEFAULT 'single'
  CHECK (cardinality IN ('single', 'multi'));
