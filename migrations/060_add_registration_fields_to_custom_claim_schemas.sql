-- Migration 060: Add registration form fields to custom_claim_schemas
-- Enables per-tenant custom registration form with dynamic field rendering

ALTER TABLE custom_claim_schemas
  ADD COLUMN show_on_registration    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE custom_claim_schemas
  ADD COLUMN registration_required   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE custom_claim_schemas
  ADD COLUMN registration_order      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE custom_claim_schemas
  ADD COLUMN registration_placeholder TEXT;
