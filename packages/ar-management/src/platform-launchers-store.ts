/**
 * The platform's application launchers (admin migration 026): reading and writing them in the
 * admin database. The routes are routes/platform-launchers.ts; a tenant's merge of the ones shared
 * with it is launchers.ts.
 *
 * A change is written by version: the row's `version` must still be the one the change was made
 * from. The tenant list a change replaces is written in the same batch, each statement only while
 * the row carries this change's `write_token`, so a change that lost the race writes nothing.
 */
import type {
  ApplicationLauncher,
  DatabaseAdapter,
  PlatformLauncher,
  PlatformLauncherShareMode,
} from '@authrim/ar-lib-core';
import { storedLauncher } from './launcher-config';

/** The most launchers the platform may define. */
export const PLATFORM_LAUNCHER_LIMIT = 100;
/** The most tenants a launcher may be shared with one by one. */
export const PLATFORM_LAUNCHER_TENANT_LIMIT = 1000;
/** The id prefix of the platform's launchers (a tenant's own launchers have bare UUIDs). */
export const PLATFORM_LAUNCHER_ID_PREFIX = 'plc_';
export const PLATFORM_LAUNCHER_ID_PATTERN = /^plc_[0-9a-f-]{36}$/u;

const SHARE_MODES = new Set<PlatformLauncherShareMode>(['none', 'all', 'selected']);
/** Tenant ids per statement: two bound values each, under D1's 100 per statement. */
const TENANTS_PER_STATEMENT = 40;

interface PlatformLauncherRow {
  id: string;
  config_json: string;
  share_mode: string;
  tenant_change_allowed: number;
  sort_order: number;
  version: number;
  created_at: number;
  updated_at: number;
}

export function isPlatformLauncherShareMode(value: unknown): value is PlatformLauncherShareMode {
  return typeof value === 'string' && SHARE_MODES.has(value as PlatformLauncherShareMode);
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function toPlatformLauncher(row: PlatformLauncherRow, tenantIds: string[]): PlatformLauncher {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.config_json);
  } catch {
    throw new Error(`Invalid platform launcher JSON: ${row.id}`);
  }
  const launcher = storedLauncher(parsed);
  if (!launcher || launcher.id !== row.id) {
    throw new Error(`Invalid platform launcher configuration: ${row.id}`);
  }
  const shareMode = isPlatformLauncherShareMode(row.share_mode) ? row.share_mode : 'none';
  return {
    ...launcher,
    sort_order: Number(row.sort_order),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    share_mode: shareMode,
    tenant_ids: shareMode === 'selected' ? [...tenantIds].sort() : [],
    tenant_change_allowed: Number(row.tenant_change_allowed) === 1,
    version: Number(row.version),
  };
}

function byOrder(left: ApplicationLauncher, right: ApplicationLauncher): number {
  return left.sort_order === right.sort_order
    ? left.created_at - right.created_at || left.id.localeCompare(right.id)
    : left.sort_order - right.sort_order;
}

const COLUMNS = `id, config_json, share_mode, tenant_change_allowed, sort_order, version,
  created_at, updated_at`;

async function tenantIdsOf(
  adapter: DatabaseAdapter,
  launcherIds: readonly string[]
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  for (const ids of chunk(launcherIds, 90)) {
    const rows = await adapter.query<{ launcher_id: string; tenant_id: string }>(
      `SELECT launcher_id, tenant_id FROM platform_launcher_tenants
        WHERE launcher_id IN (${ids.map(() => '?').join(', ')})`,
      [...ids]
    );
    for (const row of rows) {
      result.set(row.launcher_id, [...(result.get(row.launcher_id) ?? []), row.tenant_id]);
    }
  }
  return result;
}

/** Every platform launcher, in the platform's order. */
export async function listPlatformLaunchers(adapter: DatabaseAdapter): Promise<PlatformLauncher[]> {
  const rows = await adapter.query<PlatformLauncherRow>(
    `SELECT ${COLUMNS} FROM platform_launchers ORDER BY created_at ASC, id ASC LIMIT ?`,
    [PLATFORM_LAUNCHER_LIMIT + 1]
  );
  if (rows.length > PLATFORM_LAUNCHER_LIMIT) throw new Error('Platform launcher limit exceeded');
  const selected = rows.filter((row) => row.share_mode === 'selected').map((row) => row.id);
  const tenants = await tenantIdsOf(adapter, selected);
  return rows.map((row) => toPlatformLauncher(row, tenants.get(row.id) ?? [])).sort(byOrder);
}

export async function findPlatformLauncher(
  adapter: DatabaseAdapter,
  id: string
): Promise<PlatformLauncher | null> {
  if (!PLATFORM_LAUNCHER_ID_PATTERN.test(id)) return null;
  const row = await adapter.queryOne<PlatformLauncherRow>(
    `SELECT ${COLUMNS} FROM platform_launchers WHERE id = ?`,
    [id]
  );
  if (!row) return null;
  const tenants = row.share_mode === 'selected' ? await tenantIdsOf(adapter, [row.id]) : null;
  return toPlatformLauncher(row, tenants?.get(row.id) ?? []);
}

/** The platform launchers shared with a tenant (every one, enabled or not), in platform order. */
export async function listPlatformLaunchersSharedWith(
  adapter: DatabaseAdapter,
  tenantId: string
): Promise<PlatformLauncher[]> {
  const rows = await adapter.query<PlatformLauncherRow>(
    `SELECT ${COLUMNS} FROM platform_launchers
      WHERE share_mode = 'all'
         OR (share_mode = 'selected' AND id IN (
              SELECT launcher_id FROM platform_launcher_tenants WHERE tenant_id = ?))
      ORDER BY created_at ASC, id ASC LIMIT ?`,
    [tenantId, PLATFORM_LAUNCHER_LIMIT + 1]
  );
  if (rows.length > PLATFORM_LAUNCHER_LIMIT) throw new Error('Platform launcher limit exceeded');
  // The tenant list itself is not needed here: it is the platform's to show.
  return rows.map((row) => toPlatformLauncher(row, [])).sort(byOrder);
}

export interface PlatformLauncherWrite {
  launcher: ApplicationLauncher;
  shareMode: PlatformLauncherShareMode;
  tenantIds: string[];
  tenantChangeAllowed: boolean;
  /**
   * A change writes the launcher's place only when the request named one: the order is written on
   * its own (PUT /order) and a change made from an earlier read must not put an older place back.
   */
  writeSortOrder?: boolean;
}

function tenantInserts(launcherId: string, tenantIds: readonly string[], token: string | null) {
  return chunk(tenantIds, TENANTS_PER_STATEMENT).map((ids) => ({
    sql: `INSERT INTO platform_launcher_tenants (launcher_id, tenant_id)
          SELECT launcher_id, tenant_id FROM (${ids
            .map(() => 'SELECT ? AS launcher_id, ? AS tenant_id')
            .join(' UNION ALL ')})
          ${token === null ? '' : 'WHERE EXISTS (SELECT 1 FROM platform_launchers WHERE id = ? AND write_token = ?)'}`,
    params: [
      ...ids.flatMap((tenantId) => [launcherId, tenantId]),
      ...(token === null ? [] : [launcherId, token]),
    ],
  }));
}

/**
 * Adds a launcher while the platform has fewer than its most (checked in the same statement, so two
 * at once cannot pass it together); false when it has its most. Its tenants are written only with
 * it.
 */
export async function insertPlatformLauncher(
  adapter: DatabaseAdapter,
  input: PlatformLauncherWrite,
  createdBy: string | null
): Promise<boolean> {
  const { launcher } = input;
  const tenantIds = input.shareMode === 'selected' ? input.tenantIds : [];
  const token = crypto.randomUUID();
  const results = await adapter.batch([
    {
      sql: `INSERT INTO platform_launchers
              (id, config_json, share_mode, tenant_change_allowed, sort_order, version,
               write_token, created_by, created_at, updated_at)
            SELECT ?, ?, ?, ?, ?, 1, ?, ?, ?, ?
             WHERE (SELECT COUNT(*) FROM platform_launchers) < ?`,
      params: [
        launcher.id,
        JSON.stringify(launcher),
        input.shareMode,
        input.tenantChangeAllowed ? 1 : 0,
        launcher.sort_order,
        token,
        createdBy,
        launcher.created_at,
        launcher.updated_at,
        PLATFORM_LAUNCHER_LIMIT,
      ],
    },
    ...tenantInserts(launcher.id, tenantIds, token),
  ]);
  return (results[0]?.rowsAffected ?? 0) === 1;
}

/** Writes a change made from `version`; false when the launcher is at another version (or gone). */
export async function updatePlatformLauncher(
  adapter: DatabaseAdapter,
  input: PlatformLauncherWrite,
  version: number
): Promise<boolean> {
  const { launcher } = input;
  const token = crypto.randomUUID();
  const tenantIds = input.shareMode === 'selected' ? input.tenantIds : [];
  const results = await adapter.batch([
    {
      sql: `UPDATE platform_launchers
               SET config_json = ?, share_mode = ?, tenant_change_allowed = ?,
                   sort_order = CASE WHEN ? = 1 THEN ? ELSE sort_order END,
                   version = version + 1, write_token = ?, updated_at = ?
             WHERE id = ? AND version = ?`,
      params: [
        JSON.stringify(launcher),
        input.shareMode,
        input.tenantChangeAllowed ? 1 : 0,
        input.writeSortOrder ? 1 : 0,
        launcher.sort_order,
        token,
        launcher.updated_at,
        launcher.id,
        version,
      ],
    },
    {
      sql: `DELETE FROM platform_launcher_tenants
             WHERE launcher_id = ?
               AND EXISTS (SELECT 1 FROM platform_launchers WHERE id = ? AND write_token = ?)`,
      params: [launcher.id, launcher.id, token],
    },
    ...tenantInserts(launcher.id, tenantIds, token),
  ]);
  return (results[0]?.rowsAffected ?? 0) === 1;
}

/** Writes the platform's order (each launcher's `sort_order`, not a change of the launcher). */
export async function writePlatformLauncherOrder(
  adapter: DatabaseAdapter,
  order: ReadonlyArray<{ id: string; sort_order: number }>
): Promise<void> {
  await adapter.batch(
    order.map((entry) => ({
      sql: 'UPDATE platform_launchers SET sort_order = ? WHERE id = ?',
      params: [entry.sort_order, entry.id],
    }))
  );
}

export async function deletePlatformLauncher(
  adapter: DatabaseAdapter,
  id: string,
  version: number
): Promise<boolean> {
  const results = await adapter.batch([
    {
      sql: `DELETE FROM platform_launcher_tenants
             WHERE launcher_id = ?
               AND EXISTS (SELECT 1 FROM platform_launchers WHERE id = ? AND version = ?)`,
      params: [id, id, version],
    },
    { sql: 'DELETE FROM platform_launchers WHERE id = ? AND version = ?', params: [id, version] },
  ]);
  return (results[1]?.rowsAffected ?? 0) === 1;
}

/** The launcher as stored in `config_json` (without the platform's columns). */
export function storedShape(launcher: PlatformLauncher): ApplicationLauncher {
  const {
    share_mode: _shareMode,
    tenant_ids: _tenantIds,
    tenant_change_allowed: _changeAllowed,
    version: _version,
    ...stored
  } = launcher;
  return stored;
}
