import { describe, expect, it } from 'vitest';
import {
  buildPreservingWorkerSettingsPatch,
  buildVersionPinnedInheritBindings,
  createWorkerSettingsFormData,
  redactControlPlaneEvidence,
  selectCloudflareControlToken,
  tokenKindForCloudflareOperation,
  verifyWorkerSettingsPreserved,
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

describe('version-pinned Worker settings preservation', () => {
  it('inherits every untouched binding from an immutable version and appends desired bindings', () => {
    const desired = [{ name: 'TENANT_DB', type: 'd1', database_id: 'db-id' }];
    const patch = buildPreservingWorkerSettingsPatch({
      currentSettings: existingSettings,
      sourceVersionId: '11111111-1111-4111-8111-111111111111',
      desiredBindings: desired,
    });

    expect(patch.bindings).toEqual([
      ...existingBindings.map((binding) => ({
        name: binding.name,
        type: 'inherit',
        version_id: '11111111-1111-4111-8111-111111111111',
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
      buildPreservingWorkerSettingsPatch({
        currentSettings: existingSettings,
        sourceVersionId: 'version-id',
        desiredBindings: [
          { name: 'DB', type: 'd1' },
          { name: 'DB', type: 'd1' },
        ],
      })
    ).toThrow('worker_settings_binding_duplicate:DB');
    expect(() =>
      buildVersionPinnedInheritBindings({
        currentBindings: [{ name: '', type: 'secret_text' }],
        sourceVersionId: 'v1',
      })
    ).toThrow('worker_settings_binding_0_name_required');
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
        desiredBindings: [{ name: 'TENANT_DB', type: 'd1', database_id: 'db-id' }],
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
    const desired = { name: 'KV', type: 'd1', database_id: 'db-id' };
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
