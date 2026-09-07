import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  createRefreshingSetupOperatorClient,
  executeSetupControlOperatorCreate,
  executeSetupControlOperatorMigration,
  executeSetupControlOperatorWorkerBindings,
  setupOperatorCredentialMap,
  type SetupOperatorControlClient,
  type SetupOperatorD1Client,
} from '../core/control-operator-executor.js';
import type {
  PendingControlOperatorOperation,
  PendingTenantDisasterRecoveryOperatorOperation,
} from '../core/control-operator-operations.js';
import {
  CloudflareControlApiError,
  type CloudflareControlApiClient,
  type ReleaseArtifactStore,
} from '@authrim/ar-lib-core/control-plane';

describe('setup operator credential scope', () => {
  it('uses the in-memory Wrangler OAuth credential for every supported resource class', () => {
    expect(setupOperatorCredentialMap(' operator-oauth ')).toEqual({
      d1: 'operator-oauth',
      workers: 'operator-oauth',
      kv: 'operator-oauth',
      r2: 'operator-oauth',
    });
    expect(() => setupOperatorCredentialMap('  ')).toThrow('wrangler_oauth_credentials_required');
  });

  it('refreshes a rejected Wrangler OAuth credential once and retries with the new token', async () => {
    const staleClient = {
      getWorkerSettings: vi
        .fn()
        .mockRejectedValue(new CloudflareControlApiError('workers.settings.get', 401, [10_000])),
    } as unknown as CloudflareControlApiClient;
    const freshClient = {
      getWorkerSettings: vi.fn().mockResolvedValue({ compatibility_date: '2026-09-04' }),
    } as unknown as CloudflareControlApiClient;
    const createClient = vi.fn((_accountId: string, token: string) =>
      token === 'stale-oauth' ? staleClient : freshClient
    );
    const refreshOAuth = vi.fn().mockResolvedValue({
      accountId: 'account-id',
      token: 'fresh-oauth',
      source: 'oauth' as const,
    });
    const operator = createRefreshingSetupOperatorClient({
      accountId: 'account-id',
      credential: { token: 'stale-oauth', source: 'oauth' },
      createClient,
      refreshOAuth,
    });

    await expect(operator.getWorkerSettings('test-ar-control')).resolves.toEqual({
      compatibility_date: '2026-09-04',
    });
    expect(refreshOAuth).toHaveBeenCalledOnce();
    expect(createClient).toHaveBeenNthCalledWith(1, 'account-id', 'stale-oauth');
    expect(createClient).toHaveBeenNthCalledWith(2, 'account-id', 'fresh-oauth');
  });

  it('refreshes a Wrangler OAuth credential after a 403 response without provider codes', async () => {
    const staleClient = {
      queryD1: vi.fn().mockRejectedValue(new CloudflareControlApiError('d1.query', 403, [])),
    } as unknown as CloudflareControlApiClient;
    const freshClient = {
      queryD1: vi.fn().mockResolvedValue({ success: true, results: [], meta: {} }),
    } as unknown as CloudflareControlApiClient;
    const createClient = vi.fn((_accountId: string, token: string) =>
      token === 'stale-oauth' ? staleClient : freshClient
    );
    const refreshOAuth = vi.fn().mockResolvedValue({
      accountId: 'account-id',
      token: 'fresh-oauth',
      source: 'oauth' as const,
    });
    const operator = createRefreshingSetupOperatorClient({
      accountId: 'account-id',
      credential: { token: 'stale-oauth', source: 'oauth' },
      createClient,
      refreshOAuth,
    });

    await expect(operator.queryD1('database-id', { sql: 'SELECT 1' })).resolves.toMatchObject({
      success: true,
    });
    expect(refreshOAuth).toHaveBeenCalledOnce();
    expect(freshClient.queryD1).toHaveBeenCalledOnce();
  });

  it('does not refresh or replace an explicit headless Setup API token', async () => {
    const rejectedClient = {
      getWorkerSettings: vi
        .fn()
        .mockRejectedValue(new CloudflareControlApiError('workers.settings.get', 401, [10_000])),
    } as unknown as CloudflareControlApiClient;
    const refreshOAuth = vi.fn();
    const operator = createRefreshingSetupOperatorClient({
      accountId: 'account-id',
      credential: { token: 'headless-token', source: 'env' },
      createClient: () => rejectedClient,
      refreshOAuth,
    });

    await expect(operator.getWorkerSettings('test-ar-control')).rejects.toThrow(
      'cloudflare_api_error:workers.settings.get:401:10000'
    );
    expect(refreshOAuth).not.toHaveBeenCalled();
  });
});

function operation(): PendingControlOperatorOperation {
  return {
    operationId: 'op_test_1',
    environmentId: 'test',
    operationKind: 'provision_shard',
    status: 'blocked',
    requestedByType: 'admin',
    attemptCount: 0,
    retryBudgetStartedAt: 100,
    createdAt: 100,
    updatedAt: 100,
    currentStep: 'create_d1',
    scope: 'tenant_exclusive',
    tenantId: 'tenant-1',
    dataRole: 'tenant_core/default',
    residencyPolicyId: 'builtin:residency:default',
    residencyPartition: 'default',
    databaseName: 'authrim-test-default-1234',
    desiredResourceId: 'desired-1',
    ownershipFingerprint: 'a'.repeat(64),
    providerCreateState: 'not_started',
    providerResourceId: null,
    providerIdentityCheckpointedAt: null,
    shardId: 'shard-1',
    bindingRef: 'TDB_DEFAULT_1234_CORE',
    jurisdiction: null,
    locationHint: 'apac',
    readReplicationMode: 'disabled',
    migration: null,
  };
}

function successfulBatch(length: number) {
  return Array.from({ length }, () => ({
    success: true,
    results: [],
    meta: { changes: 1 },
  }));
}

function client(options: { createError?: unknown; staleClaim?: boolean } = {}) {
  let batchCall = 0;
  let createdDatabaseName = 'authrim-test-default-1234';
  const queryD1Batch = vi.fn(async (_databaseId: string, batch: readonly unknown[]) => {
    batchCall += 1;
    if (batchCall === 1) {
      const results = successfulBatch(batch.length);
      results[0] = {
        success: true,
        results: [
          {
            operation_id: 'op_test_1',
            environment_id: 'test',
            operation_kind: 'provision_shard',
            status: 'running',
            attempt_count: 1,
            next_attempt_at: null,
            last_error_code: null,
            retry_budget_started_at: 100,
            created_at: 100,
            updated_at: 200,
            fencing_token: 1,
          },
        ],
      };
      results[results.length - 1] = {
        success: true,
        results: [
          {
            operation_status: 'running',
            lock_owner: options.staleClaim ? 'setup:stale-owner' : 'setup:execution-1',
            fencing_token: 1,
            step_status: 'running',
            provisioning_state: 'creating',
            shard_status: 'provisioning',
          },
        ],
      };
      return results;
    }
    const statements = batch as Array<{ sql?: string }>;
    if (statements.some((statement) => statement.sql?.includes('control_d1_create_budget'))) {
      return [
        { success: true, results: [], meta: { changes: 1 } },
        {
          success: true,
          results: [{ operation_id: 'op_test_1' }],
          meta: { changes: 0 },
        },
      ];
    }
    if (
      batch.length === 1 &&
      statements.some(
        (statement) =>
          statement.sql?.includes("provider_create_state = 'issued'") ||
          statement.sql?.includes("provider_create_state = 'not_started'") ||
          statement.sql?.includes("provider_create_state = 'identified'")
      )
    ) {
      return successfulBatch(batch.length);
    }
    const results = successfulBatch(batch.length);
    results[results.length - 1] = options.createError
      ? {
          success: true,
          results: [
            {
              operation_status: 'blocked',
              operation_error_code:
                typeof options.createError === 'object' &&
                options.createError !== null &&
                'status' in options.createError &&
                options.createError.status === 403
                  ? 'cloudflare_d1_capability_rejected'
                  : 'operator_action_required',
              next_attempt_at:
                typeof options.createError === 'object' &&
                options.createError !== null &&
                'status' in options.createError &&
                options.createError.status === 403
                  ? null
                  : (batch[0] as { params?: unknown[] }).params?.[0],
              lock_owner: null,
              fencing_token: 1,
              step_status: 'blocked',
              step_error_code:
                typeof options.createError === 'object' &&
                options.createError !== null &&
                'status' in options.createError &&
                options.createError.status === 403
                  ? 'cloudflare_d1_capability_rejected'
                  : 'cloudflare_d1_request_failed',
            },
          ],
        }
      : {
          success: true,
          results: [
            {
              operation_status: 'blocked',
              operation_error_code: 'operator_action_required',
              lock_owner: null,
              fencing_token: 1,
              create_status: 'succeeded',
              migration_status: 'blocked',
              observed_resource_id: 'observed:desired-1',
              provider_database_id: 'database-id',
            },
          ],
        };
    return results;
  });
  const api: SetupOperatorD1Client = {
    queryD1Batch,
    queryD1: vi.fn(async () => [{ success: true, results: [] }]),
    listD1Databases: vi.fn(async () => []),
    createD1Database: vi.fn(async ({ name }) => {
      if (options.createError) throw options.createError;
      createdDatabaseName = name;
      return { uuid: 'database-id', name, read_replication: { mode: 'disabled' } };
    }),
    updateD1Database: vi.fn(async () => {
      throw new Error('unexpected_update');
    }),
    getD1Database: vi.fn(async () => ({
      uuid: 'database-id',
      name: createdDatabaseName,
      read_replication: { mode: 'disabled' },
    })),
  };
  return { api, queryD1Batch };
}

describe('setup canonical Control operator executor', () => {
  it('claims with fencing, reserves capacity, creates D1, and hands the same operation to migration', async () => {
    const mocked = client();
    await expect(
      executeSetupControlOperatorCreate({
        controlDatabaseId: '11111111-1111-1111-1111-111111111111',
        operation: operation(),
        client: mocked.api,
        executionId: 'execution-1',
        now: () => 200,
      })
    ).resolves.toEqual({
      operationId: 'op_test_1',
      state: 'awaiting_migration',
      errorCode: null,
      nextAttemptAt: null,
    });

    expect(mocked.queryD1Batch).toHaveBeenCalledTimes(5);
    const claimBatch = mocked.queryD1Batch.mock.calls[0]?.[1] as Array<{ sql: string }>;
    expect(claimBatch[0]?.sql).toContain("status = 'blocked'");
    expect(claimBatch[0]?.sql).toContain('fencing_token = fencing_token + 1');
    const commitBatch = mocked.queryD1Batch.mock.calls[4]?.[1] as Array<{ sql: string }>;
    expect(commitBatch).toHaveLength(12);
    expect(commitBatch.some((statement) => statement.sql.includes('actor_type'))).toBe(true);
    expect(
      commitBatch.some((statement) =>
        statement.sql.includes('control_provider_identity_projection_assertions')
      )
    ).toBe(true);
    expect(
      commitBatch
        .slice(0, 6)
        .every(
          (statement) =>
            statement.sql.includes("provider_create_state = 'identified'") &&
            statement.sql.includes('provider_resource_id = ?')
        )
    ).toBe(true);
    expect(JSON.stringify(mocked.queryD1Batch.mock.calls)).not.toMatch(/api[_-]?token|secret/iu);
  });

  it('projects Lookup creation through the exact Lookup shard inventory atomically', async () => {
    const mocked = client();
    const lookupOperation: PendingControlOperatorOperation = {
      ...operation(),
      dataRole: 'lookup',
      databaseName: 'authrim-test-lookup-1234',
      shardId: 'lookup-shard-1',
      bindingRef: 'TDB_LOOKUP_1234_CORE',
    };
    await expect(
      executeSetupControlOperatorCreate({
        controlDatabaseId: '11111111-1111-1111-1111-111111111111',
        operation: lookupOperation,
        client: mocked.api,
        executionId: 'execution-1',
        now: () => 200,
      })
    ).resolves.toMatchObject({ state: 'awaiting_migration' });

    const commitBatch = mocked.queryD1Batch.mock.calls[4]?.[1] as Array<{ sql: string }>;
    expect(commitBatch[2]?.sql).toContain('UPDATE control_lookup_physical_shards');
    expect(commitBatch[2]?.sql).toContain('WHERE lookup_shard_id = ?');
    const assertion = commitBatch.find((statement) =>
      statement.sql.startsWith('INSERT INTO control_provider_identity_projection_assertions')
    );
    expect(assertion?.sql).toContain('FROM control_lookup_physical_shards shard');
    expect(assertion?.sql).toContain('shard.lookup_shard_id = ?');
  });

  it('keeps a transient failure operator-actionable without exposing the provider body', async () => {
    const providerError = Object.assign(new Error('sensitive provider body'), { status: 429 });
    const mocked = client({ createError: providerError });
    await expect(
      executeSetupControlOperatorCreate({
        controlDatabaseId: '11111111-1111-1111-1111-111111111111',
        operation: operation(),
        client: mocked.api,
        executionId: 'execution-1',
        now: () => 200,
      })
    ).resolves.toMatchObject({
      state: 'retry_required',
      errorCode: 'cloudflare_d1_request_failed',
    });
    const failureBatch = mocked.queryD1Batch.mock.calls[4]?.[1] as Array<{
      sql: string;
      params?: unknown[];
    }>;
    expect(failureBatch[0]?.params).toContain('operator_action_required');
    expect(JSON.stringify(failureBatch)).not.toContain('sensitive provider body');
  });

  it('blocks a permanent credential failure and does not silently use another credential', async () => {
    const mocked = client({ createError: { status: 403 } });
    await expect(
      executeSetupControlOperatorCreate({
        controlDatabaseId: '11111111-1111-1111-1111-111111111111',
        operation: operation(),
        client: mocked.api,
        executionId: 'execution-1',
        now: () => 200,
      })
    ).resolves.toEqual({
      operationId: 'op_test_1',
      state: 'blocked',
      errorCode: 'cloudflare_d1_capability_rejected',
      nextAttemptAt: null,
    });
  });

  it('rejects an operation whose server-owned step is not D1 creation', async () => {
    const mocked = client();
    await expect(
      executeSetupControlOperatorCreate({
        controlDatabaseId: '11111111-1111-1111-1111-111111111111',
        operation: { ...operation(), currentStep: 'apply_migrations' },
        client: mocked.api,
      })
    ).rejects.toThrow('control_operator_create_step_not_pending');
    expect(mocked.queryD1Batch).not.toHaveBeenCalled();
  });

  it('rejects a stale lease reflection before making a provider mutation', async () => {
    const mocked = client({ staleClaim: true });
    await expect(
      executeSetupControlOperatorCreate({
        controlDatabaseId: '11111111-1111-1111-1111-111111111111',
        operation: operation(),
        client: mocked.api,
        executionId: 'execution-1',
        now: () => 200,
      })
    ).rejects.toThrow('control_operator_lease_reflection_mismatch');
    expect(mocked.api.createD1Database).not.toHaveBeenCalled();
  });

  it('applies the pinned release and hands the same operation to Worker binding reconciliation', async () => {
    const sql = 'CREATE TABLE example (id TEXT PRIMARY KEY);';
    const checksum = createHash('sha256').update(sql).digest('hex');
    const manifest = `${JSON.stringify({
      formatVersion: 2,
      productVersion: '0.4.0',
      streams: [
        {
          id: 'core-d1',
          schemaFamily: 'core',
          dialect: 'sqlite',
          targetKind: 'cloudflare-d1',
          logicalRoles: ['core', 'tenant_core'],
          files: [{ path: '001_example.sql', checksum }],
        },
      ],
    })}\n`;
    const manifestDigest = createHash('sha256').update(manifest).digest('hex');
    const manifestObjectKey = `releases/0.4.0/${manifestDigest}/manifest.json`;
    const objects = new Map([
      [manifestObjectKey, manifest],
      [`releases/0.4.0/${manifestDigest}/streams/core-d1/001_example.sql`, sql],
    ]);
    const artifactStore: ReleaseArtifactStore = {
      get: async (key) => {
        const value = objects.get(key);
        if (value === undefined) return null;
        const bytes = new TextEncoder().encode(value);
        return { size: bytes.byteLength, arrayBuffer: async () => bytes.slice().buffer };
      },
    };
    const migratingOperation: PendingControlOperatorOperation = {
      ...operation(),
      currentStep: 'apply_migrations',
      migration: {
        databaseId: 'database-id',
        streamId: 'core-d1',
        releaseId: '0.4.0',
        manifestDigest,
        manifestObjectKey,
        generation: 1,
      },
    };
    let controlBatchCount = 0;
    const queryD1Batch = vi.fn(async (databaseId: string, batch: readonly { sql: string }[]) => {
      if (databaseId === 'control-id') {
        controlBatchCount += 1;
        if (controlBatchCount === 1) {
          const results = successfulBatch(batch.length);
          results[0] = {
            success: true,
            results: [
              {
                operation_id: 'op_test_1',
                environment_id: 'test',
                operation_kind: 'provision_shard',
                status: 'running',
                attempt_count: 2,
                next_attempt_at: null,
                last_error_code: null,
                retry_budget_started_at: 100,
                created_at: 100,
                updated_at: 200,
                fencing_token: 2,
              },
            ],
          };
          results[results.length - 1] = {
            success: true,
            results: [
              {
                operation_status: 'running',
                lock_owner: 'setup:execution-2',
                fencing_token: 2,
                step_status: 'running',
                migration_state: 'applying',
              },
            ],
          };
          return results;
        }
        const results = successfulBatch(batch.length);
        results[results.length - 1] = {
          success: true,
          results: [
            {
              operation_status: 'blocked',
              operation_error_code: 'operator_action_required',
              lock_owner: null,
              fencing_token: 2,
              migration_state: 'ready',
              expected_file_count: 1,
              applied_file_count: 1,
              last_filename: '001_example.sql',
              migration_step_status: 'succeeded',
              binding_step_status: 'blocked',
              provisioning_state: 'ready',
              shard_status: 'ready',
            },
          ],
        };
        return results;
      }
      if (
        batch.some((statement) => statement.sql.includes('authrim_control_plane_shard_metadata'))
      ) {
        return [
          { success: true, results: [] },
          {
            success: true,
            results: [
              {
                binding_ref: migratingOperation.bindingRef,
                data_role: migratingOperation.dataRole,
                residency_partition: migratingOperation.residencyPartition,
                migration_generation: 1,
                release_id: '0.4.0',
                manifest_digest: manifestDigest,
                expected_file_count: 1,
                last_filename: '001_example.sql',
              },
            ],
          },
        ];
      }
      return successfulBatch(batch.length);
    });
    const api: SetupOperatorD1Client = {
      queryD1Batch,
      queryD1: vi.fn(async (_databaseId, query) => {
        if (query.startsWith('SELECT filename')) return [{ success: true, results: [] }];
        return [
          {
            success: true,
            results: [
              {
                stream_id: 'core-d1',
                release_id: '0.4.0',
                manifest_digest: manifestDigest,
                applied_file_count: 1,
                state: 'ready',
                last_filename: '001_example.sql',
              },
            ],
          },
        ];
      }),
      listD1Databases: vi.fn(),
      createD1Database: vi.fn(),
      updateD1Database: vi.fn(),
      getD1Database: vi.fn(),
    };

    await expect(
      executeSetupControlOperatorMigration({
        controlDatabaseId: 'control-id',
        migrationReleaseBucketName: 'test-migration-releases',
        operation: migratingOperation,
        client: api,
        artifactStore,
        executionId: 'execution-2',
        now: () => 200,
      })
    ).resolves.toEqual({
      operationId: 'op_test_1',
      state: 'awaiting_worker_bindings',
      errorCode: null,
      nextAttemptAt: null,
    });
    expect(controlBatchCount).toBe(2);
    const claimBatch = queryD1Batch.mock.calls.find((call) => call[0] === 'control-id')?.[1] as
      | Array<{ sql: string }>
      | undefined;
    expect(claimBatch?.[0]?.sql).toContain(
      "migration.state IN ('requested', 'applying', 'waiting_retry', 'ready')"
    );
    expect(claimBatch?.[0]?.sql).toContain('lock_expires_at <= ?');
    expect(queryD1Batch.mock.calls.some((call) => call[0] === 'database-id')).toBe(true);
  });

  it('reconciles a post-commit response loss and hands smoke back to Control', async () => {
    const digest = 'b'.repeat(64);
    const bindingOperation: PendingControlOperatorOperation = {
      ...operation(),
      currentStep: 'reconcile_worker_bindings',
      migration: {
        databaseId: 'database-id',
        streamId: 'core-d1',
        releaseId: '0.4.0',
        manifestDigest: digest,
        manifestObjectKey: `releases/0.4.0/${digest}/manifest.json`,
        generation: 1,
      },
    };
    const oldDeployment = {
      id: 'deployment-old',
      created_on: '2026-07-30T00:00:00.000Z',
      source: 'api',
      strategy: 'percentage' as const,
      versions: [{ percentage: 100, version_id: 'version-old' }],
    };
    const newDeployment = {
      ...oldDeployment,
      id: 'deployment-new',
      created_on: '2026-07-30T00:00:01.000Z',
      versions: [{ percentage: 100, version_id: 'version-new' }],
    };
    const beforeSettings = {
      bindings: [{ name: 'DB', type: 'd1', database_id: 'shared-db' }],
      compatibility_date: '2026-07-01',
    };
    const afterSettings = {
      ...beforeSettings,
      bindings: [
        ...beforeSettings.bindings,
        { name: bindingOperation.bindingRef, type: 'd1', database_id: 'database-id' },
      ],
    };
    let patchRecorded = false;
    const queryD1Batch = vi.fn(async (_databaseId: string, batch: readonly { sql: string }[]) => {
      const firstSql = batch[0]?.sql ?? '';
      const results = successfulBatch(batch.length);
      if (firstSql.includes('INSERT OR IGNORE INTO control_worker_binding_reconciliations')) {
        results[2] = {
          success: true,
          results: [
            {
              operation_id: bindingOperation.operationId,
              environment_id: bindingOperation.environmentId,
              environment_name: 'test',
              worker_script_name: 'test-ar-auth',
              shard_id: bindingOperation.shardId,
              binding_ref: bindingOperation.bindingRef,
              data_role: bindingOperation.dataRole,
              residency_partition: bindingOperation.residencyPartition,
              migration_generation: 1,
              provider_database_id: 'database-id',
              state: 'pending',
              expected_source_version_id: null,
              previous_deployment_id: null,
              patch_result_version_id: null,
              patch_result_deployment_id: null,
              previous_restore_settings_json: null,
            },
          ],
        };
        results[3] = {
          success: true,
          results: [{ total_count: 1, patched_count: 0 }],
        };
      } else if (firstSql.includes('INSERT INTO control_worker_deployment_leases')) {
        results[1] = {
          success: true,
          results: [
            {
              environment_id: 'test',
              worker_script_name: 'test-ar-auth',
              owner_operation_id: bindingOperation.operationId,
              fencing_token: 1,
              expected_source_version_id: 'version-old',
              mutation_started: 0,
              previous_deployment_id: null,
              patch_result_version_id: null,
              patch_result_deployment_id: null,
              lease_expires_at: 1100,
            },
          ],
        };
      } else if (firstSql.includes('SELECT 1 AS valid')) {
        results[0] = { success: true, results: [{ valid: 1 }] };
      } else if (
        firstSql.includes('UPDATE control_operations') &&
        !batch.some((statement) => statement.sql.includes('patch_result_version_id = ?'))
      ) {
        results[4] = {
          success: true,
          results: [
            {
              operation_status: 'running',
              step_status: 'running',
              mutation_started: 1,
              fencing_token: 1,
              expected_source_version_id: 'version-old',
              previous_deployment_id: 'deployment-old',
            },
          ],
        };
      } else if (
        firstSql.includes('UPDATE control_operations') &&
        batch.some((statement) => statement.sql.includes('patch_result_version_id = ?'))
      ) {
        patchRecorded = true;
        throw new Error('control_db_response_lost_after_commit');
      } else if (firstSql.includes('SELECT state, patch_result_version_id')) {
        results[0] = {
          success: true,
          results: [
            {
              state: 'settings_patched',
              patch_result_version_id: 'version-new',
              patch_result_deployment_id: 'deployment-new',
            },
          ],
        };
      }
      return results;
    });
    const api: SetupOperatorControlClient = {
      queryD1Batch,
      queryD1: vi.fn(),
      listD1Databases: vi.fn(),
      createD1Database: vi.fn(),
      updateD1Database: vi.fn(),
      getD1Database: vi.fn(),
      listWorkerDeployments: vi
        .fn()
        .mockResolvedValueOnce([oldDeployment])
        .mockResolvedValueOnce([oldDeployment])
        .mockResolvedValueOnce([newDeployment, oldDeployment]),
      getWorkerSettings: vi
        .fn()
        .mockResolvedValueOnce(beforeSettings)
        .mockResolvedValueOnce(afterSettings),
      patchWorkerSettings: vi.fn().mockResolvedValue(afterSettings),
    };

    await expect(
      executeSetupControlOperatorWorkerBindings({
        controlDatabaseId: 'control-id',
        operation: bindingOperation,
        client: api,
        now: () => 200,
      })
    ).resolves.toEqual({
      operationId: bindingOperation.operationId,
      state: 'awaiting_smoke',
      errorCode: null,
      nextAttemptAt: null,
    });
    expect(api.patchWorkerSettings).toHaveBeenCalledWith(
      'test-ar-auth',
      expect.objectContaining({
        bindings: [
          { name: 'DB', type: 'inherit', version_id: 'latest' },
          { name: bindingOperation.bindingRef, type: 'd1', database_id: 'database-id' },
        ],
      })
    );
    expect(patchRecorded).toBe(true);
    expect(
      queryD1Batch.mock.calls.some((call) =>
        call[1][0]?.sql.includes('DELETE FROM control_worker_deployment_leases')
      )
    ).toBe(false);
    expect(JSON.stringify(queryD1Batch.mock.calls)).not.toMatch(/api[_-]?token|secret/iu);
  });

  it('checkpoints a propagating patch without touching the next binding target', async () => {
    const bindingOperation: PendingTenantDisasterRecoveryOperatorOperation = {
      operationId: 'tenant-dr-propagating',
      environmentId: 'test',
      operationKind: 'tenant_disaster_recovery',
      status: 'blocked',
      lastErrorCode: 'operator_action_required',
      requestedByType: 'admin',
      attemptCount: 1,
      retryBudgetStartedAt: 100,
      createdAt: 100,
      updatedAt: 200,
      currentStep: 'reconcile_worker_bindings',
      tenantId: 'tenant-1',
      bindingTargets: [
        {
          workerScriptName: 'test-ar-auth',
          shardId: 'core-1',
          bindingRef: 'TDB_DEFAULT_CORE_1',
          dataRole: 'tenant_core/default',
          residencyPartition: 'default',
          databaseId: 'database-core-1',
          migrationGeneration: 1,
        },
        {
          workerScriptName: 'test-ar-auth',
          shardId: 'users-1',
          bindingRef: 'TDB_USERS_1',
          dataRole: 'tenant_core/users',
          residencyPartition: 'default',
          databaseId: 'database-users-1',
          migrationGeneration: 1,
        },
      ],
    };
    const oldDeployment = {
      id: 'deployment-old',
      created_on: '2026-07-30T00:00:00.000Z',
      source: 'api',
      strategy: 'percentage' as const,
      versions: [{ percentage: 100, version_id: 'version-old' }],
    };
    const queryD1Batch = vi.fn(async (_databaseId: string, batch: readonly { sql: string }[]) => {
      const firstSql = batch[0]?.sql ?? '';
      const results = successfulBatch(batch.length);
      if (firstSql.includes('INSERT OR IGNORE INTO control_worker_binding_reconciliations')) {
        results[2] = {
          success: true,
          results: bindingOperation.bindingTargets.map((target) => ({
            operation_id: bindingOperation.operationId,
            environment_id: bindingOperation.environmentId,
            environment_name: 'test',
            worker_script_name: target.workerScriptName,
            shard_id: target.shardId,
            binding_ref: target.bindingRef,
            data_role: target.dataRole,
            residency_partition: target.residencyPartition,
            migration_generation: target.migrationGeneration,
            provider_database_id: target.databaseId,
            state: 'pending',
            expected_source_version_id: null,
            previous_deployment_id: null,
            patch_result_version_id: null,
            patch_result_deployment_id: null,
            previous_restore_settings_json: null,
          })),
        };
        results[3] = { success: true, results: [{ total_count: 2, patched_count: 0 }] };
      } else if (firstSql.includes('INSERT INTO control_worker_deployment_leases')) {
        results[1] = {
          success: true,
          results: [
            {
              environment_id: 'test',
              worker_script_name: 'test-ar-auth',
              owner_operation_id: bindingOperation.operationId,
              fencing_token: 1,
              expected_source_version_id: 'version-old',
              mutation_started: 0,
              previous_deployment_id: null,
              patch_result_version_id: null,
              patch_result_deployment_id: null,
              lease_expires_at: 1100,
            },
          ],
        };
      } else if (firstSql.includes('SELECT 1 AS valid')) {
        results[0] = { success: true, results: [{ valid: 1 }] };
      } else if (firstSql.includes('UPDATE control_operations')) {
        results[4] = {
          success: true,
          results: [
            {
              operation_status: 'running',
              step_status: 'running',
              mutation_started: 1,
              fencing_token: 1,
              expected_source_version_id: 'version-old',
              previous_deployment_id: 'deployment-old',
            },
          ],
        };
      } else if (firstSql.includes('SELECT next_attempt_at FROM control_operations')) {
        results[0] = { success: true, results: [{ next_attempt_at: 260 }] };
      }
      return results;
    });
    const api: SetupOperatorControlClient = {
      queryD1Batch,
      queryD1: vi.fn(),
      listD1Databases: vi.fn(),
      createD1Database: vi.fn(),
      updateD1Database: vi.fn(),
      getD1Database: vi.fn(),
      listWorkerDeployments: vi.fn().mockResolvedValue([oldDeployment]),
      getWorkerSettings: vi.fn().mockResolvedValue({ bindings: [] }),
      patchWorkerSettings: vi.fn().mockResolvedValue({ bindings: [] }),
    };

    await expect(
      executeSetupControlOperatorWorkerBindings({
        controlDatabaseId: 'control-id',
        operation: bindingOperation,
        client: api,
        now: () => 200,
        interTargetDelayMs: 0,
      })
    ).resolves.toEqual({
      operationId: bindingOperation.operationId,
      state: 'retry_required',
      errorCode: 'control_worker_patch_propagating',
      nextAttemptAt: 260,
    });
    expect(api.patchWorkerSettings).toHaveBeenCalledOnce();
    expect(api.patchWorkerSettings).toHaveBeenCalledWith(
      'test-ar-auth',
      expect.objectContaining({
        bindings: expect.arrayContaining([
          { name: 'TDB_DEFAULT_CORE_1', type: 'd1', database_id: 'database-core-1' },
          { name: 'TDB_USERS_1', type: 'd1', database_id: 'database-users-1' },
        ]),
      })
    );
    expect(api.listWorkerDeployments).toHaveBeenCalledTimes(3);
  });

  it('patches all bindings once and retains the final Worker lease through smoke', async () => {
    const bindingOperation: PendingTenantDisasterRecoveryOperatorOperation = {
      operationId: 'tenant-dr-batched',
      environmentId: 'test',
      operationKind: 'tenant_disaster_recovery',
      status: 'blocked',
      lastErrorCode: 'operator_action_required',
      requestedByType: 'admin',
      attemptCount: 1,
      retryBudgetStartedAt: 100,
      createdAt: 100,
      updatedAt: 200,
      currentStep: 'reconcile_worker_bindings',
      tenantId: 'tenant-1',
      bindingTargets: [
        {
          workerScriptName: 'test-ar-auth',
          shardId: 'core-1',
          bindingRef: 'TDB_DEFAULT_CORE_1',
          dataRole: 'tenant_core/default',
          residencyPartition: 'default',
          databaseId: 'database-core-1',
          migrationGeneration: 1,
        },
        {
          workerScriptName: 'test-ar-auth',
          shardId: 'users-1',
          bindingRef: 'TDB_USERS_1',
          dataRole: 'tenant_core/users',
          residencyPartition: 'default',
          databaseId: 'database-users-1',
          migrationGeneration: 1,
        },
      ],
    };
    const oldDeployment = {
      id: 'deployment-old',
      created_on: '2026-07-30T00:00:00.000Z',
      source: 'api',
      strategy: 'percentage' as const,
      versions: [{ percentage: 100, version_id: 'version-old' }],
    };
    const newDeployment = {
      ...oldDeployment,
      id: 'deployment-new',
      created_on: '2026-07-30T00:00:01.000Z',
      versions: [{ percentage: 100, version_id: 'version-new' }],
    };
    const beforeSettings = { bindings: [] };
    const afterSettings = {
      bindings: bindingOperation.bindingTargets.map((target) => ({
        name: target.bindingRef,
        type: 'd1',
        database_id: target.databaseId,
      })),
    };
    let deployments = [oldDeployment];
    let settings = beforeSettings;
    let leaseAcquisitions = 0;
    const queryD1Batch = vi.fn(
      async (
        _databaseId: string,
        batch: readonly { sql: string; params?: readonly unknown[] }[]
      ) => {
        const firstSql = batch[0]?.sql ?? '';
        const results = successfulBatch(batch.length);
        if (firstSql.includes('INSERT OR IGNORE INTO control_worker_binding_reconciliations')) {
          results[2] = {
            success: true,
            results: bindingOperation.bindingTargets.map((target) => ({
              operation_id: bindingOperation.operationId,
              environment_id: bindingOperation.environmentId,
              environment_name: 'test',
              worker_script_name: target.workerScriptName,
              shard_id: target.shardId,
              binding_ref: target.bindingRef,
              data_role: target.dataRole,
              residency_partition: target.residencyPartition,
              migration_generation: target.migrationGeneration,
              provider_database_id: target.databaseId,
              state: 'pending',
              expected_source_version_id: null,
              previous_deployment_id: null,
              patch_result_version_id: null,
              patch_result_deployment_id: null,
              previous_restore_settings_json: null,
            })),
          };
          results[3] = { success: true, results: [{ total_count: 2, patched_count: 0 }] };
        } else if (firstSql.includes('INSERT INTO control_worker_deployment_leases')) {
          leaseAcquisitions += 1;
          results[1] = {
            success: true,
            results: [
              {
                environment_id: 'test',
                worker_script_name: 'test-ar-auth',
                owner_operation_id: bindingOperation.operationId,
                fencing_token: 1,
                expected_source_version_id: batch[0]?.params?.[4],
                mutation_started: 0,
                mutation_started_at: null,
                previous_deployment_id: null,
                patch_result_version_id: null,
                patch_result_deployment_id: null,
                lease_expires_at: 1100,
              },
            ],
          };
        } else if (firstSql.includes('SELECT 1 AS valid')) {
          results[0] = { success: true, results: [{ valid: 1 }] };
        } else if (firstSql.includes('DELETE FROM control_worker_deployment_leases')) {
          results[1] = { success: true, results: [] };
        } else if (firstSql.includes('UPDATE control_operations') && batch.length === 5) {
          results[4] = {
            success: true,
            results: [
              {
                operation_status: 'running',
                step_status: 'running',
                mutation_started: 1,
                fencing_token: 1,
                expected_source_version_id: 'version-old',
                previous_deployment_id: 'deployment-old',
              },
            ],
          };
        } else if (firstSql.includes('UPDATE control_operations') && batch.length === 7) {
          results[6] = {
            success: true,
            results: [
              {
                state: 'settings_patched',
                patch_result_version_id: 'version-new',
                patch_result_deployment_id: 'deployment-new',
                fencing_token: 1,
                binding_step_status: 'running',
                smoke_step_status: 'queued',
              },
            ],
          };
        } else if (firstSql.includes('UPDATE control_operations') && batch.length === 6) {
          results[5] = {
            success: true,
            results: [
              {
                state: 'settings_patched',
                patch_result_version_id: 'version-new',
                patch_result_deployment_id: 'deployment-new',
                operation_status: 'running',
                lease_version_id: 'version-new',
                lease_deployment_id: 'deployment-new',
                binding_step_status: 'succeeded',
                smoke_step_status: 'running',
              },
            ],
          };
        }
        return results;
      }
    );
    const api: SetupOperatorControlClient = {
      queryD1Batch,
      queryD1: vi.fn(),
      listD1Databases: vi.fn(),
      createD1Database: vi.fn(),
      updateD1Database: vi.fn(),
      getD1Database: vi.fn(),
      listWorkerDeployments: vi.fn(async () => deployments),
      getWorkerSettings: vi.fn(async () => settings),
      patchWorkerSettings: vi.fn(async () => {
        settings = afterSettings;
        deployments = [newDeployment, oldDeployment];
        return afterSettings;
      }),
    };

    await expect(
      executeSetupControlOperatorWorkerBindings({
        controlDatabaseId: 'control-id',
        operation: bindingOperation,
        client: api,
        now: () => 200,
      })
    ).resolves.toEqual({
      operationId: bindingOperation.operationId,
      state: 'awaiting_smoke',
      errorCode: null,
      nextAttemptAt: null,
    });
    expect(api.patchWorkerSettings).toHaveBeenCalledOnce();
    expect(api.patchWorkerSettings).toHaveBeenCalledWith(
      'test-ar-auth',
      expect.objectContaining({ bindings: afterSettings.bindings })
    );
    expect(leaseAcquisitions).toBe(2);
    expect(
      queryD1Batch.mock.calls.some((call) =>
        call[1].some((statement) => statement.sql.includes('mutation_started_at = COALESCE'))
      )
    ).toBe(true);
    expect(
      queryD1Batch.mock.calls.filter((call) =>
        call[1][0]?.sql.includes('DELETE FROM control_worker_deployment_leases')
      )
    ).toHaveLength(1);
  });

  it('resumes as awaiting smoke when every Worker target is already patched', async () => {
    const bindingOperation: PendingControlOperatorOperation = {
      ...operation(),
      currentStep: 'reconcile_worker_bindings',
      migration: {
        databaseId: 'database-id',
        streamId: 'core-d1',
        releaseId: '0.4.0',
        manifestDigest: 'c'.repeat(64),
        manifestObjectKey: `releases/0.4.0/${'c'.repeat(64)}/manifest.json`,
        generation: 1,
      },
    };
    const queryD1Batch = vi.fn(async (_databaseId: string, batch: readonly { sql: string }[]) => {
      const results = successfulBatch(batch.length);
      results[2] = { success: true, results: [] };
      results[3] = {
        success: true,
        results: [{ total_count: 12, patched_count: 12 }],
      };
      return results;
    });
    const api: SetupOperatorControlClient = {
      queryD1Batch,
      queryD1: vi.fn(),
      listD1Databases: vi.fn(),
      createD1Database: vi.fn(),
      updateD1Database: vi.fn(),
      getD1Database: vi.fn(),
      listWorkerDeployments: vi.fn(),
      getWorkerSettings: vi.fn(),
      patchWorkerSettings: vi.fn(),
    };

    await expect(
      executeSetupControlOperatorWorkerBindings({
        controlDatabaseId: 'control-id',
        operation: bindingOperation,
        client: api,
        now: () => 200,
      })
    ).resolves.toEqual({
      operationId: bindingOperation.operationId,
      state: 'awaiting_smoke',
      errorCode: null,
      nextAttemptAt: null,
    });
    expect(api.listWorkerDeployments).not.toHaveBeenCalled();
  });

  it('requires the complete disaster recovery binding target set before awaiting smoke', async () => {
    const bindingOperation: PendingTenantDisasterRecoveryOperatorOperation = {
      operationId: 'tenant-dr-1',
      environmentId: 'test',
      operationKind: 'tenant_disaster_recovery',
      status: 'blocked',
      lastErrorCode: 'operator_action_required',
      requestedByType: 'admin',
      attemptCount: 1,
      retryBudgetStartedAt: 100,
      createdAt: 100,
      updatedAt: 200,
      currentStep: 'reconcile_worker_bindings',
      tenantId: 'tenant-1',
      bindingTargets: [
        {
          workerScriptName: 'test-ar-auth',
          shardId: 'core-1',
          bindingRef: 'TDB_DEFAULT_CORE_1',
          dataRole: 'tenant_core/default',
          residencyPartition: 'default',
          databaseId: 'database-core-1',
          migrationGeneration: 1,
        },
        {
          workerScriptName: 'test-ar-auth',
          shardId: 'users-1',
          bindingRef: 'TDB_USERS_1',
          dataRole: 'tenant_core/users',
          residencyPartition: 'default',
          databaseId: 'database-users-1',
          migrationGeneration: 1,
        },
      ],
    };
    const queryD1Batch = vi.fn(async (_databaseId: string, batch: readonly { sql: string }[]) => {
      const results = successfulBatch(batch.length);
      results[2] = { success: true, results: [] };
      results[3] = { success: true, results: [{ total_count: 1, patched_count: 1 }] };
      return results;
    });
    const api: SetupOperatorControlClient = {
      queryD1Batch,
      queryD1: vi.fn(),
      listD1Databases: vi.fn(),
      createD1Database: vi.fn(),
      updateD1Database: vi.fn(),
      getD1Database: vi.fn(),
      listWorkerDeployments: vi.fn(),
      getWorkerSettings: vi.fn(),
      patchWorkerSettings: vi.fn(),
    };

    await expect(
      executeSetupControlOperatorWorkerBindings({
        controlDatabaseId: 'control-id',
        operation: bindingOperation,
        client: api,
        now: () => 200,
      })
    ).rejects.toThrow('control_operator_worker_binding_target_invalid');
    expect(api.listWorkerDeployments).not.toHaveBeenCalled();
  });

  it('hands a completely patched multi-target disaster recovery operation to smoke', async () => {
    const bindingOperation: PendingTenantDisasterRecoveryOperatorOperation = {
      operationId: 'tenant-dr-2',
      environmentId: 'test',
      operationKind: 'tenant_disaster_recovery',
      status: 'blocked',
      lastErrorCode: 'operator_action_required',
      requestedByType: 'admin',
      attemptCount: 1,
      retryBudgetStartedAt: 100,
      createdAt: 100,
      updatedAt: 200,
      currentStep: 'reconcile_worker_bindings',
      tenantId: 'tenant-1',
      bindingTargets: [
        {
          workerScriptName: 'test-ar-auth',
          shardId: 'core-1',
          bindingRef: 'TDB_DEFAULT_CORE_1',
          dataRole: 'tenant_core/default',
          residencyPartition: 'default',
          databaseId: 'database-core-1',
          migrationGeneration: 1,
        },
        {
          workerScriptName: 'test-ar-auth',
          shardId: 'users-1',
          bindingRef: 'TDB_USERS_1',
          dataRole: 'tenant_core/users',
          residencyPartition: 'default',
          databaseId: 'database-users-1',
          migrationGeneration: 1,
        },
      ],
    };
    const queryD1Batch = vi.fn(async (_databaseId: string, batch: readonly { sql: string }[]) => {
      const results = successfulBatch(batch.length);
      results[2] = { success: true, results: [] };
      results[3] = { success: true, results: [{ total_count: 2, patched_count: 2 }] };
      return results;
    });
    const api: SetupOperatorControlClient = {
      queryD1Batch,
      queryD1: vi.fn(),
      listD1Databases: vi.fn(),
      createD1Database: vi.fn(),
      updateD1Database: vi.fn(),
      getD1Database: vi.fn(),
      listWorkerDeployments: vi.fn(),
      getWorkerSettings: vi.fn(),
      patchWorkerSettings: vi.fn(),
    };

    await expect(
      executeSetupControlOperatorWorkerBindings({
        controlDatabaseId: 'control-id',
        operation: bindingOperation,
        client: api,
        now: () => 200,
      })
    ).resolves.toEqual({
      operationId: 'tenant-dr-2',
      state: 'awaiting_smoke',
      errorCode: null,
      nextAttemptAt: null,
    });
    expect(api.listWorkerDeployments).not.toHaveBeenCalled();
  });
});
