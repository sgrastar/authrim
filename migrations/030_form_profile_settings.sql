ALTER TABLE form_profiles ADD COLUMN settings_json TEXT;

UPDATE form_profiles
SET settings_json = '{"canvas_layout":"narrow"}'
WHERE settings_json IS NULL;
