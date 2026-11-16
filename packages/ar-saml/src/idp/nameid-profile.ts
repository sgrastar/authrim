import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import type { SAMLNameIdProfile } from '../release-explain';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** NameID is a protocol subject, separate from the profile's attribute release policies. */
export async function loadSAMLNameIdProfile(
  adapter: DatabaseAdapter,
  tenantId: string,
  profileId: string
): Promise<SAMLNameIdProfile | null> {
  const row = await adapter.queryOne<{ schema_json: string }>(
    `SELECT v.schema_json FROM destination_profiles p
      JOIN destination_profile_versions v ON v.id = p.active_version_id
       AND v.profile_id = p.id AND v.tenant_id = p.tenant_id
      WHERE p.id = ? AND p.tenant_id IN (?, 'platform') AND p.destination_type = 'saml'
       AND p.lifecycle_state = 'active' AND v.lifecycle_state = 'active' LIMIT 1`,
    [profileId, tenantId]
  );
  if (!row) return null;
  const schema: unknown = JSON.parse(row.schema_json);
  if (!record(schema) || !record(schema.nameId)) return null;
  return {
    format: typeof schema.nameId.format === 'string' ? schema.nameId.format : null,
    classification:
      typeof schema.nameId.classification === 'string' ? schema.nameId.classification : 'internal',
  };
}
