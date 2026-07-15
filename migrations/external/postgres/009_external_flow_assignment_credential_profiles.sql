-- =============================================================================
-- Authrim External Postgres Migration 009: Credential Profile Flow Assignments
-- =============================================================================
-- Extend the immutable Flow runtime baseline with credential-profile targets.

ALTER TABLE flow_assignments
  DROP CONSTRAINT IF EXISTS flow_assignments_target_type_check,
  DROP CONSTRAINT IF EXISTS flow_assignments_check;

ALTER TABLE flow_assignments
  ADD CONSTRAINT flow_assignments_target_type_check
    CHECK (target_type IN ('tenant', 'oidc_client', 'saml_sp', 'credential_profile')),
  ADD CONSTRAINT flow_assignments_target_id_check
    CHECK (
      (target_type = 'tenant' AND target_id IS NULL)
      OR (
        target_type IN ('oidc_client', 'saml_sp', 'credential_profile')
        AND target_id IS NOT NULL
      )
    );
