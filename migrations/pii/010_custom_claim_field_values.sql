-- Materialize PII custom attributes as field-level sensitive values so runtime
-- mappings can retrieve only the fields they reference. Keep the aggregate
-- custom_attributes_json row for compatibility with existing account readers.
INSERT INTO identity_sensitive_values (
  id,
  tenant_id,
  owner_type,
  owner_id,
  value_key,
  value_json,
  value_hash,
  classification,
  lifecycle_state,
  created_at,
  updated_at
)
SELECT
  source.id || ':field:' || attribute.key,
  source.tenant_id,
  source.owner_type,
  source.owner_id,
  'custom_attribute:' || attribute.key,
  CASE attribute.type
    WHEN 'text' THEN json_quote(attribute.value)
    WHEN 'true' THEN 'true'
    WHEN 'false' THEN 'false'
    WHEN 'null' THEN 'null'
    ELSE CAST(attribute.value AS TEXT)
  END,
  NULL,
  source.classification,
  source.lifecycle_state,
  source.created_at,
  source.updated_at
FROM identity_sensitive_values AS source,
     json_each(
       CASE
         WHEN json_valid(source.value_json) AND json_type(source.value_json) = 'object'
           THEN source.value_json
         ELSE '{}'
       END
     ) AS attribute
WHERE source.owner_type = 'runtime_user'
  AND source.value_key = 'custom_attributes_json'
  AND source.lifecycle_state = 'active'
ON CONFLICT(tenant_id, owner_type, owner_id, value_key) DO NOTHING;
