-- Allow dedicated code input forms to be managed with other form profiles.

ALTER TABLE form_profiles
  DROP CONSTRAINT IF EXISTS form_profiles_form_kind_check;

ALTER TABLE form_profiles
  ADD CONSTRAINT form_profiles_form_kind_check
  CHECK (form_kind IN ('registration', 'profile_completion', 'login', 'consent', 'code_input', 'custom'));
