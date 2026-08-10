-- Keep the built-in registration screen aligned with the registration field schema.
-- Email is optional by default so Passkey registration can work without an email
-- address. An administrator can still make it required through the field schema.

UPDATE screens
SET fields_json = (
  SELECT json_group_array(
    json(
      CASE
        WHEN json_extract(field.value, '$.field') IN ('email', 'field.canonical.email')
             AND COALESCE(json_extract(field.value, '$.block_type'), 'identity_field') = 'identity_field'
        THEN json_set(field.value, '$.required', json('false'))
        ELSE field.value
      END
    )
  )
  FROM json_each(screens.fields_json) AS field
)
WHERE screens.screen_key = 'registration'
  AND screens.is_system = 1
  AND EXISTS (
    SELECT 1
    FROM custom_claim_schemas AS schema
    WHERE schema.tenant_id = screens.tenant_id
      AND schema.field_key IN ('email', 'field.canonical.email')
      AND schema.is_active = 1
      AND schema.registration_required = 0
  )
  AND EXISTS (
    SELECT 1
    FROM json_each(screens.fields_json) AS field
    WHERE json_extract(field.value, '$.field') IN ('email', 'field.canonical.email')
      AND COALESCE(json_extract(field.value, '$.block_type'), 'identity_field') = 'identity_field'
      AND json_extract(field.value, '$.required') = 1
  );
