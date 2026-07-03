-- Allow reusable consent forms to be managed with other form profiles.
-- SQLite/D1 cannot alter CHECK constraints in place, so rebuild the table.

CREATE TABLE form_profiles_new (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  profile_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  form_kind TEXT NOT NULL CHECK (
    form_kind IN ('registration', 'profile_completion', 'login', 'consent', 'custom')
  ),
  fields_json TEXT NOT NULL,
  localizations_json TEXT,
  settings_json TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  is_system INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, profile_key)
);

INSERT INTO form_profiles_new
  (id, tenant_id, profile_key, display_name, description, form_kind, fields_json,
   localizations_json, settings_json, is_active, is_system, created_at, updated_at)
SELECT
  id,
  tenant_id,
  profile_key,
  display_name,
  description,
  form_kind,
  fields_json,
  localizations_json,
  COALESCE(settings_json, '{"canvas_layout":"narrow"}'),
  is_active,
  is_system,
  created_at,
  updated_at
FROM form_profiles;

DROP TABLE form_profiles;

ALTER TABLE form_profiles_new RENAME TO form_profiles;

CREATE INDEX IF NOT EXISTS idx_form_profiles_kind
  ON form_profiles(tenant_id, form_kind, is_active);
