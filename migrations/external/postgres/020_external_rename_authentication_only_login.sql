-- Authrim External Postgres Migration 020: Rename Authentication-only Login
-- Clarifies that the built-in Flow controls authentication, not protocol consent.

UPDATE flows
SET
  name = 'Authentication-only Login',
  display_name = 'Authentication-only Login',
  updated_by = 'system',
  updated_at = __AUTHRIM_NOW_EPOCH_SECONDS__
WHERE id = 'flow-default-login-no-consent'
  AND tenant_id = 'default'
  AND slug = 'default-login-no-consent'
  AND deleted_at IS NULL;
