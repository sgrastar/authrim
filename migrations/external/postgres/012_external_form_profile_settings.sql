ALTER TABLE form_profiles ADD COLUMN IF NOT EXISTS settings_json JSONB;

UPDATE form_profiles
SET settings_json = '{"canvas_layout":"narrow"}'::jsonb
WHERE settings_json IS NULL;
