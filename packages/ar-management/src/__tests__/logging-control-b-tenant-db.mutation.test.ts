/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- admin API response bodies are untyped JSON in these route tests */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../admin-shared', async (original) => ({
  ...(await original<typeof import('../admin-shared')>()),
  writeAdminAuditLog: (await import('./logging-control-b-harness')).auditWrite,
}));
vi.mock('../admin-step-up-gate', async () => {
  const { stepUpFakes } = await import('./logging-control-b-harness');
  return {
    requireAdminStepUp: stepUpFakes.requireAdminStepUp,
    refuseAdminFreshAuth: stepUpFakes.refuseAdminFreshAuth,
  };
});
vi.mock('@authrim/ar-lib-core', async (importOriginal) =>
  (await import('./logging-control-b-harness')).buildCoreMock(
    await importOriginal<typeof import('@authrim/ar-lib-core')>()
  )
);

import { ADMIN_PERMISSIONS } from '@authrim/ar-lib-core';
import { coreFakes, auditWrite, mockAdapter, resetFakes } from './logging-control-b-harness';
import { POLICIES, call, createApp, createPlatformApp } from './logging-control-b-app';
import { must } from './helpers/must';

const READ = [ADMIN_PERMISSIONS.LOGGING_OVERVIEW_READ];

describe('runtime/tenant-db-health', () => {
  beforeEach(() => resetFakes());
  const path = `${POLICIES}/runtime/tenant-db-health`;
  const base = {
    tenant_id: 'tenant-a',
    role: 'tenant_core',
    shard_group: 'default',
    generation: '3',
    shard_count: 2,
    shard_key_strategy: 'hash',
    runtime_generation: '4',
    pointer_status: 'active',
    pointer_updated_at: 111,
    provider: 'd1',
    database_id: 'dbid',
    database_name: 'dbname',
    binding_ref: 'DB_ADMIN',
    connection_ref: null,
    schema_version: '7',
    registry_status: 'active',
    region_hint: 'eu',
    jurisdiction: 'EU',
    registry_updated_at: 222,
    pointer_metadata_json: '{"p":1}',
    registry_metadata_json: '{"r":2}',
  };

  it('requires routing-read or overview-read', async () => {
    expect((await call(createApp([]), 'GET', path)).status).toBe(403);
    expect(
      (await call(createApp([ADMIN_PERMISSIONS.DATABASE_ROUTING_READ]), 'GET', path)).status
    ).toBe(200);
  });

  it('validates the role filter and tenant scope', async () => {
    const bad = await call(createApp(READ), 'GET', `${path}?role=tenant_unknown`);
    expect(bad.status).toBe(400);
    expect(bad.body.details.fields).toEqual([
      { path: 'role', code: 'invalid_value', message: 'Tenant database role is not supported.' },
    ]);
    for (const role of ['tenant_core', 'tenant_pii', 'tenant_audit', 'tenant_custom']) {
      expect((await call(createApp(READ), 'GET', `${path}?filter[role]=${role}`)).status).toBe(200);
    }
    const mismatch = await call(createApp(READ), 'GET', `${path}?filter[tenant_id]=tenant-b`);
    expect(mismatch.status).toBe(403);
  });

  it('queries the tenant (and role) pointers', async () => {
    await call(createApp(READ), 'GET', path);
    const [sql, params] = mockAdapter.query.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toContain('AND p.role = ?');
    expect(params).toEqual(['tenant-a']);
    mockAdapter.query.mockClear();
    const res = await call(
      createPlatformApp(READ),
      'GET',
      `${path}?tenant_id=tenant-z&role=tenant_pii`
    );
    const [sql2, params2] = mockAdapter.query.mock.calls[0] as [string, unknown[]];
    expect(sql2).toContain('AND p.role = ?');
    expect(params2).toEqual(['tenant-z', 'tenant_pii']);
    expect(res.body.item).toMatchObject({ tenant_id: 'tenant-z', role: 'tenant_pii', items: [] });
    const noRole = await call(createApp(READ), 'GET', path);
    expect(noRole.body.item.role).toBeNull();
  });

  it('maps rows to items with parsed numbers and metadata', async () => {
    mockAdapter.query.mockResolvedValue([base]);
    const res = await call(createApp(READ), 'GET', path);
    expect(res.body.item.items).toEqual([
      {
        tenant_id: 'tenant-a',
        role: 'tenant_core',
        shard_group: 'default',
        generation: 3,
        shard_count: 2,
        shard_key_strategy: 'hash',
        runtime_generation: 4,
        pointer_status: 'active',
        pointer_updated_at: 111,
        registry_status: 'active',
        provider: 'd1',
        database_id: 'dbid',
        database_name: 'dbname',
        binding_ref: 'DB_ADMIN',
        connection_ref: null,
        binding_configured: true,
        schema_version: 7,
        region_hint: 'eu',
        jurisdiction: 'EU',
        registry_updated_at: 222,
        health_state: 'healthy',
        pointer_metadata: { p: 1 },
        registry_metadata: { r: 2 },
      },
    ]);
    expect(res.body.item.summary).toEqual({
      healthy: 1,
      degraded: 0,
      failed: 0,
      missing_registry: 0,
      missing_binding: 0,
    });
  });

  it('fills defaults for sparse rows', async () => {
    mockAdapter.query.mockResolvedValue([
      {
        tenant_id: 'tenant-a',
        role: 'tenant_core',
        connection_ref: 'conn-1',
        registry_status: 'active',
        pointer_metadata_json: 5,
        registry_metadata_json: '[1]',
      },
    ]);
    const res = await call(createApp(READ), 'GET', path);
    expect(res.body.item.items[0]).toMatchObject({
      pointer_status: 'unknown',
      provider: null,
      database_id: null,
      database_name: null,
      binding_ref: null,
      connection_ref: 'conn-1',
      binding_configured: true,
      schema_version: null,
      region_hint: null,
      jurisdiction: null,
      registry_updated_at: null,
      generation: 0,
      pointer_metadata: {},
      registry_metadata: {},
      health_state: 'healthy',
    });
  });

  it('classifies health from registry status, pointer status and binding', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ registry_status: null }, 'failed'],
      [{ registry_status: 'failed' }, 'failed'],
      [{ registry_status: 'disabled' }, 'failed'],
      [{ pointer_status: 'disabled' }, 'failed'],
      [{ binding_ref: 'NOT_BOUND' }, 'failed'],
      [{ binding_ref: null, connection_ref: null }, 'failed'],
      [{ registry_status: 'degraded' }, 'degraded'],
      [{ registry_status: 'degraded_pending_snapshot' }, 'degraded'],
      [{ pointer_status: 'degraded_pending_snapshot' }, 'degraded'],
      [{}, 'healthy'],
    ];
    mockAdapter.query.mockResolvedValue(cases.map(([override]) => ({ ...base, ...override })));
    const res = await call(createApp(READ), 'GET', path);
    expect(res.body.item.items.map((item: { health_state: string }) => item.health_state)).toEqual(
      cases.map(([, expected]) => expected)
    );
    expect(res.body.item.summary).toEqual({
      healthy: 1,
      degraded: 3,
      failed: 6,
      missing_registry: 1,
      missing_binding: 2,
    });
    expect(res.body.item.items[0].registry_status).toBe('missing');
  });

  it('answers 500 when the query fails', async () => {
    mockAdapter.query.mockRejectedValue(new Error('x'));
    expect((await call(createApp(READ), 'GET', path)).status).toBe(500);
  });
});

describe('runtime/tenant-db-probe and probes', () => {
  beforeEach(() => resetFakes());
  const path = `${POLICIES}/runtime/tenant-db-probe`;
  const WRITE = [ADMIN_PERMISSIONS.DATABASE_ROUTING_WRITE];

  function arrangeTenantDatabase(mismatch = false) {
    const state = { nonce: '' };
    const tenantAdapter = {
      execute: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.startsWith('INSERT') && params) state.nonce = String(params[4]);
        return { rowsAffected: 1 };
      }),
      queryOne: vi.fn(async () => ({ nonce: mismatch ? 'different' : state.nonce })),
    };
    coreFakes.ensureDatabaseAdapter.mockReturnValue(tenantAdapter);
    coreFakes.resolveTenantDatabase.mockResolvedValue({
      source: { kind: 'fake-source' },
      shardCount: 4,
      runtimeGeneration: 9,
      deploymentTarget: 'cloudflare',
      healthStatus: 'healthy',
      generation: 2,
      bindingRef: 'DB_TENANT',
      schemaVersion: 12,
      registryRow: { connection_ref: 'conn-x', provider: 'd1' },
    });
    return tenantAdapter;
  }

  it('requires routing-write permission and tenant scope', async () => {
    const denied = await call(createApp(READ), 'POST', path, {});
    expect(denied.status).toBe(403);
    expect(coreFakes.resolveTenantDatabase).not.toHaveBeenCalled();
    const mismatch = await call(createApp(WRITE), 'POST', path, { tenant_id: 'tenant-b' });
    expect(mismatch.status).toBe(403);
    expect(mismatch.body.details.permission.reason).toBe('tenant_scope_mismatch');
  });

  it('rejects an unsupported probe kind', async () => {
    const res = await call(createApp(WRITE), 'POST', path, { probe_kind: 'read_only' });
    expect(res.status).toBe(400);
    expect(res.body.details.fields).toEqual([
      {
        path: 'probe_kind',
        code: 'invalid_value',
        message: 'Probe kind must be write_read_delete.',
      },
    ]);
    expect(coreFakes.resolveTenantDatabase).not.toHaveBeenCalled();
  });

  it('runs a write/read/delete probe, records it and audits success', async () => {
    const tenantAdapter = arrangeTenantDatabase();
    const res = await call(createApp(WRITE), 'POST', path, {
      role: 'tenant_pii',
      shard_group: ' grp ',
      shard_index: '3',
      probe_kind: 'write_read_delete',
    });
    expect(res.status).toBe(200);
    expect(res.body.audit_id).toBe('audit-id-1');
    const result = res.body.result;
    expect(result).toMatchObject({
      id: expect.stringMatching(/^tdp_/),
      tenant_id: 'tenant-a',
      role: 'tenant_pii',
      shard_group: 'grp',
      shard_index: 3,
      probe_kind: 'write_read_delete',
      status: 'succeeded',
      binding_ref: 'DB_TENANT',
      connection_ref: 'conn-x',
      provider: 'd1',
      schema_version: 12,
      error_class: null,
      error_message: null,
      metadata: {
        shard_count: 4,
        runtime_generation: 9,
        deployment_target: 'cloudflare',
        health_status: 'healthy',
      },
    });
    expect(result.latency_ms).toEqual(expect.any(Number));
    expect(coreFakes.resolveTenantDatabase).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'tenant-a',
      role: 'tenant_pii',
      shardGroup: 'grp',
      shardIndex: 3,
    });
    expect(coreFakes.ensureDatabaseAdapter).toHaveBeenCalledWith(
      { kind: 'fake-source' },
      'tenant-db-probe'
    );
    const statements = tenantAdapter.execute.mock.calls.map(([sql]) => String(sql).trim());
    expect(statements[0]).toContain('CREATE TABLE IF NOT EXISTS authrim_runtime_probes');
    expect(statements[1]).toContain('INSERT INTO authrim_runtime_probes');
    expect(statements[2]).toBe('DELETE FROM authrim_runtime_probes WHERE id = ?');
    expect(tenantAdapter.execute.mock.calls[2][1]).toEqual([result.id]);
    expect(tenantAdapter.execute.mock.calls[1][1]).toEqual([
      result.id,
      'tenant-a',
      'tenant_pii',
      'write_read_delete',
      expect.any(String),
      result.checked_at,
    ]);
    expect((tenantAdapter.queryOne.mock.calls[0] as unknown[])[1]).toEqual([result.id]);

    const persisted = must(
      mockAdapter.execute.mock.calls.find(([sql]) =>
        String(sql).includes('INSERT INTO tenant_database_probe_results')
      )
    );
    expect(persisted[1]).toEqual([
      result.id,
      'tenant-a',
      'tenant_pii',
      'grp',
      3,
      2,
      'write_read_delete',
      'succeeded',
      expect.any(Number),
      'DB_TENANT',
      'conn-x',
      'd1',
      12,
      null,
      null,
      JSON.stringify(result.metadata),
      'admin-1',
      result.checked_at,
    ]);
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'logging.runtime.tenant_db_probe',
        resourceType: 'tenant_database',
        resourceId: 'tenant-a:tenant_pii:grp:3',
        result: 'success',
        severity: 'info',
        metadata: {
          tenant_id: 'tenant-a',
          role: 'tenant_pii',
          shard_group: 'grp',
          shard_index: 3,
          probe_kind: 'write_read_delete',
          error_class: null,
        },
      })
    );
  });

  it('defaults role, shard group and index and sanitizes odd values', async () => {
    arrangeTenantDatabase();
    for (const shardIndex of ['-4', 'abc', undefined]) {
      const res = await call(createApp(WRITE), 'POST', path, {
        role: 'nope',
        shard_index: shardIndex,
      });
      expect(res.body.result).toMatchObject({
        role: 'tenant_core',
        shard_group: 'default',
        shard_index: 0,
        probe_kind: 'write_read_delete',
      });
    }
    const platform = await call(createPlatformApp(WRITE), 'POST', path, { tenant_id: 'tenant-q' });
    expect(platform.body.result.tenant_id).toBe('tenant-q');
  });

  it('reports a read-back mismatch as a failed probe (503) and audits the failure', async () => {
    const tenantAdapter = arrangeTenantDatabase(true);
    const res = await call(createApp(WRITE), 'POST', path, {});
    expect(res.status).toBe(503);
    expect(res.body.result).toMatchObject({
      status: 'failed',
      error_class: 'tenant_database_probe_failed',
      error_message: 'tenant_database_probe_readback_mismatch',
      metadata: {},
      binding_ref: 'DB_TENANT',
    });
    expect(tenantAdapter.execute.mock.calls.at(-1)?.[0]).toBe(
      'DELETE FROM authrim_runtime_probes WHERE id = ?'
    );
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        result: 'failure',
        severity: 'warn',
        metadata: expect.objectContaining({ error_class: 'tenant_database_probe_failed' }),
      })
    );
    const persisted = must(
      mockAdapter.execute.mock.calls.find(([sql]) =>
        String(sql).includes('tenant_database_probe_results')
      )
    );
    expect((persisted[1] as unknown[])[7]).toBe('failed');
    expect((persisted[1] as unknown[])[13]).toBe('tenant_database_probe_failed');
    expect((persisted[1] as unknown[])[14]).toBe('tenant_database_probe_readback_mismatch');
    expect((persisted[1] as unknown[])[15]).toBe('{}');
  });

  it('uses the resolver error prefix as the error class and nulls the unresolved columns', async () => {
    const error = new Error('registry_row_missing: tenant-a/tenant_core');
    error.name = 'TenantDatabaseResolverError';
    coreFakes.resolveTenantDatabase.mockRejectedValue(error);
    const res = await call(createApp(WRITE), 'POST', path, {});
    expect(res.status).toBe(503);
    expect(res.body.result).toMatchObject({
      status: 'failed',
      error_class: 'registry_row_missing',
      error_message: 'registry_row_missing: tenant-a/tenant_core',
      binding_ref: null,
      connection_ref: null,
      provider: null,
      schema_version: null,
    });
    const persisted = must(
      mockAdapter.execute.mock.calls.find(([sql]) =>
        String(sql).includes('tenant_database_probe_results')
      )
    );
    expect((persisted[1] as unknown[]).slice(5, 13)).toEqual([
      null,
      'write_read_delete',
      'failed',
      expect.any(Number),
      null,
      null,
      null,
      null,
    ]);
  });

  it('falls back to a generic message for a thrown non-error and survives persistence failure', async () => {
    coreFakes.resolveTenantDatabase.mockRejectedValue('weird');
    mockAdapter.execute.mockRejectedValue(new Error('index db down'));
    const res = await call(createApp(WRITE), 'POST', path, {});
    expect(res.status).toBe(503);
    expect(res.body.result).toMatchObject({
      error_class: 'tenant_database_probe_failed',
      error_message: 'tenant_database_probe_failed',
    });
    expect(res.body.audit_id).toBe('audit-id-1');
  });

  describe('listing probe results', () => {
    const listPath = `${POLICIES}/runtime/tenant-db-probes`;

    it('requires routing-read permission and tenant scope', async () => {
      expect((await call(createApp(READ), 'GET', listPath)).status).toBe(403);
      const mismatch = await call(
        createApp([ADMIN_PERMISSIONS.DATABASE_ROUTING_READ]),
        'GET',
        `${listPath}?tenant_id=tenant-b`
      );
      expect(mismatch.status).toBe(403);
    });

    it('filters by tenant and role with a default limit of 25 (max 100)', async () => {
      mockAdapter.query.mockResolvedValue([{ id: 'tdp_1' }]);
      const app = createApp([ADMIN_PERMISSIONS.DATABASE_ROUTING_READ]);
      const res = await call(app, 'GET', `${listPath}?filter[role]=tenant_audit`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ items: [{ id: 'tdp_1' }], total: 1 });
      const [sql, params] = mockAdapter.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('WHERE tenant_id = ? AND role = ?');
      expect(sql).toContain('ORDER BY created_at DESC');
      expect(params).toEqual(['tenant-a', 'tenant_audit', 25]);

      mockAdapter.query.mockClear();
      await call(
        createPlatformApp([ADMIN_PERMISSIONS.DATABASE_ROUTING_READ]),
        'GET',
        `${listPath}?limit=1000`
      );
      const [sql2, params2] = mockAdapter.query.mock.calls[0] as [string, unknown[]];
      expect(sql2).not.toContain('WHERE');
      expect(params2).toEqual([100]);

      mockAdapter.query.mockClear();
      await call(
        createPlatformApp([ADMIN_PERMISSIONS.DATABASE_ROUTING_READ]),
        'GET',
        `${listPath}?role=bogus&tenant_id=tenant-z`
      );
      expect(mockAdapter.query.mock.calls[0][1]).toEqual(['tenant-z', 25]);
    });

    it('answers 500 when the query fails', async () => {
      mockAdapter.query.mockRejectedValue(new Error('x'));
      expect(
        (await call(createApp([ADMIN_PERMISSIONS.DATABASE_ROUTING_READ]), 'GET', listPath)).status
      ).toBe(500);
    });
  });
});
