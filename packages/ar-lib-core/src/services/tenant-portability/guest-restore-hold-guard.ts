import type { DatabaseAdapter } from '../../db/adapter';
import { parseGuestDeletionReceiptV2 } from '../guest-deletion-receipt';
import type { PortableSqliteRow } from './sqlite-dataset-inspector';

export interface PreparedGuestRestoreRow {
  table: string;
  rowJson: string;
}
export interface GuestRestoreHoldGuard {
  sql: string;
  params: unknown[];
}
interface AccountSnapshot {
  id: string;
  tenant_id: string;
  legacy_user_id: string | null;
  account_type: string;
  registration_state: string | null;
  account_route_generation: number;
}
interface GuestSnapshot {
  user_id: string;
  phase: string;
  revision: number;
  deletion_operation_id: string | null;
  deletion_route_json: string | null;
  deletion_started_at_ms: number | null;
}
const ACCOUNT_KEYS = [
  'id',
  'tenant_id',
  'legacy_user_id',
  'account_type',
  'registration_state',
  'account_route_generation',
] as const;
const GUEST_KEYS = [
  'phase',
  'revision',
  'deletion_operation_id',
  'deletion_route_json',
  'deletion_started_at_ms',
] as const;
const reject = () => new Error('backup_restore_target_rejected');
const CHUNK = 90;

function row(value: string): PortableSqliteRow {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw reject();
  return parsed as PortableSqliteRow;
}
function cell(value: PortableSqliteRow, name: string): string | number | null {
  const field = value[name];
  if (!Array.isArray(field) || field.length !== 2) throw reject();
  if (field[0] === 'null' && field[1] === null) return null;
  if (field[0] === 'text' && typeof field[1] === 'string') return field[1];
  if (field[0] === 'integer' && typeof field[1] === 'string' && /^-?\d+$/u.test(field[1])) {
    const number = Number(field[1]);
    if (Number.isSafeInteger(number)) return number;
  }
  throw reject();
}
function account(value: Record<string, unknown>): AccountSnapshot {
  if (
    typeof value.id !== 'string' ||
    !value.id ||
    typeof value.tenant_id !== 'string' ||
    !value.tenant_id ||
    (value.legacy_user_id !== null && typeof value.legacy_user_id !== 'string') ||
    typeof value.account_type !== 'string' ||
    !value.account_type ||
    (value.registration_state !== null && typeof value.registration_state !== 'string') ||
    !Number.isSafeInteger(value.account_route_generation) ||
    Number(value.account_route_generation) < 1
  )
    throw reject();
  return {
    id: value.id,
    tenant_id: value.tenant_id,
    legacy_user_id: value.legacy_user_id,
    account_type: value.account_type,
    registration_state: value.registration_state,
    account_route_generation: Number(value.account_route_generation),
  };
}
function guest(value: Record<string, unknown>): GuestSnapshot {
  if (
    typeof value.user_id !== 'string' ||
    !value.user_id ||
    !['active', 'upgrading', 'registered', 'deleting', 'deleted'].includes(String(value.phase)) ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1 ||
    (value.deletion_operation_id !== null && typeof value.deletion_operation_id !== 'string') ||
    (value.deletion_route_json !== null && typeof value.deletion_route_json !== 'string') ||
    (value.deletion_started_at_ms !== null &&
      (!Number.isSafeInteger(value.deletion_started_at_ms) ||
        Number(value.deletion_started_at_ms) < 1))
  )
    throw reject();
  return {
    user_id: value.user_id,
    phase: String(value.phase),
    revision: Number(value.revision),
    deletion_operation_id: value.deletion_operation_id,
    deletion_route_json: value.deletion_route_json,
    deletion_started_at_ms:
      value.deletion_started_at_ms === null ? null : Number(value.deletion_started_at_ms),
  };
}

/**
 * Read one bounded primary snapshot for a complete restore slice, rather than two queries per
 * active hold. Each resulting predicate still pins that exact snapshot in the write itself.
 */
export async function loadGuestRestoreHoldGuards(
  database: Pick<DatabaseAdapter, 'query'>,
  tenantId: string,
  rows: readonly PreparedGuestRestoreRow[]
): Promise<
  (
    table: string,
    rowJson: string,
    preceding: readonly PreparedGuestRestoreRow[]
  ) => GuestRestoreHoldGuard | null
> {
  const ids = new Set<string>();
  for (const input of rows) {
    if (input.table !== 'legal_holds') continue;
    const current = row(input.rowJson);
    if (cell(current, 'state') !== 'active') continue;
    const id = cell(current, 'subject_id');
    if (
      cell(current, 'tenant_id') !== tenantId ||
      cell(current, 'subject_type') !== 'account' ||
      typeof id !== 'string' ||
      !id ||
      id.length > 4096
    )
      throw reject();
    ids.add(id);
  }
  if (ids.size > 500) throw reject();
  const decoded = new Map<string, PortableSqliteRow>();
  const decode = (json: string) => {
    const cached = decoded.get(json);
    if (cached) return cached;
    const value = row(json);
    decoded.set(json, value);
    return value;
  };
  const accounts = new Map<string, AccountSnapshot>();
  const guests = new Map<string, GuestSnapshot>();
  let bytes = 0;
  const budget = (value: unknown) => {
    bytes += new TextEncoder().encode(JSON.stringify(value)).byteLength;
    if (bytes > 4 * 1024 * 1024) throw reject();
  };
  const requested = [...ids];
  for (let offset = 0; offset < requested.length; offset += CHUNK) {
    const chunk = requested.slice(offset, offset + CHUNK);
    const result = await database.query<Record<string, unknown>>(
      `SELECT ${ACCOUNT_KEYS.join(',')} FROM identity_accounts
       WHERE tenant_id=? AND id IN (${chunk.map(() => '?').join(',')})`,
      [tenantId, ...chunk],
      { consistencyClass: 'primary_required' }
    );
    if (result.length > chunk.length) throw reject();
    for (const value of result) {
      budget(value);
      const snapshot = account(value);
      if (
        snapshot.tenant_id !== tenantId ||
        !chunk.includes(snapshot.id) ||
        accounts.has(snapshot.id)
      )
        throw reject();
      accounts.set(snapshot.id, snapshot);
    }
  }
  const userIds = new Set(
    [...accounts.values()].flatMap((a) => (a.legacy_user_id ? [a.legacy_user_id] : []))
  );
  // A preceding planned account may not exist until the ordered batch runs. Its lifecycle may
  // already exist, so include its exact legacy identity in the same bounded primary read set.
  for (const input of rows) {
    if (input.table !== 'identity_accounts') continue;
    const value = row(input.rowJson);
    if (cell(value, 'tenant_id') !== tenantId) throw reject();
    const id = cell(value, 'id');
    if (typeof id === 'string' && ids.has(id)) {
      const userId = cell(value, 'legacy_user_id');
      if (typeof userId === 'string' && userId) userIds.add(userId);
    }
  }
  if (userIds.size > 500) throw reject();
  const users = [...userIds];
  for (let offset = 0; offset < users.length; offset += CHUNK) {
    const chunk = users.slice(offset, offset + CHUNK);
    const result = await database.query<Record<string, unknown>>(
      `SELECT user_id,${GUEST_KEYS.join(',')} FROM guest_account_lifecycle
       WHERE tenant_id=? AND user_id IN (${chunk.map(() => '?').join(',')})`,
      [tenantId, ...chunk],
      { consistencyClass: 'primary_required' }
    );
    if (result.length > chunk.length) throw reject();
    for (const value of result) {
      budget(value);
      const snapshot = guest(value);
      if (!chunk.includes(snapshot.user_id) || guests.has(snapshot.user_id)) throw reject();
      guests.set(snapshot.user_id, snapshot);
    }
  }
  return (table, rowJson, preceding) => {
    if (table !== 'legal_holds') return null;
    const current = row(rowJson);
    if (cell(current, 'state') !== 'active') return null;
    const id = cell(current, 'subject_id');
    if (
      typeof id !== 'string' ||
      !ids.has(id) ||
      cell(current, 'tenant_id') !== tenantId ||
      cell(current, 'subject_type') !== 'account'
    )
      throw reject();
    const planned = (name: string, key: string, expected: string) => {
      const matches = preceding
        .filter((input) => input.table === name)
        .map((input) => decode(input.rowJson))
        .filter((value) => cell(value, 'tenant_id') === tenantId && cell(value, key) === expected);
      if (matches.length > 1) throw reject();
      return matches[0];
    };
    const plannedOwner = planned('identity_accounts', 'id', id);
    const owner =
      accounts.get(id) ??
      (plannedOwner
        ? account(Object.fromEntries(ACCOUNT_KEYS.map((key) => [key, cell(plannedOwner, key)])))
        : null);
    if (!owner) throw reject();
    const plannedLifecycle = owner.legacy_user_id
      ? planned('guest_account_lifecycle', 'user_id', owner.legacy_user_id)
      : undefined;
    const lifecycle =
      (owner.legacy_user_id && guests.get(owner.legacy_user_id)) ||
      (plannedLifecycle
        ? guest(
            Object.fromEntries(
              ['user_id', ...GUEST_KEYS].map((key) => [key, cell(plannedLifecycle, key)])
            )
          )
        : null);
    if (lifecycle?.phase === 'deleted') throw reject();
    if (lifecycle?.phase === 'deleting') {
      if (
        owner.account_type !== 'user' ||
        owner.registration_state !== 'guest' ||
        !owner.legacy_user_id ||
        !lifecycle.deletion_operation_id ||
        !lifecycle.deletion_started_at_ms
      )
        throw reject();
      try {
        const receipt = parseGuestDeletionReceiptV2(lifecycle.deletion_route_json, {
          tenantId,
          userId: owner.legacy_user_id,
          accountId: owner.id,
          operationId: lifecycle.deletion_operation_id,
          acceptedOnly: true,
        });
        if (receipt.accountRouteGeneration !== owner.account_route_generation) throw reject();
      } catch {
        throw reject();
      }
    } else if (
      lifecycle &&
      (lifecycle.deletion_operation_id !== null ||
        lifecycle.deletion_route_json !== null ||
        lifecycle.deletion_started_at_ms !== null)
    )
      throw reject();
    const guestSql = lifecycle
      ? `EXISTS (SELECT 1 FROM guest_account_lifecycle guest WHERE guest.tenant_id=account.tenant_id
         AND guest.user_id=account.legacy_user_id AND ${GUEST_KEYS.map((key) => `guest.${key} IS ?`).join(' AND ')})`
      : `NOT EXISTS (SELECT 1 FROM guest_account_lifecycle guest
         WHERE guest.tenant_id=account.tenant_id AND guest.user_id=account.legacy_user_id)`;
    return {
      sql: `EXISTS (SELECT 1 FROM identity_accounts account
        WHERE ${ACCOUNT_KEYS.map((key) => `account.${key} IS ?`).join(' AND ')} AND ${guestSql})`,
      params: [
        ...ACCOUNT_KEYS.map((key) => owner[key]),
        ...(lifecycle ? GUEST_KEYS.map((key) => lifecycle[key]) : []),
      ],
    };
  };
}
