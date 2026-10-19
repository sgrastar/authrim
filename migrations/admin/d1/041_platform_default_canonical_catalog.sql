-- Migration: 041_platform_default_canonical_catalog.sql
-- Description: The standard canonical field catalog owned by the platform namespace
--   (tenant_id = 'platform'), which the Mapping Sets every tenant shares are compiled against.
--   The platform ID is reserved (no tenant can hold it) and these rows have no foreign key to
--   `tenants`. The IDs differ from the tenant catalog's (`system_*`) because a catalog, a catalog
--   version and an entry are keyed by ID alone. The fields mirror
--   DEFAULT_CANONICAL_CATALOG_ENTRIES in packages/setup/src/core/cloudflare.ts; a test applies this
--   file to SQLite and requires the rows to equal that definition.
--   Every statement inserts only what is missing, so a row an operator already holds is left as it is.
-- Date: 2026-10-19

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

INSERT INTO field_catalogs (
  id, tenant_id, catalog_key, display_name, lifecycle_state, created_at, updated_at
)
SELECT 'platform_default_canonical_catalog', 'platform', 'authrim.platform_default_canonical', 'Authrim Platform Default Canonical Catalog',
       'active', __AUTHRIM_NOW_EPOCH_MILLISECONDS__, __AUTHRIM_NOW_EPOCH_MILLISECONDS__
WHERE NOT EXISTS (
  SELECT 1 FROM field_catalogs
  WHERE tenant_id = 'platform'
    AND catalog_key = 'authrim.platform_default_canonical'
);

INSERT INTO field_catalog_versions (
  id, tenant_id, catalog_id, version_label, bundle_hash, compatibility_range,
  lifecycle_state, created_at, updated_at
)
SELECT 'platform_default_canonical_catalog_v1', 'platform', c.id, '2026-05-30',
       '0000000000000000000000000000000000000000000000000000000000000001', '*', 'active', __AUTHRIM_NOW_EPOCH_MILLISECONDS__, __AUTHRIM_NOW_EPOCH_MILLISECONDS__
FROM field_catalogs c
WHERE c.tenant_id = 'platform'
  AND c.catalog_key = 'authrim.platform_default_canonical'
  AND NOT EXISTS (
    SELECT 1 FROM field_catalog_versions
    WHERE tenant_id = 'platform'
      AND id = 'platform_default_canonical_catalog_v1'
  );

INSERT INTO field_catalog_entries (
  id, tenant_id, catalog_version_id, stable_field_id, namespace, path, target_taxonomy,
  value_type, cardinality, classification, aliases_json, validation_json,
  ui_group_key, ui_group_label, ui_group_order, ui_field_order, examples_json,
  created_at, updated_at
)
SELECT 'platform_canonical_name', 'platform', 'platform_default_canonical_catalog_v1', 'field.canonical.name', 'authrim.canonical', 'name',
       'canonical', 'string', 'single', 'pii', '[]',
       '{}', 'name', 'Name', 10, 10,
       '["John Doe","山田 太郎","김민준"]', __AUTHRIM_NOW_EPOCH_MILLISECONDS__, __AUTHRIM_NOW_EPOCH_MILLISECONDS__
WHERE NOT EXISTS (
  SELECT 1 FROM field_catalog_entries
  WHERE tenant_id = 'platform'
    AND catalog_version_id = 'platform_default_canonical_catalog_v1'
    AND stable_field_id = 'field.canonical.name'
);

INSERT INTO field_catalog_entries (
  id, tenant_id, catalog_version_id, stable_field_id, namespace, path, target_taxonomy,
  value_type, cardinality, classification, aliases_json, validation_json,
  ui_group_key, ui_group_label, ui_group_order, ui_field_order, examples_json,
  created_at, updated_at
)
SELECT 'platform_canonical_given_name', 'platform', 'platform_default_canonical_catalog_v1', 'field.canonical.given_name', 'authrim.canonical', 'given_name',
       'canonical', 'string', 'single', 'pii', '[]',
       '{}', 'name', 'Name', 10, 20,
       '["John","太郎","민준"]', __AUTHRIM_NOW_EPOCH_MILLISECONDS__, __AUTHRIM_NOW_EPOCH_MILLISECONDS__
WHERE NOT EXISTS (
  SELECT 1 FROM field_catalog_entries
  WHERE tenant_id = 'platform'
    AND catalog_version_id = 'platform_default_canonical_catalog_v1'
    AND stable_field_id = 'field.canonical.given_name'
);

INSERT INTO field_catalog_entries (
  id, tenant_id, catalog_version_id, stable_field_id, namespace, path, target_taxonomy,
  value_type, cardinality, classification, aliases_json, validation_json,
  ui_group_key, ui_group_label, ui_group_order, ui_field_order, examples_json,
  created_at, updated_at
)
SELECT 'platform_canonical_family_name', 'platform', 'platform_default_canonical_catalog_v1', 'field.canonical.family_name', 'authrim.canonical', 'family_name',
       'canonical', 'string', 'single', 'pii', '[]',
       '{}', 'name', 'Name', 10, 30,
       '["Doe","山田","김"]', __AUTHRIM_NOW_EPOCH_MILLISECONDS__, __AUTHRIM_NOW_EPOCH_MILLISECONDS__
WHERE NOT EXISTS (
  SELECT 1 FROM field_catalog_entries
  WHERE tenant_id = 'platform'
    AND catalog_version_id = 'platform_default_canonical_catalog_v1'
    AND stable_field_id = 'field.canonical.family_name'
);

INSERT INTO field_catalog_entries (
  id, tenant_id, catalog_version_id, stable_field_id, namespace, path, target_taxonomy,
  value_type, cardinality, classification, aliases_json, validation_json,
  ui_group_key, ui_group_label, ui_group_order, ui_field_order, examples_json,
  created_at, updated_at
)
SELECT 'platform_canonical_middle_name', 'platform', 'platform_default_canonical_catalog_v1', 'field.canonical.middle_name', 'authrim.canonical', 'middle_name',
       'canonical', 'string', 'single', 'pii', '[]',
       '{}', 'name', 'Name', 10, 40,
       '["Quincy"]', __AUTHRIM_NOW_EPOCH_MILLISECONDS__, __AUTHRIM_NOW_EPOCH_MILLISECONDS__
WHERE NOT EXISTS (
  SELECT 1 FROM field_catalog_entries
  WHERE tenant_id = 'platform'
    AND catalog_version_id = 'platform_default_canonical_catalog_v1'
    AND stable_field_id = 'field.canonical.middle_name'
);

INSERT INTO field_catalog_entries (
  id, tenant_id, catalog_version_id, stable_field_id, namespace, path, target_taxonomy,
  value_type, cardinality, classification, aliases_json, validation_json,
  ui_group_key, ui_group_label, ui_group_order, ui_field_order, examples_json,
  created_at, updated_at
)
SELECT 'platform_canonical_nickname', 'platform', 'platform_default_canonical_catalog_v1', 'field.canonical.nickname', 'authrim.canonical', 'nickname',
       'canonical', 'string', 'single', 'pii', '[]',
       '{}', 'name', 'Name', 10, 50,
       '["Johnny","たろう"]', __AUTHRIM_NOW_EPOCH_MILLISECONDS__, __AUTHRIM_NOW_EPOCH_MILLISECONDS__
WHERE NOT EXISTS (
  SELECT 1 FROM field_catalog_entries
  WHERE tenant_id = 'platform'
    AND catalog_version_id = 'platform_default_canonical_catalog_v1'
    AND stable_field_id = 'field.canonical.nickname'
);

INSERT INTO field_catalog_entries (
  id, tenant_id, catalog_version_id, stable_field_id, namespace, path, target_taxonomy,
  value_type, cardinality, classification, aliases_json, validation_json,
  ui_group_key, ui_group_label, ui_group_order, ui_field_order, examples_json,
  created_at, updated_at
)
SELECT 'platform_canonical_preferred_username', 'platform', 'platform_default_canonical_catalog_v1', 'field.canonical.preferred_username', 'authrim.canonical', 'preferred_username',
       'canonical', 'string', 'single', 'internal', '[]',
       '{}', 'name', 'Name', 10, 60,
       '["jdoe","taro.yamada"]', __AUTHRIM_NOW_EPOCH_MILLISECONDS__, __AUTHRIM_NOW_EPOCH_MILLISECONDS__
WHERE NOT EXISTS (
  SELECT 1 FROM field_catalog_entries
  WHERE tenant_id = 'platform'
    AND catalog_version_id = 'platform_default_canonical_catalog_v1'
    AND stable_field_id = 'field.canonical.preferred_username'
);

INSERT INTO field_catalog_entries (
  id, tenant_id, catalog_version_id, stable_field_id, namespace, path, target_taxonomy,
  value_type, cardinality, classification, aliases_json, validation_json,
  ui_group_key, ui_group_label, ui_group_order, ui_field_order, examples_json,
  created_at, updated_at
)
SELECT 'platform_canonical_email', 'platform', 'platform_default_canonical_catalog_v1', 'field.canonical.email', 'authrim.canonical', 'email',
       'canonical', 'string', 'single', 'pii', '[]',
       '{}', 'contact', 'Contact', 20, 10,
       '["john@example.edu"]', __AUTHRIM_NOW_EPOCH_MILLISECONDS__, __AUTHRIM_NOW_EPOCH_MILLISECONDS__
WHERE NOT EXISTS (
  SELECT 1 FROM field_catalog_entries
  WHERE tenant_id = 'platform'
    AND catalog_version_id = 'platform_default_canonical_catalog_v1'
    AND stable_field_id = 'field.canonical.email'
);

INSERT INTO field_catalog_entries (
  id, tenant_id, catalog_version_id, stable_field_id, namespace, path, target_taxonomy,
  value_type, cardinality, classification, aliases_json, validation_json,
  ui_group_key, ui_group_label, ui_group_order, ui_field_order, examples_json,
  created_at, updated_at
)
SELECT 'platform_canonical_email_verified', 'platform', 'platform_default_canonical_catalog_v1', 'field.canonical.email_verified', 'authrim.canonical', 'email_verified',
       'canonical', 'boolean', 'single', 'internal', '[]',
       '{}', 'contact', 'Contact', 20, 20,
       '[true]', __AUTHRIM_NOW_EPOCH_MILLISECONDS__, __AUTHRIM_NOW_EPOCH_MILLISECONDS__
WHERE NOT EXISTS (
  SELECT 1 FROM field_catalog_entries
  WHERE tenant_id = 'platform'
    AND catalog_version_id = 'platform_default_canonical_catalog_v1'
    AND stable_field_id = 'field.canonical.email_verified'
);

INSERT INTO field_catalog_entries (
  id, tenant_id, catalog_version_id, stable_field_id, namespace, path, target_taxonomy,
  value_type, cardinality, classification, aliases_json, validation_json,
  ui_group_key, ui_group_label, ui_group_order, ui_field_order, examples_json,
  created_at, updated_at
)
SELECT 'platform_canonical_phone_number', 'platform', 'platform_default_canonical_catalog_v1', 'field.canonical.phone_number', 'authrim.canonical', 'phone_number',
       'canonical', 'string', 'single', 'pii', '[]',
       '{}', 'contact', 'Contact', 20, 30,
       '["+1 415 555 0100"]', __AUTHRIM_NOW_EPOCH_MILLISECONDS__, __AUTHRIM_NOW_EPOCH_MILLISECONDS__
WHERE NOT EXISTS (
  SELECT 1 FROM field_catalog_entries
  WHERE tenant_id = 'platform'
    AND catalog_version_id = 'platform_default_canonical_catalog_v1'
    AND stable_field_id = 'field.canonical.phone_number'
);

INSERT INTO field_catalog_entries (
  id, tenant_id, catalog_version_id, stable_field_id, namespace, path, target_taxonomy,
  value_type, cardinality, classification, aliases_json, validation_json,
  ui_group_key, ui_group_label, ui_group_order, ui_field_order, examples_json,
  created_at, updated_at
)
SELECT 'platform_canonical_phone_number_verified', 'platform', 'platform_default_canonical_catalog_v1', 'field.canonical.phone_number_verified', 'authrim.canonical', 'phone_number_verified',
       'canonical', 'boolean', 'single', 'internal', '[]',
       '{}', 'contact', 'Contact', 20, 40,
       '[false]', __AUTHRIM_NOW_EPOCH_MILLISECONDS__, __AUTHRIM_NOW_EPOCH_MILLISECONDS__
WHERE NOT EXISTS (
  SELECT 1 FROM field_catalog_entries
  WHERE tenant_id = 'platform'
    AND catalog_version_id = 'platform_default_canonical_catalog_v1'
    AND stable_field_id = 'field.canonical.phone_number_verified'
);

INSERT INTO field_catalog_entries (
  id, tenant_id, catalog_version_id, stable_field_id, namespace, path, target_taxonomy,
  value_type, cardinality, classification, aliases_json, validation_json,
  ui_group_key, ui_group_label, ui_group_order, ui_field_order, examples_json,
  created_at, updated_at
)
SELECT 'platform_canonical_address', 'platform', 'platform_default_canonical_catalog_v1', 'field.canonical.address', 'authrim.canonical', 'address',
       'canonical', 'json', 'multi', 'pii', '[]',
       '{}', 'address', 'Address', 30, 10,
       '[{"formatted":"1-1 Chiyoda, Chiyoda-ku, Tokyo 100-8111, JP","streetAddress":"1-1 Chiyoda","locality":"Chiyoda-ku","region":"Tokyo","postalCode":"100-8111","country":"JP"}]', __AUTHRIM_NOW_EPOCH_MILLISECONDS__, __AUTHRIM_NOW_EPOCH_MILLISECONDS__
WHERE NOT EXISTS (
  SELECT 1 FROM field_catalog_entries
  WHERE tenant_id = 'platform'
    AND catalog_version_id = 'platform_default_canonical_catalog_v1'
    AND stable_field_id = 'field.canonical.address'
);

INSERT INTO field_catalog_entries (
  id, tenant_id, catalog_version_id, stable_field_id, namespace, path, target_taxonomy,
  value_type, cardinality, classification, aliases_json, validation_json,
  ui_group_key, ui_group_label, ui_group_order, ui_field_order, examples_json,
  created_at, updated_at
)
SELECT 'platform_canonical_address_street_address', 'platform', 'platform_default_canonical_catalog_v1', 'field.canonical.address_street_address', 'authrim.canonical', 'address_street_address',
       'canonical', 'string', 'single', 'pii', '[]',
       '{}', 'address', 'Address', 30, 20,
       '["1-1 Chiyoda"]', __AUTHRIM_NOW_EPOCH_MILLISECONDS__, __AUTHRIM_NOW_EPOCH_MILLISECONDS__
WHERE NOT EXISTS (
  SELECT 1 FROM field_catalog_entries
  WHERE tenant_id = 'platform'
    AND catalog_version_id = 'platform_default_canonical_catalog_v1'
    AND stable_field_id = 'field.canonical.address_street_address'
);

INSERT INTO field_catalog_entries (
  id, tenant_id, catalog_version_id, stable_field_id, namespace, path, target_taxonomy,
  value_type, cardinality, classification, aliases_json, validation_json,
  ui_group_key, ui_group_label, ui_group_order, ui_field_order, examples_json,
  created_at, updated_at
)
SELECT 'platform_canonical_address_locality', 'platform', 'platform_default_canonical_catalog_v1', 'field.canonical.address_locality', 'authrim.canonical', 'address_locality',
       'canonical', 'string', 'single', 'pii', '[]',
       '{}', 'address', 'Address', 30, 30,
       '["Chiyoda-ku"]', __AUTHRIM_NOW_EPOCH_MILLISECONDS__, __AUTHRIM_NOW_EPOCH_MILLISECONDS__
WHERE NOT EXISTS (
  SELECT 1 FROM field_catalog_entries
  WHERE tenant_id = 'platform'
    AND catalog_version_id = 'platform_default_canonical_catalog_v1'
    AND stable_field_id = 'field.canonical.address_locality'
);

INSERT INTO field_catalog_entries (
  id, tenant_id, catalog_version_id, stable_field_id, namespace, path, target_taxonomy,
  value_type, cardinality, classification, aliases_json, validation_json,
  ui_group_key, ui_group_label, ui_group_order, ui_field_order, examples_json,
  created_at, updated_at
)
SELECT 'platform_canonical_address_region', 'platform', 'platform_default_canonical_catalog_v1', 'field.canonical.address_region', 'authrim.canonical', 'address_region',
       'canonical', 'string', 'single', 'pii', '[]',
       '{}', 'address', 'Address', 30, 40,
       '["Tokyo"]', __AUTHRIM_NOW_EPOCH_MILLISECONDS__, __AUTHRIM_NOW_EPOCH_MILLISECONDS__
WHERE NOT EXISTS (
  SELECT 1 FROM field_catalog_entries
  WHERE tenant_id = 'platform'
    AND catalog_version_id = 'platform_default_canonical_catalog_v1'
    AND stable_field_id = 'field.canonical.address_region'
);

INSERT INTO field_catalog_entries (
  id, tenant_id, catalog_version_id, stable_field_id, namespace, path, target_taxonomy,
  value_type, cardinality, classification, aliases_json, validation_json,
  ui_group_key, ui_group_label, ui_group_order, ui_field_order, examples_json,
  created_at, updated_at
)
SELECT 'platform_canonical_address_postal_code', 'platform', 'platform_default_canonical_catalog_v1', 'field.canonical.address_postal_code', 'authrim.canonical', 'address_postal_code',
       'canonical', 'string', 'single', 'pii', '[]',
       '{}', 'address', 'Address', 30, 50,
       '["100-8111"]', __AUTHRIM_NOW_EPOCH_MILLISECONDS__, __AUTHRIM_NOW_EPOCH_MILLISECONDS__
WHERE NOT EXISTS (
  SELECT 1 FROM field_catalog_entries
  WHERE tenant_id = 'platform'
    AND catalog_version_id = 'platform_default_canonical_catalog_v1'
    AND stable_field_id = 'field.canonical.address_postal_code'
);

INSERT INTO field_catalog_entries (
  id, tenant_id, catalog_version_id, stable_field_id, namespace, path, target_taxonomy,
  value_type, cardinality, classification, aliases_json, validation_json,
  ui_group_key, ui_group_label, ui_group_order, ui_field_order, examples_json,
  created_at, updated_at
)
SELECT 'platform_canonical_address_country', 'platform', 'platform_default_canonical_catalog_v1', 'field.canonical.address_country', 'authrim.canonical', 'address_country',
       'canonical', 'string', 'single', 'pii', '[]',
       '{}', 'address', 'Address', 30, 60,
       '["JP"]', __AUTHRIM_NOW_EPOCH_MILLISECONDS__, __AUTHRIM_NOW_EPOCH_MILLISECONDS__
WHERE NOT EXISTS (
  SELECT 1 FROM field_catalog_entries
  WHERE tenant_id = 'platform'
    AND catalog_version_id = 'platform_default_canonical_catalog_v1'
    AND stable_field_id = 'field.canonical.address_country'
);

INSERT INTO field_catalog_entries (
  id, tenant_id, catalog_version_id, stable_field_id, namespace, path, target_taxonomy,
  value_type, cardinality, classification, aliases_json, validation_json,
  ui_group_key, ui_group_label, ui_group_order, ui_field_order, examples_json,
  created_at, updated_at
)
SELECT 'platform_canonical_profile', 'platform', 'platform_default_canonical_catalog_v1', 'field.canonical.profile', 'authrim.canonical', 'profile',
       'canonical', 'string', 'single', 'internal', '[]',
       '{}', 'profile', 'Profile', 40, 10,
       '["https://example.edu/users/jdoe"]', __AUTHRIM_NOW_EPOCH_MILLISECONDS__, __AUTHRIM_NOW_EPOCH_MILLISECONDS__
WHERE NOT EXISTS (
  SELECT 1 FROM field_catalog_entries
  WHERE tenant_id = 'platform'
    AND catalog_version_id = 'platform_default_canonical_catalog_v1'
    AND stable_field_id = 'field.canonical.profile'
);

INSERT INTO field_catalog_entries (
  id, tenant_id, catalog_version_id, stable_field_id, namespace, path, target_taxonomy,
  value_type, cardinality, classification, aliases_json, validation_json,
  ui_group_key, ui_group_label, ui_group_order, ui_field_order, examples_json,
  created_at, updated_at
)
SELECT 'platform_canonical_picture', 'platform', 'platform_default_canonical_catalog_v1', 'field.canonical.picture', 'authrim.canonical', 'picture',
       'canonical', 'string', 'single', 'pii', '[]',
       '{}', 'profile', 'Profile', 40, 20,
       '["https://example.edu/users/jdoe/photo.jpg"]', __AUTHRIM_NOW_EPOCH_MILLISECONDS__, __AUTHRIM_NOW_EPOCH_MILLISECONDS__
WHERE NOT EXISTS (
  SELECT 1 FROM field_catalog_entries
  WHERE tenant_id = 'platform'
    AND catalog_version_id = 'platform_default_canonical_catalog_v1'
    AND stable_field_id = 'field.canonical.picture'
);

INSERT INTO field_catalog_entries (
  id, tenant_id, catalog_version_id, stable_field_id, namespace, path, target_taxonomy,
  value_type, cardinality, classification, aliases_json, validation_json,
  ui_group_key, ui_group_label, ui_group_order, ui_field_order, examples_json,
  created_at, updated_at
)
SELECT 'platform_canonical_website', 'platform', 'platform_default_canonical_catalog_v1', 'field.canonical.website', 'authrim.canonical', 'website',
       'canonical', 'string', 'single', 'internal', '[]',
       '{}', 'profile', 'Profile', 40, 30,
       '["https://jdoe.example.edu"]', __AUTHRIM_NOW_EPOCH_MILLISECONDS__, __AUTHRIM_NOW_EPOCH_MILLISECONDS__
WHERE NOT EXISTS (
  SELECT 1 FROM field_catalog_entries
  WHERE tenant_id = 'platform'
    AND catalog_version_id = 'platform_default_canonical_catalog_v1'
    AND stable_field_id = 'field.canonical.website'
);

INSERT INTO field_catalog_entries (
  id, tenant_id, catalog_version_id, stable_field_id, namespace, path, target_taxonomy,
  value_type, cardinality, classification, aliases_json, validation_json,
  ui_group_key, ui_group_label, ui_group_order, ui_field_order, examples_json,
  created_at, updated_at
)
SELECT 'platform_canonical_birthdate', 'platform', 'platform_default_canonical_catalog_v1', 'field.canonical.birthdate', 'authrim.canonical', 'birthdate',
       'canonical', 'date', 'single', 'pii', '[]',
       '{}', 'profile', 'Profile', 40, 40,
       '["1990-04-12"]', __AUTHRIM_NOW_EPOCH_MILLISECONDS__, __AUTHRIM_NOW_EPOCH_MILLISECONDS__
WHERE NOT EXISTS (
  SELECT 1 FROM field_catalog_entries
  WHERE tenant_id = 'platform'
    AND catalog_version_id = 'platform_default_canonical_catalog_v1'
    AND stable_field_id = 'field.canonical.birthdate'
);

INSERT INTO field_catalog_entries (
  id, tenant_id, catalog_version_id, stable_field_id, namespace, path, target_taxonomy,
  value_type, cardinality, classification, aliases_json, validation_json,
  ui_group_key, ui_group_label, ui_group_order, ui_field_order, examples_json,
  created_at, updated_at
)
SELECT 'platform_canonical_zoneinfo', 'platform', 'platform_default_canonical_catalog_v1', 'field.canonical.zoneinfo', 'authrim.canonical', 'zoneinfo',
       'canonical', 'string', 'single', 'internal', '[]',
       '{}', 'profile', 'Profile', 40, 50,
       '["Asia/Tokyo"]', __AUTHRIM_NOW_EPOCH_MILLISECONDS__, __AUTHRIM_NOW_EPOCH_MILLISECONDS__
WHERE NOT EXISTS (
  SELECT 1 FROM field_catalog_entries
  WHERE tenant_id = 'platform'
    AND catalog_version_id = 'platform_default_canonical_catalog_v1'
    AND stable_field_id = 'field.canonical.zoneinfo'
);

INSERT INTO field_catalog_entries (
  id, tenant_id, catalog_version_id, stable_field_id, namespace, path, target_taxonomy,
  value_type, cardinality, classification, aliases_json, validation_json,
  ui_group_key, ui_group_label, ui_group_order, ui_field_order, examples_json,
  created_at, updated_at
)
SELECT 'platform_canonical_locale', 'platform', 'platform_default_canonical_catalog_v1', 'field.canonical.locale', 'authrim.canonical', 'locale',
       'canonical', 'string', 'single', 'internal', '[]',
       '{}', 'profile', 'Profile', 40, 60,
       '["ja-JP"]', __AUTHRIM_NOW_EPOCH_MILLISECONDS__, __AUTHRIM_NOW_EPOCH_MILLISECONDS__
WHERE NOT EXISTS (
  SELECT 1 FROM field_catalog_entries
  WHERE tenant_id = 'platform'
    AND catalog_version_id = 'platform_default_canonical_catalog_v1'
    AND stable_field_id = 'field.canonical.locale'
);

INSERT INTO field_catalog_entries (
  id, tenant_id, catalog_version_id, stable_field_id, namespace, path, target_taxonomy,
  value_type, cardinality, classification, aliases_json, validation_json,
  ui_group_key, ui_group_label, ui_group_order, ui_field_order, examples_json,
  created_at, updated_at
)
SELECT 'platform_canonical_group_membership', 'platform', 'platform_default_canonical_catalog_v1', 'field.canonical.group_membership', 'authrim.canonical', 'group_membership',
       'canonical', 'array', 'multi', 'internal', '[]',
       '{}', 'access', 'Access', 50, 10,
       '["library-staff","researcher"]', __AUTHRIM_NOW_EPOCH_MILLISECONDS__, __AUTHRIM_NOW_EPOCH_MILLISECONDS__
WHERE NOT EXISTS (
  SELECT 1 FROM field_catalog_entries
  WHERE tenant_id = 'platform'
    AND catalog_version_id = 'platform_default_canonical_catalog_v1'
    AND stable_field_id = 'field.canonical.group_membership'
);

INSERT INTO field_catalog_entries (
  id, tenant_id, catalog_version_id, stable_field_id, namespace, path, target_taxonomy,
  value_type, cardinality, classification, aliases_json, validation_json,
  ui_group_key, ui_group_label, ui_group_order, ui_field_order, examples_json,
  created_at, updated_at
)
SELECT 'platform_canonical_entitlements', 'platform', 'platform_default_canonical_catalog_v1', 'field.canonical.entitlements', 'authrim.canonical', 'entitlements',
       'canonical', 'array', 'multi', 'internal', '[]',
       '{}', 'access', 'Access', 50, 20,
       '["publisher:journal:read"]', __AUTHRIM_NOW_EPOCH_MILLISECONDS__, __AUTHRIM_NOW_EPOCH_MILLISECONDS__
WHERE NOT EXISTS (
  SELECT 1 FROM field_catalog_entries
  WHERE tenant_id = 'platform'
    AND catalog_version_id = 'platform_default_canonical_catalog_v1'
    AND stable_field_id = 'field.canonical.entitlements'
);

INSERT INTO field_catalog_entries (
  id, tenant_id, catalog_version_id, stable_field_id, namespace, path, target_taxonomy,
  value_type, cardinality, classification, aliases_json, validation_json,
  ui_group_key, ui_group_label, ui_group_order, ui_field_order, examples_json,
  created_at, updated_at
)
SELECT 'platform_canonical_subject_id', 'platform', 'platform_default_canonical_catalog_v1', 'field.canonical.subject_id', 'authrim.canonical', 'subject_id',
       'canonical', 'string', 'single', 'internal', '[]',
       '{}', 'identity', 'Identity', 60, 10,
       '["user_01HZY9G3V3W0M7K9D2B1N6A8CQ"]', __AUTHRIM_NOW_EPOCH_MILLISECONDS__, __AUTHRIM_NOW_EPOCH_MILLISECONDS__
WHERE NOT EXISTS (
  SELECT 1 FROM field_catalog_entries
  WHERE tenant_id = 'platform'
    AND catalog_version_id = 'platform_default_canonical_catalog_v1'
    AND stable_field_id = 'field.canonical.subject_id'
);

INSERT INTO field_catalog_entries (
  id, tenant_id, catalog_version_id, stable_field_id, namespace, path, target_taxonomy,
  value_type, cardinality, classification, aliases_json, validation_json,
  ui_group_key, ui_group_label, ui_group_order, ui_field_order, examples_json,
  created_at, updated_at
)
SELECT 'platform_canonical_linked_identity', 'platform', 'platform_default_canonical_catalog_v1', 'field.canonical.linked_identity', 'authrim.canonical', 'linked_identity',
       'canonical', 'string', 'single', 'internal', '[]',
       '{}', 'identity', 'Identity', 60, 20,
       '["saml:urn:example:idp:00u123"]', __AUTHRIM_NOW_EPOCH_MILLISECONDS__, __AUTHRIM_NOW_EPOCH_MILLISECONDS__
WHERE NOT EXISTS (
  SELECT 1 FROM field_catalog_entries
  WHERE tenant_id = 'platform'
    AND catalog_version_id = 'platform_default_canonical_catalog_v1'
    AND stable_field_id = 'field.canonical.linked_identity'
);

INSERT INTO field_catalog_entries (
  id, tenant_id, catalog_version_id, stable_field_id, namespace, path, target_taxonomy,
  value_type, cardinality, classification, aliases_json, validation_json,
  ui_group_key, ui_group_label, ui_group_order, ui_field_order, examples_json,
  created_at, updated_at
)
SELECT 'platform_canonical_lifecycle_state', 'platform', 'platform_default_canonical_catalog_v1', 'field.canonical.lifecycle_state', 'authrim.canonical', 'lifecycle_state',
       'canonical', 'string', 'single', 'internal', '[]',
       '{}', 'identity', 'Identity', 60, 30,
       '["active"]', __AUTHRIM_NOW_EPOCH_MILLISECONDS__, __AUTHRIM_NOW_EPOCH_MILLISECONDS__
WHERE NOT EXISTS (
  SELECT 1 FROM field_catalog_entries
  WHERE tenant_id = 'platform'
    AND catalog_version_id = 'platform_default_canonical_catalog_v1'
    AND stable_field_id = 'field.canonical.lifecycle_state'
);

-- =============================================================================
-- Down Migration (Rollback) - COMMENTED OUT
-- =============================================================================
-- DELETE FROM field_catalog_entries WHERE tenant_id = 'platform' AND catalog_version_id = 'platform_default_canonical_catalog_v1';
-- DELETE FROM field_catalog_versions WHERE tenant_id = 'platform' AND id = 'platform_default_canonical_catalog_v1';
-- DELETE FROM field_catalogs WHERE tenant_id = 'platform' AND id = 'platform_default_canonical_catalog';
