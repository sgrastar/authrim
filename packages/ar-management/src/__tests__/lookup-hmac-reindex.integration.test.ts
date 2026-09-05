import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { D1Database, D1DatabaseSession } from '@cloudflare/workers-types';
import {
  buildLookupHmacKeyStateGenerationKey,
  buildLookupHmacKeyStateSnapshotKey,
  buildLookupShardRegistryGenerationKey,
  buildLookupShardRegistrySnapshotKey,
  createLookupBlindIndex,
  fingerprintLookupHmacKey,
  signLookupHmacKeyState,
  signLookupShardRegistry,
  type AccountDirectoryPublication,
  type ControlLookupHmacRotationView,
  type Env,
} from '@authrim/ar-lib-core';
import { exportJWK, generateKeyPair, type JWK } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLookupHmacReindexProcessor } from '../lookup-hmac-reindex';
import { resetLookupHmacRuntimeKeyCacheForTest } from '../lookup-hmac-runtime';

type SqlValue = string | number | null | Uint8Array;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const NOW_SECONDS = Math.floor(Date.now() / 1000);
const NOW_MS = NOW_SECONDS * 1000;
const KEY_A = 'lookup-key-a-0123456789abcdef0123456789abcdef';
const KEY_B = 'lookup-key-b-0123456789abcdef0123456789abcdef';

class BoundStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: SqlValue[]
  ) {}

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.values) as T | undefined) ?? null;
  }

  async all<T>() {
    return { success: true, results: this.statement.all(...this.values) as T[], meta: {} };
  }

  async run() {
    const result = this.statement.run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

class PreparedStatement {
  constructor(private readonly statement: StatementSync) {}

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
        throw new Error('unsupported_sqlite_test_value');
      })
    );
  }
}

function d1(database: DatabaseSync): D1Database {
  const session = {
    prepare: (sql: string) => new PreparedStatement(database.prepare(sql)),
    batch: async (statements: BoundStatement[]) =>
      Promise.all(statements.map((item) => item.run())),
    getBookmark: () => 'test-bookmark',
  } as unknown as D1DatabaseSession;
  return {
    prepare: (sql: string) => new PreparedStatement(database.prepare(sql)),
    batch: async (statements: BoundStatement[]) =>
      Promise.all(statements.map((item) => item.run())),
    withSession: () => session,
  } as unknown as D1Database;
}

function operation(state: ControlLookupHmacRotationView['state']): ControlLookupHmacRotationView {
  return {
    operationId: 'hmac-operation-1',
    state,
    source: {
      generation: 1,
      keyId: 'lookup-key-1',
      slot: 'A',
      fingerprint: 'a'.repeat(64),
    },
    candidate: {
      generation: 2,
      keyId: 'lookup-key-2',
      slot: 'B',
      fingerprint: 'b'.repeat(64),
    },
    checkpoint: {},
    sourceRowCount: state === 'verifying' ? 1 : null,
    currentRowCount: null,
    verificationAttemptCount: 0,
    graceExpiresAt: null,
    ownerId: 'scheduler',
    fencingToken: 3,
    leaseExpiresAt: NOW_SECONDS + 120,
    mutationStarted: true,
    updatedAt: NOW_SECONDS,
  };
}

describe('Lookup HMAC reindex processor', () => {
  let core: DatabaseSync;
  let lookup: DatabaseSync;
  let privateJwk: JWK;
  let publicJwk: JWK;
  let registry: Map<string, string>;
  let publication: AccountDirectoryPublication;

  beforeAll(async () => {
    const pair = await generateKeyPair('EdDSA', { extractable: true });
    privateJwk = { ...(await exportJWK(pair.privateKey)), kid: 'test-signing-key', alg: 'EdDSA' };
    publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'test-signing-key', alg: 'EdDSA' };
  });

  beforeEach(async () => {
    resetLookupHmacRuntimeKeyCacheForTest();
    core = new DatabaseSync(':memory:');
    lookup = new DatabaseSync(':memory:');
    lookup.exec(
      readFileSync(resolve(REPO_ROOT, 'migrations/lookup/001_0_4_0_lookup_baseline.sql'), 'utf8')
        .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '(unixepoch() * 1000)')
        .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', 'unixepoch()')
    );
    publication = {
      operationId: 'account-create-operation-1',
      tenantId: 'tenant-a',
      accountId: 'account:user-a',
      idempotencyKey: `account-create:${'c'.repeat(64)}`,
      routeProjection: {
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
      },
      indexes: [
        await createLookupBlindIndex('account_id', 'account:user-a', {
          generation: 1,
          secret: KEY_A,
        }),
      ],
    };
    core.exec(
      `CREATE TABLE identity_accounts (
         id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, legacy_user_id TEXT NOT NULL,
         lifecycle_state TEXT NOT NULL, directory_publication_state TEXT NOT NULL,
         account_route_generation INTEGER NOT NULL, created_at INTEGER NOT NULL
       );
       CREATE TABLE account_routing_outbox (
         outbox_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, account_id TEXT NOT NULL,
         event_kind TEXT NOT NULL, route_generation INTEGER NOT NULL, status TEXT NOT NULL,
         payload_json TEXT NOT NULL
       );
       CREATE TABLE passkeys (
         id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL,
         credential_id TEXT NOT NULL, rp_id TEXT, created_at INTEGER NOT NULL
       );
       CREATE TABLE anonymous_devices (
         id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL,
         device_id_hash TEXT NOT NULL, created_at INTEGER NOT NULL, is_active INTEGER NOT NULL
       );`
    );
    core
      .prepare(
        `INSERT INTO identity_accounts VALUES (
           'account:user-a', 'tenant-a', 'user-a', 'active', 'active', 1, ?
         )`
      )
      .run(NOW_MS - 10_000);
    core
      .prepare(
        `INSERT INTO account_routing_outbox VALUES (
           'outbox-a', 'tenant-a', 'account:user-a', 'account_created', 1, 'succeeded', ?
         )`
      )
      .run(JSON.stringify(publication));
    const hmacState = await signLookupHmacKeyState({
      state: {
        environmentId: 'test',
        generation: 3,
        issuedAt: NOW_SECONDS - 60,
        expiresAt: NOW_SECONDS + 3600,
        rotationState: 'reindexing',
        writeMode: 'current_only',
        current: {
          generation: 2,
          keyId: 'lookup-key-2',
          slot: 'B',
          fingerprint: await fingerprintLookupHmacKey(KEY_B),
        },
        previous: {
          generation: 1,
          keyId: 'lookup-key-1',
          slot: 'A',
          fingerprint: await fingerprintLookupHmacKey(KEY_A),
        },
      },
      privateJwk,
    });
    const shardRegistry = await signLookupShardRegistry({
      registry: {
        environmentId: 'test',
        generation: 1,
        issuedAt: NOW_SECONDS - 60,
        expiresAt: NOW_SECONDS + 3600,
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
    registry = new Map([
      [buildLookupHmacKeyStateSnapshotKey('test'), hmacState],
      [buildLookupHmacKeyStateGenerationKey('test'), '3'],
      [buildLookupShardRegistrySnapshotKey('test'), shardRegistry],
      [buildLookupShardRegistryGenerationKey('test'), '1'],
    ]);
  });

  afterEach(() => {
    core.close();
    lookup.close();
  });

  function baseEnv(control: Record<string, unknown>): Env {
    return {
      AUTHRIM_ENVIRONMENT_NAME: 'test',
      LOOKUP_HMAC_KEY_SLOT_A: KEY_A,
      LOOKUP_HMAC_KEY_SLOT_B: KEY_B,
      TENANT_RUNTIME_REGISTRY: { get: async (key: string) => registry.get(key) ?? null },
      TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: JSON.stringify({ keys: [publicJwk] }),
      TDB_USERS_1: d1(core),
      LOOKUP_DB_1: d1(lookup),
      CONTROL: control,
    } as unknown as Env;
  }

  function processorInput() {
    return {
      adapter: {} as never,
      jobClass: 'hmac_reindex' as const,
      cursor: {},
      rowLimit: 10,
      deadlineMs: NOW_MS + 10_000,
      ownerId: 'scheduler',
      fencingToken: 1,
      nowMs: () => NOW_MS,
    };
  }

  it('is idle during staged deployment when Control has no HMAC operation capability', async () => {
    await expect(createLookupHmacReindexProcessor(baseEnv({}))(processorInput())).resolves.toEqual({
      cursor: {},
      processedRows: 0,
    });
  });

  it('projects the candidate generation and persists a resumable source checkpoint', async () => {
    const checkpoint = vi.fn(async (input) => ({ ...input }));
    const control = {
      claimNextLookupHmacRotation: vi.fn(async () => operation('reindexing')),
      getNextLookupHmacRotationSource: vi.fn(async () => ({
        operationId: 'hmac-operation-1',
        sourceKind: 'account_id',
        dataRole: 'tenant_core/users',
        shardId: 'users-1',
        bindingRef: 'TDB_USERS_1',
        routeGeneration: 1,
        cutoffAt: NOW_MS,
        state: 'pending',
        cursor: {},
        sourceRowCount: 0,
        completedAt: null,
        updatedAt: NOW_SECONDS,
      })),
      checkpointLookupHmacRotationSource: checkpoint,
      beginLookupHmacRotationVerification: vi.fn(),
      getNextLookupHmacRotationVerificationShard: vi.fn(),
      checkpointLookupHmacRotationVerificationShard: vi.fn(),
      finalizeLookupHmacRotationVerification: vi.fn(),
      completeLookupHmacRotationGrace: vi.fn(),
    };
    const result = await createLookupHmacReindexProcessor(baseEnv(control))(processorInput());
    expect(result.processedRows).toBe(1);
    expect(checkpoint).toHaveBeenCalledWith(
      expect.objectContaining({ sourceRowCount: 1, complete: true })
    );
    const index = await createLookupBlindIndex('account_id', 'account:user-a', {
      generation: 2,
      secret: KEY_B,
    });
    expect(
      lookup
        .prepare(
          `SELECT tenant_id, account_id, lifecycle_state FROM lookup_identifiers
            WHERE virtual_bucket = ? AND hmac_key_generation = ? AND identifier_blind_digest = ?`
        )
        .get(index.virtualBucket, 2, index.digest)
    ).toEqual({ tenant_id: 'tenant-a', account_id: 'account:user-a', lifecycle_state: 'active' });
    expect(
      lookup
        .prepare(
          `SELECT SUM(successful_route_publication_count) AS count
             FROM lookup_bucket_counters`
        )
        .get()
    ).toEqual({ count: 1 });
  });

  it('reindexes passkey and anonymous credential routes from the authoritative users shard', async () => {
    const sourceAccountIndex = publication.indexes[0];
    const sourcePasskeyIndex = await createLookupBlindIndex(
      'external_subject',
      { issuer: 'urn:authrim:passkey:login.example.com', subject: 'credential-a' },
      { generation: 1, secret: KEY_A }
    );
    const sourceAnonymousIndex = await createLookupBlindIndex(
      'external_subject',
      { issuer: 'urn:authrim:anonymous-device:v1', subject: 'd'.repeat(64) },
      { generation: 1, secret: KEY_A }
    );
    const projection = JSON.stringify(publication.routeProjection);
    const insertLookup = lookup.prepare(
      `INSERT INTO lookup_identifiers (
         virtual_bucket, index_kind, normalization_version, hmac_key_generation,
         identifier_blind_digest, tenant_id, account_id, route_schema_version,
         account_route_generation, required_binding_route_generation, residency_policy_id,
         route_projection_json, tenant_lifecycle_state, runtime_route_status,
         lifecycle_state, created_at, updated_at
       ) VALUES (?, ?, 1, 1, ?, 'tenant-a', 'account:user-a', 1, 1, 1,
         'default-policy', ?, 'active', 'active', 'active', ?, ?)`
    );
    insertLookup.run(
      sourceAccountIndex.virtualBucket,
      sourceAccountIndex.indexKind,
      sourceAccountIndex.digest,
      projection,
      NOW_SECONDS,
      NOW_SECONDS
    );
    insertLookup.run(
      sourcePasskeyIndex.virtualBucket,
      sourcePasskeyIndex.indexKind,
      sourcePasskeyIndex.digest,
      projection,
      NOW_SECONDS,
      NOW_SECONDS
    );
    insertLookup.run(
      sourceAnonymousIndex.virtualBucket,
      sourceAnonymousIndex.indexKind,
      sourceAnonymousIndex.digest,
      projection,
      NOW_SECONDS,
      NOW_SECONDS
    );
    const insertReservation = lookup.prepare(
      `INSERT INTO lookup_identifier_reservations (
           virtual_bucket, tenant_id, index_kind, normalization_version,
           hmac_key_generation, identifier_blind_digest, account_id,
           reservation_state, operation_id, committed_at, created_at, updated_at
         ) VALUES (?, 'tenant-a', 'external_subject', 1, 1, ?, 'account:user-a',
           'committed', ?, ?, ?, ?)`
    );
    insertReservation.run(
      sourcePasskeyIndex.virtualBucket,
      sourcePasskeyIndex.digest,
      'passkey-route-a',
      NOW_SECONDS,
      NOW_SECONDS,
      NOW_SECONDS
    );
    insertReservation.run(
      sourceAnonymousIndex.virtualBucket,
      sourceAnonymousIndex.digest,
      'anonymous-route-a',
      NOW_SECONDS,
      NOW_SECONDS,
      NOW_SECONDS
    );
    core
      .prepare(
        `INSERT INTO passkeys (id, tenant_id, user_id, credential_id, rp_id, created_at)
         VALUES ('passkey-a', 'tenant-a', 'user-a', 'credential-a',
                 'login.example.com', ?)`
      )
      .run(NOW_MS - 5_000);
    core
      .prepare(
        `INSERT INTO anonymous_devices (
           id, tenant_id, user_id, device_id_hash, created_at, is_active
         ) VALUES ('anonymous-a', 'tenant-a', 'user-a', ?, ?, 1)`
      )
      .run('d'.repeat(64), NOW_MS - 4_000);

    const checkpoint = vi.fn(async (input) => ({ ...input }));
    const control = {
      claimNextLookupHmacRotation: vi.fn(async () => operation('reindexing')),
      getNextLookupHmacRotationSource: vi.fn(async () => ({
        operationId: 'hmac-operation-1',
        sourceKind: 'external_subject',
        dataRole: 'tenant_core/users',
        shardId: 'users-1',
        bindingRef: 'TDB_USERS_1',
        routeGeneration: 1,
        cutoffAt: NOW_MS,
        state: 'pending',
        cursor: {},
        sourceRowCount: 0,
        completedAt: null,
        updatedAt: NOW_SECONDS,
      })),
      checkpointLookupHmacRotationSource: checkpoint,
      beginLookupHmacRotationVerification: vi.fn(),
      getNextLookupHmacRotationVerificationShard: vi.fn(),
      checkpointLookupHmacRotationVerificationShard: vi.fn(),
      finalizeLookupHmacRotationVerification: vi.fn(),
      completeLookupHmacRotationGrace: vi.fn(),
    };

    await createLookupHmacReindexProcessor(baseEnv(control))(processorInput());

    const candidate = await createLookupBlindIndex(
      'external_subject',
      { issuer: 'urn:authrim:passkey:login.example.com', subject: 'credential-a' },
      { generation: 2, secret: KEY_B }
    );
    expect(
      lookup
        .prepare(
          `SELECT account_id, lifecycle_state FROM lookup_identifiers
            WHERE virtual_bucket = ? AND hmac_key_generation = 2
              AND identifier_blind_digest = ?`
        )
        .get(candidate.virtualBucket, candidate.digest)
    ).toEqual({ account_id: 'account:user-a', lifecycle_state: 'active' });
    const anonymousCandidate = await createLookupBlindIndex(
      'external_subject',
      { issuer: 'urn:authrim:anonymous-device:v1', subject: 'd'.repeat(64) },
      { generation: 2, secret: KEY_B }
    );
    expect(
      lookup
        .prepare(
          `SELECT account_id, lifecycle_state FROM lookup_identifiers
            WHERE virtual_bucket = ? AND hmac_key_generation = 2
              AND identifier_blind_digest = ?`
        )
        .get(anonymousCandidate.virtualBucket, anonymousCandidate.digest)
    ).toEqual({ account_id: 'account:user-a', lifecycle_state: 'active' });
    expect(checkpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: { after_created_at: NOW_MS - 4_000, after_id: 'anonymous:anonymous-a' },
        sourceRowCount: 2,
        complete: true,
      })
    );
  });

  it('records route tampering as failed verification evidence', async () => {
    const index = await createLookupBlindIndex('account_id', 'account:user-a', {
      generation: 2,
      secret: KEY_B,
    });
    lookup
      .prepare(
        `INSERT INTO lookup_identifiers (
           virtual_bucket, index_kind, normalization_version, hmac_key_generation,
           identifier_blind_digest, tenant_id, account_id, route_schema_version,
           account_route_generation, required_binding_route_generation, residency_policy_id,
           route_projection_json, tenant_lifecycle_state, runtime_route_status,
           lifecycle_state, created_at, updated_at
         ) VALUES (?, 'account_id', 1, 2, ?, 'tenant-a', 'account:user-a', 1, 1, 1,
           'default-policy', ?, 'active', 'active', 'active', ?, ?)`
      )
      .run(
        index.virtualBucket,
        index.digest,
        JSON.stringify({ broken: true }),
        NOW_SECONDS,
        NOW_SECONDS
      );
    const checkpoint = vi.fn(async (input) => ({ ...input }));
    const control = {
      claimNextLookupHmacRotation: vi.fn(async () => operation('verifying')),
      getNextLookupHmacRotationSource: vi.fn(),
      checkpointLookupHmacRotationSource: vi.fn(),
      beginLookupHmacRotationVerification: vi.fn(),
      getNextLookupHmacRotationVerificationShard: vi.fn(async () => ({
        operationId: 'hmac-operation-1',
        lookupShardId: 'lookup-1',
        bindingRef: 'LOOKUP_DB_1',
        state: 'pending',
        cursor: {},
        currentRowCount: 0,
        currentRowsValid: true,
        reservationsValid: true,
        routeReferencesValid: true,
        completedAt: null,
        updatedAt: NOW_SECONDS,
      })),
      checkpointLookupHmacRotationVerificationShard: checkpoint,
      finalizeLookupHmacRotationVerification: vi.fn(),
      completeLookupHmacRotationGrace: vi.fn(),
    };
    await createLookupHmacReindexProcessor(baseEnv(control))(processorInput());
    expect(checkpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        currentRowCount: 1,
        complete: true,
        result: expect.objectContaining({
          currentRowsValid: false,
          routeReferencesValid: false,
        }),
      })
    );
  });

  it('finalizes completed verification evidence and elapsed grace without scanning data', async () => {
    const finalize = vi.fn(async () => operation('grace'));
    const completeGrace = vi.fn(async () => operation('complete'));
    const control = {
      claimNextLookupHmacRotation: vi
        .fn()
        .mockResolvedValueOnce(operation('verifying'))
        .mockResolvedValueOnce({
          ...operation('grace'),
          graceExpiresAt: NOW_SECONDS - 1,
        }),
      getNextLookupHmacRotationSource: vi.fn(),
      checkpointLookupHmacRotationSource: vi.fn(),
      beginLookupHmacRotationVerification: vi.fn(),
      getNextLookupHmacRotationVerificationShard: vi.fn(async () => null),
      checkpointLookupHmacRotationVerificationShard: vi.fn(),
      finalizeLookupHmacRotationVerification: finalize,
      completeLookupHmacRotationGrace: completeGrace,
    };
    const processor = createLookupHmacReindexProcessor(baseEnv(control));
    await expect(processor(processorInput())).resolves.toMatchObject({ processedRows: 0 });
    expect(finalize).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: 'hmac-operation-1', fencingToken: 3 })
    );
    await expect(processor(processorInput())).resolves.toMatchObject({ processedRows: 0 });
    expect(completeGrace).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: 'hmac-operation-1', fencingToken: 3 })
    );
  });
});
