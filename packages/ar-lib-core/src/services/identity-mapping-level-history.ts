import type { DatabaseAdapter, PreparedStatement } from '../db/adapter';
import { sanitizeObject } from '../utils/security';

export type IdentityMappingLevelHistoryDatabase = Pick<
  DatabaseAdapter,
  'query' | 'queryOne' | 'execute'
>;

export type IdentityMappingLevelHistoryTier = 'tenant_default' | 'client';
export type IdentityMappingLevelHistoryStatus = 'pending' | 'committed' | 'aborted';
export type IdentityMappingLevelHistoryVia = 'settings' | 'client' | 'bulk_apply' | 'restore';
/** The level's own value. Null means unset, independently of inherited defaults. */
export type IdentityMappingLevelHistoryChoice = string | Record<string, unknown> | null;

export interface IdentityMappingLevelHistoryMetadata {
  actorId: string;
  actorType: string;
  via: IdentityMappingLevelHistoryVia;
  bulkId?: string;
  /** Restore-only guard against an intervening level change, including a raw-value ABA. */
  expectedLatestHistoryId?: string;
}

export interface IdentityMappingLevelHistoryInput extends IdentityMappingLevelHistoryMetadata {
  id: string;
  tenantId: string;
  tier: IdentityMappingLevelHistoryTier;
  clientId?: string | null;
  before: IdentityMappingLevelHistoryChoice;
  after: IdentityMappingLevelHistoryChoice;
  /** The committed source version; a pending intent may hold its proposed version. */
  sourceVersion: string;
  now?: number;
}

export interface IdentityMappingLevelHistoryRow {
  id: string;
  tenant_id: string;
  tier: IdentityMappingLevelHistoryTier;
  client_id: string | null;
  before_json: string;
  after_json: string;
  actor_id: string;
  actor_type: string;
  via: IdentityMappingLevelHistoryVia;
  bulk_id: string | null;
  source_version: string;
  status: IdentityMappingLevelHistoryStatus;
  created_at: number;
  updated_at: number;
  committed_at: number | null;
  last_reconciled_at: number;
  receipt_acknowledged_at: number | null;
}

export interface IdentityMappingLevelHistoryReceipt {
  historyId: string;
  tenantId: string;
  clientId: string;
  before: IdentityMappingLevelHistoryChoice;
  after: IdentityMappingLevelHistoryChoice;
  expectedSourceVersion: string;
  sourceVersion: string;
}

function timestamp(now = Date.now()): number {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('identity_mapping_history_invalid');
  return now;
}

export function normalizeIdentityMappingLevelHistoryChoice(
  tier: IdentityMappingLevelHistoryTier,
  raw: unknown
): IdentityMappingLevelHistoryChoice {
  if (raw === undefined || raw === null) return null;
  if (tier === 'tenant_default') {
    if (typeof raw !== 'string') throw new Error('identity_mapping_history_choice_invalid');
    return raw;
  }
  if (typeof raw === 'string' && raw.trim() === '') return null;
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error('identity_mapping_history_choice_invalid');
    }
  }
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('identity_mapping_history_choice_invalid');
  }
  const safe = sanitizeObject(value as Record<string, unknown>);
  return Object.fromEntries(
    Object.entries(safe).sort(([left], [right]) => left.localeCompare(right))
  );
}

export function identityMappingLevelHistoryChoicesEqual(
  tier: IdentityMappingLevelHistoryTier,
  before: unknown,
  after: unknown
): boolean {
  return (
    JSON.stringify(normalizeIdentityMappingLevelHistoryChoice(tier, before)) ===
    JSON.stringify(normalizeIdentityMappingLevelHistoryChoice(tier, after))
  );
}

/** An INSERT the owner may compose into the same atomic batch as its source update. */
export function identityMappingLevelHistoryInsertStatement(
  input: IdentityMappingLevelHistoryInput,
  status: 'pending' | 'committed' = 'pending',
  condition?: { sql: string; params: unknown[] }
): PreparedStatement {
  const now = timestamp(input.now);
  if (
    !input.id ||
    !input.tenantId ||
    !input.actorId ||
    !input.actorType ||
    !input.sourceVersion ||
    (input.tier === 'client' ? !input.clientId : Boolean(input.clientId))
  ) {
    throw new Error('identity_mapping_history_invalid');
  }
  // Allocate order in the same Admin write as the intent. UUID ordering and wall clocks do
  // not preserve consecutive changes made within one millisecond or after a clock rollback.
  return {
    sql: `INSERT INTO identity_mapping_level_history
      (id,tenant_id,tier,client_id,before_json,after_json,actor_id,actor_type,via,bulk_id,
       source_version,status,created_at,updated_at,committed_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,stamp,stamp,${status === 'committed' ? 'stamp' : 'NULL'}
      FROM (
        SELECT max(?,COALESCE(MAX(created_at)+1,0)) AS stamp
        FROM identity_mapping_level_history
        WHERE tenant_id=? AND tier=? AND client_id IS ?
      )${condition ? ` WHERE ${condition.sql}` : ''}`,
    params: [
      input.id,
      input.tenantId,
      input.tier,
      input.clientId ?? null,
      JSON.stringify(normalizeIdentityMappingLevelHistoryChoice(input.tier, input.before)),
      JSON.stringify(normalizeIdentityMappingLevelHistoryChoice(input.tier, input.after)),
      input.actorId,
      input.actorType,
      input.via,
      input.bulkId ?? null,
      input.sourceVersion,
      status,
      now,
      input.tenantId,
      input.tier,
      input.clientId ?? null,
      ...(condition?.params ?? []),
    ],
  };
}

export async function readIdentityMappingLevelHistory(
  admin: IdentityMappingLevelHistoryDatabase,
  tenantId: string,
  id: string
): Promise<IdentityMappingLevelHistoryRow | null> {
  return admin.queryOne<IdentityMappingLevelHistoryRow>(
    'SELECT * FROM identity_mapping_level_history WHERE tenant_id=? AND id=?',
    [tenantId, id],
    { consistencyClass: 'primary_required' }
  );
}

export const readIdentityMappingLevelHistoryById = readIdentityMappingLevelHistory;

export async function prepareIdentityMappingLevelHistory(
  admin: IdentityMappingLevelHistoryDatabase,
  input: IdentityMappingLevelHistoryInput
): Promise<IdentityMappingLevelHistoryRow> {
  const statement = identityMappingLevelHistoryInsertStatement(input);
  try {
    await admin.execute(statement.sql, statement.params);
  } catch (error) {
    // A lost successful INSERT response may be retried only for the same immutable intent.
    const existing = await readIdentityMappingLevelHistory(admin, input.tenantId, input.id);
    const expected = statement.params;
    if (
      !existing ||
      !expected ||
      existing.tier !== input.tier ||
      existing.client_id !== (input.clientId ?? null) ||
      existing.before_json !== expected[4] ||
      existing.after_json !== expected[5] ||
      existing.actor_id !== input.actorId ||
      existing.actor_type !== input.actorType ||
      existing.via !== input.via ||
      existing.bulk_id !== (input.bulkId ?? null) ||
      (existing.status === 'pending' && existing.source_version !== input.sourceVersion)
    )
      throw error;
    return existing;
  }
  const row = await readIdentityMappingLevelHistory(admin, input.tenantId, input.id);
  if (!row) throw new Error('identity_mapping_history_unavailable');
  return row;
}

export async function commitIdentityMappingLevelHistory(
  admin: IdentityMappingLevelHistoryDatabase,
  id: string,
  tenantId: string,
  options: { sourceVersion?: string; now?: number } = {}
): Promise<void> {
  const now = timestamp(options.now);
  await admin.execute(
    `UPDATE identity_mapping_level_history SET status='committed',source_version=COALESCE(?,source_version),
       updated_at=max(updated_at,?),committed_at=max(created_at,?)
     WHERE tenant_id=? AND id=? AND status='pending'`,
    [options.sourceVersion ?? null, now, now, tenantId, id]
  );
  const row = await readIdentityMappingLevelHistory(admin, tenantId, id);
  if (
    row?.status !== 'committed' ||
    (options.sourceVersion !== undefined && row.source_version !== options.sourceVersion)
  ) {
    throw new Error('identity_mapping_history_unavailable');
  }
}

/** Positive source-side evidence, never the current client value, confirms the prepared history. */
export async function finalizeIdentityMappingLevelHistoryFromReceipt(
  admin: IdentityMappingLevelHistoryDatabase,
  receipt: IdentityMappingLevelHistoryReceipt,
  now?: number
): Promise<IdentityMappingLevelHistoryRow> {
  const row = await readIdentityMappingLevelHistory(admin, receipt.tenantId, receipt.historyId);
  if (
    !row ||
    row.tier !== 'client' ||
    row.client_id !== receipt.clientId ||
    row.status === 'aborted' ||
    !identityMappingLevelHistoryChoicesEqual(
      'client',
      JSON.parse(row.before_json) as unknown,
      receipt.before
    ) ||
    !identityMappingLevelHistoryChoicesEqual(
      'client',
      JSON.parse(row.after_json) as unknown,
      receipt.after
    ) ||
    row.source_version !==
      (row.status === 'committed' ? receipt.sourceVersion : receipt.expectedSourceVersion)
  ) {
    throw new Error('identity_mapping_history_receipt_mismatch');
  }
  await commitIdentityMappingLevelHistory(admin, receipt.historyId, receipt.tenantId, {
    sourceVersion: receipt.sourceVersion,
    now,
  });
  const confirmed = await readIdentityMappingLevelHistory(
    admin,
    receipt.tenantId,
    receipt.historyId
  );
  if (
    !confirmed ||
    confirmed.status !== 'committed' ||
    confirmed.source_version !== receipt.sourceVersion
  ) {
    throw new Error('identity_mapping_history_unavailable');
  }
  return confirmed;
}

export async function abortIdentityMappingLevelHistory(
  admin: IdentityMappingLevelHistoryDatabase,
  id: string,
  tenantId: string,
  now?: number
): Promise<void> {
  await admin.execute(
    `UPDATE identity_mapping_level_history SET status='aborted',updated_at=max(updated_at,?)
     WHERE tenant_id=? AND id=? AND status='pending'`,
    [timestamp(now), tenantId, id]
  );
}

export async function listPendingIdentityMappingLevelHistory(
  admin: IdentityMappingLevelHistoryDatabase,
  limit = 25,
  tenantId?: string
): Promise<IdentityMappingLevelHistoryRow[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('identity_mapping_history_invalid');
  }
  return admin.query<IdentityMappingLevelHistoryRow>(
    `SELECT * FROM identity_mapping_level_history WHERE status='pending' AND tier='client'${tenantId ? ' AND tenant_id=?' : ''}
     ORDER BY last_reconciled_at,created_at,id LIMIT ?`,
    tenantId ? [tenantId, limit] : [limit],
    { consistencyClass: 'primary_required' }
  );
}
