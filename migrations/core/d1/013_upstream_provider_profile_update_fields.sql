-- The profile fields a login from this OIDC provider updates (a JSON array of standard profile
-- claim names), overriding the tenant's external_idp.jit_update_fields. NULL follows the tenant;
-- an empty array updates none. The admin API validates the field names.
ALTER TABLE upstream_providers ADD COLUMN profile_update_fields TEXT
  CHECK (
    profile_update_fields IS NULL OR (
      json_valid(profile_update_fields)
      AND json_type(profile_update_fields) = 'array'
    )
  );
