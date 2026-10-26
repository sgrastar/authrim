import { describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import type { SamlDrFrozenSourceCapture } from '@authrim/ar-lib-core/services/tenant-portability/saml-dr-snapshot';
import { tenantBackupBoundaryId } from '@authrim/ar-lib-core/services/tenant-portability/snapshot-boundary-step';
import type {
  AdapterContext,
  TenantBackupInstalledExportAdapter,
} from '../tenant-backup-export-dispatcher';
import { tenantBackupRecordSnapshotId } from '../tenant-backup-phase5-adapter';
import {
  createTenantBackupSamlDrSupplementPort,
  withSamlDrSupplementExport,
  type SamlDrSnapshotSources,
  type SamlDrSourceCollections,
} from '../tenant-backup-saml-dr-supplement';

vi.mock('../tenant-backup-execution', () => ({
  loadTenantBackupExportExecution: vi.fn(async () => ({
    key: { envelope: new Uint8Array(17).fill(1) },
    intent: {
      source: { tenantId: 'tenant-a', issuer: 'https://idp.example.test', productVersion: '0.4.2' },
    },
  })),
}));

function bucket() {
  const values = new Map<string, string>();
  return {
    values,
    async put(key: string, value: string) {
      values.set(key, value);
      return {};
    },
    async get(key: string) {
      const value = values.get(key);
      return value === undefined ? null : { text: async () => value };
    },
    async list(input: { prefix: string; limit: number }) {
      const keys = [...values.keys()].filter((key) => key.startsWith(input.prefix)).sort();
      return {
        objects: keys.slice(0, input.limit).map((key) => ({ key })),
        truncated: keys.length > input.limit,
      };
    },
    async delete(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key);
    },
  };
}

async function fixture() {
  const storage = bucket();
  const controller = new AbortController();
  const selection = {
    settings: true,
    users: true,
    admin: false,
    artifacts: false,
    logs: { audit: false, other: false, sensitive: false, period: 'all' as const },
  };
  const context = {
    boundaryUnixMs: 100,
    selection,
    inventory: {
      headForLease: async () => ({ state: 'sealed', chain_digest: 'a'.repeat(64) }),
    },
    context: {
      lease: { tenantId: 'tenant-a', operationId: 'operation-a' },
      operation: { kind: 'export', state: 'running', phase: 'export_artifact' },
      signal: controller.signal,
    },
  } as unknown as AdapterContext;
  const identity: SamlDrFrozenSourceCapture['source'] = {
    bundleId: '01'.repeat(16),
    snapshotId: await tenantBackupBoundaryId({
      environmentId: 'test',
      tenantId: 'tenant-a',
      operationId: 'operation-a',
      inventoryDigest: 'a'.repeat(64),
    }),
    boundaryUnixMs: 100,
    inventoryDigestSha256: 'a'.repeat(64),
    source: { tenantId: 'tenant-a', issuer: 'https://idp.example.test', productVersion: '0.4.2' },
  };
  const live: {
    [Collection in keyof SamlDrSourceCollections]: SamlDrSourceCollections[Collection][];
  } = {
    loginUiClients: [{ tenant_id: ['text', 'tenant-a'], client_id: ['text', 'login-ui'] }],
    loginUiOrigins: [
      {
        tenant_id: ['text', 'tenant-a'],
        client_id: ['text', 'login-ui'],
        origin: ['text', 'https://idp.example.test'],
      },
    ],
    platformDestinationProfiles: [],
    platformDestinationProfileVersions: [],
    accountAuthStates: [
      {
        tenantId: 'tenant-a',
        userId: 'user-a',
        accountId: 'account:user-a',
        lifecycle: 'active',
        lifecycleVersionMs: 80,
        lifecycleOperationId: null,
        revokedAfterMs: null,
        lastLoginAtMs: 90,
      },
    ],
    passkeyCounters: [
      {
        tenantId: 'tenant-a',
        userId: 'user-a',
        passkeyId: 'passkey-a',
        credentialId: 'public-credential-a',
        counter: '7',
        updatedAtMs: 90,
      },
    ],
    persistentNameIds: [],
    accountRoutes: [
      {
        accountId: 'account:user-a',
        route: {
          schemaVersion: 1,
          accountRouteGeneration: 1,
          residencyPolicyId: 'default',
          targets: [
            {
              dataRole: 'tenant_core/users',
              residencyPartition: 'default',
              shardId: 'core-a',
              bindingRef: 'TEST_CORE',
              requiredBindingRouteGeneration: 1,
            },
            {
              dataRole: 'tenant_pii',
              residencyPartition: 'default',
              shardId: 'pii-a',
              bindingRef: 'TEST_PII',
              requiredBindingRouteGeneration: 1,
            },
          ],
        },
      },
    ],
    platformSettings: [],
    runtimeSettings: [
      { sourceFlowRuntimeEnabled: true, consentIpSalt: 'synthetic-existing-consent-salt-32-bytes' },
    ],
  };
  let frozen: typeof live | undefined;
  let released = false;
  let coverage = true;
  const sources: SamlDrSnapshotSources = {
    bindParticipants: vi.fn(async () => {}),
    assertReady: vi.fn(async () => {
      if (!coverage) throw new Error('writer_coverage_unverified');
    }),
    prepare: vi.fn(async () => {}),
    start: vi.fn(
      async (
        _context: AdapterContext,
        _snapshotId: string,
        source: SamlDrFrozenSourceCapture['source'],
        assertHeld: () => Promise<void>
      ) => {
        await assertHeld();
        expect(source).toEqual(identity);
        frozen ??= structuredClone(live);
      }
    ),
    assertFrozen: vi.fn(async (_context, _snapshotId, source) => {
      if (!frozen || JSON.stringify(source) !== JSON.stringify(identity))
        throw new Error('source_snapshot_missing');
    }),
    assertBoundaryReleased: vi.fn(async () => {
      if (!released) throw new Error('source_boundary_not_released');
    }),
    async readPage(_context, _snapshotId, _identity, collection, cursor, limit) {
      if (!frozen) throw new Error('source_snapshot_missing');
      const offset = cursor === null ? 0 : Number(cursor);
      const items = frozen[collection].slice(offset, offset + limit);
      return {
        source: structuredClone(identity),
        items,
        nextCursor: offset + limit < frozen[collection].length ? String(offset + limit) : null,
      };
    },
    release: vi.fn(async () => {
      frozen = undefined;
    }),
    assertReleased: vi.fn(async () => {
      if (frozen) throw new Error('source_snapshot_not_released');
    }),
  };
  const env = {
    ENABLE_SAML_DR_EXPORT: 'true',
    AUTHRIM_ENVIRONMENT_NAME: 'test',
    EXPORT_ARTIFACTS: storage,
    OBJECT_ENCRYPTION_ROOT_KEY: '11'.repeat(32),
    OBJECT_ENCRYPTION_KEY_VERSION: '1',
  } as unknown as Env & { ENABLE_SAML_DR_EXPORT: string };
  const port = createTenantBackupSamlDrSupplementPort({ env, sources, now: () => 200 });
  const snapshotId = await tenantBackupRecordSnapshotId(context, port.resourceId);
  const held = vi.fn(async () => {});
  return {
    storage,
    controller,
    context,
    identity,
    live,
    sources,
    env,
    port,
    snapshotId,
    held,
    releaseBoundary: () => {
      released = true;
    },
    removeCoverage: () => {
      coverage = false;
    },
    async start() {
      await port.prepare(context);
      await port.start(context, snapshotId, held, 100);
    },
    read: () => port.readNext(context, snapshotId, null, controller.signal),
  };
}

describe('SAML DR supplemental snapshot export', () => {
  it('materializes only frozen state after release, encrypts staging, and cleans both sources', async () => {
    const f = await fixture();
    await f.start();
    expect(f.storage.values.size).toBe(0);
    f.live.passkeyCounters[0].counter = '8';
    f.live.runtimeSettings[0].consentIpSalt = 'a-different-salt-after-the-held-boundary';
    f.releaseBoundary();
    const row = await f.read();
    const decoded = JSON.parse(new TextDecoder().decode(row?.bytes)) as {
      tenant_id: ['text', string];
      capture_json: ['text', string];
    };
    const capture = JSON.parse(decoded.capture_json[1]) as SamlDrFrozenSourceCapture;
    expect(decoded.tenant_id).toEqual(['text', 'tenant-a']);
    expect(capture.source).toEqual(f.identity);
    expect(capture.payload.state.passkeyCounters[0].counter).toBe('7');
    expect(capture.payload.consentIpSalt).toBe('synthetic-existing-consent-salt-32-bytes');
    expect(Object.values(capture.completeness).every((value) => value === true)).toBe(true);
    expect([...f.storage.values.values()].join('')).not.toContain(capture.payload.consentIpSalt);
    expect(f.storage.values.size).toBe(2);
    await expect(
      f.port.readNext(f.context, f.snapshotId, row?.nextCursor ?? null, f.controller.signal)
    ).resolves.toBeNull();
    await f.port.release(f.context, f.snapshotId);
    await expect(f.port.assertReleased(f.context, f.snapshotId)).resolves.toBeUndefined();
    expect(f.storage.values.size).toBe(0);
    expect(f.sources.release).toHaveBeenCalledOnce();
  });

  it('requires a released boundary before reading or staging the source', async () => {
    const f = await fixture();
    await f.start();
    await expect(f.read()).rejects.toThrow('source_boundary_not_released');
    expect(f.storage.values.size).toBe(0);
  });

  it.each(['disabled', 'users_excluded', 'unverified_writers'])(
    'refuses source capture when %s',
    async (condition) => {
      const f = await fixture();
      if (condition === 'disabled') f.env.ENABLE_SAML_DR_EXPORT = 'false';
      if (condition === 'users_excluded') f.context.selection.users = false;
      if (condition === 'unverified_writers') f.removeCoverage();
      await expect(f.start()).rejects.toThrow();
      expect(f.sources.start).not.toHaveBeenCalled();
      expect(f.storage.values.size).toBe(0);
    }
  );

  it('does not replace an unavailable legacy NameID authority with an empty inventory', async () => {
    const f = await fixture();
    const original = f.sources.readPage;
    f.sources.readPage = async (...args) => {
      if (args[3] === 'persistentNameIds') throw new Error('nameid_authority_unavailable');
      return original(...args);
    };
    await f.start();
    f.releaseBoundary();
    await expect(f.read()).rejects.toThrow('nameid_authority_unavailable');
    expect(f.storage.values.size).toBe(0);
  });

  it('rejects a page from another bundle even when the rows match', async () => {
    const f = await fixture();
    const original = f.sources.readPage;
    f.sources.readPage = async (...args) => {
      const page = await original(...args);
      return { ...page, source: { ...page.source, bundleId: '02'.repeat(16) } };
    };
    await f.start();
    f.releaseBoundary();
    await expect(f.read()).rejects.toThrow('saml_dr_source_capture_invalid');
    expect(f.storage.values.size).toBe(0);
  });

  it('rejects a repeating source cursor instead of asserting complete inventory', async () => {
    const f = await fixture();
    const original = f.sources.readPage;
    f.sources.readPage = async (...args) => {
      const page = await original(args[0], args[1], args[2], args[3], null, args[5]);
      return { ...page, nextCursor: 'repeated' };
    };
    await f.start();
    f.releaseBoundary();
    await expect(f.read()).rejects.toThrow('saml_dr_source_capture_invalid');
  });

  it.each(['cross_tenant', 'duplicate_passkey', 'missing_salt', 'missing_login_client'])(
    'rejects incomplete or inconsistent %s data without synthesizing replacements',
    async (condition) => {
      const f = await fixture();
      if (condition === 'cross_tenant') f.live.accountAuthStates[0].tenantId = 'tenant-b';
      if (condition === 'duplicate_passkey')
        f.live.passkeyCounters.push(structuredClone(f.live.passkeyCounters[0]));
      if (condition === 'missing_salt') f.live.runtimeSettings[0].consentIpSalt = '';
      if (condition === 'missing_login_client') f.live.loginUiClients = [];
      await f.start();
      f.releaseBoundary();
      await expect(f.read()).rejects.toThrow('saml_dr_source_capture_invalid');
      expect(f.storage.values.size).toBe(0);
    }
  );

  it('rejects a different record snapshot ID before invoking source snapshots', async () => {
    const f = await fixture();
    await expect(f.port.start(f.context, 'another-snapshot', f.held, 100)).rejects.toThrow(
      'saml_dr_source_capture_invalid'
    );
    expect(f.sources.start).not.toHaveBeenCalled();
  });

  it('does not stage output after cancellation or an oversized source page', async () => {
    const cancelled = await fixture();
    await cancelled.start();
    cancelled.releaseBoundary();
    cancelled.controller.abort();
    await expect(cancelled.read()).rejects.toThrow();
    expect(cancelled.storage.values.size).toBe(0);

    const oversized = await fixture();
    const original = oversized.sources.readPage;
    oversized.sources.readPage = async (...args) => {
      const page = await original(...args);
      return { ...page, items: Array.from({ length: 129 }, () => page.items[0]) };
    };
    await oversized.start();
    oversized.releaseBoundary();
    await expect(oversized.read()).rejects.toThrow('saml_dr_source_capture_invalid');
    expect(oversized.storage.values.size).toBe(0);
  });

  it('preserves base preparation and streaming, then waits for source cleanup before publication', async () => {
    const f = await fixture();
    const baseRow = { bytes: new TextEncoder().encode('base-row'), nextCursor: 'next-base-row' };
    const assertSources = vi.fn(async () => {});
    const assertBoundaryReady = vi.fn(async () => {});
    const assertPublishable = vi.fn(async () => {});
    const prepareSources = vi
      .fn(async () => ({ cursor: null as string | null, done: true }))
      .mockResolvedValueOnce({ cursor: 'continue-base-preparation', done: false });
    const releaseAdditionalResources = vi
      .fn(async () => ({ done: true }))
      .mockResolvedValueOnce({ done: false });
    const base = {
      datasets: () => [],
      prepareSources,
      assertSources,
      assertBoundaryReady,
      additionalParticipants: async () => [],
      readNext: async () => baseRow,
      releaseAdditionalResources,
      assertPublishable,
    } as unknown as TenantBackupInstalledExportAdapter;
    const wrapped = withSamlDrSupplementExport(base, f.port);
    await expect(wrapped.prepareSources({ ...f.context, cursor: null })).resolves.toEqual({
      cursor: 'continue-base-preparation',
      done: false,
    });
    expect(f.sources.prepare).not.toHaveBeenCalled();
    await wrapped.prepareSources({ ...f.context, cursor: 'continue-base-preparation' });
    expect(f.sources.prepare).toHaveBeenCalledOnce();
    await wrapped.assertSources(f.context);
    await wrapped.assertBoundaryReady(f.context);
    expect(assertSources).toHaveBeenCalledOnce();
    expect(assertBoundaryReady).toHaveBeenCalledOnce();
    const participants = await wrapped.additionalParticipants(f.context);
    await participants[0].start(f.held, 100);
    f.releaseBoundary();
    await expect(
      wrapped.readNext({
        ...f.context,
        datasetId: 'core.users_core',
        cursor: null,
        signal: f.controller.signal,
      })
    ).resolves.toBe(baseRow);
    const result = await wrapped.readNext({
      ...f.context,
      datasetId: 'federation.saml_runtime_state',
      cursor: null,
      signal: f.controller.signal,
    });
    expect(result?.bytes.length).toBeGreaterThan(0);
    const visit = vi.fn();
    await f.port.readSummaries(f.context, f.snapshotId, 100, visit);
    expect(visit).not.toHaveBeenCalled();
    await expect(
      wrapped.assertPublishable({ ...f.context, inventoryDigest: 'a'.repeat(64) })
    ).rejects.toThrow('backup_record_snapshot_invalid');
    await expect(wrapped.releaseAdditionalResources(f.context)).resolves.toEqual({ done: false });
    expect(f.sources.release).not.toHaveBeenCalled();
    await expect(wrapped.releaseAdditionalResources(f.context)).resolves.toEqual({ done: true });
    await expect(
      wrapped.assertPublishable({ ...f.context, inventoryDigest: 'a'.repeat(64) })
    ).resolves.toBeUndefined();
    expect(f.sources.release).toHaveBeenCalledOnce();
    expect(f.storage.values.size).toBe(0);
  });

  it('keeps the default adapter unchanged and requires exactly one opt-in participant', async () => {
    const f = await fixture();
    const assertCoverage = vi.fn(async () => {});
    const base = {
      datasets: vi.fn(() => []),
      prepareSources: vi.fn(async () => ({ cursor: null, done: true })),
      additionalParticipants: vi.fn(async () => [{ resourceId: 'base', snapshotId: 'base' }]),
      assertCoverage,
    } as unknown as TenantBackupInstalledExportAdapter;
    expect(withSamlDrSupplementExport(base, undefined)).toBe(base);
    const wrapped = withSamlDrSupplementExport(base, f.port);
    expect(wrapped.datasets(f.context.selection)).toEqual([
      expect.objectContaining({ id: 'federation.saml_runtime_state' }),
    ]);
    const participants = await wrapped.additionalParticipants(f.context);
    expect(participants).toHaveLength(2);
    await wrapped.assertCoverage({ ...f.context, sqliteResources: [], participants });
    expect(f.sources.bindParticipants).toHaveBeenCalledWith(
      expect.objectContaining({ participants }),
      participants
    );
    expect(assertCoverage).toHaveBeenCalledWith(
      expect.objectContaining({ participants: [{ resourceId: 'base', snapshotId: 'base' }] })
    );
    await expect(
      wrapped.assertCoverage({ ...f.context, sqliteResources: [], participants: [] })
    ).rejects.toThrow('saml_dr_source_capture_invalid');
    await expect(
      wrapped.assertCoverage({
        ...f.context,
        sqliteResources: [],
        participants: [...participants, participants[1]],
      })
    ).rejects.toThrow('saml_dr_source_capture_invalid');
    expect(f.sources.bindParticipants).toHaveBeenCalledOnce();
  });
});
