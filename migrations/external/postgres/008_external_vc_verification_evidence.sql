ALTER TABLE attribute_verifications ADD COLUMN IF NOT EXISTS credential_profile_id TEXT;
ALTER TABLE attribute_verifications ADD COLUMN IF NOT EXISTS credential_profile_version_id TEXT;
ALTER TABLE attribute_verifications ADD COLUMN IF NOT EXISTS mapping_version_id TEXT;
ALTER TABLE attribute_verifications ADD COLUMN IF NOT EXISTS mapping_snapshot_hash TEXT;
ALTER TABLE attribute_verifications ADD COLUMN IF NOT EXISTS policy_version TEXT;
ALTER TABLE attribute_verifications ADD COLUMN IF NOT EXISTS evidence_fingerprint TEXT;
ALTER TABLE attribute_verifications ADD COLUMN IF NOT EXISTS status_checked_at BIGINT;
ALTER TABLE attribute_verifications ADD COLUMN IF NOT EXISTS status_fresh_until BIGINT;
ALTER TABLE attribute_verifications ADD COLUMN IF NOT EXISTS revalidate_after BIGINT;
ALTER TABLE attribute_verifications ADD COLUMN IF NOT EXISTS invalidated_at BIGINT;
ALTER TABLE attribute_verifications ADD COLUMN IF NOT EXISTS invalidation_reason TEXT;
ALTER TABLE user_verified_attributes ADD COLUMN IF NOT EXISTS revalidate_after BIGINT;
CREATE INDEX IF NOT EXISTS idx_attribute_verifications_runtime_validity
  ON attribute_verifications(tenant_id, verification_result, invalidated_at, revalidate_after);

INSERT INTO oidc_scopes
  (id, tenant_id, name, display_name, description, scope_type, enabled, localizations_json, created_at, updated_at)
VALUES
  ('scope-vc-attribute-default', 'default', 'vc.attribute', 'Verified attributes',
   'Present and read verified attributes through the VC attribute-elevation service.',
   'system', TRUE, NULL, 0, 0)
ON CONFLICT (tenant_id, name) DO NOTHING;
