import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { D1Database, D1DatabaseSession } from '@cloudflare/workers-types';
import {
  buildLookupShardRegistryGenerationKey,
  buildLookupShardRegistrySnapshotKey,
  buildLookupHmacKeyStateGenerationKey,
  buildLookupHmacKeyStateSnapshotKey,
  clearLookupRouteMemoryCache,
  createLookupBlindIndex,
  fingerprintLookupHmacKey,
  signLookupHmacKeyState,
  signLookupShardRegistry,
  type Env,
} from '@authrim/ar-lib-core';
import { exportJWK, generateKeyPair, type JWK } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  DiscoveryEmailOtpService,
  type DiscoveryEmailOtpDependencies,
  type DiscoveryEmailOtpTimingName,
} from '../discovery-email-otp';
import { resetLookupHmacRuntimeKeyCacheForTest } from '../lookup-hmac-runtime';

const notificationDelivery = vi.hoisted(() => vi.fn());

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  produceNotificationDelivery: notificationDelivery,
}));

type SqlValue = string | number | null | Uint8Array;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const NOW = Math.floor(Date.now() / 1000);
const LOOKUP_KEY = 'lookup-test-key-0123456789abcdef0123456789';
const LOOKUP_KEY_B = 'lookup-test-key-b-0123456789abcdef0123456789';
const OTP_KEY = 'otp-test-key-0123456789abcdef012345678901';

class BoundStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: SqlValue[],
    private readonly touch: () => void,
    private readonly returnsRows: boolean
  ) {}

  async first<T>(): Promise<T | null> {
    this.touch();
    return (this.statement.get(...this.values) as T | undefined) ?? null;
  }

  async all<T>() {
    this.touch();
    return { success: true, results: this.statement.all(...this.values) as T[], meta: {} };
  }

  async run() {
    this.touch();
    const result = this.statement.run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }

  batchResult() {
    this.touch();
    if (this.returnsRows) {
      return { success: true, results: this.statement.all(...this.values), meta: {} };
    }
    const result = this.statement.run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

class PreparedStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly touch: () => void,
    private readonly returnsRows: boolean
  ) {}

  bind(...values: unknown[]): BoundStatement {
    return new BoundStatement(
      this.statement,
      values.map((value) => {
        if (
          typeof value === 'string' ||
          typeof value === 'number' ||
          value === null ||
          value instanceof Uint8Array
        ) {
          return value;
        }
        throw new Error('unsupported_test_sqlite_value');
      }),
      this.touch,
      this.returnsRows
    );
  }
}

class SqliteD1 {
  accesses = 0;
  batches = 0;

  constructor(readonly database: DatabaseSync) {}

  private touch = () => {
    this.accesses += 1;
  };

  private prepare(sql: string): PreparedStatement {
    return new PreparedStatement(
      this.database.prepare(sql),
      this.touch,
      /^\s*SELECT\b/iu.test(sql) || /\bRETURNING\b/iu.test(sql)
    );
  }

  private async batch(statements: BoundStatement[]) {
    this.batches += 1;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map((statement) => statement.batchResult());
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  readonly binding = {
    prepare: (sql: string) => this.prepare(sql),
    batch: (statements: BoundStatement[]) => this.batch(statements),
    withSession: (_constraint: string) =>
      ({
        prepare: (sql: string) => this.prepare(sql),
        batch: (statements: BoundStatement[]) => this.batch(statements),
        getBookmark: () => 'test-bookmark',
      }) as unknown as D1DatabaseSession,
  } as unknown as D1Database;
}

describe('DiscoveryEmailOtpService', () => {
  let database: DatabaseSync;
  let targetDatabase: DatabaseSync;
  let lookup: SqliteD1;
  let targetLookup: SqliteD1;
  let privateJwk: JWK;
  let publicJwk: JWK;
  let registry: Map<string, string>;
  let emailSend: Mock<
    (input: {
      to: string;
      from?: string;
      subject: string;
      text: string;
    }) => Promise<{ messageId: string }>
  >;
  let rateAllowed: boolean;

  beforeAll(async () => {
    const pair = await generateKeyPair('EdDSA', { extractable: true });
    privateJwk = { ...(await exportJWK(pair.privateKey)), kid: 'registry-test-key', alg: 'EdDSA' };
    publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'registry-test-key', alg: 'EdDSA' };
  });

  beforeEach(async () => {
    clearLookupRouteMemoryCache();
    resetLookupHmacRuntimeKeyCacheForTest();
    database = new DatabaseSync(':memory:');
    targetDatabase = new DatabaseSync(':memory:');
    for (const target of [database, targetDatabase]) {
      for (const filename of [
        '001_lookup_directory.sql',
        '002_identifier_replacement_verification_gate.sql',
        '003_allow_external_subject_identifier_replacement.sql',
        '004_lookup_retention_and_otp_bucket.sql',
      ]) {
        target.exec(readFileSync(resolve(REPO_ROOT, 'migrations/lookup', filename), 'utf8'));
      }
    }
    lookup = new SqliteD1(database);
    targetLookup = new SqliteD1(targetDatabase);
    emailSend = vi.fn(async () => ({ messageId: 'message-1' }));
    notificationDelivery.mockReset().mockImplementation(async (_env, input) => {
      await emailSend({
        to: input.payload.to,
        from: input.payload.from,
        subject: input.payload.subject,
        text: input.payload.body,
      });
      return {
        reference: { intentId: input.intentId },
        bindingRef: 'PLATFORM_NOTIFICATION_DB',
        delivery: 'delivered',
      };
    });
    rateAllowed = true;
    const token = await signLookupShardRegistry({
      registry: {
        environmentId: 'test',
        generation: 1,
        issuedAt: NOW - 60,
        expiresAt: NOW + 3600,
        ranges: [
          {
            startBucket: 0,
            endBucket: 4095,
            assignmentGeneration: 1,
            lookupShardId: 'lookup-1',
            bindingRef: 'LOOKUP_DB_1',
          },
        ],
      },
      privateJwk,
    });
    const hmacStateToken = await signLookupHmacKeyState({
      state: {
        environmentId: 'test',
        generation: 1,
        issuedAt: NOW - 60,
        expiresAt: NOW + 3600,
        rotationState: 'stable',
        writeMode: 'current_only',
        current: {
          generation: 1,
          keyId: 'lookup-key-1',
          slot: 'A',
          fingerprint: await fingerprintLookupHmacKey(LOOKUP_KEY),
        },
        previous: null,
      },
      privateJwk,
    });
    registry = new Map([
      [buildLookupShardRegistrySnapshotKey('test'), token],
      [buildLookupShardRegistryGenerationKey('test'), '1'],
      [buildLookupHmacKeyStateSnapshotKey('test'), hmacStateToken],
      [buildLookupHmacKeyStateGenerationKey('test'), '1'],
    ]);
    const index = await createLookupBlindIndex('email_exact', 'person@example.com', {
      generation: 1,
      secret: LOOKUP_KEY,
    });
    const projection = JSON.stringify({
      schemaVersion: 1,
      accountRouteGeneration: 1,
      residencyPolicyId: 'default-policy',
      targets: [
        {
          dataRole: 'tenant_core/users',
          residencyPartition: 'default',
          shardId: 'users-1',
          bindingRef: 'TDB_USERS_1',
          requiredBindingRouteGeneration: 1,
        },
      ],
    });
    database
      .prepare(
        `INSERT INTO lookup_identifiers (
           virtual_bucket, index_kind, normalization_version, hmac_key_generation,
           identifier_blind_digest, tenant_id, account_id, route_schema_version,
           account_route_generation, required_binding_route_generation, residency_policy_id,
           route_projection_json, tenant_lifecycle_state, runtime_route_status,
           lifecycle_state, created_at, updated_at
         ) VALUES (?, 'email_exact', 1, 1, ?, 'tenant-a', 'account-a', 1, 1, 1,
                   'default-policy', ?, 'active', 'active', 'active', ?, ?)`
      )
      .run(index.virtualBucket, index.digest, projection, NOW, NOW);
  });

  afterEach(() => {
    database.close();
    targetDatabase.close();
  });

  function env(includeEmail = true): Env {
    const limiter = {
      incrementRpc: vi.fn(async () => ({ allowed: rateAllowed, retryAfter: rateAllowed ? 0 : 60 })),
    };
    return {
      AUTHRIM_ENVIRONMENT_NAME: 'test',
      LOOKUP_HMAC_KEY_SLOT_A: LOOKUP_KEY,
      OTP_HMAC_SECRET: OTP_KEY,
      EMAIL_FROM: 'noreply@example.com',
      ...(includeEmail ? { EMAIL: { send: emailSend } } : {}),
      RATE_LIMITER: {
        idFromName: () => ({}) as DurableObjectId,
        get: () => limiter,
      },
      TENANT_RUNTIME_REGISTRY: { get: async (key: string) => registry.get(key) ?? null },
      TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: JSON.stringify({ keys: [publicJwk] }),
      LOOKUP_DB_1: lookup.binding,
      LOOKUP_DB_2: targetLookup.binding,
    } as unknown as Env;
  }

  function service(
    workerEnv = env(),
    dependencies: Pick<DiscoveryEmailOtpDependencies, 'recordTiming' | 'timingNow'> = {}
  ) {
    return new DiscoveryEmailOtpService(workerEnv, {
      now: () => NOW,
      randomId: () => '00000000-0000-4000-8000-000000000001',
      randomCode: () => '123456',
      ...dependencies,
    });
  }

  it('stores no raw email and returns memberships only after one-time OTP consumption', async () => {
    const instance = service();
    const started = await instance.start({ email: ' Person@Example.com ', clientIp: '192.0.2.1' });

    expect(started).toMatchObject({ expiresIn: 600 });
    expect(emailSend).toHaveBeenCalledWith(expect.objectContaining({ to: 'person@example.com' }));
    const stored = database
      .prepare(
        `SELECT email_blind_digest, otp_verifier, delivery_state, consumed_at
           FROM lookup_discovery_otp_challenges`
      )
      .get() as Record<string, unknown>;
    expect(stored).toMatchObject({ delivery_state: 'sent', consumed_at: null });
    expect(JSON.stringify(stored)).not.toContain('person@example.com');
    expect(JSON.stringify(stored)).not.toContain('123456');

    const accessesBeforeVerify = lookup.accesses;
    await expect(
      instance.verify({ challengeId: started.challengeId, code: '123456' })
    ).resolves.toEqual([expect.objectContaining({ tenantId: 'tenant-a', accountId: 'account-a' })]);
    expect(lookup.accesses - accessesBeforeVerify).toBe(2);
    expect(lookup.batches).toBe(1);
    await expect(
      instance.verify({ challengeId: started.challengeId, code: '123456' })
    ).rejects.toThrow('discovery_challenge_invalid');
    expect(lookup.accesses - accessesBeforeVerify).toBe(4);
    expect(lookup.batches).toBe(2);
  });

  it('allows exactly one concurrent verifier to consume a challenge', async () => {
    const instance = service();
    const started = await instance.start({ email: 'person@example.com', clientIp: '192.0.2.1' });

    const results = await Promise.allSettled([
      instance.verify({ challengeId: started.challengeId, code: '123456' }),
      instance.verify({ challengeId: started.challengeId, code: '123456' }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(
      database
        .prepare(`SELECT attempt_count, consumed_at FROM lookup_discovery_otp_challenges`)
        .get()
    ).toEqual({ attempt_count: 1, consumed_at: NOW });
  });

  it('records only fixed secret-free verify timing spans when diagnostics are requested', async () => {
    const spans: Array<{ name: DiscoveryEmailOtpTimingName; durationMs: number }> = [];
    let timingNow = 100;
    const instance = service(env(), {
      timingNow: () => {
        timingNow += 5;
        return timingNow;
      },
      recordTiming: (name, durationMs) => spans.push({ name, durationMs }),
    });
    const started = await instance.start({
      email: 'person@example.com',
      clientIp: '192.0.2.1',
    });

    await instance.verify({ challengeId: started.challengeId, code: '123456' });

    expect(spans).toEqual([
      { name: 'otp_registry', durationMs: 5 },
      { name: 'otp_assignment', durationMs: 5 },
      { name: 'otp_verifier', durationMs: 5 },
      { name: 'otp_membership_batch', durationMs: 5 },
    ]);
    expect(JSON.stringify(spans)).not.toContain(started.challengeId);
    expect(JSON.stringify(spans)).not.toContain('person@example.com');
    expect(JSON.stringify(spans)).not.toContain('123456');
  });

  it('finds previous-generation membership after a current-key OTP during rotation', async () => {
    resetLookupHmacRuntimeKeyCacheForTest();
    const hmacStateToken = await signLookupHmacKeyState({
      state: {
        environmentId: 'test',
        generation: 2,
        issuedAt: NOW - 60,
        expiresAt: NOW + 3600,
        rotationState: 'activation_dual_write',
        writeMode: 'dual_write',
        current: {
          generation: 2,
          keyId: 'lookup-key-2',
          slot: 'B',
          fingerprint: await fingerprintLookupHmacKey(LOOKUP_KEY_B),
        },
        previous: {
          generation: 1,
          keyId: 'lookup-key-1',
          slot: 'A',
          fingerprint: await fingerprintLookupHmacKey(LOOKUP_KEY),
        },
      },
      privateJwk,
    });
    registry.set(buildLookupHmacKeyStateSnapshotKey('test'), hmacStateToken);
    registry.set(buildLookupHmacKeyStateGenerationKey('test'), '2');
    const workerEnv = env();
    workerEnv.LOOKUP_HMAC_KEY_SLOT_B = LOOKUP_KEY_B;
    const timingNames: DiscoveryEmailOtpTimingName[] = [];
    let timingNow = 100;
    const instance = service(workerEnv, {
      timingNow: () => {
        timingNow += 5;
        return timingNow;
      },
      recordTiming: (name) => timingNames.push(name),
    });

    const started = await instance.start({
      email: 'person@example.com',
      clientIp: '192.0.2.44',
    });
    const stored = database
      .prepare(
        `SELECT hmac_key_generation, previous_hmac_key_generation,
                previous_email_blind_digest, previous_virtual_bucket
           FROM lookup_discovery_otp_challenges WHERE challenge_id = ?`
      )
      .get(started.challengeId) as {
      hmac_key_generation: number;
      previous_hmac_key_generation: number;
      previous_email_blind_digest: string;
      previous_virtual_bucket: number;
    };
    expect(stored).toMatchObject({
      hmac_key_generation: 2,
      previous_hmac_key_generation: 1,
    });
    expect(stored.previous_email_blind_digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(stored.previous_virtual_bucket).toBeGreaterThanOrEqual(0);
    const accessesBeforeVerify = lookup.accesses;
    await expect(
      instance.verify({ challengeId: started.challengeId, code: '123456' })
    ).resolves.toEqual([expect.objectContaining({ tenantId: 'tenant-a', accountId: 'account-a' })]);
    expect(lookup.batches).toBe(1);
    expect(lookup.accesses - accessesBeforeVerify).toBe(5);
    expect(timingNames).toEqual([
      'otp_registry',
      'otp_assignment',
      'otp_verifier',
      'otp_membership_batch',
      'lookup_membership',
    ]);
  });

  it('fails closed when the prefetched exact membership limit is exceeded', async () => {
    const existing = database.prepare(`SELECT * FROM lookup_identifiers LIMIT 1`).get() as Record<
      string,
      string | number | null
    >;
    const columns = Object.keys(existing);
    const insert = database.prepare(
      `INSERT INTO lookup_identifiers (${columns.join(', ')})
       VALUES (${columns.map(() => '?').join(', ')})`
    );
    for (let index = 0; index < 100; index += 1) {
      insert.run(
        ...columns.map((column) =>
          column === 'tenant_id'
            ? `tenant-${index}`
            : column === 'account_id'
              ? `account-${index}`
              : existing[column]
        )
      );
    }
    const instance = service();
    const started = await instance.start({ email: 'person@example.com', clientIp: '192.0.2.90' });

    await expect(
      instance.verify({ challengeId: started.challengeId, code: '123456' })
    ).rejects.toThrow('lookup_exact_membership_limit_exceeded');
    expect(lookup.batches).toBe(1);
    expect(
      database
        .prepare(`SELECT attempt_count, consumed_at FROM lookup_discovery_otp_challenges`)
        .get()
    ).toEqual({ attempt_count: 1, consumed_at: NOW });
  });

  it('counts wrong codes and stops consuming after the fixed attempt limit', async () => {
    const instance = service();
    const started = await instance.start({ email: 'person@example.com', clientIp: '192.0.2.1' });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        instance.verify({ challengeId: started.challengeId, code: '000000' })
      ).rejects.toThrow('discovery_challenge_invalid');
    }
    await expect(
      instance.verify({ challengeId: started.challengeId, code: '123456' })
    ).rejects.toThrow('discovery_challenge_invalid');
    expect(
      database
        .prepare(`SELECT attempt_count, consumed_at FROM lookup_discovery_otp_challenges`)
        .get()
    ).toEqual({ attempt_count: 5, consumed_at: null });
  });

  it('pins challenge consumption to its source generation across a bucket cutover', async () => {
    const index = await createLookupBlindIndex('email_exact', 'person@example.com', {
      generation: 1,
      secret: LOOKUP_KEY,
    });
    const sourceIdentifier = database
      .prepare(`SELECT * FROM lookup_identifiers WHERE identifier_blind_digest = ?`)
      .get(index.digest) as Record<string, string | number | null>;
    const columns = Object.keys(sourceIdentifier);
    targetDatabase
      .prepare(
        `INSERT INTO lookup_identifiers (${columns.join(', ')})
         VALUES (${columns.map(() => '?').join(', ')})`
      )
      .run(...columns.map((column) => sourceIdentifier[column]));

    const workerEnv = env();
    workerEnv.CONTROL = {
      getLookupBucketWriteRoute: vi.fn(async ({ virtualBucket }) => ({
        virtualBucket,
        primary: {
          lookupShardId: 'lookup-1',
          bindingRef: 'LOOKUP_DB_1',
          assignmentGeneration: 1,
        },
        mirrors: [
          {
            lookupShardId: 'lookup-2',
            bindingRef: 'LOOKUP_DB_2',
            assignmentGeneration: 2,
          },
        ],
        migration: { operationId: 'lookup-bucket:test', state: 'backfilling' },
      })),
      resolveLookupBucketRouteVersion: vi.fn(async () => ({
        lookupShardId: 'lookup-1',
        bindingRef: 'LOOKUP_DB_1',
        assignmentGeneration: 1,
      })),
    } as unknown as Env['CONTROL'];
    const cutoverTimingNames: DiscoveryEmailOtpTimingName[] = [];
    let cutoverTimingNow = 100;
    const instance = service(workerEnv, {
      timingNow: () => {
        cutoverTimingNow += 5;
        return cutoverTimingNow;
      },
      recordTiming: (name) => cutoverTimingNames.push(name),
    });
    const started = await instance.start({
      email: 'person@example.com',
      clientIp: '192.0.2.1',
    });
    expect(started.challengeId).toMatch(/^discovery-[0-9]+-1-/u);
    expect(
      targetDatabase.prepare(`SELECT delivery_state FROM lookup_discovery_otp_challenges`).get()
    ).toEqual({ delivery_state: 'sent' });

    const cutoverToken = await signLookupShardRegistry({
      registry: {
        environmentId: 'test',
        generation: 2,
        issuedAt: NOW - 30,
        expiresAt: NOW + 3600,
        ranges: [
          {
            startBucket: 0,
            endBucket: 4095,
            assignmentGeneration: 2,
            lookupShardId: 'lookup-2',
            bindingRef: 'LOOKUP_DB_2',
          },
        ],
      },
      privateJwk,
    });
    registry.set(buildLookupShardRegistrySnapshotKey('test'), cutoverToken);
    registry.set(buildLookupShardRegistryGenerationKey('test'), '2');

    const sourceAccessesBeforeVerify = lookup.accesses;
    const targetAccessesBeforeVerify = targetLookup.accesses;
    await expect(
      instance.verify({ challengeId: started.challengeId, code: '123456' })
    ).resolves.toEqual([expect.objectContaining({ tenantId: 'tenant-a', accountId: 'account-a' })]);
    expect(cutoverTimingNames).toEqual([
      'otp_registry',
      'otp_assignment',
      'otp_verifier',
      'otp_challenge',
      'lookup_membership',
    ]);
    await expect(
      instance.verify({ challengeId: started.challengeId, code: '123456' })
    ).rejects.toThrow('discovery_challenge_invalid');
    expect(
      database.prepare(`SELECT consumed_at FROM lookup_discovery_otp_challenges`).get()
    ).toEqual({ consumed_at: NOW });
    expect(
      targetDatabase.prepare(`SELECT consumed_at FROM lookup_discovery_otp_challenges`).get()
    ).toEqual({ consumed_at: null });
    expect(lookup.accesses - sourceAccessesBeforeVerify).toBe(2);
    expect(targetLookup.accesses - targetAccessesBeforeVerify).toBe(1);
    expect(lookup.batches).toBe(0);
    expect(targetLookup.batches).toBe(0);
  });

  it('keeps a failed, undisclosed challenge when the provider order is unavailable', async () => {
    notificationDelivery.mockRejectedValueOnce(
      new Error('notification_delivery_provider_order_unavailable')
    );

    await expect(
      service(env(false)).start({ email: 'person@example.com', clientIp: '192.0.2.1' })
    ).rejects.toThrow('discovery_email_provider_unavailable');
    expect(
      database.prepare(`SELECT delivery_state FROM lookup_discovery_otp_challenges`).get()
    ).toEqual({ delivery_state: 'failed' });
  });

  it('does not persist a challenge after an atomic rate-limit rejection', async () => {
    rateAllowed = false;

    await expect(
      service().start({ email: 'person@example.com', clientIp: '192.0.2.1' })
    ).rejects.toThrow('discovery_rate_limited');
    expect(
      database.prepare(`SELECT COUNT(*) AS count FROM lookup_discovery_otp_challenges`).get()
    ).toEqual({ count: 0 });
  });

  it('marks a created challenge failed when delivery rejects', async () => {
    emailSend.mockRejectedValueOnce(new Error('provider secret detail'));

    await expect(
      service().start({ email: 'person@example.com', clientIp: '192.0.2.1' })
    ).rejects.toThrow('discovery_email_provider_unavailable');
    expect(
      database.prepare(`SELECT delivery_state FROM lookup_discovery_otp_challenges`).get()
    ).toEqual({ delivery_state: 'failed' });
  });
});
