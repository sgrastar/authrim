/**
 * Records of who read personal data, in the encrypted pii.audit_log_pii log dataset.
 *
 * A record says who read (the actor), whose data (the user), which fields were returned, for which
 * operation and request, and when; never a value. An admin response collects them as it builds
 * its body and writes them after replying (bounded batches grouped by source PII store), so reading is not slowed down
 * by the writes. No audit row is written to the source PII database. A record that cannot be written is logged without PII and does not fail the
 * response that was already sent.
 */

import type { DatabaseAdapter } from '../db/adapter';
import type { LogIcebergRuntimeEnv } from './log-iceberg-runtime';
import { generateId, getCurrentTimestamp } from '../repositories/base';
import {
  writePiiAccessAuditRows,
  type PIIAuditLog,
  type PIIAuditAction,
} from '../repositories/pii/audit-log';
import { createLogger } from '../utils/logger';

const log = createLogger().module('PII-ACCESS-LOG');

/** Statements in one batch call. */
const BATCH_STATEMENTS = 50;
/** Fields listed in one record (more is a bug in the caller, not a reason to drop the record). */
const MAX_FIELDS = 64;
const SAFE_NAME = /^[a-z0-9_.:-]{1,64}$/u;

export interface PiiAccessLogContext {
  tenantId: string;
  /** The administrator or service that read; null when unknown. */
  actorId: string | null;
  actorType: string | null;
  requestId: string | null;
  /** What was read through, e.g. `admin.users.list`. */
  operation: string;
}

interface PiiAccessEntry {
  action: PIIAuditAction;
  targetUserId: string;
  fields: string[];
}

/**
 * The names of `fields` that `record` returns with a value (a disclosed field). Empty strings,
 * null and undefined are not disclosures.
 */
export function disclosedPiiFields(
  record: Record<string, unknown>,
  fields: readonly string[]
): string[] {
  return fields.filter((field) => {
    const value = record[field];
    return value !== null && value !== undefined && value !== '';
  });
}

export class PiiAccessLog {
  private readonly stores = new Map<
    string,
    { adapter: DatabaseAdapter; entries: PiiAccessEntry[] }
  >();

  constructor(private readonly context: PiiAccessLogContext) {}

  /**
   * Note that `fields` of `targetUserId` were returned from the PII store `storeKey` (its binding,
   * or any name stable for the store). Nothing is noted when no field was returned.
   */
  add(
    store: { key: string; adapter: DatabaseAdapter },
    targetUserId: string,
    fields: readonly string[],
    action: PIIAuditAction = 'pii_accessed'
  ): void {
    const names = [...new Set(fields)]
      .filter((field) => SAFE_NAME.test(field))
      .slice(0, MAX_FIELDS);
    if (!targetUserId || names.length === 0) return;
    let group = this.stores.get(store.key);
    if (!group) {
      group = { adapter: store.adapter, entries: [] };
      this.stores.set(store.key, group);
    }
    group.entries.push({ action, targetUserId, fields: names });
  }

  get size(): number {
    let total = 0;
    for (const group of this.stores.values()) total += group.entries.length;
    return total;
  }

  private rows(entries: PiiAccessEntry[], now: number): PIIAuditLog[] {
    return entries.map((entry) => ({
      id: generateId(),
      tenant_id: this.context.tenantId,
      user_id: this.context.actorId,
      action: entry.action,
      target_user_id: entry.targetUserId,
      details: JSON.stringify({
        fields: entry.fields,
        operation: this.context.operation,
        request_id: this.context.requestId,
        actor_type: this.context.actorType,
      }),
      ip_address: null,
      user_agent: null,
      created_at: now,
      updated_at: now,
    }));
  }

  /** Writes every noted record; returns how many were written and how many stores failed. */
  async write(env: LogIcebergRuntimeEnv): Promise<{ written: number; failedStores: number }> {
    const now = getCurrentTimestamp();
    let written = 0;
    let failedStores = 0;
    for (const [key, group] of this.stores) {
      try {
        for (let offset = 0; offset < group.entries.length; offset += BATCH_STATEMENTS) {
          const chunk = group.entries.slice(offset, offset + BATCH_STATEMENTS);
          await writePiiAccessAuditRows(env, this.context.tenantId, this.rows(chunk, now));
          written += chunk.length;
        }
      } catch (error) {
        failedStores += 1;
        log.warn('PII access records could not be written to a store', {
          tenantId: this.context.tenantId,
          store: key,
          operation: this.context.operation,
          errorType: error instanceof Error ? error.name : 'Unknown',
        });
      }
    }
    return { written, failedStores };
  }
}

/**
 * Writes `accessLog` after the response (or now, when there is no execution context to wait on),
 * as a storage effect a tenant backup accounts for.
 */
export function schedulePiiAccessLog(
  env: LogIcebergRuntimeEnv,
  executionCtx: { waitUntil(promise: Promise<unknown>): void } | undefined,
  accessLog: PiiAccessLog,
  tenantId: string
): Promise<void> {
  if (accessLog.size === 0) return Promise.resolve();
  const promise = accessLog
    .write(env)
    .then(() => undefined)
    .catch((error: unknown) => {
      log.warn('PII access records could not be written', {
        tenantId,
        errorType: error instanceof Error ? error.name : 'Unknown',
      });
    });
  executionCtx?.waitUntil(promise);
  return promise;
}
