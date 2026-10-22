/**
 * What a deletion writes into the deleted account's tombstone, decided before the deletion
 * changes anything: the keyed fingerprint of its email and how long the record is kept (the
 * tenant's setting, or the deletion request's own period where the API accepts one); and the
 * write itself, safe to repeat.
 */
import {
  createTombstoneEmailIndexForDeletion,
  isValidTombstoneRetentionDays,
  resolveAccountTombstonePolicy,
  TombstoneRepository,
  type DatabaseAdapter,
  type Env,
  type PreparedStatement,
  type Tombstone,
} from '@authrim/ar-lib-core';
import { loadLookupHmacRuntimeKeys } from './lookup-hmac-runtime';

export interface PreparedAccountTombstone {
  emailBlindIndex: string | null;
  retentionDays: number;
}

export class TombstoneRetentionDaysInvalidError extends Error {
  constructor() {
    super('tombstone_retention_days_invalid');
    this.name = 'TombstoneRetentionDaysInvalidError';
  }
}

export async function prepareAccountTombstone(
  env: Env,
  input: { tenantId: string; email: string | null | undefined; retentionDays?: unknown }
): Promise<PreparedAccountTombstone> {
  if (input.retentionDays !== undefined && !isValidTombstoneRetentionDays(input.retentionDays)) {
    throw new TombstoneRetentionDaysInvalidError();
  }
  const [policy, emailBlindIndex] = await Promise.all([
    input.retentionDays === undefined
      ? resolveAccountTombstonePolicy(env, input.tenantId)
      : Promise.resolve(null),
    createTombstoneEmailIndexForDeletion(env, input.email, {
      loadKeys: (runtimeEnv) => loadLookupHmacRuntimeKeys(runtimeEnv),
    }),
  ]);
  return {
    emailBlindIndex,
    retentionDays: (input.retentionDays as number | undefined) ?? policy!.retentionDays,
  };
}

export interface AccountTombstoneWrite {
  tenantId: string;
  userId: string;
  prepared: PreparedAccountTombstone;
  deletedBy: string;
  reason: string;
  metadata: Record<string, unknown>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** A newer value from the incoming row (`excluded`) wins; else the stored one stays. */
const NEWER = (column: string) =>
  `${column} = CASE WHEN excluded.deleted_at > users_pii_tombstone.deleted_at
      THEN excluded.${column} ELSE users_pii_tombstone.${column} END`;

/**
 * Writes the deletion's tombstone. The user's record (id = the user's id) always describes its
 * latest deletion, so that the account's own lookups by id find it:
 * - none yet (or removed by the retention task meanwhile): it is created;
 * - the same address (or none to keep): it is refreshed to this deletion, its retention never
 *   shortened (a retried deletion lands here too, a few seconds later);
 * - another address (the PII was erased, the account given a new email, then deleted): the earlier
 *   address moves to a record of its own (`<user id>#<end of its index>`), keeping its deadline,
 *   and the user's record takes this deletion.
 * Both statements are one batch and compare against the stored rows, not a copy read before, so a
 * concurrent deletion or cleanup cannot lose the record or shorten its retention.
 */
export async function writeAccountTombstone(
  adapter: DatabaseAdapter,
  input: AccountTombstoneWrite
): Promise<Tombstone> {
  const now = Date.now();
  const index = input.prepared.emailBlindIndex;
  const retentionUntil = now + input.prepared.retentionDays * DAY_MS;
  const metadata = JSON.stringify(input.metadata);
  const statements: PreparedStatement[] = [];
  if (index) {
    statements.push({
      sql: `INSERT INTO users_pii_tombstone (
          id, tenant_id, email_blind_index, deleted_at, deleted_by,
          deletion_reason, retention_until, deletion_metadata, created_at, updated_at
        )
        SELECT ? || '#' || substr(email_blind_index, length(email_blind_index) - 15),
               tenant_id, email_blind_index, deleted_at, deleted_by,
               deletion_reason, retention_until, deletion_metadata, created_at, ?
          FROM users_pii_tombstone
         WHERE id = ? AND tenant_id = ?
           AND email_blind_index IS NOT NULL AND email_blind_index <> ?
        ON CONFLICT (id) DO UPDATE SET
          retention_until = CASE
            WHEN excluded.retention_until > users_pii_tombstone.retention_until
              THEN excluded.retention_until
            ELSE users_pii_tombstone.retention_until
          END,
          ${NEWER('deleted_by')},
          ${NEWER('deletion_reason')},
          ${NEWER('deletion_metadata')},
          ${NEWER('deleted_at')},
          updated_at = excluded.updated_at`,
      params: [input.userId, now, input.userId, input.tenantId, index],
    });
  }
  statements.push({
    sql: `INSERT INTO users_pii_tombstone (
        id, tenant_id, email_blind_index, deleted_at, deleted_by,
        deletion_reason, retention_until, deletion_metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        retention_until = CASE
          WHEN (excluded.email_blind_index IS NULL
                OR excluded.email_blind_index = users_pii_tombstone.email_blind_index)
               AND users_pii_tombstone.retention_until > excluded.retention_until
            THEN users_pii_tombstone.retention_until
          ELSE excluded.retention_until
        END,
        email_blind_index = COALESCE(excluded.email_blind_index, users_pii_tombstone.email_blind_index),
        deleted_at = excluded.deleted_at,
        deleted_by = excluded.deleted_by,
        deletion_reason = excluded.deletion_reason,
        deletion_metadata = excluded.deletion_metadata,
        updated_at = excluded.updated_at`,
    params: [
      input.userId,
      input.tenantId,
      index,
      now,
      input.deletedBy,
      input.reason,
      retentionUntil,
      metadata,
      now,
      now,
    ],
  });
  await adapter.batch(statements);
  // The upsert leaves the row in place (a failed batch throws); read it back for what was kept.
  // The record is written by now, so a failed read must not stop the deletion: what was written
  // stands in (the stored retention may be longer).
  let stored: Tombstone | null = null;
  try {
    stored = await new TombstoneRepository(adapter).findByUserId(
      input.tenantId,
      input.userId,
      adapter
    );
  } catch {
    stored = null;
  }
  return (
    stored ?? {
      id: input.userId,
      tenant_id: input.tenantId,
      email_blind_index: index,
      deleted_at: now,
      deleted_by: input.deletedBy,
      deletion_reason: input.reason,
      retention_until: retentionUntil,
      deletion_metadata: metadata,
      created_at: now,
      updated_at: now,
    }
  );
}
