import { readRenderedMigrationSql } from '../../../../test/helpers/migration-source.mjs';
/** Coordinator regression: body/plan proof is supplied by the installed test port. The production
 * dispatcher, production adapter, actual activation SQL/KV, and strict Control SQL are real. */
import { DatabaseSync, type SQLiteDatabase, type SQLInputValue } from './test-sqlite';

import { afterEach, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import { encodeTenantBackupRequestIntent } from '@authrim/ar-lib-core/services/tenant-portability/operation-request';
import { TenantBackupMutationAdmission } from '@authrim/ar-lib-core/services/tenant-portability/mutation-admission';
import { TenantBackupBoundaryReceipts } from '@authrim/ar-lib-core/services/tenant-portability/boundary-receipts';
import {
  runSamlDrCoveredOperation,
  samlDrTrackEffect,
} from '@authrim/ar-lib-core/services/tenant-portability/saml-dr-writer';
import {
  hasTenantBackupMutationCoverage,
  runTenantBackupCoveredEffect,
} from '@authrim/ar-lib-core/services/tenant-portability/covered-mutation';
import type { TenantBackupStepContext } from '@authrim/ar-lib-core/services/tenant-portability/operation-executor';
import type { GuestCurrentDenyWitness } from '@authrim/ar-lib-core/services/tenant-portability/guest-current-deny-witness';
import type { TenantBackupBoundaryRequest } from '@authrim/ar-lib-core/services/tenant-portability/boundary-rpc-contract';
import type { Phase8InstalledAdapterPorts } from '../tenant-backup-phase8-adapter';

const mocks = vi.hoisted(() => ({
  resources: vi.fn(),
  fixed: vi.fn(),
  scopeChecks: vi.fn(),
  deferred: null as Promise<void> | null,
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/database-resources', () => ({
  resolveBackupTenantDatabaseResources: mocks.resources,
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/fixed-database-resources', () => ({
  resolveFixedBackupDatabaseResources: mocks.fixed,
}));
vi.mock('../tenant-backup-phase8-plan-loader', () => ({
  loadPhase8InstalledSqlitePlan: async () => [],
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/restore-plan-inventory', () => ({
  DatabaseTenantBackupRestorePlanInventory: class {
    async headForLease() {
      return { state: 'sealed', chain_digest: 'a'.repeat(64) };
    }
  },
}));
vi.mock('../admin-tenants', async (original) => ({
  ...(await original<typeof import('../admin-tenants')>()),
  resolveActiveTenantRuntimeRouteObservation: async () => ({}),
}));
vi.mock('../tenant-backup-phase8-adapter', () => ({
  createPhase8TenantBackupInstalledAdapter: ({
    ports,
  }: {
    ports: Phase8InstalledAdapterPorts;
  }) => ({
    export: {},
    cleanup: {},
    import: {
      ...ports.import,
      datasets: () => [
        {
          id: 'core.identity_accounts',
          module: 'tenant-runtime',
          kind: 'users',
          store: 'database',
          schemaVersion: 1,
          disposition: 'include',
        },
      ],
      restoreOtherStores: async () => ({ done: true, cursor: null }),
      verifyOtherStores: async () => ({ done: true, cursor: null }),
      async activate(context: TenantBackupStepContext, planDigest: string) {
        const port = ports.guestAuthority;
        if (!port || !(await port.enabled(context)))
          return ports.import.activate(context, planDigest);
        const witness: GuestCurrentDenyWitness = {
          version: 1,
          purpose: 'guest-current-deny-v1',
          tenantId: context.lease.tenantId,
          operationId: context.lease.operationId,
          planDigest,
          sourceEnvironmentId: 'test',
          sourceIssuer: 'https://tenant.example',
          inventoryDigest: 'b'.repeat(64),
          epochs: [
            { family: 'core', resourceId: 'core-db', revision: 0 },
            { family: 'pii', resourceId: 'pii-db', revision: 0 },
          ],
          denyDigest: 'c'.repeat(64),
          markerCount: 0,
        };
        return port.withHeldBoundary(
          context,
          witness,
          async (deadlineAt, assertHeld, scopedEnv) => {
            mocks.scopeChecks(
              hasTenantBackupMutationCoverage(scopedEnv, { tenantId: context.lease.tenantId }),
              hasTenantBackupMutationCoverage(scopedEnv, { environment: true })
            );
            await runTenantBackupCoveredEffect(
              scopedEnv,
              { tenantId: context.lease.tenantId },
              () =>
                ports.import.activate(context, planDigest, { deadlineAt, assertHeld, scopedEnv })
            );
            if (mocks.deferred) void samlDrTrackEffect(mocks.deferred);
          }
        );
      },
    },
  }),
}));

import { createTenantBackupOperationHandlers } from '../tenant-backup-operation-dispatcher';
import { createProductionTenantBackupExportAdapter } from '../tenant-backup-production-export';

const dbs: SQLiteDatabase[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  mocks.deferred = null;
  vi.clearAllMocks();
});
function database(db: SQLiteDatabase): DatabaseAdapter {
  return {
    query: async <T>(sql: string, params: unknown[] = []) =>
      db.prepare(sql).all(...(params as SQLInputValue[])) as T[],
    queryOne: async <T>(sql: string, params: unknown[] = []) =>
      (db.prepare(sql).get(...(params as SQLInputValue[])) as T) ?? null,
    execute: async (sql, params = []) => ({
      success: true,
      rowsAffected: Number(db.prepare(sql).run(...(params as SQLInputValue[])).changes),
    }),
    batch: vi.fn(),
    transaction: vi.fn(),
    getType: () => 'd1',
    isHealthy: async () => ({ healthy: true, latencyMs: 0, type: 'd1' }),
    close: async () => {},
  };
}
async function fixture(users = true) {
  const admin = new DatabaseSync(':memory:'),
    core = new DatabaseSync(':memory:'),
    control = new DatabaseSync(':memory:');
  dbs.push(admin, core, control);
  for (const file of ['001_0_5_0_control_baseline.sql'])
    control.exec(
      readRenderedMigrationSql(
        new URL(`../../../../migrations/control/d1/`, import.meta.url),
        `${file}`
      )
    );
  admin.exec(
    'CREATE TABLE tenant_backup_operations(id TEXT,tenant_id TEXT,kind TEXT,state TEXT,lease_owner TEXT,fencing_token INTEGER,revision INTEGER,phase TEXT,cursor_json TEXT,lease_expires_at INTEGER,created_by TEXT,request_json TEXT,request_digest TEXT)'
  );
  const encoded = await encodeTenantBackupRequestIntent({
    version: 1,
    kind: 'import',
    source: { tenantId: 'tenant-a', issuer: 'https://tenant.example', productVersion: '0.4.2' },
    selection: {
      settings: !users,
      users,
      admin: false,
      artifacts: false,
      logs: { audit: false, other: false, sensitive: false, period: 'all' },
    },
    inputs: [{ id: 'input-a', digestSha256: 'a'.repeat(64) }],
  });
  const cursor = JSON.stringify({ version: 1, planDigest: 'a'.repeat(64) });
  admin
    .prepare('INSERT INTO tenant_backup_operations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(
      'import-a',
      'tenant-a',
      'import',
      'running',
      'worker',
      2,
      7,
      'activate_restore',
      cursor,
      Date.now() + 100000,
      'admin-a',
      encoded.json,
      encoded.digest
    );
  core.exec(
    "CREATE TABLE tenants(id TEXT PRIMARY KEY,tenant_key TEXT,lifecycle_state TEXT,updated_at INTEGER);INSERT INTO tenants VALUES('tenant-a','tenant-key-a','provisioning',0);CREATE TABLE tenant_backup_restore_targets(id TEXT PRIMARY KEY,tenant_id TEXT,operation_id TEXT,resource_id TEXT,plan_digest TEXT,state TEXT)"
  );
  core
    .prepare('INSERT INTO tenant_backup_restore_targets VALUES(?,?,?,?,?,?)')
    .run('import-a:core-db', 'tenant-a', 'import-a', 'core-db', 'a'.repeat(64), 'sealed');
  const adminAdapter = database(admin),
    coreAdapter = database(core),
    controlAdapter = database(control);
  const admission = new TenantBackupMutationAdmission(controlAdapter, 'test', true, true),
    receipts = new TenantBackupBoundaryReceipts(controlAdapter, true);
  const environmentAcquire = vi.fn(async ({ permitId }: { permitId: string }) => ({
    admitted: await admission.acquireEnvironment(permitId, Date.now()),
  }));
  const tenantAcquire = vi.fn(
    async ({ tenantId, permitId }: { tenantId: string; permitId: string }) => ({
      admitted: await admission.acquire(tenantId, permitId, Date.now()),
    })
  );
  const boundaryActions: string[] = [];
  const mutation = {
    acquireEnvironmentBackupMutationPermit: environmentAcquire,
    completeEnvironmentBackupMutationPermit: async ({ permitId }: { permitId: string }) =>
      admission.completeEnvironment(permitId, Date.now()),
    acquireTenantBackupMutationPermit: tenantAcquire,
    completeTenantBackupMutationPermit: async ({
      tenantId,
      permitId,
    }: {
      tenantId: string;
      permitId: string;
    }) => admission.complete(tenantId, permitId, Date.now()),
  };
  const config = { put: vi.fn(async () => {}), get: vi.fn(async () => null) };
  const env = {
    DB: coreAdapter,
    DB_ADMIN: adminAdapter,
    PII_ENCRYPTION_KEY: 'c'.repeat(64),
    OBJECT_ENCRYPTION_ROOT_KEY: 'd'.repeat(64),
    AUTHRIM_LOG_ARCHIVE_MODE: 'scheduled',
    AUTHRIM_LOG_ARCHIVE_STORAGE_GENERATION: 'fixturegeneration',
    AUTHRIM_LOG_ARCHIVE_SCHEMA_VERSION: '1',
    AUTHRIM_LOG_ARCHIVE_ACTIVATED_AT: '2026-01-01T00:00:00.000Z',
    AUTHRIM_LOG_ARCHIVE_DB_RETENTION_DAYS: '7',
    AUTHRIM_LOG_ARCHIVE_EXPORT_INTERVAL_MINUTES: '5',
    AUTHRIM_LOG_ARCHIVE_ACCOUNT_ID: 'a'.repeat(32),
    AUTHRIM_LOG_ARCHIVE_BUCKET: 'fixture-logs',
    AUTHRIM_LOG_ARCHIVE_WAREHOUSE: `${'a'.repeat(32)}_fixture-logs`,
    AUTHRIM_LOG_ARCHIVE_CATALOG_URI: `https://catalog.cloudflarestorage.com/${'a'.repeat(32)}/fixture-logs`,
    AUTHRIM_LOG_ARCHIVE_NAMESPACE: 'authrim',
    AUTHRIM_LOG_ARCHIVE_TABLE: 'logs',
    AUTHRIM_LOG_ARCHIVE_TABLE_UUID: '11111111-1111-4111-8111-111111111111',
    AUTHRIM_LOG_ARCHIVE_PHYSICAL_FINGERPRINT: 'f'.repeat(64),
    EXPORT_ARTIFACTS: {},
    AUTHRIM_CONFIG: config,
    AUTHRIM_ENVIRONMENT_NAME: 'test',
    ISSUER_URL: 'https://tenant.example',
    ENABLE_SAML_DR_EXPORT: 'true',
    SAML_DR_MUTATION_CONTROL: mutation,
    CONTROL: {
      ...mutation,
      publishTenantBackupRuntimeState: async () => {},
      inspectSamlDrWriterCoverage: async () => ({
        formatVersion: 1,
        tenantId: 'tenant-a',
        environmentId: 'test',
        inventoryDigest: 'd'.repeat(64),
        workers: [{}],
        protectedResources: [{}],
      }),
      tenantBackupSnapshotBoundary: async (request: TenantBackupBoundaryRequest) => {
        boundaryActions.push(request.action);
        const identity = { environmentId: 'test', ...request };
        if (request.action === 'begin')
          return {
            environmentId: 'test',
            accepted: true,
            boundary: await admission.begin({
              id: request.boundaryId,
              tenantId: request.tenantId,
              operationId: request.operationId,
              inventoryDigest: request.inventoryDigest,
              now: Date.now(),
            }),
          };
        if (request.action === 'hold') {
          const held = await admission.hold(request.tenantId, request.boundaryId, Date.now());
          return { environmentId: 'test', accepted: held !== null, boundary: held };
        }
        if (request.action === 'assertHeld') await receipts.assertHeld(identity, Date.now());
        else if (request.action === 'abort')
          await admission.abort(request.tenantId, request.boundaryId, Date.now());
        else throw new Error('unexpected_action');
        return { environmentId: 'test', accepted: true, boundary: null };
      },
    },
  } as unknown as Env;
  mocks.resources.mockResolvedValue([
    {
      databaseId: 'core-db',
      database: coreAdapter,
      assignments: [
        { dataRole: 'tenant_core/default', assignmentGeneration: 1 },
        { dataRole: 'tenant_core/users', assignmentGeneration: 1 },
      ],
    },
  ]);
  mocks.fixed.mockReturnValue([{ databaseId: 'admin-db', database: adminAdapter }]);
  const context = {
    lease: { tenantId: 'tenant-a', operationId: 'import-a', owner: 'worker', fencingToken: 2 },
    operation: {
      kind: 'import',
      state: 'running',
      phase: 'activate_restore',
      cursor_json: cursor,
      revision: 7,
    },
    signal: new AbortController().signal,
  } as TenantBackupStepContext;
  const handlers = (value = env) =>
    createTenantBackupOperationHandlers(
      value,
      (ctx, scoped) => createProductionTenantBackupExportAdapter(scoped, ctx),
      Date.now
    );
  return {
    env,
    context,
    handlers,
    core,
    control,
    admission,
    environmentAcquire,
    tenantAcquire,
    boundaryActions,
    config,
    state: () =>
      (core.prepare('SELECT lifecycle_state FROM tenants').get() as { lifecycle_state: string })
        .lifecycle_state,
  };
}

it('reproduces the former outer-scheduler self-permit and activates through the real production dispatcher after scope separation', async () => {
  const f = await fixture();
  await expect(
    runSamlDrCoveredOperation(f.env, undefined, (covered) => f.handlers(covered).run(f.context))
  ).rejects.toThrow('source_mutations_pending');
  expect(f.state()).toBe('provisioning');
  expect(f.environmentAcquire).toHaveBeenCalledTimes(1);
  const result = await f.handlers().run(f.context);
  expect(result.phase).toBe('verify_restore_activation');
  expect(f.state()).toBe('active');
  expect(f.environmentAcquire).toHaveBeenCalledTimes(1);
  expect(f.tenantAcquire).not.toHaveBeenCalled();
  expect(mocks.scopeChecks).toHaveBeenCalledWith(true, false);
  expect(f.config.put).toHaveBeenCalled();
});

it('keeps the actual held gate until deferred activation effects settle and rejects another live writer', async () => {
  const f = await fixture();
  expect(await f.admission.acquireEnvironment('different-writer', Date.now())).toBe(true);
  await expect(f.handlers().run(f.context)).rejects.toThrow('source_mutations_pending');
  expect(f.state()).toBe('provisioning');
  await f.admission.completeEnvironment('different-writer', Date.now());
  let release: () => void = () => {};
  mocks.deferred = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = f.handlers().run(f.context);
  for (let i = 0; i < 100 && f.state() !== 'active'; i++)
    await new Promise((resolve) => setTimeout(resolve, 1));
  expect(f.state()).toBe('active');
  expect(await f.admission.acquire('tenant-a', 'late-writer', Date.now())).toBe(false);
  let finished = false;
  void running.then(() => {
    finished = true;
  });
  await Promise.resolve();
  expect(finished).toBe(false);
  release();
  expect((await running).phase).toBe('verify_restore_activation');
  expect(await f.admission.acquire('tenant-a', 'after-completion', Date.now())).toBe(true);
});

it('keeps normal non-users activation under ordinary environment coverage', async () => {
  const f = await fixture(false);
  expect((await f.handlers().run(f.context)).phase).toBe('verify_restore_activation');
  expect(f.state()).toBe('active');
  expect(f.environmentAcquire).toHaveBeenCalledTimes(1);
  expect(f.boundaryActions).toEqual([]);
  expect(f.tenantAcquire).not.toHaveBeenCalled();
});
