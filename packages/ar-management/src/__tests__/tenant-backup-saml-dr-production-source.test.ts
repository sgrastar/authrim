import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LEGACY_IMPORT_CONTRACT, type Env } from '@authrim/ar-lib-core';
import type { SamlDrFrozenSourceCapture } from '@authrim/ar-lib-core/services/tenant-portability/saml-dr-snapshot';
import type { AdapterContext } from '../tenant-backup-export-dispatcher';
import { createProductionSamlDrSnapshotSources } from '../tenant-backup-saml-dr-production-source';
import type { SamlDrSqlInventory } from '../tenant-backup-saml-dr-sql-source';

const mocks = vi.hoisted(() => ({
  guard: vi.fn(),
  runtime: vi.fn(),
  route: vi.fn(),
  live: vi.fn(),
  frozen: vi.fn(),
  checkSql: vi.fn(),
  start: vi.fn(),
  read: vi.fn(),
  release: vi.fn(),
  assertReleased: vi.fn(),
  boundary: vi.fn(),
  platform: vi.fn(),
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/saml-dr-writer', () => ({
  assertSamlDrWriterCoverage: mocks.guard,
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/saml-dr-runtime-settings', () => ({
  readSamlDrRuntimeSettings: mocks.runtime,
}));
vi.mock('@authrim/ar-lib-core/services/runtime-data-context', () => ({
  resolveAccountRouteForSamlDrSnapshot: mocks.route,
}));
vi.mock('../tenant-backup-services', () => ({
  getTenantBackupBoundaryClient: () => ({ receipts: { readReleased: mocks.boundary } }),
}));
vi.mock('../tenant-backup-saml-dr-account-source', () => ({
  createSamlDrAccountSnapshotSource: () => ({
    start: mocks.start,
    read: mocks.read,
    release: mocks.release,
    assertReleased: mocks.assertReleased,
  }),
}));
vi.mock('../tenant-backup-saml-dr-sql-source', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tenant-backup-saml-dr-sql-source')>()),
  readLiveSamlDrSqlInventory: mocks.live,
  readFrozenSamlDrSqlRows: mocks.frozen,
  assertSamlDrSqlInventoryFrozen: mocks.checkSql,
  readBoundedSamlDrSqlRows: mocks.platform,
}));

const text = (value: string) => ['text', value] as const;
const integer = (value: string) => ['integer', value] as const;
const sql: SamlDrSqlInventory = {
  'core.users_core': [{ tenant_id: text('tenant-a'), id: text('user-a') }],
  'core.identity_accounts': [
    {
      tenant_id: text('tenant-a'),
      id: text('account:user-a'),
      account_type: text('user'),
      legacy_user_id: text('user-a'),
      lifecycle_state: text('active'),
      directory_publication_state: text('active'),
      account_route_generation: integer('3'),
    },
  ],
  'core.passkeys': [
    {
      tenant_id: text('tenant-a'),
      id: text('passkey-a'),
      user_id: text('user-a'),
      credential_id: text('credential-a'),
      counter: integer('7'),
      created_at: integer('10'),
    },
  ],
};
const route = {
  schemaVersion: 1,
  accountRouteGeneration: 3,
  residencyPolicyId: 'default',
  targets: [
    {
      dataRole: 'tenant_core/users',
      residencyPartition: 'default',
      shardId: 'core-shard',
      bindingRef: 'CORE_A',
      requiredBindingRouteGeneration: 4,
    },
    {
      dataRole: 'tenant_pii',
      residencyPartition: 'default',
      shardId: 'pii-shard',
      bindingRef: 'PII_A',
      requiredBindingRouteGeneration: 5,
    },
  ],
};
const identity: SamlDrFrozenSourceCapture['source'] = {
  bundleId: '01'.repeat(16),
  snapshotId: 'boundary-a',
  boundaryUnixMs: 100,
  inventoryDigestSha256: 'a'.repeat(64),
  source: { tenantId: 'tenant-a', issuer: 'https://idp.example.test', productVersion: '0.4.2' },
};
function fixture() {
  const values = new Map<string, string>();
  const bucket = {
    put: vi.fn(
      async (key: string, value: string, options?: { onlyIf?: { etagDoesNotMatch: string } }) => {
        if (options?.onlyIf && values.has(key)) return null;
        values.set(key, value);
        return {};
      }
    ),
    get: vi.fn(async (key: string) => {
      const value = values.get(key);
      return value === undefined ? null : { text: async () => value, size: value.length };
    }),
    delete: vi.fn(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key);
    }),
    list: vi.fn(async (input: { prefix: string }) => ({
      objects: [...values.keys()]
        .filter((key) => key.startsWith(input.prefix))
        .map((key) => ({ key })),
      truncated: false,
    })),
  };
  const settings = vi.fn(async () => []);
  const legacy = vi.fn(async () => ({
    state_json: JSON.stringify({
      status: 'completed',
      contract: LEGACY_IMPORT_CONTRACT,
      rejectedCount: 0,
    }),
  }));
  const context = {
    context: {
      lease: { tenantId: 'tenant-a', operationId: 'operation-a' },
      signal: new AbortController().signal,
    },
    databases: {
      fixed: [{ binding: 'DB_ADMIN', database: { query: settings, queryOne: legacy } }],
      tenant: [
        {
          assignments: route.targets.map((target) => ({
            dataRole: target.dataRole,
            bindingRef: target.bindingRef,
            shardId: target.shardId,
            residencyPartition: target.residencyPartition,
            bindingRouteGeneration: target.requiredBindingRouteGeneration,
          })),
        },
      ],
    },
  } as unknown as AdapterContext;
  const env = {
    ENABLE_SAML_DR_EXPORT: 'true',
    AUTHRIM_ENVIRONMENT_NAME: 'test',
    EXPORT_ARTIFACTS: bucket,
    OBJECT_ENCRYPTION_ROOT_KEY: 'c'.repeat(64),
    KV: { get: vi.fn() },
    AUTHRIM_CONFIG: { get: vi.fn() },
  } as unknown as Env;
  const plan = async () =>
    ['destination_profiles', 'destination_profile_versions'].map((table) => ({
      dataset: { id: `admin.${table}` },
      capture: { columns: ['id'] },
    })) as never;
  const source = () =>
    createProductionSamlDrSnapshotSources({ env, loadPlanned: plan, now: () => 101 });
  const participants = [
    { resourceId: 'core-a', snapshotId: 'sql-a' },
    { resourceId: 'saml-runtime-state:tenant', snapshotId: 'record-a' },
  ];
  return { values, bucket, context, env, source, participants, legacy, settings };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.guard.mockResolvedValue({
    formatVersion: 1,
    accountId: '123456789012',
    environmentId: 'test',
    tenantId: 'tenant-a',
    workers: [],
    protectedResources: [],
    inventoryDigest: 'f'.repeat(64),
  });
  mocks.live.mockImplementation(async () => structuredClone(sql));
  mocks.runtime.mockResolvedValue({
    sourceFlowRuntimeEnabled: true,
    consentIpSalt: 's'.repeat(32),
  });
  mocks.route.mockImplementation(async () => structuredClone(route));
  mocks.platform.mockResolvedValue([]);
  mocks.boundary.mockResolvedValue({ held_at: 100 });
  mocks.read.mockResolvedValue({
    accountAuthStates: [
      { tenantId: 'tenant-a', accountId: 'account:user-a', userId: 'user-a', lifecycle: 'active' },
    ],
    passkeyCounters: [],
    persistentNameIds: [],
  });
  mocks.frozen.mockImplementation(async (_context, _plan, id) =>
    id === 'core.oauth_clients'
      ? [{ tenant_id: text('tenant-a'), client_id: text('login-ui') }]
      : [
          {
            tenant_id: text('tenant-a'),
            client_id: text('login-ui'),
            origin: text(identity.source.issuer),
          },
        ]
  );
});

describe('installed SAML DR production source', () => {
  it.each(['disabled', 'external'] as const)(
    'freezes %s UI configuration before release and does not substitute issuer origin',
    async (mode) => {
      const f = fixture();
      f.env.LOGIN_UI_ENABLED = mode === 'disabled' ? 'false' : 'true';
      f.env.LOGIN_UI_EXECUTION_HOST_MODE = 'dedicated';
      f.env.UI_URL = 'https://login.example.test';
      const source = f.source();
      await source.prepare(f.context);
      await source.bindParticipants?.(f.context, f.participants);
      await source.start(f.context, 'record-a', identity, async () => {});
      f.env.LOGIN_UI_ENABLED = 'true';
      f.env.UI_URL = 'https://changed-after-freeze.example.test';
      const page = await f
        .source()
        .readPage(f.context, 'record-a', identity, 'loginUiConfiguration', null, 128);
      expect(page.items).toEqual([
        mode === 'disabled'
          ? { mode: 'disabled' }
          : { mode: 'registered', clientId: 'login-ui', origin: 'https://login.example.test' },
      ]);
      if (mode === 'disabled') {
        expect(
          (await f.source().readPage(f.context, 'record-a', identity, 'loginUiClients', null, 128))
            .items
        ).toEqual([]);
        expect(mocks.frozen).not.toHaveBeenCalled();
      }
    }
  );

  it('freezes actual sources, encrypts staging, and reloads immutable data after worker restart', async () => {
    const f = fixture(),
      source = f.source(),
      hold = vi.fn(async () => {});
    await source.bindParticipants?.(f.context, f.participants);
    mocks.start.mockImplementation(async () => {
      expect([...f.values.keys()].some((key) => key.endsWith('plan.json'))).toBe(true);
    });
    await source.start(f.context, 'record-a', identity, hold);
    await source.assertFrozen(f.context, 'record-a', identity);
    await source.assertBoundaryReleased(f.context, identity);
    expect(hold.mock.calls.length).toBeGreaterThan(5);
    for (const value of f.values.values()) {
      expect(value).not.toContain('credential-a');
      expect(value).not.toContain('s'.repeat(32));
    }
    mocks.runtime.mockRejectedValue(new Error('must not reread live state'));
    mocks.live.mockRejectedValue(new Error('must not reread live SQL'));
    const reloaded = f.source();
    const page = await reloaded.readPage(
      f.context,
      'record-a',
      identity,
      'runtimeSettings',
      null,
      128
    );
    expect(page.items).toEqual([{ sourceFlowRuntimeEnabled: true, consentIpSalt: 's'.repeat(32) }]);
    expect(mocks.checkSql).toHaveBeenCalledOnce();
    expect(mocks.boundary).toHaveBeenCalledWith(
      expect.objectContaining({ boundaryId: 'boundary-a' }),
      f.participants,
      101
    );
    const coverageChecks = mocks.guard.mock.calls.length;
    mocks.guard.mockRejectedValue(new Error('coverage unavailable during cleanup'));
    await reloaded.release(f.context, 'record-a');
    expect(mocks.guard).toHaveBeenCalledTimes(coverageChecks);
    expect(mocks.release).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      snapshotId: 'record-a',
      boundaryUnixMs: 100,
    });
    await reloaded.assertReleased(f.context, 'record-a');
    expect(f.values.size).toBe(0);
    expect((f.env.KV as unknown as { get: ReturnType<typeof vi.fn> }).get).not.toHaveBeenCalled();
    expect(
      (f.env.AUTHRIM_CONFIG as unknown as { get: ReturnType<typeof vi.fn> }).get
    ).not.toHaveBeenCalled();
  });
  it('retains cleanup inventory for a partially failed DO start and does not publish ready', async () => {
    const f = fixture(),
      source = f.source();
    await source.bindParticipants?.(f.context, f.participants);
    mocks.start.mockRejectedValueOnce(new Error('account snapshot failed'));
    await expect(source.start(f.context, 'record-a', identity, async () => {})).rejects.toThrow(
      'account snapshot failed'
    );
    expect([...f.values.keys()].every((key) => key.endsWith('plan.json'))).toBe(true);
    await expect(source.assertFrozen(f.context, 'record-a', identity)).rejects.toThrow(
      'saml_dr_sql_source_invalid'
    );
    await f.source().release(f.context, 'record-a');
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(f.values.size).toBe(0);
  });
  it('keeps the plan when DO cleanup cannot be verified, allowing safe retry', async () => {
    const f = fixture(),
      source = f.source();
    await source.bindParticipants?.(f.context, f.participants);
    await source.start(f.context, 'record-a', identity, async () => {});
    mocks.assertReleased.mockRejectedValueOnce(new Error('still present'));
    await expect(source.release(f.context, 'record-a')).rejects.toThrow('still present');
    expect(f.values.size).toBe(2);
    await f.source().release(f.context, 'record-a');
    expect(f.values.size).toBe(0);
  });
  it('rejects a ready marker whose cleanup inventory disappeared', async () => {
    const f = fixture(),
      source = f.source();
    await source.bindParticipants?.(f.context, f.participants);
    await source.start(f.context, 'record-a', identity, async () => {});
    for (const key of f.values.keys()) if (key.endsWith('plan.json')) f.values.delete(key);
    await expect(source.release(f.context, 'record-a')).rejects.toThrow(
      'saml_dr_sql_source_invalid'
    );
    expect(mocks.release).not.toHaveBeenCalled();
    expect(f.values.size).toBe(1);
  });
  it('retries cleanup after the ready marker was deleted but plan deletion failed', async () => {
    const f = fixture(),
      source = f.source();
    await source.bindParticipants?.(f.context, f.participants);
    await source.start(f.context, 'record-a', identity, async () => {});
    f.bucket.delete
      .mockImplementationOnce(async (keys) => {
        expect(typeof keys).toBe('string');
        f.values.delete(keys as string);
      })
      .mockRejectedValueOnce(new Error('temporary delete failure'));
    await expect(source.release(f.context, 'record-a')).rejects.toThrow('temporary delete failure');
    expect([...f.values.keys()]).toHaveLength(1);
    expect([...f.values.keys()][0]).toMatch(/plan\.json$/u);
    await f.source().release(f.context, 'record-a');
    expect(f.values.size).toBe(0);
  });
  it('refuses unverified writer coverage before reads, snapshots, or staging', async () => {
    const f = fixture();
    mocks.guard.mockRejectedValue(new Error('saml_dr_writer_inventory_unverified'));
    await expect(f.source().prepare(f.context)).rejects.toThrow(
      'saml_dr_writer_inventory_unverified'
    );
    expect(mocks.live).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(f.bucket.put).not.toHaveBeenCalled();
  });
  it('never inspects provider inventory inside an unprepared held boundary', async () => {
    const f = fixture();
    await expect(
      f.source().start({ ...f.context, boundaryUnixMs: 100 }, 'record-a', identity, async () => {})
    ).rejects.toThrow('saml_dr_writer_receipt_unprepared');
    expect(mocks.guard).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it('pins preflight writer evidence and rejects a changed deployment after release', async () => {
    const f = fixture(),
      source = f.source();
    await source.bindParticipants?.(f.context, f.participants);
    mocks.guard.mockClear();
    await source.start({ ...f.context, boundaryUnixMs: 100 }, 'record-a', identity, async () => {});
    expect(mocks.guard).not.toHaveBeenCalled();
    mocks.guard.mockImplementation(async (_env, _tenant, _signal, expected) => {
      expect(expected).toMatchObject({ inventoryDigest: 'f'.repeat(64), tenantId: 'tenant-a' });
      throw new Error('saml_dr_writer_inventory_changed');
    });
    await expect(
      f.source().readPage(f.context, 'record-a', identity, 'runtimeSettings', null, 128)
    ).rejects.toThrow('saml_dr_writer_inventory_changed');
    expect(mocks.checkSql).not.toHaveBeenCalled();
  });
  it('rejects replay under a different preflight deployment before any DO restart', async () => {
    const f = fixture(),
      source = f.source();
    await source.bindParticipants?.(f.context, f.participants);
    await source.start(f.context, 'record-a', identity, async () => {});
    const previous = (await mocks.guard.mock.results[0].value) as Record<string, unknown>;
    mocks.guard.mockResolvedValue({ ...previous, inventoryDigest: 'e'.repeat(64) });
    const retry = f.source();
    await retry.bindParticipants?.(f.context, f.participants);
    await expect(retry.start(f.context, 'record-a', identity, async () => {})).rejects.toThrow(
      'saml_dr_writer_inventory_changed'
    );
    expect(mocks.start).toHaveBeenCalledOnce();
  });
  it.each(['legacy_settings', 'stale_target', 'missing_runtime', 'hold_expired'])(
    'fails closed before DO freeze: %s',
    async (kind) => {
      const f = fixture(),
        source = f.source();
      await source.bindParticipants?.(f.context, f.participants);
      if (kind === 'legacy_settings')
        f.legacy.mockResolvedValue({ state_json: JSON.stringify({ status: 'in_progress' }) });
      if (kind === 'stale_target') {
        const stale = structuredClone(route);
        stale.targets[0].requiredBindingRouteGeneration++;
        mocks.route.mockResolvedValue(stale);
      }
      if (kind === 'missing_runtime')
        mocks.runtime.mockRejectedValue(
          new Error('saml_dr_runtime_settings_authority_unavailable')
        );
      const held = async () => {
        if (kind === 'hold_expired') throw new Error('expired');
      };
      await expect(source.start(f.context, 'record-a', identity, held)).rejects.toThrow();
      expect(mocks.start).not.toHaveBeenCalled();
      expect(f.values.size).toBe(0);
    }
  );
  it.each(['unreleased', 'wrong_boundary_time', 'sql_mismatch', 'identity_mismatch', 'bad_cursor'])(
    'rejects invalid frozen read: %s',
    async (kind) => {
      const f = fixture(),
        source = f.source();
      await source.bindParticipants?.(f.context, f.participants);
      await source.start(f.context, 'record-a', identity, async () => {});
      if (kind === 'unreleased') mocks.boundary.mockResolvedValue(null);
      if (kind === 'wrong_boundary_time') mocks.boundary.mockResolvedValue({ held_at: 99 });
      if (kind === 'sql_mismatch') mocks.checkSql.mockRejectedValue(new Error('mismatch'));
      await expect(
        source.readPage(
          f.context,
          'record-a',
          kind === 'identity_mismatch' ? { ...identity, bundleId: '02'.repeat(16) } : identity,
          'accountAuthStates',
          kind === 'bad_cursor' ? '01' : null,
          128
        )
      ).rejects.toThrow();
    }
  );
  it('refuses changing dispatcher participants and leaves original plan intact on replay', async () => {
    const f = fixture(),
      source = f.source();
    await source.bindParticipants?.(f.context, f.participants);
    await expect(source.bindParticipants?.(f.context, [f.participants[0]])).rejects.toThrow(
      'saml_dr_sql_source_invalid'
    );
    await source.start(f.context, 'record-a', identity, async () => {});
    const saved = [...f.values.entries()];
    await source.start(f.context, 'record-a', identity, async () => {});
    expect([...f.values.entries()]).toEqual(saved);
    expect(mocks.live).toHaveBeenCalledOnce();
  });
});
