import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';
import { logProducerFixture } from './log-iceberg-producer-fixture';
import { renderPortableMigrationSql } from '../../migrations/sql-portability';
import {
  SIGN_IN_ATTEMPT_FAILED_EVENT,
  SIGN_IN_ATTEMPT_INTERACTION_METADATA_KEY,
  computeInvestigationSubjectHash,
  generateInquiryNumber,
  investigationSubjectHashes,
  isInvestigationSubjectHash,
  loadInvestigationSubjectHmacKeysFromEnv,
  recordSignInAttemptFailure,
  resolveSignInAttemptInteraction,
  scheduleSignInAttemptFailureRecord,
  signInAttemptInteractionFromMetadata,
} from '../sign-in-attempts';

const MIGRATIONS = new URL('../../../../../migrations/core/d1/', import.meta.url);
const NOW = 1_800_000_000;
const FLOW = 'flow-default-login-no-consent';
const FLOW_VERSION = 'flow-version-default-login-no-consent-v1';
const KEYRING = JSON.stringify({ current: 2, keys: { '1': 'a'.repeat(43), '2': 'b'.repeat(43) } });

type SqlValue = string | number | bigint | Uint8Array | null;
interface SqliteDatabase {
  exec(sql: string): void;
  close(): void;
  prepare(sql: string): {
    run(...params: SqlValue[]): { changes: number | bigint };
    get(...params: SqlValue[]): Record<string, SqlValue> | undefined;
    all(...params: SqlValue[]): Array<Record<string, SqlValue>>;
  };
}
// Node22+ provides SQLite; the supported Node ambient types predate that module.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (filename: string) => SqliteDatabase;
};
const values = (params: unknown[] = []) =>
  params.map((value): SqlValue => (value === undefined ? null : (value as SqlValue)));

/** The executable Core schema: a column the migration did not add fails here as in D1. */
function coreStore(): { db: SqliteDatabase; adapter: DatabaseAdapter } {
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    db.exec(renderPortableMigrationSql(readFileSync(new URL(file, MIGRATIONS), 'utf8'), 'sqlite'));
  }
  const adapter = {
    query: async (sql: string, params?: unknown[]) => db.prepare(sql).all(...values(params)),
    queryOne: async (sql: string, params?: unknown[]) =>
      db.prepare(sql).get(...values(params)) ?? null,
    execute: async (sql: string, params?: unknown[]) => ({
      success: true,
      rowsAffected: Number(db.prepare(sql).run(...values(params)).changes),
    }),
  } as unknown as DatabaseAdapter;
  return { db, adapter };
}

function addInteraction(
  db: SqliteDatabase,
  input: { id: string; tenantId?: string; state?: string; expiresAt?: number; clientId?: string }
) {
  db.prepare(
    `INSERT INTO flow_interactions (id, tenant_id, flow_id, flow_version_id, client_id, state,
       current_node_id, contract_hash, signature, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'authentication', 'contract-1', 'sig', ?, ?, ?)`
  ).run(
    input.id,
    input.tenantId ?? 'tenant-a',
    FLOW,
    FLOW_VERSION,
    input.clientId ?? 'login-ui',
    input.state ?? 'active',
    input.expiresAt ?? NOW + 600,
    NOW,
    NOW
  );
}

describe('investigation keyring and subject hash', () => {
  it('is absent when the secret is not set, and refuses a malformed one', () => {
    expect(loadInvestigationSubjectHmacKeysFromEnv({})).toBeNull();
    expect(
      loadInvestigationSubjectHmacKeysFromEnv({ INVESTIGATION_SUBJECT_HMAC_KEYRING: ' ' })
    ).toBeNull();
    expect(() =>
      loadInvestigationSubjectHmacKeysFromEnv({
        INVESTIGATION_SUBJECT_HMAC_KEYRING: JSON.stringify({
          current: 3,
          keys: { '1': 'a'.repeat(43) },
        }),
      })
    ).toThrow('investigation_subject_hmac_keyring_invalid');
    const keys = loadInvestigationSubjectHmacKeysFromEnv({
      INVESTIGATION_SUBJECT_HMAC_KEYRING: KEYRING,
    });
    expect(keys?.writeKey.generation).toBe(2);
    expect(keys?.readKeys.map((key) => key.generation)).toEqual([2, 1]);
  });

  it('is keyed by tenant, account and key generation, and names its generation', async () => {
    const keys = loadInvestigationSubjectHmacKeysFromEnv({
      INVESTIGATION_SUBJECT_HMAC_KEYRING: KEYRING,
    })!;
    const hash = await computeInvestigationSubjectHash(keys.writeKey, 'tenant-a', 'user-1');
    expect(hash).toMatch(/^isub:v1:g2:[0-9a-f]{64}$/u);
    expect(isInvestigationSubjectHash(hash)).toBe(true);
    expect(await computeInvestigationSubjectHash(keys.writeKey, 'tenant-a', 'user-1')).toBe(hash);
    expect(await computeInvestigationSubjectHash(keys.writeKey, 'tenant-b', 'user-1')).not.toBe(
      hash
    );
    expect(await computeInvestigationSubjectHash(keys.writeKey, 'tenant-a', 'user-2')).not.toBe(
      hash
    );
    // Tenant and account are length-prefixed: shifting a character between them changes the hash.
    expect(await computeInvestigationSubjectHash(keys.writeKey, 'tenant-au', 'ser-1')).not.toBe(
      hash
    );
    const older = await computeInvestigationSubjectHash(keys.readKeys[1]!, 'tenant-a', 'user-1');
    expect(older).toMatch(/^isub:v1:g1:/u);
    expect(await investigationSubjectHashes(keys, 'tenant-a', 'user-1')).toEqual([hash, older]);
  });

  it('makes tenant-scoped deterministic 128-bit inquiry numbers', async () => {
    const numbers = new Set(
      await Promise.all(
        Array.from({ length: 200 }, (_, i) => generateInquiryNumber('tenant-a', `event-${i}`))
      )
    );
    for (const value of numbers) expect(value).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
    expect(numbers.size).toBe(200);
    expect(await generateInquiryNumber('tenant-a', 'event')).toBe(
      await generateInquiryNumber('tenant-a', 'event')
    );
    expect(await generateInquiryNumber('tenant-b', 'event')).not.toBe(
      await generateInquiryNumber('tenant-a', 'event')
    );
  });
});

describe('resolveSignInAttemptInteraction', () => {
  let db: SqliteDatabase;
  let core: DatabaseAdapter;

  beforeEach(() => {
    ({ db, adapter: core } = coreStore());
    addInteraction(db, { id: 'int-live' });
    addInteraction(db, { id: 'int-expired', expiresAt: NOW - 1 });
    addInteraction(db, { id: 'int-done', state: 'completed' });
    addInteraction(db, { id: 'int-other-tenant', tenantId: 'tenant-b' });
  });

  afterEach(() => db.close());

  const resolve = (interactionId: string | null, clientId?: string) =>
    resolveSignInAttemptInteraction(core, {
      tenantId: 'tenant-a',
      interactionId,
      clientId,
      nowSeconds: NOW,
    });

  it('keeps only a live interaction of the tenant and client', async () => {
    expect(await resolve('int-live')).toBe('int-live');
    expect(await resolve('int-live', 'login-ui')).toBe('int-live');
    expect(await resolve('int-live', 'another-client')).toBeNull();
    expect(await resolve('int-expired')).toBeNull();
    expect(await resolve('int-done')).toBeNull();
    expect(await resolve('int-other-tenant')).toBeNull();
    expect(await resolve('int-missing')).toBeNull();
    expect(await resolve(null)).toBeNull();
  });

  it('refuses a value of no interaction-ID form without reading', async () => {
    const spy = vi.spyOn(core, 'queryOne');
    expect(await resolve("int-live' OR '1'='1")).toBeNull();
    expect(await resolve('x'.repeat(129))).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('is read back from challenge metadata only in its validated form', () => {
    expect(
      signInAttemptInteractionFromMetadata({
        [SIGN_IN_ATTEMPT_INTERACTION_METADATA_KEY]: 'int-live',
      })
    ).toBe('int-live');
    // The unchecked interaction a start body carries is not the validated one.
    expect(signInAttemptInteractionFromMetadata({ runtime_interaction_id: 'int-live' })).toBeNull();
    expect(
      signInAttemptInteractionFromMetadata({ [SIGN_IN_ATTEMPT_INTERACTION_METADATA_KEY]: 'a b' })
    ).toBeNull();
    expect(signInAttemptInteractionFromMetadata(undefined)).toBeNull();
  });
});

describe.each(['scheduled', 'pipeline'] as const)('new sign-in failure storage (%s)', (mode) => {
  let f: Awaited<ReturnType<typeof logProducerFixture>>;
  const keys = () =>
    loadInvestigationSubjectHmacKeysFromEnv({ INVESTIGATION_SUBJECT_HMAC_KEYRING: KEYRING });
  const input = () => ({
    tenantId: 'tenant-a',
    interactionId: 'int-1',
    method: 'external_idp' as const,
    reasonCode: 'verification_failed' as const,
    userId: 'known-account',
    dedupeKey: 'verified-state-a',
  });
  beforeEach(async () => {
    f = await logProducerFixture(mode);
    addInteraction(f.db, { id: 'int-1' });
    addInteraction(f.db, { id: 'int-b', tenantId: 'tenant-b' });
  });
  afterEach(() => {
    f.db.close();
    vi.restoreAllMocks();
  });
  const rows = () => f.rows('core.flow_audit_events');

  it('stores only an encrypted new log and never inserts a searchable Core audit row', async () => {
    const inquiry = await recordSignInAttemptFailure(f.env, f.adapter, keys(), input(), NOW);
    const result = await rows();
    expect(inquiry).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      tenant_id: 'tenant-a',
      interaction_id: 'int-1',
      user_id: null,
      event_type: SIGN_IN_ATTEMPT_FAILED_EVENT,
      result: 'failure',
      method: 'external_idp',
      reason_code: 'verification_failed',
      inquiry_number: inquiry,
      created_at: NOW,
      subject_hash: await computeInvestigationSubjectHash(
        keys()!.writeKey,
        'tenant-a',
        'known-account'
      ),
    });
    expect(JSON.stringify(result)).not.toContain('known-account');
    expect(JSON.stringify(result)).not.toContain('verified-state-a');
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM flow_audit_events').get()?.n).toBe(0);
    expect(f.queueMessages.length).toBe(mode === 'pipeline' ? 1 : 0);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM log_iceberg_records').get()?.n).toBe(
      mode === 'scheduled' ? 1 : 0
    );
  });

  it('preserves the first failed timestamp and inquiry number on concurrent and delayed retries', async () => {
    await recordSignInAttemptFailure(f.env, f.adapter, keys(), input(), NOW);
    const result = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        recordSignInAttemptFailure(f.env, f.adapter, keys(), input(), NOW + i)
      )
    );
    expect(new Set(result).size).toBe(1);
    await recordSignInAttemptFailure(f.env, f.adapter, keys(), input(), NOW + 100);
    const resultRows = await rows();
    expect(resultRows).toHaveLength(1);
    expect(resultRows[0].created_at).toBe(NOW);
    expect(
      f.db.prepare('SELECT state,failed_at,payload_hmac FROM log_sign_in_attempt_receipts').get()
    ).toMatchObject({
      state: 'committed',
      failed_at: NOW,
      payload_hmac: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it('keeps the first reservation winner stable when first requests race', async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        recordSignInAttemptFailure(f.env, f.adapter, keys(), input(), NOW + i)
      )
    );
    const reservation = f.db.prepare('SELECT failed_at FROM log_sign_in_attempt_receipts').get();
    expect(Number(reservation?.failed_at)).toBeGreaterThanOrEqual(NOW);
    expect(Number(reservation?.failed_at)).toBeLessThan(NOW + 8);
    await recordSignInAttemptFailure(f.env, f.adapter, keys(), input(), NOW + 100);
    expect((await rows())[0].created_at).toBe(reservation?.failed_at);
  });

  it('does not publish a body or retention scope after its reservation disappears', async () => {
    const batch = f.adapter.batch.bind(f.adapter);
    vi.spyOn(f.adapter, 'batch').mockImplementation(async (statements) => {
      if (
        statements.some((statement) =>
          statement.sql.includes('UPDATE log_sign_in_attempt_receipts SET state=')
        )
      ) {
        f.db.exec('DELETE FROM log_sign_in_attempt_receipts');
      }
      return batch(statements);
    });
    await expect(
      recordSignInAttemptFailure(f.env, f.adapter, keys(), input(), NOW)
    ).rejects.toThrow('log_sign_in_attempt_reservation_changed');
    expect(await rows()).toHaveLength(0);
    expect(f.db.prepare('SELECT count(*) n FROM log_iceberg_retention_jobs').get()?.n).toBe(0);
    expect(f.queueMessages).toHaveLength(0);
  });

  it('refuses changed subject or reason for an already reserved opaque identity', async () => {
    await recordSignInAttemptFailure(f.env, f.adapter, keys(), input(), NOW);
    for (const changed of [{ userId: 'other-account' }, { reasonCode: 'signup_disabled' as const }])
      await expect(
        recordSignInAttemptFailure(f.env, f.adapter, keys(), { ...input(), ...changed }, NOW + 10)
      ).rejects.toThrow();
    expect(await rows()).toHaveLength(1);
  });

  it('rolls back completion together with log promotion when the business batch fails', async () => {
    f.db.exec(
      mode === 'scheduled'
        ? "CREATE TRIGGER reject_log BEFORE INSERT ON log_iceberg_event_receipts BEGIN SELECT RAISE(ABORT,'fixture_commit_failed'); END"
        : "CREATE TRIGGER reject_log BEFORE UPDATE OF state ON log_iceberg_outbox WHEN NEW.state='pending' BEGIN SELECT RAISE(ABORT,'fixture_commit_failed'); END"
    );
    await expect(
      recordSignInAttemptFailure(f.env, f.adapter, keys(), input(), NOW)
    ).rejects.toThrow('fixture_commit_failed');
    expect(
      f.db.prepare('SELECT state,payload_hmac FROM log_sign_in_attempt_receipts').get()
    ).toMatchObject({ state: 'reserved', payload_hmac: null });
    expect(await rows()).toEqual([]);
    expect(f.queueMessages).toEqual([]);
    f.db.exec('DROP TRIGGER reject_log');
    await recordSignInAttemptFailure(f.env, f.adapter, keys(), input(), NOW + 20);
    expect((await rows())[0].created_at).toBe(NOW);
  });

  it('does not reserve or emit a foreign interaction, and enforces the closed vocabulary', async () => {
    expect(
      await recordSignInAttemptFailure(
        f.env,
        f.adapter,
        keys(),
        { ...input(), interactionId: 'int-b' },
        NOW
      )
    ).toBeNull();
    await expect(
      recordSignInAttemptFailure(
        f.env,
        f.adapter,
        keys(),
        { ...input(), reasonCode: 'email@example.invalid' as never },
        NOW
      )
    ).rejects.toThrow('sign_in_attempt_failure_invalid');
    expect(await rows()).toEqual([]);
  });

  it('keeps independent opaque events without a dedupe key and omits unavailable account hashes', async () => {
    const attempt = { ...input(), dedupeKey: undefined };
    const first = await recordSignInAttemptFailure(f.env, f.adapter, null, attempt, NOW);
    const second = await recordSignInAttemptFailure(f.env, f.adapter, null, attempt, NOW);
    expect(first).not.toBe(second);
    expect((await rows()).map((row) => row.subject_hash)).toEqual([null, null]);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM log_sign_in_attempt_receipts').get()?.n).toBe(0);
  });

  it('schedules using the new writer without failing the response or exposing unknown account IDs', async () => {
    const pending: Promise<unknown>[] = [],
      onError = vi.fn();
    scheduleSignInAttemptFailureRecord(
      {
        env: { ...f.env, INVESTIGATION_SUBJECT_HMAC_KEYRING: KEYRING },
        core: () => f.adapter,
        waitUntil: (promise) => {
          pending.push(promise);
        },
        onError,
      },
      { ...input(), userId: 'unknown' }
    );
    await Promise.all(pending);
    expect(onError).not.toHaveBeenCalled();
    expect((await rows())[0].subject_hash).toBeNull();
    scheduleSignInAttemptFailureRecord(
      {
        env: f.env,
        core: () => f.adapter,
        waitUntil: (promise) => {
          pending.push(promise);
        },
        onError,
      },
      { ...input(), interactionId: null }
    );
    expect(pending).toHaveLength(1);
  });
});
