import { replicationCanonicalJson, assertReplicationIdentifier } from './transport';
/** Each serving generation opens three independent database pools per tenant. Never truncate. */
export const MAX_REPLICATION_ENVIRONMENT_TENANTS = 16;
export interface EnvironmentReplicationInventory {
  formatVersion: 1;
  complete: true;
  environmentId: string;
  pairId: string;
  sourceDeploymentId: string;
  observedAtMs: number;
  inventorySha256: string;
  writerCoverageSha256: string;
  tenants: Array<{
    tenantId: string;
    issuer: string;
    productVersion: string;
    lifecycleState: string;
    placementGeneration: number;
  }>;
}
export async function replicationInventoryDigest(value: unknown): Promise<string> {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(replicationCanonicalJson(value))
      )
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function assertEnvironmentSourceInventory(
  raw: unknown
): Promise<EnvironmentReplicationInventory> {
  const fail = (): never => {
    throw new Error('replication_environment_inventory_invalid');
  };
  const exact = (value: unknown, keys: string[]): value is Record<string, unknown> =>
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === keys.sort().join(',');
  if (
    !exact(raw, [
      'formatVersion',
      'complete',
      'environmentId',
      'pairId',
      'sourceDeploymentId',
      'observedAtMs',
      'inventorySha256',
      'writerCoverageSha256',
      'tenants',
    ])
  )
    fail();
  const value = raw as EnvironmentReplicationInventory;
  if (
    value.formatVersion !== 1 ||
    value.complete !== true ||
    !Number.isSafeInteger(value.observedAtMs) ||
    value.observedAtMs < 0 ||
    !/^[a-f0-9]{64}$/.test(value.inventorySha256) ||
    !/^[a-f0-9]{64}$/.test(value.writerCoverageSha256) ||
    !Array.isArray(value.tenants) ||
    value.tenants.length < 1 ||
    value.tenants.length > MAX_REPLICATION_ENVIRONMENT_TENANTS
  )
    fail();
  for (const id of [value.environmentId, value.pairId, value.sourceDeploymentId])
    assertReplicationIdentifier(id);
  let previous = '';
  const issuers = new Set<string>();
  for (const row of value.tenants) {
    if (
      !exact(row, [
        'tenantId',
        'issuer',
        'productVersion',
        'lifecycleState',
        'placementGeneration',
      ]) ||
      typeof row.tenantId !== 'string' ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(row.tenantId) ||
      row.tenantId <= previous ||
      row.lifecycleState !== 'active' ||
      !Number.isSafeInteger(row.placementGeneration) ||
      row.placementGeneration < 1 ||
      typeof row.productVersion !== 'string' ||
      !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(row.productVersion)
    )
      fail();
    const url = new URL(row.issuer);
    if (
      url.protocol !== 'https:' ||
      url.origin !== row.issuer ||
      url.username ||
      url.password ||
      issuers.has(row.issuer)
    )
      fail();
    previous = row.tenantId;
    issuers.add(row.issuer);
  }
  const { observedAtMs: _time, inventorySha256: _digest, ...body } = value;
  if ((await replicationInventoryDigest(body)) !== value.inventorySha256) fail();
  return value;
}
