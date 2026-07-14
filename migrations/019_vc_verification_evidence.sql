ALTER TABLE attribute_verifications ADD COLUMN credential_profile_id TEXT;
ALTER TABLE attribute_verifications ADD COLUMN credential_profile_version_id TEXT;
ALTER TABLE attribute_verifications ADD COLUMN mapping_version_id TEXT;
ALTER TABLE attribute_verifications ADD COLUMN mapping_snapshot_hash TEXT;
ALTER TABLE attribute_verifications ADD COLUMN policy_version TEXT;
ALTER TABLE attribute_verifications ADD COLUMN evidence_fingerprint TEXT;
ALTER TABLE attribute_verifications ADD COLUMN status_checked_at INTEGER;
ALTER TABLE attribute_verifications ADD COLUMN status_fresh_until INTEGER;
ALTER TABLE attribute_verifications ADD COLUMN revalidate_after INTEGER;
ALTER TABLE attribute_verifications ADD COLUMN invalidated_at INTEGER;
ALTER TABLE attribute_verifications ADD COLUMN invalidation_reason TEXT;
ALTER TABLE user_verified_attributes ADD COLUMN revalidate_after INTEGER;
CREATE INDEX IF NOT EXISTS idx_attribute_verifications_runtime_validity
  ON attribute_verifications(tenant_id, verification_result, invalidated_at, revalidate_after);

INSERT INTO oidc_scopes
  (id, tenant_id, name, display_name, description, scope_type, enabled, localizations_json, created_at, updated_at)
VALUES
  ('scope-vc-attribute-default', 'default', 'vc.attribute', 'Verified attributes',
   'Present and read verified attributes through the VC attribute-elevation service.',
   'system', 1, NULL, 0, 0)
ON CONFLICT (tenant_id, name) DO NOTHING;
