import { describe, expect, it } from 'vitest';
import {
  decodeTenantBundleManifest,
  encodeTenantBundleManifest,
  TENANT_BUNDLE_MANIFEST_MAX_BYTES,
  type TenantBundleManifest,
  type TenantBundleManifestExpectation,
} from '../bundle-manifest';

const expected: TenantBundleManifestExpectation = {
  bundleId: 'ab'.repeat(16),
  source: { tenantId: 'tenant-a', issuer: 'https://issuer.example', productVersion: '0.4.2' },
  selection: {
    settings: true,
    users: false,
    admin: false,
    logs: { audit: false, other: false, sensitive: false, period: 'all' },
    artifacts: false,
  },
  datasets: [
    {
      id: 'core.oauth_clients',
      module: 'applications',
      kind: 'settings',
      store: 'database',
      schemaVersion: 1,
      disposition: 'include',
    },
    {
      id: 'core.roles',
      module: 'authorization',
      kind: 'settings',
      store: 'database',
      schemaVersion: 1,
      disposition: 'include',
    },
  ],
};
function fixture(): TenantBundleManifest {
  return structuredClone({
    formatVersion: 1,
    bundleId: expected.bundleId,
    source: expected.source,
    snapshotId: 'snapshot-1',
    boundaryUnixMs: 123,
    inventoryDigestSha256: '12'.repeat(32),
    selection: expected.selection,
    datasets: [...expected.datasets],
  });
}
function bytes(input: unknown) {
  return new TextEncoder().encode(JSON.stringify(input));
}

describe('authenticated bundle manifest semantics', () => {
  it('roundtrips a fixed source, selection, snapshot and installed dataset contract', () => {
    const manifest = fixture();
    const decoded = decodeTenantBundleManifest(
      encodeTenantBundleManifest(manifest, expected),
      expected
    );
    expect(decoded).toEqual(manifest);
    manifest.datasets[0].id = 'changed';
    expect(decoded.datasets[0].id).toBe('core.oauth_clients');
  });
  it.each([
    'version',
    'bundle',
    'tenant',
    'issuer',
    'product',
    'selection',
    'module',
    'store',
    'schema',
    'kind',
    'disposition',
    'missing',
    'duplicate',
    'unexpected',
    'path',
    'extra',
    'clock',
    'digest',
  ])('rejects %s drift before invoking an adapter', (scenario) => {
    const value = fixture();
    if (scenario === 'version') Object.assign(value, { formatVersion: 2 });
    if (scenario === 'bundle') value.bundleId = 'cd'.repeat(16);
    if (scenario === 'tenant') value.source.tenantId = 'tenant-b';
    if (scenario === 'issuer') value.source.issuer += '/';
    if (scenario === 'product') value.source.productVersion = '0.4.3';
    if (scenario === 'selection') value.selection.users = true;
    if (scenario === 'module') Object.assign(value.datasets[0], { module: 'unknown' });
    if (scenario === 'store') value.datasets[0].store = 'kv';
    if (scenario === 'schema') value.datasets[0].schemaVersion = 2;
    if (scenario === 'kind') value.datasets[0].kind = 'users';
    if (scenario === 'disposition') value.datasets[0].disposition = 'rebuild';
    if (scenario === 'missing') value.datasets.pop();
    if (scenario === 'duplicate') value.datasets[1] = value.datasets[0];
    if (scenario === 'unexpected') value.datasets[0].id = 'core.unreviewed';
    if (scenario === 'path') value.snapshotId = '../escape';
    if (scenario === 'extra') Object.assign(value, { sql: 'DROP TABLE users' });
    if (scenario === 'clock') value.boundaryUnixMs = -1;
    if (scenario === 'digest') value.inventoryDigestSha256 = 'not-a-digest';
    expect(() => decodeTenantBundleManifest(bytes(value), expected)).toThrow(
      'invalid_tenant_bundle_manifest'
    );
  });
  it('rejects duplicate JSON keys, invalid Unicode, BOM and oversized input', () => {
    const valid = new TextDecoder().decode(encodeTenantBundleManifest(fixture(), expected));
    for (const malformed of [
      valid.replace('"formatVersion":1', '"formatVersion":2,"formatVersion":1'),
      ' ' + valid,
      '\ufeff' + valid,
    ]) {
      expect(() =>
        decodeTenantBundleManifest(new TextEncoder().encode(malformed), expected)
      ).toThrow();
    }
    expect(() => decodeTenantBundleManifest(new Uint8Array([0xff]), expected)).toThrow();
    expect(() =>
      decodeTenantBundleManifest(new Uint8Array(TENANT_BUNDLE_MANIFEST_MAX_BYTES + 1), expected)
    ).toThrow();
  });
  it('requires explicit installed support even if input and expectations both name an unknown module', () => {
    const value = fixture();
    Object.assign(value.datasets[0], { module: 'external-executable' });
    expect(() =>
      decodeTenantBundleManifest(bytes(value), { ...expected, datasets: value.datasets })
    ).toThrow();
  });
  it('does not let a matching dataset descriptor override selection or unsupported disposition', () => {
    for (const change of [
      { kind: 'users' },
      { disposition: 'unsupported' },
      { kind: 'ephemeral' },
    ]) {
      const value = fixture();
      Object.assign(value.datasets[0], change);
      expect(() =>
        decodeTenantBundleManifest(bytes(value), { ...expected, datasets: value.datasets })
      ).toThrow();
    }
  });
});
