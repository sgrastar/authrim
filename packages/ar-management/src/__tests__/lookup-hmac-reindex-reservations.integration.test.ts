import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type SQLiteDatabase } from './test-sqlite';
import { fileURLToPath } from 'node:url';
import type { D1Database, D1DatabaseSession } from '@cloudflare/workers-types';
import {
  accountDirectoryRemovalOutboxId,
  buildLookupHmacKeyStateGenerationKey,
  buildLookupHmacKeyStateSnapshotKey,
  buildLookupShardRegistryGenerationKey,
  buildLookupShardRegistrySnapshotKey,
  createD1Adapter,
  createLookupBlindIndex,
  fingerprintLookupHmacKey,
  signLookupHmacKeyState,
  signLookupShardRegistry,
  type AccountDirectoryPublication,
  type AccountDirectoryRemovalPublication,
  type ControlLookupHmacRotationView,
  type Env,
  type LookupBlindIndex,
} from '@authrim/ar-lib-core';
import { exportJWK, generateKeyPair, type JWK } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountDirectoryRemovalCoordinator } from '../account-directory-removal';
import { InitialAccountIdentifierReservationService } from '../account-directory-reservation';
import { IdentifierReplacementCoordinator } from '../identifier-replacement-coordinator';
import { IdentifierReplacementOperationRepository } from '../identifier-replacement-operation';
import { createLookupHmacReindexProcessor } from '../lookup-hmac-reindex';
import { resetLookupHmacRuntimeKeyCacheForTest } from '../lookup-hmac-runtime';

/**
 * What an HMAC reindex leaves behind in the Lookup reservations when the link it projects is gone,
 * or goes while it runs: real SQL on the Lookup baseline and the tenant core baseline, the real
 * reindex processor, the real removal coordinator and the real reservation service.
 */

type StatementSync = ReturnType<SQLiteDatabase['prepare']>;
type SqlValue = string | number | null | Uint8Array;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const NOW_SECONDS = Math.floor(Date.now() / 1000);
const NOW_MS = NOW_SECONDS * 1000;
const KEY_A = 'lookup-key-a-0123456789abcdef0123456789abcdef';
const KEY_B = 'lookup-key-b-0123456789abcdef0123456789abcdef';
const PASSKEY = { issuer: 'urn:authrim:passkey:login.example.com', subject: 'credential-a' };
const ACCOUNT = 'account:user-a';
/** The source (generation 1) reservation was acquired long before the reindex ... */
const ACQUIRED_AT = NOW_SECONDS - 1000;
/** ... and the unlink was prepared after that, but before the reindex reached the row. */
const REMOVAL_PREPARED_AT = NOW_SECONDS - 500;

type PrepareHook = (sql: string) => void;
type FirstHook = (sql: string) => Promise<void>;

class BoundStatement {
  constructor(
    private readonly sql: string,
    private readonly statement: StatementSync,
    private readonly values: SqlValue[],
    private readonly beforeFirst?: { current?: FirstHook }
  ) {}

  async first<T>(): Promise<T | null> {
    await this.beforeFirst?.current?.(this.sql);
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
  constructor(
    private readonly sql: string,
    private readonly statement: StatementSync,
    private readonly beforeFirst?: { current?: FirstHook }
  ) {}

  bind(...values: unknown[]): BoundStatement {
    return new BoundStatement(
      this.sql,
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
      }),
      this.beforeFirst
    );
  }
}

function d1(
  database: SQLiteDatabase,
  hook?: { current?: PrepareHook },
  beforeFirst?: { current?: FirstHook }
): D1Database {
  const prepare = (sql: string) => {
    hook?.current?.(sql);
    return new PreparedStatement(sql, database.prepare(sql), beforeFirst);
  };
  const batch = async (statements: BoundStatement[]) => {
    database.exec('BEGIN IMMEDIATE');
    try {
      const results = [];
      for (const item of statements) results.push(await item.run());
      database.exec('COMMIT');
      return results;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  };
  const session = {
    prepare,
    batch,
    getBookmark: () => 'test-bookmark',
  } as unknown as D1DatabaseSession;
  return { prepare, batch, withSession: () => session } as unknown as D1Database;
}

function operation(): ControlLookupHmacRotationView {
  return {
    operationId: 'hmac-operation-1',
    state: 'reindexing',
    source: { generation: 1, keyId: 'lookup-key-1', slot: 'A', fingerprint: 'a'.repeat(64) },
    candidate: { generation: 2, keyId: 'lookup-key-2', slot: 'B', fingerprint: 'b'.repeat(64) },
    checkpoint: {},
    sourceRowCount: null,
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

describe('HMAC reindex and the reservations of the new generation', () => {
  let core: SQLiteDatabase;
  let lookup: SQLiteDatabase;
  let pii: SQLiteDatabase;
  let privateJwk: JWK;
  let publicJwk: JWK;
  let registry: Map<string, string>;
  let publication: AccountDirectoryPublication;
  let sourceIndex: LookupBlindIndex;
  let currentIndex: LookupBlindIndex;
  const hook: { current?: PrepareHook } = {};
  /** The Control stub of the latest reindex call, also when that call rejected. */
  let lastControl: Record<string, ReturnType<typeof vi.fn>>;
  const piiFirst: { current?: FirstHook } = {};
  const coreFirst: { current?: FirstHook } = {};
  const lookupFirst: { current?: FirstHook } = {};

  beforeAll(async () => {
    const pair = await generateKeyPair('EdDSA', { extractable: true });
    privateJwk = { ...(await exportJWK(pair.privateKey)), kid: 'test-signing-key', alg: 'EdDSA' };
    publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'test-signing-key', alg: 'EdDSA' };
  });

  beforeEach(async () => {
    resetLookupHmacRuntimeKeyCacheForTest();
    hook.current = undefined;
    piiFirst.current = undefined;
    coreFirst.current = undefined;
    lookupFirst.current = undefined;
    core = new DatabaseSync(':memory:');
    lookup = new DatabaseSync(':memory:');
    pii = new DatabaseSync(':memory:');
    pii.exec(
      readFileSync(resolve(REPO_ROOT, 'migrations/pii/d1/001_0_4_0_pii_baseline.sql'), 'utf8')
    );
    const placeholders = (sql: string) =>
      sql
        .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '(unixepoch() * 1000)')
        .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', 'unixepoch()');
    core.exec(
      placeholders(
        readFileSync(resolve(REPO_ROOT, 'migrations/core/d1/001_0_4_0_core_baseline.sql'), 'utf8')
      )
    );
    lookup.exec(
      placeholders(
        readFileSync(
          resolve(REPO_ROOT, 'migrations/lookup/d1/001_0_4_0_lookup_baseline.sql'),
          'utf8'
        )
      )
    );
    // The reindex reads guest devices next to passkeys; they belong to a later migration.
    core.exec(
      `CREATE TABLE guest_devices (
         id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL,
         resume_credential_hash TEXT NOT NULL, created_at INTEGER NOT NULL, is_active INTEGER NOT NULL
       )`
    );
    sourceIndex = await createLookupBlindIndex('external_subject', PASSKEY, {
      generation: 1,
      secret: KEY_A,
    });
    currentIndex = await createLookupBlindIndex('external_subject', PASSKEY, {
      generation: 2,
      secret: KEY_B,
    });
    publication = {
      operationId: 'account-create-operation-1',
      tenantId: 'tenant-a',
      accountId: ACCOUNT,
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
          {
            dataRole: 'tenant_pii',
            residencyPartition: 'default',
            shardId: 'pii-1',
            bindingRef: 'TDB_PII_1',
            requiredBindingRouteGeneration: 1,
          },
        ],
      },
      indexes: [
        await createLookupBlindIndex('account_id', ACCOUNT, { generation: 1, secret: KEY_A }),
      ],
    };
    core
      .prepare(
        `INSERT INTO identity_accounts (
           id, tenant_id, account_type, lifecycle_state, legacy_user_id,
           directory_publication_state, account_route_generation, created_at, updated_at
         ) VALUES (?, 'tenant-a', 'person', 'active', 'user-a', 'active', 1, ?, ?)`
      )
      .run(ACCOUNT, NOW_MS - 10_000, NOW_MS - 10_000);
    core
      .prepare(
        `INSERT INTO account_routing_outbox (
           outbox_id, tenant_id, account_id, event_kind, route_generation, route_schema_version,
           hmac_key_generation, payload_json, status, attempt_count, created_at, updated_at
         ) VALUES ('outbox-a', 'tenant-a', ?, 'account_created', 1, 1, 1, ?, 'succeeded', 1, 1, 1)`
      )
      .run(ACCOUNT, JSON.stringify(publication));
    // The generation 1 projection of the account and of the passkey the reindex reads.
    const projection = JSON.stringify(publication.routeProjection);
    const insertRoute = lookup.prepare(
      `INSERT INTO lookup_identifiers (
         virtual_bucket, index_kind, normalization_version, hmac_key_generation,
         identifier_blind_digest, tenant_id, account_id, route_schema_version,
         account_route_generation, required_binding_route_generation, residency_policy_id,
         route_projection_json, tenant_lifecycle_state, runtime_route_status,
         lifecycle_state, created_at, updated_at
       ) VALUES (?, ?, 1, 1, ?, 'tenant-a', ?, 1, 1, 1, 'default-policy', ?,
                 'active', 'active', 'active', ?, ?)`
    );
    for (const index of [publication.indexes[0], sourceIndex]) {
      insertRoute.run(
        index.virtualBucket,
        index.indexKind,
        index.digest,
        ACCOUNT,
        projection,
        ACQUIRED_AT,
        ACQUIRED_AT
      );
    }
    lookup
      .prepare(
        `INSERT INTO lookup_identifier_reservations (
           virtual_bucket, tenant_id, index_kind, normalization_version,
           hmac_key_generation, identifier_blind_digest, account_id,
           reservation_state, operation_id, committed_at, created_at, updated_at
         ) VALUES (?, 'tenant-a', 'external_subject', 1, 1, ?, ?, 'committed',
                   'passkey-add-a', ?, ?, ?)`
      )
      .run(
        sourceIndex.virtualBucket,
        sourceIndex.digest,
        ACCOUNT,
        ACQUIRED_AT,
        ACQUIRED_AT,
        ACQUIRED_AT
      );
    seedPasskey();

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
    pii.close();
  });

  function seedPasskey() {
    core
      .prepare(
        `INSERT INTO passkeys (id, tenant_id, user_id, credential_id, public_key, rp_id, created_at)
         VALUES ('passkey-a', 'tenant-a', 'user-a', 'credential-a', 'key', 'login.example.com', ?)`
      )
      .run(NOW_MS - 5_000);
  }

  /** The unlink of the passkey as a user does it: the authority loses the row. */
  function unlinkPasskey() {
    core.prepare(`DELETE FROM passkeys WHERE id = 'passkey-a'`).run();
  }

  /** The removal an unlink prepares: both generations of the identifier, in the outbox. */
  function prepareRemoval(preparedAt: number): AccountDirectoryRemovalPublication {
    const removal: AccountDirectoryRemovalPublication = {
      operationId: 'passkey-remove-a',
      tenantId: 'tenant-a',
      accountId: ACCOUNT,
      idempotencyKey: 'passkey-remove-a',
      routeProjection: publication.routeProjection,
      scope: 'identifier',
      indexes: [sourceIndex, currentIndex],
    };
    core
      .prepare(
        `INSERT INTO account_routing_outbox (
           outbox_id, tenant_id, account_id, event_kind, route_generation, route_schema_version,
           hmac_key_generation, payload_json, status, attempt_count, created_at, updated_at
         ) VALUES (?, 'tenant-a', ?, 'identifier_removed', 1, 1, 2, ?, 'pending', 0, ?, ?)`
      )
      .run(
        accountDirectoryRemovalOutboxId(removal.operationId),
        ACCOUNT,
        JSON.stringify(removal),
        preparedAt,
        preparedAt
      );
    return removal;
  }

  function runRemoval(removal: AccountDirectoryRemovalPublication) {
    return new AccountDirectoryRemovalCoordinator({
      tenantCore: d1(core),
      lookupForBucket: async () => d1(lookup),
      now: () => NOW_SECONDS + 5,
    }).remove(removal);
  }

  async function reserveAgain(operationId: string, accountId = ACCOUNT) {
    return new InitialAccountIdentifierReservationService({
      lookupForBucket: async () => d1(lookup),
      now: () => NOW_SECONDS + 10,
    }).reserve({
      ...publication,
      operationId,
      accountId,
      idempotencyKey: `key-${operationId}`,
      indexes: [
        await createLookupBlindIndex('account_id', accountId, { generation: 2, secret: KEY_B }),
        currentIndex,
      ],
    });
  }

  function currentReservation() {
    return lookup
      .prepare(
        `SELECT account_id, operation_id, reservation_state, created_at, committed_at,
                released_at, lease_expires_at
           FROM lookup_identifier_reservations
          WHERE hmac_key_generation = 2 AND identifier_blind_digest = ?`
      )
      .get(currentIndex.digest) as Record<string, unknown> | undefined;
  }

  function currentRoute() {
    return lookup
      .prepare(
        `SELECT account_id, lifecycle_state FROM lookup_identifiers
          WHERE hmac_key_generation = 2 AND identifier_blind_digest = ?`
      )
      .get(currentIndex.digest) as Record<string, unknown> | undefined;
  }

  function baseEnv(control: Record<string, unknown>): Env {
    return {
      AUTHRIM_ENVIRONMENT_NAME: 'test',
      LOOKUP_HMAC_KEY_SLOT_A: KEY_A,
      LOOKUP_HMAC_KEY_SLOT_B: KEY_B,
      TENANT_RUNTIME_REGISTRY: { get: async (key: string) => registry.get(key) ?? null },
      TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: JSON.stringify({ keys: [publicJwk] }),
      TDB_USERS_1: d1(core, undefined, coreFirst),
      TDB_PII_1: d1(pii, undefined, piiFirst),
      LOOKUP_DB_1: d1(lookup, hook, lookupFirst),
      CONTROL: control,
    } as unknown as Env;
  }

  async function reindex(
    sourceShard: Record<string, unknown> = {
      sourceKind: 'external_subject',
      dataRole: 'tenant_core/users',
      shardId: 'users-1',
      bindingRef: 'TDB_USERS_1',
    },
    checkpointFailure = false
  ) {
    const control = {
      claimNextLookupHmacRotation: vi.fn(async () => operation()),
      getNextLookupHmacRotationSource: vi.fn(async () => ({
        operationId: 'hmac-operation-1',
        ...sourceShard,
        routeGeneration: 1,
        cutoffAt: NOW_MS,
        state: 'pending',
        cursor: {},
        sourceRowCount: 0,
        completedAt: null,
        updatedAt: NOW_SECONDS,
      })),
      checkpointLookupHmacRotationSource: vi.fn(async (input: Record<string, unknown>) => {
        if (checkpointFailure) throw new Error('checkpoint_unavailable');
        return { ...input };
      }),
      beginLookupHmacRotationVerification: vi.fn(),
      getNextLookupHmacRotationVerificationShard: vi.fn(),
      checkpointLookupHmacRotationVerificationShard: vi.fn(),
      finalizeLookupHmacRotationVerification: vi.fn(),
      completeLookupHmacRotationGrace: vi.fn(),
    };
    lastControl = control;
    const result = await createLookupHmacReindexProcessor(baseEnv(control))({
      adapter: {} as never,
      jobClass: 'hmac_reindex' as const,
      cursor: {},
      rowLimit: 10,
      deadlineMs: NOW_MS + 10_000,
      ownerId: 'scheduler',
      fencingToken: 1,
      nowMs: () => NOW_MS,
    });
    return { result, control };
  }

  /** Runs `action` once, right before the reindex prepares its reservation insert. */
  function beforeReservationUpsert(action: () => void) {
    let fired = false;
    hook.current = (sql) => {
      if (!fired && sql.includes('INSERT OR IGNORE INTO lookup_identifier_reservations')) {
        fired = true;
        action();
      }
    };
    return () => fired;
  }

  it('finishes a checkpoint retry when the source reservation is released after the source scan', async () => {
    await expect(reindex(undefined, true)).rejects.toThrow('checkpoint_unavailable');
    expect(currentReservation()).toMatchObject({ reservation_state: 'committed' });
    let fired = false;
    hook.current = (sql) => {
      if (!fired && sql.includes('SELECT account_id, reservation_state, created_at')) {
        fired = true;
        unlinkPasskey();
        lookup
          .prepare(
            `UPDATE lookup_identifier_reservations SET reservation_state = 'released', released_at = 1 WHERE hmac_key_generation = 1`
          )
          .run();
      }
    };
    const { result, control } = await reindex();
    expect(fired).toBe(true);
    expect(result.processedRows).toBe(1);
    expect(control.checkpointLookupHmacRotationSource).toHaveBeenCalledWith(
      expect.objectContaining({ sourceRowCount: 0, complete: true })
    );
    expect(currentReservation()).toMatchObject({ reservation_state: 'released' });
    expect(currentRoute()).toEqual({ account_id: ACCOUNT, lifecycle_state: 'disabled' });
  });

  it('finishes a stale checkpoint retry whose candidate reservation was already released', async () => {
    await expect(reindex(undefined, true)).rejects.toThrow('checkpoint_unavailable');
    lookup
      .prepare(
        `UPDATE lookup_identifier_reservations SET reservation_state = 'released', released_at = 1 WHERE hmac_key_generation = 2`
      )
      .run();
    const fired = beforeReservationUpsert(() => {
      unlinkPasskey();
      lookup
        .prepare(
          `UPDATE lookup_identifier_reservations SET reservation_state = 'released', released_at = 1 WHERE hmac_key_generation = 1`
        )
        .run();
    });
    await expect(reindex()).resolves.toMatchObject({ result: { processedRows: 1 } });
    expect(fired()).toBe(true);
    expect(lastControl.checkpointLookupHmacRotationSource).toHaveBeenCalledWith(
      expect.objectContaining({ sourceRowCount: 0, complete: true })
    );
    expect(currentReservation()).toMatchObject({ reservation_state: 'released' });
    expect(currentRoute()).toEqual({ account_id: ACCOUNT, lifecycle_state: 'disabled' });
  });

  it('still fails a source ownership conflict while the authority has the link', async () => {
    lookup
      .prepare(
        `UPDATE lookup_identifier_reservations SET reservation_state = 'released', released_at = 1`
      )
      .run();
    await expect(reindex()).rejects.toThrow('lookup_hmac_reindex_source_reservation_invalid');
    expect(lastControl.checkpointLookupHmacRotationSource).not.toHaveBeenCalled();
    expect(currentRoute()).toBeUndefined();
  });

  it("does not take another account's candidate reservation when the source is still authoritative", async () => {
    await reindex();
    lookup
      .prepare(
        `UPDATE lookup_identifier_reservations SET account_id = 'account:other', operation_id = 'other-add' WHERE hmac_key_generation = 2`
      )
      .run();
    const reservation = currentReservation();
    const route = currentRoute();
    await expect(reindex()).rejects.toThrow('lookup_hmac_reindex_reservation_conflict');
    expect(currentReservation()).toEqual(reservation);
    expect(currentRoute()).toEqual(route);
    expect(lastControl.checkpointLookupHmacRotationSource).not.toHaveBeenCalled();
  });

  it('does not hide a storage failure even if the source was unlinked', async () => {
    const fired = beforeReservationUpsert(() => {
      unlinkPasskey();
      throw new Error('lookup_storage_unavailable');
    });
    await expect(reindex()).rejects.toThrow('lookup_storage_unavailable');
    expect(fired()).toBe(true);
    expect(lastControl.checkpointLookupHmacRotationSource).not.toHaveBeenCalled();
  });

  it('does not finish a conflict when its primary authority recheck is unavailable', async () => {
    const fired = beforeReservationUpsert(() => {
      unlinkPasskey();
      lookup
        .prepare(
          `INSERT INTO lookup_identifier_reservations (
        virtual_bucket, tenant_id, index_kind, normalization_version, hmac_key_generation,
        identifier_blind_digest, account_id, reservation_state, operation_id, created_at, updated_at, released_at
      ) VALUES (?, 'tenant-a', 'external_subject', 1, 2, ?, ?, 'released', 'hmac-reindex:hmac-operation-1', 1, 1, 1)`
        )
        .run(currentIndex.virtualBucket, currentIndex.digest, ACCOUNT);
    });
    coreFirst.current = async (sql) => {
      if (sql.includes('SELECT id FROM passkeys')) throw new Error('authority_unavailable');
    };
    await expect(reindex()).rejects.toThrow('authority_unavailable');
    expect(fired()).toBe(true);
    expect(lastControl.checkpointLookupHmacRotationSource).not.toHaveBeenCalled();
  });

  it('gives the new generation the time the source reservation was acquired, not the time of the reindex', async () => {
    await reindex();
    expect(currentReservation()).toMatchObject({
      account_id: ACCOUNT,
      operation_id: 'hmac-reindex:hmac-operation-1',
      reservation_state: 'committed',
      created_at: ACQUIRED_AT,
      committed_at: NOW_SECONDS,
    });
    expect(currentRoute()).toEqual({ account_id: ACCOUNT, lifecycle_state: 'active' });
  });

  it('lets an unlink prepared before the reindex reached the row release what the reindex created', async () => {
    await reindex();
    const removal = prepareRemoval(REMOVAL_PREPARED_AT);
    // The authority still has the passkey when the reindex projects it; the removal then runs.
    unlinkPasskey();
    await expect(runRemoval(removal)).resolves.toMatchObject({ status: 201 });
    expect(currentReservation()).toMatchObject({ reservation_state: 'released' });
    expect(currentRoute()).toEqual({ account_id: ACCOUNT, lifecycle_state: 'disabled' });
    await expect(reserveAgain('readd-1')).resolves.toEqual({ reservedCount: 1 });
  });

  it('releases (not leaves in releasing) what it projected for a link the authority no longer has', async () => {
    const fired = beforeReservationUpsert(unlinkPasskey);
    await reindex();
    expect(fired()).toBe(true);
    expect(currentReservation()).toMatchObject({
      reservation_state: 'released',
      lease_expires_at: null,
      released_at: NOW_SECONDS,
    });
    expect(currentRoute()).toEqual({ account_id: ACCOUNT, lifecycle_state: 'disabled' });
    await expect(reserveAgain('readd-1')).resolves.toEqual({ reservedCount: 1 });
    expect(currentReservation()).toMatchObject({
      operation_id: 'readd-1',
      reservation_state: 'reserved',
    });
  });

  it('survives the race: unlink and removal prepared between the reindex reading the link and writing', async () => {
    let removal: AccountDirectoryRemovalPublication | undefined;
    beforeReservationUpsert(() => {
      unlinkPasskey();
      removal = prepareRemoval(REMOVAL_PREPARED_AT);
    });
    await reindex();
    expect(removal).toBeDefined();
    // The removal runs after the reindex, in either order of finishing it must end released.
    if (!removal) throw new Error('removal_hook_not_called');
    await expect(runRemoval(removal)).resolves.toMatchObject({ status: 201 });
    expect(currentReservation()).toMatchObject({ reservation_state: 'released' });
    expect(currentRoute()).toEqual({ account_id: ACCOUNT, lifecycle_state: 'disabled' });
    // The identifier can be linked again straight away, by the same account and by another.
    await expect(reserveAgain('readd-1')).resolves.toEqual({ reservedCount: 1 });
    expect(currentReservation()).toMatchObject({ operation_id: 'readd-1' });
  });

  it('survives the race when the removal released the source generation just before the reindex wrote the new one', async () => {
    let removal: AccountDirectoryRemovalPublication | undefined;
    beforeReservationUpsert(() => {
      unlinkPasskey();
      removal = prepareRemoval(REMOVAL_PREPARED_AT);
      // The removal's effect on the source generation (it runs between the reindex's check of
      // the source reservation and its write of the new generation).
      lookup
        .prepare(
          `UPDATE lookup_identifier_reservations
              SET reservation_state = 'released', released_at = ?, updated_at = ?
            WHERE hmac_key_generation = 1 AND identifier_blind_digest = ?`
        )
        .run(NOW_SECONDS - 1, NOW_SECONDS - 1, sourceIndex.digest);
    });
    await reindex();
    expect(currentReservation()).toMatchObject({ reservation_state: 'released' });
    if (!removal) throw new Error('removal_hook_not_called');
    await expect(runRemoval(removal)).resolves.toMatchObject({ status: 201 });
    await expect(reserveAgain('readd-1')).resolves.toEqual({ reservedCount: 1 });
  });

  it('leaves a reservation another operation holds alone, and its route', async () => {
    // An add of the new generation by another operation committed the identifier before the
    // reindex reached the row; the link this reindex row stands for is gone.
    lookup
      .prepare(
        `INSERT INTO lookup_identifier_reservations (
           virtual_bucket, tenant_id, index_kind, normalization_version,
           hmac_key_generation, identifier_blind_digest, account_id,
           reservation_state, operation_id, committed_at, created_at, updated_at
         ) VALUES (?, 'tenant-a', 'external_subject', 1, 2, ?, ?, 'committed',
                   'passkey-add-b', ?, ?, ?)`
      )
      .run(
        currentIndex.virtualBucket,
        currentIndex.digest,
        ACCOUNT,
        NOW_SECONDS - 10,
        NOW_SECONDS - 10,
        NOW_SECONDS - 10
      );
    const fired = beforeReservationUpsert(unlinkPasskey);
    await reindex();
    expect(fired()).toBe(true);
    expect(currentReservation()).toMatchObject({
      operation_id: 'passkey-add-b',
      reservation_state: 'committed',
      created_at: NOW_SECONDS - 10,
      released_at: null,
    });
    expect(currentRoute()).toEqual({ account_id: ACCOUNT, lifecycle_state: 'active' });
  });

  it('releases a reservation of its own that something moved to releasing meanwhile', async () => {
    const fired = beforeReservationUpsert(() => {
      unlinkPasskey();
    });
    // Between its reservation write and its stale check the email replacement flips the row.
    let flipped = false;
    const previous = hook.current;
    hook.current = (sql) => {
      previous?.(sql);
      if (fired() && !flipped && sql.includes('SELECT 1 AS present FROM lookup_bucket_counters')) {
        flipped = true;
        lookup
          .prepare(
            `UPDATE lookup_identifier_reservations SET reservation_state = 'releasing'
              WHERE hmac_key_generation = 2`
          )
          .run();
      }
    };
    await reindex();
    expect(flipped).toBe(true);
    expect(currentReservation()).toMatchObject({ reservation_state: 'released' });
  });

  describe('a reservation released after the reindex checked it', () => {
    function releaseBeforeBatch(alsoUnlink = false) {
      let fired = false;
      hook.current = (sql) => {
        if (!fired && sql.includes('UPDATE lookup_bucket_counters')) {
          fired = true;
          // A removal (or the email replacement's completion) releases the row between the
          // reindex's check of the reservation and its batch.
          lookup
            .prepare(
              `UPDATE lookup_identifier_reservations
                  SET reservation_state = 'released', released_at = ?, updated_at = ?
                WHERE hmac_key_generation = 2 AND identifier_blind_digest = ?`
            )
            .run(NOW_SECONDS, NOW_SECONDS, currentIndex.digest);
          if (alsoUnlink) unlinkPasskey();
        }
      };
      return () => fired;
    }
    const publicationCount = () =>
      lookup
        .prepare(
          `SELECT successful_route_publication_count AS count FROM lookup_bucket_counters
            WHERE virtual_bucket = ?`
        )
        .get(currentIndex.virtualBucket);

    it('fails the row, writes no route or publication count, and does not move the cursor while the authority still has the link', async () => {
      const fired = releaseBeforeBatch();
      await expect(reindex()).rejects.toThrow('lookup_hmac_reindex_reservation_not_committed');
      expect(fired()).toBe(true);
      expect(lastControl.checkpointLookupHmacRotationSource).not.toHaveBeenCalled();
      expect(lastControl.beginLookupHmacRotationVerification).not.toHaveBeenCalled();
      expect(currentReservation()).toMatchObject({ reservation_state: 'released' });
      expect(currentRoute()).toBeUndefined();
      expect(publicationCount()).toEqual({ count: 0 });
    });

    it("does not let another account's route make up for the missing one", async () => {
      // A new link added after the cutoff, by another account: its generation 2 route exists, so
      // the number of active routes of the new generation equals the number of source rows the
      // reindex would have counted. A count comparison cannot tell; the row has to fail.
      const other = await createLookupBlindIndex(
        'external_subject',
        { issuer: 'urn:authrim:passkey:login.example.com', subject: 'credential-other' },
        { generation: 2, secret: KEY_B }
      );
      lookup
        .prepare(
          `INSERT INTO lookup_identifiers (
             virtual_bucket, index_kind, normalization_version, hmac_key_generation,
             identifier_blind_digest, tenant_id, account_id, route_schema_version,
             account_route_generation, required_binding_route_generation, residency_policy_id,
             route_projection_json, tenant_lifecycle_state, runtime_route_status,
             lifecycle_state, created_at, updated_at
           ) VALUES (?, 'external_subject', 1, 2, ?, 'tenant-a', 'account:other', 1, 1, 1,
                     'default-policy', '{}', 'active', 'active', 'active', ?, ?)`
        )
        .run(other.virtualBucket, other.digest, NOW_SECONDS + 5, NOW_SECONDS + 5);
      expect(
        lookup
          .prepare(
            `SELECT COUNT(*) AS count FROM lookup_identifiers
              WHERE hmac_key_generation = 2 AND lifecycle_state = 'active'
                AND index_kind = 'external_subject'`
          )
          .get()
      ).toEqual({ count: 1 });
      releaseBeforeBatch();
      await expect(reindex()).rejects.toThrow('lookup_hmac_reindex_reservation_not_committed');
      expect(lastControl.checkpointLookupHmacRotationSource).not.toHaveBeenCalled();
      expect(lastControl.beginLookupHmacRotationVerification).not.toHaveBeenCalled();
      expect(currentRoute()).toBeUndefined();
    });

    it('is finished as before when the authority no longer has the link', async () => {
      const released = releaseBeforeBatch(true);
      const { result } = await reindex();
      expect(released()).toBe(true);
      expect(result.processedRows).toBe(1);
      expect(lastControl.checkpointLookupHmacRotationSource).toHaveBeenCalledWith(
        expect.objectContaining({ sourceRowCount: 1 - 1, complete: true })
      );
      expect(currentReservation()).toMatchObject({ reservation_state: 'released' });
      expect(currentRoute()).toBeUndefined();
      expect(publicationCount()).toEqual({ count: 0 });
      await expect(reserveAgain('readd-1')).resolves.toEqual({ reservedCount: 1 });
    });
  });

  describe('an email replacement that runs while the reindex does', () => {
    const OLD_EMAIL = 'old@example.test';
    const NEW_EMAIL = 'new@example.test';
    const sourceShard = {
      sourceKind: 'email_exact',
      dataRole: 'tenant_pii',
      shardId: 'pii-1',
      bindingRef: 'TDB_PII_1',
    };
    const convergeHook: { current?: PrepareHook } = {};
    let oldGen1: LookupBlindIndex;
    let oldGen2: LookupBlindIndex;
    let newGen1: LookupBlindIndex;
    let newGen2: LookupBlindIndex;

    beforeEach(async () => {
      convergeHook.current = undefined;
      const keyA = { generation: 1, secret: KEY_A };
      const keyB = { generation: 2, secret: KEY_B };
      oldGen1 = await createLookupBlindIndex('email_exact', OLD_EMAIL, keyA);
      oldGen2 = await createLookupBlindIndex('email_exact', OLD_EMAIL, keyB);
      newGen1 = await createLookupBlindIndex('email_exact', NEW_EMAIL, keyA);
      newGen2 = await createLookupBlindIndex('email_exact', NEW_EMAIL, keyB);
      pii
        .prepare(
          `INSERT INTO identity_sensitive_values (
             id, tenant_id, owner_type, owner_id, value_key, value_json,
             classification, lifecycle_state, created_at, updated_at
           ) VALUES ('email-1', 'tenant-a', 'runtime_user', 'user-a', 'email', ?,
                     'sensitive', 'active', ?, ?)`
        )
        .run(JSON.stringify(OLD_EMAIL), NOW_MS - 5000, NOW_MS - 5000);
      // The generation 1 projection of the address the reindex reads.
      lookup
        .prepare(
          `INSERT INTO lookup_identifiers (
             virtual_bucket, index_kind, normalization_version, hmac_key_generation,
             identifier_blind_digest, tenant_id, account_id, route_schema_version,
             account_route_generation, required_binding_route_generation, residency_policy_id,
             route_projection_json, tenant_lifecycle_state, runtime_route_status,
             lifecycle_state, created_at, updated_at
           ) VALUES (?, 'email_exact', 1, 1, ?, 'tenant-a', ?, 1, 1, 1, 'default-policy', ?,
                     'active', 'active', 'active', ?, ?)`
        )
        .run(
          oldGen1.virtualBucket,
          oldGen1.digest,
          ACCOUNT,
          JSON.stringify(publication.routeProjection),
          ACQUIRED_AT,
          ACQUIRED_AT
        );
      lookup
        .prepare(
          `INSERT INTO lookup_identifier_reservations (
             virtual_bucket, tenant_id, index_kind, normalization_version,
             hmac_key_generation, identifier_blind_digest, account_id,
             reservation_state, operation_id, committed_at, created_at, updated_at
           ) VALUES (?, 'tenant-a', 'email_exact', 1, 1, ?, ?, 'committed',
                     'email-add-a', ?, ?, ?)`
        )
        .run(oldGen1.virtualBucket, oldGen1.digest, ACCOUNT, ACQUIRED_AT, ACQUIRED_AT, ACQUIRED_AT);
    });

    async function startReplacement(
      oldIndexes: LookupBlindIndex[],
      newIndexes: LookupBlindIndex[]
    ) {
      await new IdentifierReplacementOperationRepository(
        createD1Adapter(d1(pii), 'pii'),
        () => NOW_SECONDS
      ).create({
        operationId: 'replacement-1',
        outboxId: 'replacement-outbox-1',
        tenantId: 'tenant-a',
        accountId: 'user-a',
        authority: 'admin',
        actorRef: 'admin-a',
        idempotencyKeySha256: 'c'.repeat(64),
        requestFingerprintSha256: 'd'.repeat(64),
        oldValue: OLD_EMAIL,
        newValue: NEW_EMAIL,
        oldValueSha256: 'a'.repeat(64),
        newValueSha256: 'b'.repeat(64),
        oldIndexes,
        newIndexes,
        authorityEvidence: { authority: 'admin' },
        verificationEvidence: { method: 'admin' },
      });
    }

    function replacement(revoke: () => Promise<void> = async () => {}) {
      return new IdentifierReplacementCoordinator({
        pii: createD1Adapter(d1(pii), 'pii'),
        lookupForBucket: async () => d1(lookup, convergeHook),
        revokeCredentials: revoke,
        now: () => NOW_SECONDS,
      });
    }

    const resume = (coordinator = replacement()) =>
      coordinator.resume({
        operationId: 'replacement-1',
        tenantId: 'tenant-a',
        accountId: 'user-a',
      });

    const replacementState = () =>
      (
        pii
          .prepare(
            `SELECT state FROM identity_identifier_replacement_operations
              WHERE operation_id = 'replacement-1'`
          )
          .get() as { state: string }
      ).state;

    /** Runs `action` once, when the reindex asks the authority whether the address is still there. */
    function duringStaleCheck(action: () => Promise<unknown>) {
      let fired = false;
      piiFirst.current = async (sql) => {
        if (!fired && sql.includes('SELECT id FROM identity_sensitive_values')) {
          fired = true;
          await action();
        }
      };
      return () => fired;
    }

    const oldReservation = () =>
      lookup
        .prepare(
          `SELECT account_id, operation_id, reservation_state, released_at
             FROM lookup_identifier_reservations
            WHERE index_kind = 'email_exact' AND hmac_key_generation = 2
              AND identifier_blind_digest = ?`
        )
        .get(oldGen2.digest) as Record<string, unknown> | undefined;
    const oldRoute = () =>
      lookup
        .prepare(
          `SELECT lifecycle_state FROM lookup_identifiers
            WHERE index_kind = 'email_exact' AND hmac_key_generation = 2
              AND identifier_blind_digest = ?`
        )
        .get(oldGen2.digest) as Record<string, unknown> | undefined;

    it('preserves an unfinished replacement after a retry finds its source reservation releasing', async () => {
      await reindex(sourceShard);
      await startReplacement([oldGen1, oldGen2], [newGen1, newGen2]);
      let fired = false;
      let held: unknown;
      lookupFirst.current = async (sql) => {
        if (!fired && sql.includes('SELECT account_id, reservation_state, created_at')) {
          fired = true;
          await expect(
            resume(
              replacement(async () => {
                throw new Error('revoke_down');
              })
            )
          ).rejects.toThrow('revoke_down');
          held = oldReservation();
        }
      };
      const { control } = await reindex(sourceShard);
      expect(fired).toBe(true);
      expect(replacementState()).toBe('revocation_pending');
      expect(oldReservation()).toEqual(held);
      expect(oldReservation()).toMatchObject({ reservation_state: 'releasing', released_at: null });
      expect(control.checkpointLookupHmacRotationSource).toHaveBeenCalledWith(
        expect.objectContaining({ sourceRowCount: 0, complete: true })
      );
      await expect(resume()).resolves.toEqual({ state: 'completed' });
      expect(oldReservation()).toMatchObject({ reservation_state: 'released' });
    });

    /** Another account adds the old address (the reservation of the generation 2 digest). */
    async function otherAccountAddsOldAddress() {
      return new InitialAccountIdentifierReservationService({
        lookupForBucket: async () => d1(lookup),
        now: () => NOW_SECONDS + 10,
      }).reserve({
        ...publication,
        operationId: 'email-add-b',
        accountId: 'account:user-b',
        idempotencyKey: 'key-email-add-b',
        indexes: [
          await createLookupBlindIndex('account_id', 'account:user-b', {
            generation: 2,
            secret: KEY_B,
          }),
          oldGen2,
        ],
      });
    }

    it('leaves the reservation to the replacement, which releases it when it completes', async () => {
      await startReplacement([oldGen2], [newGen2]);
      const fired = duringStaleCheck(() =>
        resume(replacement(async () => Promise.reject(new Error('revoke_down')))).catch(() => {})
      );
      await reindex(sourceShard);
      expect(fired()).toBe(true);
      expect(replacementState()).toBe('revocation_pending');
      // The replacement holds the old address (releasing, as it left it): nobody can add it.
      expect(oldReservation()).toMatchObject({
        operation_id: 'hmac-reindex:hmac-operation-1',
        reservation_state: 'releasing',
        released_at: null,
      });
      await expect(otherAccountAddsOldAddress()).rejects.toThrow(
        'directory_identifier_reservation_conflict'
      );

      await expect(resume()).resolves.toEqual({ state: 'completed' });
      expect(oldReservation()).toMatchObject({
        account_id: ACCOUNT,
        reservation_state: 'released',
      });
      expect(oldRoute()).toEqual({ lifecycle_state: 'disabled' });
      await expect(otherAccountAddsOldAddress()).resolves.toEqual({ reservedCount: 1 });
    });

    it('does not touch the row or the route while the replacement has not converged yet', async () => {
      await startReplacement([oldGen2], [newGen2]);
      convergeHook.current = (sql) => {
        if (sql.includes(`SET reservation_state = 'committed', committed_at`)) {
          throw new Error('lookup_down');
        }
      };
      const fired = duringStaleCheck(() => resume().catch(() => {}));
      await reindex(sourceShard);
      expect(fired()).toBe(true);
      expect(replacementState()).toBe('authoritative_switched');
      expect(oldReservation()).toMatchObject({
        operation_id: 'hmac-reindex:hmac-operation-1',
        reservation_state: 'committed',
      });
      expect(oldRoute()).toEqual({ lifecycle_state: 'active' });

      convergeHook.current = undefined;
      await expect(resume()).resolves.toEqual({ state: 'completed' });
      expect(oldReservation()).toMatchObject({ reservation_state: 'released' });
      expect(oldRoute()).toEqual({ lifecycle_state: 'disabled' });
    });

    it('leaves it as well to a replacement that is blocked for repair', async () => {
      await startReplacement([oldGen2], [newGen2]);
      const fired = duringStaleCheck(async () => {
        await resume(replacement(async () => Promise.reject(new Error('revoke_down')))).catch(
          () => {}
        );
        pii
          .prepare(
            `UPDATE identity_identifier_replacement_operations
                SET state = 'blocked_forward_repair', error_code = 'x'
              WHERE operation_id = 'replacement-1'`
          )
          .run();
      });
      await reindex(sourceShard);
      expect(fired()).toBe(true);
      expect(oldReservation()).toMatchObject({ reservation_state: 'releasing' });
    });

    it('still releases its own reservation when the replacement is about another generation', async () => {
      // The replacement was prepared before generation 2 existed: it tracks generation 1 only,
      // so nothing but the reindex will ever release the generation 2 row.
      await startReplacement([oldGen1], [newGen1]);
      const fired = duringStaleCheck(() => resume());
      await reindex(sourceShard);
      expect(fired()).toBe(true);
      expect(replacementState()).toBe('completed');
      expect(oldReservation()).toMatchObject({
        account_id: ACCOUNT,
        reservation_state: 'released',
      });
      expect(oldRoute()).toEqual({ lifecycle_state: 'disabled' });
      await expect(otherAccountAddsOldAddress()).resolves.toEqual({ reservedCount: 1 });
    });

    it.each([
      ['completed', `state = 'completed', completed_at = 1, authoritative_switched_at = 1`],
      ['canceled', `state = 'canceled'`],
    ])('does not treat a %s replacement as the owner', async (_name, assignment) => {
      await startReplacement([oldGen2], [newGen2]);
      pii.prepare(`UPDATE identity_identifier_replacement_operations SET ${assignment}`).run();
      const fired = duringStaleCheck(async () => {
        pii.prepare(`DELETE FROM identity_sensitive_values WHERE id = 'email-1'`).run();
      });
      await reindex(sourceShard);
      expect(fired()).toBe(true);
      expect(oldReservation()).toMatchObject({ reservation_state: 'released' });
    });

    it('does not treat a replacement of another account as the owner', async () => {
      await startReplacement([oldGen2], [newGen2]);
      pii
        .prepare(`UPDATE identity_identifier_replacement_operations SET account_id = 'user-z'`)
        .run();
      const fired = duringStaleCheck(async () => {
        pii.prepare(`DELETE FROM identity_sensitive_values WHERE id = 'email-1'`).run();
      });
      await reindex(sourceShard);
      expect(fired()).toBe(true);
      expect(oldReservation()).toMatchObject({ reservation_state: 'released' });
    });

    it('does not bring the old route back when the replacement released the address meanwhile', async () => {
      await startReplacement([oldGen2], [newGen2]);
      let fired = false;
      hook.current = (sql) => {
        if (!fired && sql.includes('UPDATE lookup_bucket_counters')) {
          fired = true;
          // The replacement's completion released the old address and switched the address in
          // the authority, after the reindex found the reservation committed and before it wrote
          // the route; the replacement's operation is still unfinished on the PII side.
          lookup
            .prepare(
              `UPDATE lookup_identifier_reservations
                  SET reservation_state = 'released', released_at = ?, updated_at = ?
                WHERE hmac_key_generation = 2 AND identifier_blind_digest = ?`
            )
            .run(NOW_SECONDS, NOW_SECONDS, oldGen2.digest);
          pii
            .prepare(`UPDATE identity_sensitive_values SET value_json = ? WHERE id = 'email-1'`)
            .run(JSON.stringify(NEW_EMAIL));
        }
      };
      await reindex(sourceShard);
      expect(fired).toBe(true);
      expect(oldReservation()).toMatchObject({ reservation_state: 'released' });
      expect(oldRoute()).toBeUndefined();
      // Another account takes the address: nothing else answers for it.
      await expect(otherAccountAddsOldAddress()).resolves.toEqual({ reservedCount: 1 });
      expect(
        lookup
          .prepare(
            `SELECT COUNT(*) AS count FROM lookup_identifiers
              WHERE hmac_key_generation = 2 AND identifier_blind_digest = ?
                AND lifecycle_state = 'active'`
          )
          .get(oldGen2.digest)
      ).toEqual({ count: 0 });
    });

    it('fails the row (to be tried again) while the authority still has the address of a replacement that released it', async () => {
      await startReplacement([oldGen2], [newGen2]);
      let fired = false;
      hook.current = (sql) => {
        if (!fired && sql.includes('UPDATE lookup_bucket_counters')) {
          fired = true;
          lookup
            .prepare(
              `UPDATE lookup_identifier_reservations
                  SET reservation_state = 'released', released_at = ?, updated_at = ?
                WHERE hmac_key_generation = 2 AND identifier_blind_digest = ?`
            )
            .run(NOW_SECONDS, NOW_SECONDS, oldGen2.digest);
        }
      };
      await expect(reindex(sourceShard)).rejects.toThrow(
        'lookup_hmac_reindex_reservation_not_committed'
      );
      expect(fired).toBe(true);
      expect(lastControl.checkpointLookupHmacRotationSource).not.toHaveBeenCalled();
      expect(oldRoute()).toBeUndefined();
    });

    it('releases its own reservation when the address is gone without any replacement', async () => {
      const fired = duringStaleCheck(async () => {
        pii.prepare(`DELETE FROM identity_sensitive_values WHERE id = 'email-1'`).run();
      });
      await reindex(sourceShard);
      expect(fired()).toBe(true);
      expect(oldReservation()).toMatchObject({ reservation_state: 'released' });
      expect(oldRoute()).toEqual({ lifecycle_state: 'disabled' });
    });
  });
});
