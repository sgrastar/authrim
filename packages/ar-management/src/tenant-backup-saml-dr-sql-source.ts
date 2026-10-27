import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import {
  plannedInstalledSqliteDatasetSources,
  type PlannedInstalledSqliteDataset,
} from '@authrim/ar-lib-core/services/tenant-portability/installed-sqlite-datasets';
import { readNextShardedSqliteDatasetChunk } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-sharded-dataset-reader';
import { phase8SqliteRestoreTargetRole } from '@authrim/ar-lib-core/services/tenant-portability/phase8-restore-targets';
import type { PortableSqliteRow } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';
import type { AdapterContext } from './tenant-backup-export-dispatcher';
import type { SamlDrAccountSourceInventory } from './tenant-backup-saml-dr-account-source';

/** Initial bounded capture; crossing a bound fails the export instead of truncating it. */
export const SAML_DR_SOURCE_MAX_ROWS = 4096;
export const SAML_DR_SOURCE_MAX_ACCOUNTS = 256;
export const SAML_DR_SOURCE_MAX_BYTES = 8 * 1024 * 1024;
export const SAML_DR_INVENTORY_COLUMNS = {
  'core.users_core': ['tenant_id', 'id'],
  'core.identity_accounts': [
    'tenant_id',
    'id',
    'account_type',
    'legacy_user_id',
    'lifecycle_state',
    'directory_publication_state',
    'account_route_generation',
  ],
  'core.passkeys': ['tenant_id', 'id', 'user_id', 'credential_id', 'counter', 'created_at'],
} as const;
export type SamlDrSqlInventory = Record<
  keyof typeof SAML_DR_INVENTORY_COLUMNS,
  PortableSqliteRow[]
>;

export function invalidSamlDrSqlSource(): never {
  throw new Error('saml_dr_sql_source_invalid');
}
export function canonicalSamlDrSource(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalSamlDrSource).join(',')}]`;
  if (!value || typeof value !== 'object') invalidSamlDrSqlSource();
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalSamlDrSource((value as Record<string, unknown>)[key])}`
    )
    .join(',')}}`;
}
export function samlDrText(row: PortableSqliteRow, column: string): string {
  const value = row[column];
  if (value?.[0] !== 'text' || typeof value[1] !== 'string' || !value[1]) invalidSamlDrSqlSource();
  return value[1];
}
export function samlDrInteger(row: PortableSqliteRow, column: string): string {
  const value = row[column];
  if (
    value?.[0] !== 'integer' ||
    typeof value[1] !== 'string' ||
    !/^(0|[1-9][0-9]*)$/u.test(value[1])
  )
    invalidSamlDrSqlSource();
  return value[1];
}
function identifier(value: string) {
  if (!/^[a-z][a-z0-9_]*$/u.test(value)) invalidSamlDrSqlSource();
  return `"${value}"`;
}

/** Preserve SQLite storage classes and full-width integers; never round through a JS number. */
export async function readBoundedSamlDrSqlRows(
  database: Pick<DatabaseAdapter, 'query'>,
  table: string,
  columns: readonly string[],
  predicate: string,
  params: unknown[],
  maximum = SAML_DR_SOURCE_MAX_ROWS
): Promise<PortableSqliteRow[]> {
  if (!columns.length || new Set(columns).size !== columns.length) invalidSamlDrSqlSource();
  const fragments: string[] = [];
  for (let from = 0; from < columns.length; from += 16) {
    fragments.push(
      `json_object(${columns
        .slice(from, from + 16)
        .map((column) => {
          const sql = identifier(column);
          return `'${column}',json_array(typeof(${sql}),CASE typeof(${sql}) WHEN 'null' THEN NULL WHEN 'blob' THEN hex(${sql}) WHEN 'integer' THEN CAST(${sql} AS TEXT) WHEN 'real' THEN printf('%!.17g',${sql}) ELSE ${sql} END)`;
        })
        .join(',')})`
    );
  }
  const expression = fragments.reduce((left, right) => `json_patch(${left},${right})`);
  const rows = await database.query<{ row_json: string }>(
    `SELECT ${expression} AS row_json FROM ${identifier(table)} WHERE ${predicate} LIMIT ?`,
    [...params, maximum + 1]
  );
  if (rows.length > maximum) invalidSamlDrSqlSource();
  let size = 0;
  return rows.map(({ row_json }) => {
    size += new TextEncoder().encode(row_json).length;
    if (size > SAML_DR_SOURCE_MAX_BYTES) invalidSamlDrSqlSource();
    return JSON.parse(row_json) as PortableSqliteRow;
  });
}

function entryFor(plan: readonly PlannedInstalledSqliteDataset[], datasetId: string) {
  const entries = plan.filter((entry) => entry.dataset.id === datasetId);
  if (entries.length !== 1) invalidSamlDrSqlSource();
  return entries[0];
}
function sourceOwns(
  context: AdapterContext,
  entry: PlannedInstalledSqliteDataset,
  resourceId: string
) {
  const role = phase8SqliteRestoreTargetRole(entry.dataset);
  if (role === 'admin')
    return context.databases.fixed.some((resource) => resource.databaseId === resourceId);
  return context.databases.tenant.some(
    (resource) =>
      resource.databaseId === resourceId &&
      resource.assignments.some((assignment) => assignment.dataRole === role)
  );
}
export async function readLiveSamlDrSqlInventory(
  context: AdapterContext,
  plan: readonly PlannedInstalledSqliteDataset[],
  assertHeld: () => Promise<void>
): Promise<SamlDrSqlInventory> {
  const result = {} as SamlDrSqlInventory;
  for (const [id, columns] of Object.entries(SAML_DR_INVENTORY_COLUMNS)) {
    const entry = entryFor(plan, id);
    if (columns.some((column) => !entry.capture.columns.includes(column))) invalidSamlDrSqlSource();
    const rows: PortableSqliteRow[] = [];
    const sources = plannedInstalledSqliteDatasetSources(entry).filter((source) =>
      sourceOwns(context, entry, source.resourceId)
    );
    if (!sources.length) invalidSamlDrSqlSource();
    for (const source of sources) {
      await assertHeld();
      const database = await context.resolveSource({
        resourceId: source.resourceId,
        family: entry.family,
      });
      rows.push(
        ...(await readBoundedSamlDrSqlRows(database, entry.table, columns, 'tenant_id=?', [
          context.context.lease.tenantId,
        ]))
      );
      if (rows.length > SAML_DR_SOURCE_MAX_ROWS) invalidSamlDrSqlSource();
      await assertHeld();
    }
    result[id as keyof SamlDrSqlInventory] = rows;
  }
  return result;
}

/** Use the exact already-admitted COW sources, retaining setup-owned Login UI rows. */
export async function readFrozenSamlDrSqlRows(
  context: AdapterContext,
  plan: readonly PlannedInstalledSqliteDataset[],
  datasetId: string
): Promise<PortableSqliteRow[]> {
  const entry = entryFor(plan, datasetId);
  if (
    !plannedInstalledSqliteDatasetSources(entry).some((source) =>
      sourceOwns(context, entry, source.resourceId)
    )
  )
    invalidSamlDrSqlSource();
  const shards = await Promise.all(
    plannedInstalledSqliteDatasetSources(entry).map(async (source) => ({
      resourceId: source.resourceId,
      firstOrdinal: source.firstOrdinal,
      snapshotId: (
        await context.snapshotResources.loadCapture(context.context.lease, source.resourceId)
      ).snapshotId,
    }))
  );
  const result: PortableSqliteRow[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let cursor: string | null = null,
    pending = '',
    size = 0;
  for (let page = 0; page < 4096; page++) {
    const next = await readNextShardedSqliteDatasetChunk(
      {
        context: context.context,
        inventory: context.inventory,
        resources: context.snapshotResources,
        dataset: entry.dataset,
        table: entry.table,
        capture: entry.capture,
        family: entry.family,
        selection: context.selection,
        partitions: entry.partitions,
        shards,
        resolveSource: async (shard) => ({
          resourceId: shard.resourceId,
          database: await context.resolveSource({
            resourceId: shard.resourceId,
            family: entry.family,
          }),
        }),
        assertResourceSet: async () => {}, // Immutable server plan, sealed inventory rechecked by reader.
        assertSourceStable: async () => {
          context.context.signal.throwIfAborted();
        },
        filterShardRow: async (shard) => sourceOwns(context, entry, shard.resourceId),
      },
      cursor
    );
    if (!next) {
      pending += decoder.decode();
      if (pending) invalidSamlDrSqlSource();
      return result;
    }
    if (next.nextCursor === cursor) invalidSamlDrSqlSource();
    cursor = next.nextCursor;
    size += next.bytes.byteLength;
    if (size > SAML_DR_SOURCE_MAX_BYTES) invalidSamlDrSqlSource();
    pending += decoder.decode(next.bytes, { stream: true });
    let end: number;
    while ((end = pending.indexOf('\n')) !== -1) {
      const row = JSON.parse(pending.slice(0, end)) as PortableSqliteRow;
      if (samlDrText(row, 'tenant_id') !== context.context.lease.tenantId) invalidSamlDrSqlSource();
      result.push(row);
      if (result.length > SAML_DR_SOURCE_MAX_ROWS) invalidSamlDrSqlSource();
      pending = pending.slice(end + 1);
    }
  }
  return invalidSamlDrSqlSource();
}

export async function assertSamlDrSqlInventoryFrozen(
  context: AdapterContext,
  plan: readonly PlannedInstalledSqliteDataset[],
  expected: SamlDrSqlInventory
): Promise<void> {
  for (const [id, columns] of Object.entries(SAML_DR_INVENTORY_COLUMNS)) {
    const actual = (await readFrozenSamlDrSqlRows(context, plan, id)).map((row) =>
      Object.fromEntries(columns.map((column) => [column, row[column]]))
    );
    const normalize = (rows: readonly unknown[]) => rows.map(canonicalSamlDrSource).sort();
    if (
      canonicalSamlDrSource(normalize(actual)) !==
      canonicalSamlDrSource(normalize(expected[id as keyof SamlDrSqlInventory]))
    )
      invalidSamlDrSqlSource();
  }
}

export function samlDrAccountInventory(
  tenantId: string,
  sql: SamlDrSqlInventory
): SamlDrAccountSourceInventory[] {
  const users = new Set(sql['core.users_core'].map((row) => samlDrText(row, 'id')));
  if (users.size !== sql['core.users_core'].length || users.size > SAML_DR_SOURCE_MAX_ACCOUNTS)
    invalidSamlDrSqlSource();
  for (const rows of Object.values(sql))
    for (const row of rows) if (samlDrText(row, 'tenant_id') !== tenantId) invalidSamlDrSqlSource();
  const accounts = sql['core.identity_accounts'].filter(
    (row) => samlDrText(row, 'account_type') === 'user'
  );
  const result = accounts.map((row) => {
    const userId = samlDrText(row, 'legacy_user_id');
    if (!users.delete(userId) || samlDrText(row, 'directory_publication_state') !== 'active')
      invalidSamlDrSqlSource();
    return {
      tenantId,
      userId,
      accountId: samlDrText(row, 'id'),
      passkeys: sql['core.passkeys']
        .filter((passkey) => samlDrText(passkey, 'user_id') === userId)
        .map((passkey) => {
          const createdAtMs = Number(samlDrInteger(passkey, 'created_at'));
          if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 1) invalidSamlDrSqlSource();
          return {
            passkeyId: samlDrText(passkey, 'id'),
            credentialId: samlDrText(passkey, 'credential_id'),
            counter: samlDrInteger(passkey, 'counter'),
            updatedAtMs: createdAtMs,
          };
        }),
    };
  });
  if (
    users.size ||
    result.reduce((total, account) => total + account.passkeys.length, 0) !==
      sql['core.passkeys'].length
  )
    invalidSamlDrSqlSource();
  return result;
}
