import { describe, expect, it } from 'vitest';
import {
  buildRemovingWorkerBindingSettingsPatch,
  buildRemovingWorkerBindingsSettingsPatch,
  buildPreservingWorkerSettingsPatch,
  buildLatestWorkerSettingsInheritBindings,
  buildVersionPinnedInheritBindings,
  createWorkerSettingsFormData,
  digestCloudflareWorkerSettings,
  redactControlPlaneEvidence,
  selectCloudflareControlToken,
  tokenKindForCloudflareOperation,
  verifyWorkerSettingsBindingRemoved,
  verifyWorkerSettingsBindingsRemoved,
  verifyWorkerSettingsPreserved,
  verifyWorkerSettingsRestoreIntent,
  type CloudflareWorkerBinding,
  type CloudflareWorkerSettings,
} from '../cloudflare-worker-settings.js';

const existingBindings: CloudflareWorkerBinding[] = [
  { name: 'SECRET', type: 'secret_text' },
  { name: 'SERVICE', type: 'service', service: 'authrim-service' },
  { name: 'KV', type: 'kv_namespace', namespace_id: 'kv-id' },
  { name: 'R2', type: 'r2_bucket', bucket_name: 'bucket' },
  { name: 'DO', type: 'durable_object_namespace', class_name: 'State' },
  { name: 'DISPATCH', type: 'dispatch_namespace', namespace: 'plugins' },
];

const existingSettings: CloudflareWorkerSettings = {
  annotations: {
    'workers/message': 'before',
    'workers/tag': 'control-plane-test',
    'workers/triggered_by': 'upload',
  },
  bindings: existingBindings,
  cache_options: { enabled: true, cross_version_cache: true },
  compatibility_date: '2026-07-01',
  compatibility_flags: ['nodejs_compat'],
  limits: { cpu_ms: 50 },
  logpush: false,
  observability: { enabled: true, head_sampling_rate: 0.25 },
  placement: { mode: 'smart' },
  tags: ['authrim', 'test'],
  tail_consumers: [{ service: 'tail-worker' }],
  usage_model: 'standard',
};

describe('Cloudflare control-plane operation tokens', () => {
  it('selects a distinct token class for each provider surface', () => {
    const tokens = { d1: 'd1-token', workers: 'worker-token', kv: 'kv-token', r2: 'r2-token' };
    expect(tokenKindForCloudflareOperation('d1.import')).toBe('d1');
    expect(tokenKindForCloudflareOperation('workers.settings.patch')).toBe('workers');
    expect(tokenKindForCloudflareOperation('kv.namespace.list')).toBe('kv');
    expect(tokenKindForCloudflareOperation('r2.bucket.delete')).toBe('r2');
    expect(selectCloudflareControlToken('d1.query', tokens)).toBe('d1-token');
    expect(selectCloudflareControlToken('workers.deployment.create', tokens)).toBe('worker-token');
  });

  it('fails before an optional provider operation can fall back to a stronger token', () => {
    const tokens = { d1: 'd1-token', workers: 'worker-token' };
    expect(() => selectCloudflareControlToken('kv.namespace.create', tokens)).toThrow(
      'cloudflare_kv_token_required_for:kv.namespace.create'
    );
    expect(() => selectCloudflareControlToken('r2.bucket.create', tokens)).toThrow(
      'cloudflare_r2_token_required_for:r2.bucket.create'
    );
  });
});

describe('deployment-fenced Worker settings preservation', () => {
  it('removes exactly one requested binding while inheriting every other binding', () => {
    const before: CloudflareWorkerSettings = {
      bindings: [
        { name: 'KEEP', type: 'plain_text', text: 'value' },
        { name: 'TDB_USERS_A', type: 'd1', id: 'database-a' },
      ],
      compatibility_date: '2026-07-01',
    };
    const patch = buildRemovingWorkerBindingSettingsPatch({
      currentSettings: before,
      sourceVersionId: 'version-1',
      bindingName: 'TDB_USERS_A',
    });

    expect(patch).toEqual({
      bindings: [{ name: 'KEEP', type: 'inherit', version_id: 'latest' }],
      compatibility_date: '2026-07-01',
    });
    expect(
      verifyWorkerSettingsBindingRemoved({
        before,
        after: {
          bindings: [{ name: 'KEEP', type: 'plain_text', text: 'value' }],
          compatibility_date: '2026-07-01',
        },
        bindingName: 'TDB_USERS_A',
      })
    ).toEqual([]);
  });

  it('fails closed when the removal target is absent or the reflected patch loses another binding', () => {
    const before: CloudflareWorkerSettings = {
      bindings: [
        { name: 'KEEP', type: 'plain_text', text: 'value' },
        { name: 'TDB_USERS_A', type: 'd1', id: 'database-a' },
      ],
    };
    expect(() =>
      buildRemovingWorkerBindingSettingsPatch({
        currentSettings: before,
        sourceVersionId: 'version-1',
        bindingName: 'UNKNOWN',
      })
    ).toThrow('worker_settings_binding_to_remove_missing');
    expect(
      verifyWorkerSettingsBindingRemoved({
        before,
        after: { bindings: [] },
        bindingName: 'TDB_USERS_A',
      })
    ).toContainEqual({ field: 'bindings.KEEP', reason: 'missing' });
  });

  it('removes an exact bounded binding set in one settings patch', () => {
    const before: CloudflareWorkerSettings = {
      bindings: [
        { name: 'KEEP', type: 'plain_text', text: 'value' },
        { name: 'PLUGIN_D1', type: 'd1', database_id: 'database-a' },
        { name: 'PLUGIN_KV', type: 'kv_namespace', namespace_id: 'namespace-a' },
      ],
      compatibility_date: '2026-08-01',
    };
    expect(
      buildRemovingWorkerBindingsSettingsPatch({
        currentSettings: before,
        sourceVersionId: 'version-1',
        bindingNames: ['PLUGIN_D1', 'PLUGIN_KV'],
      })
    ).toEqual({
      bindings: [{ name: 'KEEP', type: 'inherit', version_id: 'latest' }],
      compatibility_date: '2026-08-01',
    });
    expect(
      verifyWorkerSettingsBindingsRemoved({
        before,
        after: {
          bindings: [{ name: 'KEEP', type: 'plain_text', text: 'value' }],
          compatibility_date: '2026-08-01',
        },
        bindingNames: ['PLUGIN_D1', 'PLUGIN_KV'],
      })
    ).toEqual([]);
    expect(() =>
      buildRemovingWorkerBindingsSettingsPatch({
        currentSettings: before,
        sourceVersionId: 'version-1',
        bindingNames: ['PLUGIN_D1', 'PLUGIN_D1'],
      })
    ).toThrow('worker_settings_bindings_to_remove_invalid');
  });

  it('inherits every untouched binding from an immutable version and appends desired bindings', () => {
    const desired = [{ name: 'TENANT_DB', type: 'd1', id: 'db-id' }];
    const patch = buildPreservingWorkerSettingsPatch({
      currentSettings: existingSettings,
      sourceVersionId: '11111111-1111-4111-8111-111111111111',
      desiredBindings: desired,
    });

    expect(patch.bindings).toEqual([
      ...existingBindings.map((binding) => ({
        name: binding.name,
        type: 'inherit',
        version_id: 'latest',
      })),
      desired[0],
    ]);
    expect(patch.placement).toEqual(existingSettings.placement);
    expect(patch.observability).toEqual(existingSettings.observability);
    expect(patch.tail_consumers).toEqual(existingSettings.tail_consumers);
    expect(patch.annotations).toEqual({
      'workers/message': 'before',
      'workers/tag': 'control-plane-test',
    });
  });

  it('omits provider empty objects and read-only-only annotations from settings patches', () => {
    const patch = buildPreservingWorkerSettingsPatch({
      currentSettings: {
        annotations: { 'workers/triggered_by': 'upload' },
        bindings: existingBindings,
        compatibility_date: '2026-07-01',
        placement: {},
      },
      sourceVersionId: '11111111-1111-4111-8111-111111111111',
      desiredBindings: [{ name: 'TENANT_DB', type: 'd1', database_id: 'db-id' }],
    });

    expect(patch).not.toHaveProperty('annotations');
    expect(patch).not.toHaveProperty('placement');
    expect(patch.compatibility_date).toBe('2026-07-01');
  });

  it('replaces an explicitly desired binding without also inheriting the old value', () => {
    const patch = buildPreservingWorkerSettingsPatch({
      currentSettings: existingSettings,
      sourceVersionId: '11111111-1111-4111-8111-111111111111',
      desiredBindings: [{ name: 'KV', type: 'kv_namespace', namespace_id: 'new-kv-id' }],
    });
    expect(patch.bindings?.filter((binding) => binding.name === 'KV')).toEqual([
      { name: 'KV', type: 'kv_namespace', namespace_id: 'new-kv-id' },
    ]);
  });

  it('rejects mutable latest inheritance, duplicate bindings, and malformed API data', () => {
    expect(() =>
      buildVersionPinnedInheritBindings({
        currentBindings: existingBindings,
        sourceVersionId: 'latest',
      })
    ).toThrow('source_version_id_must_be_immutable');
    expect(() =>
      buildLatestWorkerSettingsInheritBindings({
        currentBindings: existingBindings,
        expectedSourceVersionId: 'latest',
      })
    ).toThrow('expected_source_version_id_must_be_immutable');
    expect(() =>
      buildPreservingWorkerSettingsPatch({
        currentSettings: existingSettings,
        sourceVersionId: 'version-id',
        desiredBindings: [
          { name: 'DB', type: 'd1', id: 'db-1' },
          { name: 'DB', type: 'd1', id: 'db-2' },
        ],
      })
    ).toThrow('worker_settings_binding_duplicate:DB');
    expect(() =>
      buildPreservingWorkerSettingsPatch({
        currentSettings: existingSettings,
        sourceVersionId: 'version-id',
        desiredBindings: [{ name: 'DB', type: 'd1' }],
      })
    ).toThrow('worker_settings_binding_0_d1_database_id_required');
    expect(() =>
      buildVersionPinnedInheritBindings({
        currentBindings: [{ name: '', type: 'secret_text' }],
        sourceVersionId: 'v1',
      })
    ).toThrow('worker_settings_binding_0_name_required');
  });

  it('accepts canonical D1 database_id and legacy id settings shapes', () => {
    for (const binding of [
      { name: 'DB', type: 'd1', database_id: 'database-1' },
      { name: 'DB', type: 'd1', id: 'legacy-database-1' },
    ]) {
      expect(() =>
        buildVersionPinnedInheritBindings({
          currentBindings: [binding],
          sourceVersionId: 'version-1',
        })
      ).not.toThrow();
    }
  });

  it('verifies response-loss recovery against inherit intent without requiring concrete ids', () => {
    const restoreSettings = buildPreservingWorkerSettingsPatch({
      currentSettings: existingSettings,
      sourceVersionId: 'version-1',
      desiredBindings: [],
    });
    expect(
      verifyWorkerSettingsRestoreIntent({
        restoreSettings,
        after: {
          ...existingSettings,
          bindings: [
            ...existingBindings,
            { name: 'TDB_CORE_001', type: 'd1', database_id: 'tenant-db' },
          ],
        },
        desiredBindings: [{ name: 'TDB_CORE_001', type: 'd1', database_id: 'tenant-db' }],
      })
    ).toEqual([]);
    expect(
      verifyWorkerSettingsRestoreIntent({
        restoreSettings,
        after: {
          ...existingSettings,
          bindings: [{ name: 'TDB_CORE_001', type: 'd1', database_id: 'other-db' }],
        },
        desiredBindings: [{ name: 'TDB_CORE_001', type: 'd1', database_id: 'tenant-db' }],
      })
    ).toEqual(
      expect.arrayContaining([
        { field: 'bindings.SECRET', reason: 'missing' },
        { field: 'bindings.TDB_CORE_001.database_id', reason: 'changed' },
      ])
    );
  });

  it('uses the required multipart settings field without overriding the boundary header', () => {
    const form = createWorkerSettingsFormData({ bindings: [] });
    expect(Array.from(form.keys())).toEqual(['settings']);
    expect(JSON.parse(String(form.get('settings')))).toEqual({ bindings: [] });
  });

  it('rejects oversized settings before allocating a multipart request', () => {
    expect(() =>
      createWorkerSettingsFormData({ annotations: { 'workers/message': 'x'.repeat(1024 * 1024) } })
    ).toThrow('worker_settings_payload_too_large');
  });

  it('reports dropped, changed, and unexpected settings after a patch', () => {
    const after: CloudflareWorkerSettings = {
      ...existingSettings,
      bindings: [
        ...existingBindings.filter((binding) => binding.name !== 'SECRET'),
        { name: 'TENANT_DB', type: 'kv_namespace' },
        { name: 'UNEXPECTED', type: 'plain_text' },
      ],
      observability: { enabled: false },
      tail_consumers: undefined,
    };
    expect(
      verifyWorkerSettingsPreserved({
        before: existingSettings,
        after,
        desiredBindings: [{ name: 'TENANT_DB', type: 'd1', id: 'db-id' }],
      })
    ).toEqual(
      expect.arrayContaining([
        { field: 'bindings.SECRET', reason: 'missing' },
        { field: 'bindings.TENANT_DB.type', reason: 'changed' },
        { field: 'bindings.UNEXPECTED', reason: 'unexpected' },
        { field: 'observability', reason: 'changed' },
        { field: 'tail_consumers', reason: 'missing' },
      ])
    );
  });

  it('detects a preserved binding whose provider target changed without a type change', () => {
    const after: CloudflareWorkerSettings = {
      ...existingSettings,
      bindings: existingBindings.map((binding) =>
        binding.name === 'SERVICE' ? { ...binding, service: 'other-service' } : binding
      ),
    };
    expect(
      verifyWorkerSettingsPreserved({ before: existingSettings, after, desiredBindings: [] })
    ).toContainEqual({ field: 'bindings.SERVICE.service', reason: 'changed' });
  });

  it('does not compare an intentionally replaced binding against its previous shape', () => {
    const desired = { name: 'KV', type: 'd1', id: 'db-id' };
    const after: CloudflareWorkerSettings = {
      ...existingSettings,
      bindings: existingBindings.filter((binding) => binding.name !== 'KV').concat(desired),
    };
    expect(
      verifyWorkerSettingsPreserved({ before: existingSettings, after, desiredBindings: [desired] })
    ).toEqual([]);
  });
});

describe('control-plane evidence redaction', () => {
  it('redacts nested credential fields without deleting operational evidence', () => {
    expect(
      redactControlPlaneEvidence({
        operation: 'workers.settings.patch',
        authorization: 'Bearer secret',
        request: { api_token: 'secret', accessToken: 'secret', database_id: 'db-id' },
        rows: [{ privateKey: 'secret', status: 'ok' }],
      })
    ).toEqual({
      operation: 'workers.settings.patch',
      authorization: '<redacted>',
      request: { api_token: '<redacted>', accessToken: '<redacted>', database_id: 'db-id' },
      rows: [{ privateKey: '<redacted>', status: 'ok' }],
    });
  });
});

describe('bootstrap Worker settings digest', () => {
  it('is stable across key order and provider-trigger annotations', async () => {
    const first = await digestCloudflareWorkerSettings(existingSettings);
    const second = await digestCloudflareWorkerSettings({
      usage_model: existingSettings.usage_model,
      bindings: existingSettings.bindings,
      annotations: {
        'workers/triggered_by': 'api',
        'workers/tag': 'control-plane-test',
        'workers/message': 'before',
      },
      compatibility_date: existingSettings.compatibility_date,
      compatibility_flags: existingSettings.compatibility_flags,
      cache_options: existingSettings.cache_options,
      limits: existingSettings.limits,
      logpush: existingSettings.logpush,
      observability: existingSettings.observability,
      placement: existingSettings.placement,
      tags: existingSettings.tags,
      tail_consumers: existingSettings.tail_consumers,
    });
    expect(second).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('changes for binding targets and preserved settings', async () => {
    const baseline = await digestCloudflareWorkerSettings(existingSettings);
    await expect(
      digestCloudflareWorkerSettings({
        ...existingSettings,
        bindings: existingBindings.map((binding) =>
          binding.name === 'KV' ? { ...binding, namespace_id: 'other-kv' } : binding
        ),
      })
    ).resolves.not.toBe(baseline);
    await expect(
      digestCloudflareWorkerSettings({ ...existingSettings, placement: { mode: 'off' } })
    ).resolves.not.toBe(baseline);
  });
});
