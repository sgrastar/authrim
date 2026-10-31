import { DatabaseSync, type SQLiteDatabase, type SQLInputValue } from './test-sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import { encodeTenantBackupRequestIntent } from '@authrim/ar-lib-core/services/tenant-portability/operation-request';
import { TenantBackupMutationAdmission } from '@authrim/ar-lib-core/services/tenant-portability/mutation-admission';
import { TenantBackupBoundaryReceipts } from '@authrim/ar-lib-core/services/tenant-portability/boundary-receipts';
import type { TenantBackupBoundaryRequest } from '@authrim/ar-lib-core/services/tenant-portability/boundary-rpc-contract';
import type { TenantBackupStepContext } from '@authrim/ar-lib-core/services/tenant-portability/operation-executor';
import type { GuestCurrentDenyWitness } from '@authrim/ar-lib-core/services/tenant-portability/guest-current-deny-witness';

const mocks = vi.hoisted(() => ({
  resources: vi.fn(),
  corePreflight: vi.fn(async () => {}),
  piiPreflight: vi.fn(async (_database: unknown, _pin: unknown) => []),
}));
vi.mock('@authrim/ar-lib-core/services/guest-core-erasure-admission', async (original) => ({
  ...(await original<
    typeof import('@authrim/ar-lib-core/services/guest-core-erasure-admission')
  >()),
  assertGuestCoreErasureAdmission: mocks.corePreflight,
}));
vi.mock('@authrim/ar-lib-core/services/guest-pii-erasure', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-core/services/guest-pii-erasure')>()),
  createGuestPiiErasurePort: (database: unknown, pin: unknown) => ({
    tables: () => mocks.piiPreflight(database, pin),
  }),
}));
vi.mock(
  '@authrim/ar-lib-core/services/tenant-portability/database-resources',
  async (original) => ({
    ...(await original<
      typeof import('@authrim/ar-lib-core/services/tenant-portability/database-resources')
    >()),
    resolveBackupTenantDatabaseResources: mocks.resources,
  })
);
vi.mock('@authrim/ar-lib-core/services/tenant-vanity-domain-resolver', () => ({
  buildCanonicalTenantIssuerUrl: async (_env: unknown, _tenant: string, fallback: string) =>
    fallback,
}));
import { createProductionGuestRestoreAuthority } from '../tenant-backup-guest-authority-production';

const dbs: SQLiteDatabase[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  vi.clearAllMocks();
});
function adapter(db: SQLiteDatabase): DatabaseAdapter {
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
    isHealthy: async () => ({ healthy: true, latencyMs: 0, type: 'd1' }),
    getType: () => 'd1',
    close: async () => {},
  };
}
async function fixture() {
  const db = new DatabaseSync(':memory:');
  dbs.push(db);
  const database = adapter(db),
    now = Date.now();
  db.exec(`CREATE TABLE tenant_backup_operations(id TEXT,tenant_id TEXT,kind TEXT,state TEXT,lease_owner TEXT,fencing_token INTEGER,revision INTEGER,phase TEXT,cursor_json TEXT,lease_expires_at INTEGER,created_by TEXT,request_json TEXT,request_digest TEXT);
    CREATE TABLE tenant_runtime_cache_generations(tenant_id TEXT,cache_namespace TEXT,generation INTEGER);INSERT INTO tenant_runtime_cache_generations VALUES('tenant-a','runtime_registry',3);
    CREATE TABLE tenant_backup_mutation_boundaries(id TEXT PRIMARY KEY,tenant_id TEXT,operation_id TEXT,inventory_digest TEXT,state TEXT,created_at INTEGER,deadline_at INTEGER,environment_id TEXT,held_at INTEGER,released_at INTEGER);
    CREATE TABLE tenant_backup_mutation_permits(id TEXT PRIMARY KEY,tenant_id TEXT,created_at INTEGER,completed_at INTEGER,environment_id TEXT,scope TEXT);`);
  const encoded = await encodeTenantBackupRequestIntent({
    version: 1,
    kind: 'import',
    source: { tenantId: 'tenant-a', issuer: 'https://tenant.example', productVersion: '0.4.2' },
    selection: {
      settings: false,
      users: true,
      admin: false,
      artifacts: false,
      logs: { audit: false, other: false, sensitive: false, period: 'all' },
    },
    inputs: [{ id: 'input-a', digestSha256: 'a'.repeat(64) }],
  });
  db.prepare('INSERT INTO tenant_backup_operations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    'import-a',
    'tenant-a',
    'import',
    'running',
    'worker',
    2,
    7,
    'activate_restore',
    null,
    now + 100000,
    'admin-a',
    encoded.json,
    encoded.digest
  );
  const context = {
    lease: { tenantId: 'tenant-a', operationId: 'import-a', owner: 'worker', fencingToken: 2 },
    operation: {
      kind: 'import',
      state: 'running',
      phase: 'activate_restore',
      cursor_json: null,
      revision: 7,
    },
    signal: new AbortController().signal,
  } as TenantBackupStepContext;
  const admission = new TenantBackupMutationAdmission(database, 'test', false, true),
    receipts = new TenantBackupBoundaryReceipts(database);
  const actions: string[] = [];
  let rejectHeld = false;
  const env = {
    DB_ADMIN: database,
    AUTHRIM_ENVIRONMENT_NAME: 'test',
    ISSUER_URL: 'https://tenant.example',
    ENABLE_SAML_DR_EXPORT: 'true',
    CONTROL: {
      inspectSamlDrWriterCoverage: async () => ({
        formatVersion: 1,
        tenantId: 'tenant-a',
        environmentId: 'test',
        inventoryDigest: 'd'.repeat(64),
        workers: [{}],
        protectedResources: [{}],
      }),
      tenantBackupSnapshotBoundary: async (request: TenantBackupBoundaryRequest) => {
        actions.push(request.action);
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
              now,
            }),
          };
        if (request.action === 'hold')
          return {
            environmentId: 'test',
            accepted: true,
            boundary: await admission.hold(request.tenantId, request.boundaryId, now),
          };
        if (request.action === 'assertHeld') {
          if (rejectHeld) return { environmentId: 'test', accepted: false, boundary: null };
          await receipts.assertHeld(identity, now);
        } else if (request.action === 'abort')
          await admission.abort(request.tenantId, request.boundaryId, now);
        else throw new Error('unexpected_control_action');
        return { environmentId: 'test', accepted: true, boundary: null };
      },
    },
  } as unknown as Env;
  mocks.resources.mockResolvedValue([
    {
      databaseId: 'core',
      database,
      runtimeGeneration: 3,
      deploymentTarget: 'edge-a',
      assignments: [
        {
          role: 'tenant_core',
          dataRole: 'tenant_core/users',
          bindingRef: 'DB_CORE',
          residencyPartition: 'default',
          shardId: 'main',
          assignmentGeneration: 3,
          bindingRouteGeneration: 2,
        },
      ],
    },
    {
      databaseId: 'pii',
      database,
      runtimeGeneration: 3,
      deploymentTarget: 'edge-a',
      assignments: [
        {
          role: 'tenant_pii',
          dataRole: 'tenant_pii',
          bindingRef: 'DB_PII',
          residencyPartition: 'default',
          shardId: 'main',
          assignmentGeneration: 3,
          bindingRouteGeneration: 2,
        },
      ],
    },
  ]);
  const port = createProductionGuestRestoreAuthority(
    env,
    () => now,
    () => context
  );
  const witness = {
    version: 1,
    purpose: 'guest-current-deny-v1',
    tenantId: 'tenant-a',
    operationId: 'import-a',
    planDigest: 'a'.repeat(64),
    sourceEnvironmentId: 'test',
    sourceIssuer: 'https://tenant.example',
    inventoryDigest: 'b'.repeat(64),
    epochs: [
      { family: 'core', resourceId: 'core', revision: 0 },
      { family: 'pii', resourceId: 'pii', revision: 0 },
    ],
    denyDigest: 'c'.repeat(64),
    markerCount: 0,
  } satisfies GuestCurrentDenyWitness;
  return {
    db,
    database,
    port,
    env,
    context,
    admission,
    actions,
    witness,
    now,
    rejectHeld: () => {
      rejectHeld = true;
    },
  };
}

it('pins same-environment signed resources to the primary Admin generation and the immutable source issuer', async () => {
  const f = await fixture();
  expect(await f.port.enabled(f.context)).toBe(true);
  expect(await f.port.source(f.context)).toEqual(
    expect.objectContaining({
      environmentId: 'test',
      issuer: 'https://tenant.example',
      resources: [
        { id: 'core', family: 'core', database: f.database },
        { id: 'pii', family: 'pii', database: f.database },
      ],
    })
  );
  f.db.exec('UPDATE tenant_runtime_cache_generations SET generation=4');
  await expect(f.port.source(f.context)).rejects.toThrow('authority_unavailable');
  f.db.exec('UPDATE tenant_runtime_cache_generations SET generation=3');
  f.env.ISSUER_URL = 'https://other.example';
  await expect(f.port.source(f.context)).rejects.toThrow('cross_environment_authority_unavailable');
});
it('fails closed for unreachable source, missing inventory and a lost import lease', async () => {
  const f = await fixture();
  mocks.resources.mockRejectedValueOnce(new Error('source_offline'));
  await expect(f.port.source(f.context)).rejects.toThrow('source_offline');
  mocks.resources.mockResolvedValueOnce([]);
  await expect(f.port.source(f.context)).rejects.toThrow('authority_unavailable');
  f.db.exec('UPDATE tenant_backup_operations SET fencing_token=3');
  await expect(f.port.source(f.context)).rejects.toThrow('authority_unavailable');
});

it('requires the installed Core and PII erasure admission profiles before using a source as authority', async () => {
  const f = await fixture();
  mocks.corePreflight.mockRejectedValueOnce(new Error('guest_core_admission_unavailable'));
  await expect(f.port.source(f.context)).rejects.toThrow('guest_core_admission_unavailable');
  mocks.piiPreflight.mockRejectedValueOnce(new Error('guest_pii_erasure_schema_unsupported'));
  await expect(f.port.source(f.context)).rejects.toThrow('guest_pii_erasure_schema_unsupported');
  expect(f.actions).toEqual([]);
});
it('holds the actual Control mutation gate across publication without manufacturing snapshot receipts', async () => {
  const f = await fixture();
  await f.port.withHeldBoundary(f.context, f.witness, async (deadline, assertHeld) => {
    expect(deadline).toBe(f.now + 5000);
    await assertHeld();
    expect(await f.admission.acquire('tenant-a', 'late-writer', f.now + 1)).toBe(false);
  });
  expect(f.actions.slice(0, 2)).toEqual(['begin', 'hold']);
  expect(f.actions.at(-1)).toBe('abort');
  expect(f.actions.slice(2, -1).every((action) => action === 'assertHeld')).toBe(true);
  expect(await f.admission.acquire('tenant-a', 'after-publish', f.now + 2)).toBe(true);
  expect(f.db.prepare('SELECT state FROM tenant_backup_mutation_boundaries').get()).toEqual({
    state: 'aborted',
  });
});
it('does not call publication when active writers have not drained or the held proof disappears', async () => {
  const f = await fixture(),
    publish = vi.fn(async () => {});
  expect(await f.admission.acquire('tenant-a', 'still-writing', f.now)).toBe(true);
  await expect(f.port.withHeldBoundary(f.context, f.witness, publish)).rejects.toThrow(
    'backup_boundary_rpc_invalid'
  );
  expect(publish).not.toHaveBeenCalled();
  await f.admission.complete('tenant-a', 'still-writing', f.now);
  f.rejectHeld();
  await expect(f.port.withHeldBoundary(f.context, f.witness, publish)).rejects.toThrow(
    'backup_boundary_rpc_invalid'
  );
  expect(publish).not.toHaveBeenCalled();
});
it('requires strict writer coverage and aborts a failed publication without claiming successful release', async () => {
  const f = await fixture(),
    publish = vi.fn(async () => {
      throw new Error('partial_activation');
    });
  f.env.ENABLE_SAML_DR_EXPORT = 'false';
  await expect(f.port.withHeldBoundary(f.context, f.witness, publish)).rejects.toThrow(
    'strict_writer_admission_required'
  );
  expect(f.actions).toEqual([]);
  f.env.ENABLE_SAML_DR_EXPORT = 'true';
  await expect(f.port.withHeldBoundary(f.context, f.witness, publish)).rejects.toThrow(
    'partial_activation'
  );
  expect(f.actions.at(-1)).toBe('abort');
  expect(f.actions).not.toContain('release');
});
