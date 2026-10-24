import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';
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

function attempts(db: SqliteDatabase) {
  return db
    .prepare(
      `SELECT tenant_id, interaction_id, user_id, client_id, node_id, event_type, result, error_code,
              method, reason_code, subject_hash, inquiry_number, created_at
         FROM flow_audit_events WHERE event_type = ? ORDER BY rowid`
    )
    .all(SIGN_IN_ATTEMPT_FAILED_EVENT) as Array<Record<string, unknown>>;
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

  it('makes inquiry numbers of 10 unambiguous characters', () => {
    const numbers = new Set(Array.from({ length: 200 }, generateInquiryNumber));
    for (const value of numbers) expect(value).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/u);
    expect(numbers.size).toBe(200);
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

describe('recordSignInAttemptFailure', () => {
  let db: SqliteDatabase;
  let core: DatabaseAdapter;
  const keys = () =>
    loadInvestigationSubjectHmacKeysFromEnv({ INVESTIGATION_SUBJECT_HMAC_KEYRING: KEYRING });

  beforeEach(() => {
    ({ db, adapter: core } = coreStore());
    addInteraction(db, { id: 'int-1' });
    addInteraction(db, { id: 'int-b', tenantId: 'tenant-b' });
  });

  afterEach(() => vi.restoreAllMocks());

  it('records the failure with the account as its subject hash, never the user ID', async () => {
    const inquiry = await recordSignInAttemptFailure(
      core,
      keys(),
      {
        tenantId: 'tenant-a',
        interactionId: 'int-1',
        method: 'totp',
        reasonCode: 'invalid_code',
        userId: 'user-1',
      },
      NOW
    );
    const expectedHash = await computeInvestigationSubjectHash(
      keys()!.writeKey,
      'tenant-a',
      'user-1'
    );
    expect(attempts(db)).toEqual([
      {
        tenant_id: 'tenant-a',
        interaction_id: 'int-1',
        user_id: null,
        client_id: 'login-ui',
        node_id: 'authentication',
        event_type: SIGN_IN_ATTEMPT_FAILED_EVENT,
        result: 'failure',
        error_code: null,
        method: 'totp',
        reason_code: 'invalid_code',
        subject_hash: expectedHash,
        inquiry_number: inquiry,
        created_at: NOW,
      },
    ]);
    expect(JSON.stringify(attempts(db))).not.toContain('user-1');
  });

  it('leaves the subject hash out before the account is known, or without a keyring', async () => {
    await recordSignInAttemptFailure(core, keys(), {
      tenantId: 'tenant-a',
      interactionId: 'int-1',
      method: 'passkey',
      reasonCode: 'credential_not_found',
    });
    await recordSignInAttemptFailure(core, null, {
      tenantId: 'tenant-a',
      interactionId: 'int-1',
      method: 'passkey',
      reasonCode: 'verification_failed',
      userId: 'user-1',
    });
    expect(attempts(db).map((row) => [row.reason_code, row.subject_hash])).toEqual([
      ['credential_not_found', null],
      ['verification_failed', null],
    ]);
  });

  it('records nothing for an interaction the tenant does not have', async () => {
    expect(
      await recordSignInAttemptFailure(core, keys(), {
        tenantId: 'tenant-a',
        interactionId: 'int-b',
        method: 'passkey',
        reasonCode: 'credential_not_found',
      })
    ).toBeNull();
    expect(attempts(db)).toEqual([]);
  });

  it('refuses a method or reason outside the vocabulary', async () => {
    await expect(
      recordSignInAttemptFailure(core, keys(), {
        tenantId: 'tenant-a',
        interactionId: 'int-1',
        method: 'passkey',
        reasonCode: 'boom: taro@corp.example' as never,
      })
    ).rejects.toThrow('sign_in_attempt_failure_invalid');
    await expect(
      recordSignInAttemptFailure(core, keys(), {
        tenantId: 'tenant-a',
        interactionId: 'int-1',
        method: 'password' as never,
        reasonCode: 'invalid_code',
      })
    ).rejects.toThrow('sign_in_attempt_failure_invalid');
    expect(attempts(db)).toEqual([]);
  });

  it('deduplicates concurrent verified-state failures and returns the persisted inquiry number', async () => {
    const input = {
      tenantId: 'tenant-a',
      interactionId: 'int-1',
      method: 'external_idp',
      reasonCode: 'provisioning_failed',
      userId: 'known-account',
      dedupeKey: 'verified-auth-state-a',
    } as const;
    const results = await Promise.all(
      Array.from({ length: 8 }, () => recordSignInAttemptFailure(core, keys(), input, NOW))
    );
    expect(new Set(results).size).toBe(1);
    expect(results[0]).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
    expect(attempts(db)).toHaveLength(1);
    expect(attempts(db)[0].subject_hash).toBe(
      await computeInvestigationSubjectHash(keys()!.writeKey, 'tenant-a', 'known-account')
    );
    const row = db
      .prepare('SELECT id,user_id,metadata_json FROM flow_audit_events WHERE event_type=?')
      .get(SIGN_IN_ATTEMPT_FAILED_EVENT) as Record<string, unknown>;
    expect(row).toMatchObject({
      user_id: null,
      metadata_json: null,
    });
    expect(row.id).toMatch(/^sia:v1:[a-f0-9]{64}$/u);
    expect(JSON.stringify(row)).not.toContain(input.dedupeKey);
    expect(JSON.stringify(attempts(db))).not.toContain(input.userId);
  });

  it('separates dedupe by tenant, interaction and method and still rejects a foreign interaction', async () => {
    addInteraction(db, { id: 'int-2' });
    const input = { reasonCode: 'verification_failed', dedupeKey: 'same-verified-state' } as const;
    expect(
      await recordSignInAttemptFailure(
        core,
        keys(),
        {
          ...input,
          tenantId: 'tenant-a',
          interactionId: 'int-b',
          method: 'external_idp',
        },
        NOW
      )
    ).toBeNull();
    for (const [tenantId, interactionId, method] of [
      ['tenant-a', 'int-1', 'external_idp'],
      ['tenant-b', 'int-b', 'external_idp'],
      ['tenant-a', 'int-2', 'external_idp'],
      ['tenant-a', 'int-1', 'saml'],
    ] as const) {
      await recordSignInAttemptFailure(
        core,
        keys(),
        { ...input, tenantId, interactionId, method },
        NOW
      );
    }
    const rows = db
      .prepare('SELECT id FROM flow_audit_events WHERE event_type=?')
      .all(SIGN_IN_ATTEMPT_FAILED_EVENT);
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((row) => row.id)).size).toBe(4);
  });

  it('does not suppress another SQL constraint failure when dedupe is enabled', async () => {
    db.exec(`CREATE TRIGGER reject_attempt_fixture BEFORE INSERT ON flow_audit_events
      WHEN NEW.reason_code='service_unavailable'
      BEGIN SELECT RAISE(ABORT,'attempt_fixture_constraint'); END`);
    await expect(
      recordSignInAttemptFailure(
        core,
        keys(),
        {
          tenantId: 'tenant-a',
          interactionId: 'int-1',
          method: 'external_idp',
          reasonCode: 'service_unavailable',
          dedupeKey: 'verified-auth-state-a',
        },
        NOW
      )
    ).rejects.toThrow('attempt_fixture_constraint');
    expect(attempts(db)).toEqual([]);
  });

  it('keeps UUID events for callers that do not supply a dedupe key', async () => {
    const input = {
      tenantId: 'tenant-a',
      interactionId: 'int-1',
      method: 'passkey',
      reasonCode: 'verification_failed',
    } as const;
    await recordSignInAttemptFailure(core, keys(), input, NOW);
    await recordSignInAttemptFailure(core, keys(), input, NOW);
    const rows = db
      .prepare('SELECT id FROM flow_audit_events WHERE event_type=?')
      .all(SIGN_IN_ATTEMPT_FAILED_EVENT);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.id).toMatch(/^[a-f0-9-]{36}$/);
  });

  it('draws another inquiry number when one is taken in the tenant, and only there', async () => {
    const same = new Uint8Array(10).fill(1);
    const other = new Uint8Array(10).fill(2);
    const draws = [same, same, same, other];
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(((array: Uint8Array) => {
      array.set(draws.shift() ?? other);
      return array;
    }) as typeof crypto.getRandomValues);
    const input = {
      interactionId: 'int-1',
      method: 'email_code',
      reasonCode: 'invalid_code',
    } as const;
    const first = await recordSignInAttemptFailure(core, keys(), {
      ...input,
      tenantId: 'tenant-a',
    });
    // The same number in another tenant does not collide.
    const elsewhere = await recordSignInAttemptFailure(core, keys(), {
      ...input,
      tenantId: 'tenant-b',
      interactionId: 'int-b',
    });
    // Taken in tenant-a: the next draw is used.
    const second = await recordSignInAttemptFailure(core, keys(), {
      ...input,
      tenantId: 'tenant-a',
    });
    expect(first).toBe('1111111111');
    expect(elsewhere).toBe('1111111111');
    expect(second).toBe('2222222222');
    expect(attempts(db)).toHaveLength(3);
  });
});

describe('scheduleSignInAttemptFailureRecord', () => {
  let db: SqliteDatabase;
  let core: DatabaseAdapter;

  beforeEach(() => {
    ({ db, adapter: core } = coreStore());
    addInteraction(db, { id: 'int-1' });
  });

  /** Schedules a failure and waits for the work it handed to waitUntil. */
  const schedule = async (
    input: Partial<Parameters<typeof scheduleSignInAttemptFailureRecord>[1]>,
    options: { keyring?: string; core?: () => DatabaseAdapter } = {}
  ) => {
    const pending: Array<Promise<unknown>> = [];
    const onError = vi.fn();
    const coreFor = vi.fn(options.core ?? (() => core));
    scheduleSignInAttemptFailureRecord(
      {
        waitUntil: (promise) => void pending.push(promise),
        core: coreFor,
        env: { INVESTIGATION_SUBJECT_HMAC_KEYRING: options.keyring ?? KEYRING },
        onError,
      },
      {
        tenantId: 'tenant-a',
        interactionId: 'int-1',
        method: 'saml',
        reasonCode: 'signup_disabled',
        ...input,
      }
    );
    await Promise.all(pending);
    return { pending, onError, coreFor };
  };

  it('records after the response, with the hash of a known account', async () => {
    const { pending } = await schedule({ userId: 'user-1' });
    expect(pending).toHaveLength(1);
    expect(attempts(db)).toMatchObject([
      {
        method: 'saml',
        reason_code: 'signup_disabled',
      },
    ]);
    expect(attempts(db)[0].subject_hash).toMatch(/^isub:/u);
  });

  it('does nothing at all for a missing or malformed interaction', async () => {
    for (const interactionId of [null, undefined, '', 'a b']) {
      const { pending, coreFor } = await schedule({ interactionId });
      expect(pending).toHaveLength(0);
      expect(coreFor).not.toHaveBeenCalled();
    }
    expect(attempts(db)).toEqual([]);
  });

  it('treats an unknown account as none', async () => {
    await schedule({ userId: 'unknown' });
    expect(attempts(db)[0]?.subject_hash).toBeNull();
  });

  it('still records without the hash when the keyring is malformed, and reports it', async () => {
    const { onError } = await schedule({ userId: 'user-1' }, { keyring: '{"current":9}' });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(attempts(db)).toMatchObject([{ subject_hash: null }]);
  });

  it('reports a failed write instead of throwing', async () => {
    const failing = {
      ...core,
      execute: async () => {
        throw new Error('D1_ERROR: taro@corp.example');
      },
    } as unknown as DatabaseAdapter;
    const { onError } = await schedule({}, { core: () => failing });
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(attempts(db)).toEqual([]);
  });
});
