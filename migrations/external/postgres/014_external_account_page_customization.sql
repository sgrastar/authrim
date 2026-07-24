-- Allow account-management screen presets in external PostgreSQL databases.

ALTER TABLE screens
  DROP CONSTRAINT IF EXISTS screens_screen_kind_check;

ALTER TABLE screens
  ADD CONSTRAINT screens_screen_kind_check
  CHECK (
    screen_kind IN (
      'registration',
      'profile_completion',
      'login',
      'consent',
      'code_input',
      'account',
      'custom'
    )
  );
