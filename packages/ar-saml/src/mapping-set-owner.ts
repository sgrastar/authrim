import { PLATFORM_MAPPING_TENANT_ID, type DatabaseAdapter } from '@authrim/ar-lib-core';

/** An explicitly selected set may belong only to the caller or the platform. */
export async function resolveSAMLMappingSetOwner(
  adapter: DatabaseAdapter,
  tenantId: string,
  setId: string
): Promise<string | null> {
  const row = await adapter.queryOne<{ tenant_id: string }>(
    `SELECT tenant_id FROM field_mapping_sets
      WHERE id = ? AND tenant_id IN (?, ?) AND lifecycle_state = 'active'`,
    [setId, tenantId, PLATFORM_MAPPING_TENANT_ID]
  );
  return row && (row.tenant_id === tenantId || row.tenant_id === PLATFORM_MAPPING_TENANT_ID)
    ? row.tenant_id
    : null;
}
