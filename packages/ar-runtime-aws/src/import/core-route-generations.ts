import type { PortableSqliteRow } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';

const TENANT_ID = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;

function invalid(): never {
  throw new Error('aws_snapshot_core_account_invalid');
}

function text(row: PortableSqliteRow, column: string): string {
  const value = row[column];
  if (!value || value.length !== 2 || value[0] !== 'text' || typeof value[1] !== 'string') {
    invalid();
  }
  return value[1];
}

function generation(row: PortableSqliteRow): number {
  const value = row.account_route_generation;
  if (
    !value ||
    value.length !== 2 ||
    value[0] !== 'integer' ||
    typeof value[1] !== 'string' ||
    !/^[1-9][0-9]*$/u.test(value[1])
  ) {
    invalid();
  }
  const parsed = Number(value[1]);
  if (!Number.isSafeInteger(parsed)) invalid();
  return parsed;
}

/**
 * Extract route generations from verified `core.identity_accounts` D1 snapshot rows.
 * The importer preserves the explicit source generation in PostgreSQL and passes it to
 * `AwsDataTenantInventory` alongside rebuilt Lookup rows from the same snapshot boundary.
 * This function does not authenticate or decrypt a backup container.
 */
export function buildCoreAccountRouteGenerations(
  tenantId: string,
  rows: readonly PortableSqliteRow[]
): Readonly<Record<string, number>> {
  if (!TENANT_ID.test(tenantId)) invalid();
  const result: Record<string, number> = Object.create(null) as Record<string, number>;
  const seen = new Set<string>();
  for (const row of rows) {
    if (text(row, 'tenant_id') !== tenantId) invalid();
    const accountId = text(row, 'id');
    const accountType = text(row, 'account_type');
    const lifecycle = text(row, 'lifecycle_state');
    const publication = text(row, 'directory_publication_state');
    const routeGeneration = generation(row);
    if (seen.has(accountId)) invalid();
    seen.add(accountId);
    if (accountType !== 'user' || lifecycle !== 'active' || publication !== 'active') continue;
    const legacy = text(row, 'legacy_user_id');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,247}$/u.test(legacy) || accountId !== `account:${legacy}`) {
      invalid();
    }
    result[accountId] = routeGeneration;
  }
  return Object.freeze(result);
}
