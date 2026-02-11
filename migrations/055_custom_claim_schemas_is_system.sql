-- Add is_system flag to custom_claim_schemas
-- System claims cannot be deleted, renamed, or have field_key/field_type/is_pii changed
-- Pattern reference: roles.is_system (037_roles_schema_extension.sql)

ALTER TABLE custom_claim_schemas ADD COLUMN is_system INTEGER NOT NULL DEFAULT 0;
