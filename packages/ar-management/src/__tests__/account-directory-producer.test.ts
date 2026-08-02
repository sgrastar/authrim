import {
  buildLookupHmacKeyStateGenerationKey,
  buildLookupHmacKeyStateSnapshotKey,
  fingerprintLookupHmacKey,
  signLookupHmacKeyState,
  type AccountDirectoryPublication,
  type ControlTenantShardCapacityResult,
  type Env,
} from '@authrim/ar-lib-core';
import { exportJWK, generateKeyPair, type JWK } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AccountCreationOperation,
  AccountCreationOperationStatus,
} from '../account-creation-operation';
import {
  attemptImmediateAccountDirectoryPublication,
  buildInitialAccountDirectoryPublication,
  executeDurableInitialAccountDirectoryWrite,
  executeInitialAccountDirectoryWrite,
  resolveInitialAccountDirectoryWriteTargets,
} from '../account-directory-producer';
import { resetLookupHmacRuntimeKeyCacheForTest } from '../lookup-hmac-runtime';

const HMAC_KEY = 'lookup-producer-key-0123456789abcdef0123456789';
const HMAC_KEY_B = 'lookup-producer-key-b-0123456789abcdef0123456789';
const registry = new Map<string, string>();
let publicJwks = '';
let privateJwk: JWK;
let stableToken = '';

beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA', { extractable: true });
  privateJwk = {
    ...(await exportJWK(pair.privateKey)),
    kid: 'registry-test-key',
    alg: 'EdDSA',
  };
  const publicJwk = {
    ...(await exportJWK(pair.publicKey)),
    kid: 'registry-test-key',
    alg: 'EdDSA',
  };
  const now = Math.floor(Date.now() / 1000);
  stableToken = await signLookupHmacKeyState({
    state: {
      environmentId: 'test',
      generation: 1,
      issuedAt: now - 1,
      expiresAt: now + 3600,
      rotationState: 'stable',
      writeMode: 'current_only',
      current: {
        generation: 1,
        keyId: 'lookup-key-1',
        slot: 'A',
        fingerprint: await fingerprintLookupHmacKey(HMAC_KEY),
      },
      previous: null,
    },
    privateJwk,
  });
  publicJwks = JSON.stringify({ keys: [publicJwk] });
});

beforeEach(() => {
  resetLookupHmacRuntimeKeyCacheForTest();
  registry.set(buildLookupHmacKeyStateSnapshotKey('test'), stableToken);
  registry.set(buildLookupHmacKeyStateGenerationKey('test'), '1');
});

function writableD1(order: string[]) {
  let outboxStatus: string | null = null;
  const prepare = (sql: string) => {
    const statement = {
      bind: (..._params: unknown[]) => statement,
      run: async () => {
        if (sql.includes('UPDATE account_routing_outbox')) {
          const changed = outboxStatus === 'prepared';
          if (changed) {
            outboxStatus = 'pending';
            order.push('ready');
          }
          return { success: true, meta: { changes: changed ? 1 : 0 } };
        }
        return { success: true, meta: { changes: 0 } };
      },
      first: async () => (outboxStatus ? { status: outboxStatus } : null),
      all: async () => ({ success: true, results: [], meta: {} }),
    };
    return statement;
  };
  return {
    binding: {
      prepare,
      batch: vi.fn(async () => []),
      withSession: vi.fn(),
    },
    setOutboxPrepared: () => {
      outboxStatus = 'prepared';
    },
    getOutboxStatus: () => outboxStatus,
  };
}

function env() {
  const allocateAccountRoute = vi.fn(async () => ({
    tenantId: 'tenant-a',
    residencyPolicyId: 'policy-a',
    targets: [
      {
        allocationId: 'allocation-users',
        dataRole: 'tenant_core/users' as const,
        residencyPartition: 'jp',
        shardId: 'users-jp-1',
        bindingRef: 'TDB_USERS_JP_1',
        routeGeneration: 3,
      },
      {
        allocationId: 'allocation-pii',
        dataRole: 'tenant_pii' as const,
        residencyPartition: 'jp',
        shardId: 'pii-jp-1',
        bindingRef: 'TDB_PII_JP_1',
        routeGeneration: 5,
      },
    ],
  }));
  const ensureTenantShardCapacity = vi.fn(
    async ({
      dataRole,
    }: {
      dataRole: 'tenant_core/users' | 'tenant_pii';
    }): Promise<ControlTenantShardCapacityResult> => ({
      state: 'ready',
      target: {
        shardId: dataRole === 'tenant_pii' ? 'pii-jp-1' : 'users-jp-1',
        dataRole,
        residencyPolicyId: 'policy-a',
        residencyPartition: 'jp',
        routeGeneration: dataRole === 'tenant_pii' ? 5 : 3,
        bindingRef: dataRole === 'tenant_pii' ? 'TDB_PII_JP_1' : 'TDB_USERS_JP_1',
        databaseId: dataRole === 'tenant_pii' ? 'database-pii-jp-1' : 'database-users-jp-1',
        databaseName: dataRole === 'tenant_pii' ? 'pii-jp-1' : 'users-jp-1',
        allocationScope: 'tenant_exclusive',
        ownerTenantId: 'tenant-a',
        assignmentGeneration: 1,
      },
      operation: null,
    })
  );
  return {
    workerEnv: {
      AUTHRIM_ENVIRONMENT_NAME: 'test',
      LOOKUP_HMAC_KEY_SLOT_A: HMAC_KEY,
      TENANT_RUNTIME_REGISTRY: { get: async (key: string) => registry.get(key) ?? null },
      TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: publicJwks,
      CONTROL: { allocateAccountRoute, ensureTenantShardCapacity },
    } as unknown as Env,
    allocateAccountRoute,
    ensureTenantShardCapacity,
  };
}

describe('account directory producer', () => {
  it('allocates routes and returns only blind identifier indexes', async () => {
    const { workerEnv, allocateAccountRoute, ensureTenantShardCapacity } = env();
    const publication = await buildInitialAccountDirectoryPublication(workerEnv, {
      tenantId: 'tenant-a',
      accountId: 'account-a',
      email: ' Person@Example.com ',
      externalSubject: { issuer: 'https://idp.example.com', subject: 'subject-a' },
      residencyPolicyId: 'policy-a',
      residencyPartition: 'jp',
      idempotencyKey: 'create-account-a',
      operationId: 'operation-account-a',
    });

    expect(publication.indexes.map((index) => index.indexKind).sort()).toEqual([
      'account_id',
      'email_exact',
      'external_subject',
    ]);
    expect(publication.routeProjection.targets).toEqual([
      expect.objectContaining({ dataRole: 'tenant_core/users', requiredBindingRouteGeneration: 3 }),
      expect.objectContaining({ dataRole: 'tenant_pii', requiredBindingRouteGeneration: 5 }),
    ]);
    expect(JSON.stringify(publication)).not.toContain('person@example.com');
    expect(JSON.stringify(publication)).not.toContain('subject-a');
    expect(allocateAccountRoute).toHaveBeenCalledWith(
      expect.objectContaining({ dataRoles: ['tenant_core/users', 'tenant_pii'] })
    );
    expect(ensureTenantShardCapacity).not.toHaveBeenCalled();
  });

  it('expands the assigned shard set only after allocation reports capacity exhaustion', async () => {
    const { workerEnv, allocateAccountRoute, ensureTenantShardCapacity } = env();
    allocateAccountRoute
      .mockRejectedValueOnce(new Error('control_account_allocation_capacity_unavailable'))
      .mockResolvedValueOnce({
        tenantId: 'tenant-a',
        residencyPolicyId: 'policy-a',
        targets: [
          {
            allocationId: 'allocation-users',
            dataRole: 'tenant_core/users',
            residencyPartition: 'jp',
            shardId: 'users-jp-1',
            bindingRef: 'TDB_USERS_JP_1',
            routeGeneration: 3,
          },
          {
            allocationId: 'allocation-pii',
            dataRole: 'tenant_pii',
            residencyPartition: 'jp',
            shardId: 'pii-jp-1',
            bindingRef: 'TDB_PII_JP_1',
            routeGeneration: 5,
          },
        ],
      });

    await expect(
      buildInitialAccountDirectoryPublication(workerEnv, {
        tenantId: 'tenant-a',
        accountId: 'account-a',
        residencyPolicyId: 'policy-a',
        residencyPartition: 'jp',
        idempotencyKey: 'create-account-a',
        operationId: 'operation-account-a',
      })
    ).resolves.toMatchObject({ accountId: 'account-a' });

    expect(allocateAccountRoute).toHaveBeenCalledTimes(2);
    expect(ensureTenantShardCapacity).toHaveBeenCalledTimes(2);
    expect(ensureTenantShardCapacity).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-a', dataRole: 'tenant_core/users' })
    );
    expect(ensureTenantShardCapacity).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-a', dataRole: 'tenant_pii' })
    );
  });

  it('keeps account creation retryable while elastic capacity is still provisioning', async () => {
    const { workerEnv, allocateAccountRoute, ensureTenantShardCapacity } = env();
    allocateAccountRoute.mockRejectedValueOnce(
      new Error('control_account_allocation_capacity_unavailable')
    );
    ensureTenantShardCapacity.mockResolvedValueOnce({
      state: 'provisioning',
      target: null,
      operation: {
        operationId: 'capacity-users-a',
        status: 'running',
        attemptCount: 1,
        nextAttemptAt: null,
        lastErrorCode: null,
        createdAt: 100,
        updatedAt: 100,
      },
    });

    await expect(
      buildInitialAccountDirectoryPublication(workerEnv, {
        tenantId: 'tenant-a',
        accountId: 'account-a',
        residencyPolicyId: 'policy-a',
        residencyPartition: 'jp',
        idempotencyKey: 'create-account-a',
        operationId: 'operation-account-a',
      })
    ).rejects.toThrow('control_account_allocation_capacity_unavailable');
    expect(allocateAccountRoute).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the capacity response does not match the requested role', async () => {
    const { workerEnv, allocateAccountRoute, ensureTenantShardCapacity } = env();
    allocateAccountRoute.mockRejectedValueOnce(
      new Error('control_account_allocation_capacity_unavailable')
    );
    ensureTenantShardCapacity.mockResolvedValueOnce({
      state: 'ready',
      target: {
        shardId: 'pii-jp-1',
        dataRole: 'tenant_pii',
        residencyPolicyId: 'policy-a',
        residencyPartition: 'jp',
        routeGeneration: 5,
        bindingRef: 'TDB_PII_JP_1',
        databaseId: 'database-pii-jp-1',
        databaseName: 'pii-jp-1',
        allocationScope: 'tenant_exclusive',
        ownerTenantId: 'tenant-a',
        assignmentGeneration: 1,
      },
      operation: null,
    });

    await expect(
      buildInitialAccountDirectoryPublication(workerEnv, {
        tenantId: 'tenant-a',
        accountId: 'account-a',
        residencyPolicyId: 'policy-a',
        residencyPartition: 'jp',
        idempotencyKey: 'create-account-a',
        operationId: 'operation-account-a',
      })
    ).rejects.toThrow('account_directory_capacity_response_invalid');
    expect(allocateAccountRoute).toHaveBeenCalledTimes(1);
  });

  it('dual-writes current and previous blind indexes only when signed state requires it', async () => {
    const now = Math.floor(Date.now() / 1000);
    registry.set(
      buildLookupHmacKeyStateSnapshotKey('test'),
      await signLookupHmacKeyState({
        state: {
          environmentId: 'test',
          generation: 2,
          issuedAt: now - 1,
          expiresAt: now + 3600,
          rotationState: 'activation_dual_write',
          writeMode: 'dual_write',
          current: {
            generation: 2,
            keyId: 'lookup-key-2',
            slot: 'B',
            fingerprint: await fingerprintLookupHmacKey(HMAC_KEY_B),
          },
          previous: {
            generation: 1,
            keyId: 'lookup-key-1',
            slot: 'A',
            fingerprint: await fingerprintLookupHmacKey(HMAC_KEY),
          },
        },
        privateJwk,
      })
    );
    registry.set(buildLookupHmacKeyStateGenerationKey('test'), '2');
    resetLookupHmacRuntimeKeyCacheForTest();
    const { workerEnv } = env();
    workerEnv.LOOKUP_HMAC_KEY_SLOT_B = HMAC_KEY_B;
    const publication = await buildInitialAccountDirectoryPublication(workerEnv, {
      tenantId: 'tenant-a',
      accountId: 'account-a',
      email: 'person@example.com',
      externalSubject: { issuer: 'https://idp.example.com', subject: 'subject-a' },
      residencyPolicyId: 'policy-a',
      residencyPartition: 'jp',
      idempotencyKey: 'create-account-a',
      operationId: 'operation-account-a',
    });
    expect(publication.indexes).toHaveLength(6);
    for (const kind of ['account_id', 'email_exact', 'external_subject']) {
      expect(
        publication.indexes
          .filter((index) => index.indexKind === kind)
          .map((index) => index.hmacKeyGeneration)
      ).toEqual([2, 1]);
    }
  });

  it('fails closed when Control returns duplicate roles or a residency mismatch', async () => {
    const duplicate = env();
    duplicate.allocateAccountRoute.mockResolvedValueOnce({
      tenantId: 'tenant-a',
      residencyPolicyId: 'policy-a',
      targets: [
        {
          allocationId: 'allocation-users-a',
          dataRole: 'tenant_core/users',
          residencyPartition: 'jp',
          shardId: 'users-jp-1',
          bindingRef: 'TDB_USERS_JP_1',
          routeGeneration: 3,
        },
        {
          allocationId: 'allocation-users-b',
          dataRole: 'tenant_core/users',
          residencyPartition: 'jp',
          shardId: 'users-jp-2',
          bindingRef: 'TDB_USERS_JP_2',
          routeGeneration: 4,
        },
      ],
    });
    await expect(
      buildInitialAccountDirectoryPublication(duplicate.workerEnv, {
        tenantId: 'tenant-a',
        accountId: 'account-a',
        residencyPolicyId: 'policy-a',
        residencyPartition: 'jp',
        idempotencyKey: 'create-account-a',
        operationId: 'operation-account-a',
      })
    ).rejects.toThrow('account_directory_allocation_role_invalid');

    const residency = env();
    residency.allocateAccountRoute.mockResolvedValueOnce({
      tenantId: 'tenant-a',
      residencyPolicyId: 'policy-a',
      targets: [
        {
          allocationId: 'allocation-users',
          dataRole: 'tenant_core/users',
          residencyPartition: 'jp',
          shardId: 'users-jp-1',
          bindingRef: 'TDB_USERS_JP_1',
          routeGeneration: 3,
        },
        {
          allocationId: 'allocation-pii',
          dataRole: 'tenant_pii',
          residencyPartition: 'eu',
          shardId: 'pii-eu-1',
          bindingRef: 'TDB_PII_EU_1',
          routeGeneration: 5,
        },
      ],
    });
    await expect(
      buildInitialAccountDirectoryPublication(residency.workerEnv, {
        tenantId: 'tenant-a',
        accountId: 'account-a',
        residencyPolicyId: 'policy-a',
        residencyPartition: 'jp',
        idempotencyKey: 'create-account-a',
        operationId: 'operation-account-a',
      })
    ).rejects.toThrow('account_directory_allocation_residency_mismatch');
  });

  it('resolves only the exact allocated core and PII D1 bindings', async () => {
    const { workerEnv } = env();
    const publication = await buildInitialAccountDirectoryPublication(workerEnv, {
      tenantId: 'tenant-a',
      accountId: 'account-a',
      residencyPolicyId: 'policy-a',
      residencyPartition: 'jp',
      idempotencyKey: 'create-account-a',
      operationId: 'operation-account-a',
    });
    const core = {
      prepare: vi.fn(),
      batch: vi.fn(),
      withSession: vi.fn(),
    };
    const pii = {
      prepare: vi.fn(),
      batch: vi.fn(),
      withSession: vi.fn(),
    };
    Object.assign(workerEnv as unknown as Record<string, unknown>, {
      TDB_USERS_JP_1: core,
      TDB_PII_JP_1: pii,
    });
    await expect(
      resolveInitialAccountDirectoryWriteTargets(workerEnv, publication)
    ).resolves.toEqual({
      tenantCoreUsers: core,
      tenantPii: pii,
      residencyPartition: 'jp',
    });
    delete (workerEnv as unknown as Record<string, unknown>).TDB_PII_JP_1;
    await expect(
      resolveInitialAccountDirectoryWriteTargets(workerEnv, publication)
    ).rejects.toThrow('account_directory_write_binding_unavailable');
  });

  it('runs reservation, authoritative write, ready transition, and immediate RPC in order', async () => {
    const { workerEnv } = env();
    const order: string[] = [];
    const core = writableD1(order);
    const pii = writableD1(order);
    Object.assign(workerEnv as unknown as Record<string, unknown>, {
      TDB_USERS_JP_1: core.binding,
      TDB_PII_JP_1: pii.binding,
      ACCOUNT_DIRECTORY: {
        publishAccountDirectory: vi.fn(async () => {
          expect(core.getOutboxStatus()).toBe('pending');
          order.push('publish');
          return {
            status: 201 as const,
            accountId: 'account-a',
            operationId: 'operation-account-a',
          };
        }),
      },
    });

    const result = await executeInitialAccountDirectoryWrite(
      workerEnv,
      {
        tenantId: 'tenant-a',
        accountId: 'account-a',
        email: 'person@example.com',
        residencyPolicyId: 'policy-a',
        residencyPartition: 'jp',
        idempotencyKey: 'create-account-a',
        operationId: 'operation-account-a',
      },
      {
        now: () => 100,
        reserveIdentifiers: async () => {
          order.push('reserve');
        },
        writeAuthoritative: async ({ publication, residencyPartition }) => {
          expect(publication.accountId).toBe('account-a');
          expect(residencyPartition).toBe('jp');
          order.push('write');
          core.setOutboxPrepared();
        },
      }
    );

    expect(result.delivery).toEqual({
      status: 201,
      accountId: 'account-a',
      operationId: 'operation-account-a',
    });
    expect(order).toEqual(['reserve', 'write', 'ready', 'publish']);
  });

  it('never writes authoritative account data when identifier reservation fails', async () => {
    const { workerEnv } = env();
    const order: string[] = [];
    const core = writableD1(order);
    const pii = writableD1(order);
    Object.assign(workerEnv as unknown as Record<string, unknown>, {
      TDB_USERS_JP_1: core.binding,
      TDB_PII_JP_1: pii.binding,
    });
    await expect(
      executeInitialAccountDirectoryWrite(
        workerEnv,
        {
          tenantId: 'tenant-a',
          accountId: 'account-a',
          email: 'person@example.com',
          residencyPolicyId: 'policy-a',
          residencyPartition: 'jp',
          idempotencyKey: 'create-account-a',
          operationId: 'operation-account-a',
        },
        {
          reserveIdentifiers: async () => {
            throw new Error('directory_identifier_reservation_conflict');
          },
          writeAuthoritative: async () => {
            order.push('write');
          },
        }
      )
    ).rejects.toThrow('directory_identifier_reservation_conflict');
    expect(order).toEqual([]);
    expect(core.getOutboxStatus()).toBeNull();
  });

  it('resumes a durable directory-pending operation without reallocating or rewriting', async () => {
    const { workerEnv, allocateAccountRoute } = env();
    const order: string[] = [];
    const core = writableD1(order);
    const pii = writableD1(order);
    Object.assign(workerEnv as unknown as Record<string, unknown>, {
      TDB_USERS_JP_1: core.binding,
      TDB_PII_JP_1: pii.binding,
    });
    let operation: AccountCreationOperation = {
      operationId: 'operation-account-a',
      tenantId: 'tenant-a',
      actorId: 'admin-a',
      idempotencyKey: 'request-key-a',
      allocationIdempotencyKey: `account-create:${'a'.repeat(64)}`,
      requestHash: 'b'.repeat(64),
      userId: 'user-a',
      accountId: 'account-a',
      status: 'preparing',
      publication: null,
    };
    const operationRepository = {
      acquire: vi.fn(async () => operation),
      recordPublication: vi.fn(
        async (_current: AccountCreationOperation, publication: AccountDirectoryPublication) => {
          operation = { ...operation, publication };
          return operation;
        }
      ),
      transition: vi.fn(
        async (_current: AccountCreationOperation, status: AccountCreationOperationStatus) => {
          operation = { ...operation, status };
          return operation;
        }
      ),
      recordDirectoryOutcome: vi.fn(async () => {
        operation = { ...operation, status: 'succeeded' };
        return operation;
      }),
    };
    const dependencies = {
      operationRepository: operationRepository as never,
      now: () => 100,
      reserveIdentifiers: vi.fn(async () => {
        order.push('reserve');
      }),
      writeAuthoritative: vi.fn(async () => {
        order.push('write');
        core.setOutboxPrepared();
      }),
    };
    const input = {
      tenantId: 'tenant-a',
      actorId: 'admin-a',
      idempotencyKey: 'request-key-a',
      requestHash: 'b'.repeat(64),
      candidateOperationId: 'operation-account-a',
      candidateUserId: 'user-a',
      email: 'person@example.com',
      residencyPolicyId: 'policy-a',
      residencyPartition: 'jp',
    };

    const pending = await executeDurableInitialAccountDirectoryWrite(
      workerEnv,
      input,
      dependencies
    );
    expect(pending.delivery.status).toBe(202);
    expect(operation.status).toBe('directory_pending');
    expect(order).toEqual(['reserve', 'write', 'ready']);

    (workerEnv as unknown as Record<string, unknown>).ACCOUNT_DIRECTORY = {
      publishAccountDirectory: vi.fn(async () => ({
        status: 201 as const,
        accountId: 'account-a',
        operationId: 'operation-account-a',
      })),
    };
    const completed = await executeDurableInitialAccountDirectoryWrite(
      workerEnv,
      input,
      dependencies
    );
    expect(completed.delivery.status).toBe(201);
    expect(operation.status).toBe('succeeded');
    expect(dependencies.reserveIdentifiers).toHaveBeenCalledTimes(1);
    expect(dependencies.writeAuthoritative).toHaveBeenCalledTimes(1);
    expect(allocateAccountRoute).toHaveBeenCalledTimes(1);
  });

  it('returns 202 when immediate RPC delivery is unavailable or loses its response', async () => {
    const { workerEnv } = env();
    const publication = await buildInitialAccountDirectoryPublication(workerEnv, {
      tenantId: 'tenant-a',
      accountId: 'account-a',
      email: 'person@example.com',
      residencyPolicyId: 'policy-a',
      residencyPartition: 'jp',
      idempotencyKey: 'create-account-a',
      operationId: 'operation-account-a',
    });
    await expect(
      attemptImmediateAccountDirectoryPublication(undefined, publication)
    ).resolves.toEqual({ status: 202, accountId: 'account-a', operationId: 'operation-account-a' });
    await expect(
      attemptImmediateAccountDirectoryPublication(
        { publishAccountDirectory: vi.fn(async () => Promise.reject(new Error('response_lost'))) },
        publication
      )
    ).resolves.toEqual({ status: 202, accountId: 'account-a', operationId: 'operation-account-a' });
  });

  it('returns 201 only for an exact reflected RPC result', async () => {
    const { workerEnv } = env();
    const publication = await buildInitialAccountDirectoryPublication(workerEnv, {
      tenantId: 'tenant-a',
      accountId: 'account-a',
      residencyPolicyId: 'policy-a',
      residencyPartition: 'jp',
      idempotencyKey: 'create-account-a',
      operationId: 'operation-account-a',
    });
    await expect(
      attemptImmediateAccountDirectoryPublication(
        {
          publishAccountDirectory: vi.fn(async () => ({
            status: 201 as const,
            accountId: 'account-a',
            operationId: 'operation-account-a',
          })),
        },
        publication
      )
    ).resolves.toMatchObject({ status: 201 });
  });
});
