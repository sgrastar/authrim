import { beforeAll, describe, expect, it } from 'vitest';
import {
  validateTenantBundleInputSet,
  type TenantBundleInspection,
  type TenantBundleInspectorFactory,
  type TenantBundleReferenceIndex,
  type TenantBundleValidationInput,
} from '../bundle-validation';
import { encodeTenantBundle } from '../bundle-codec';
import {
  createTenantBundleKeyEnvelope,
  type TenantBundleKeyEnvelope,
} from '../bundle-key-envelope';
import type { TenantBundleManifestExpectation } from '../bundle-manifest';
import type { TenantPortableDependency, TenantPortableRecordIdentity } from '../reference-contract';

async function* source<T>(items: T[]) {
  yield* items;
}
const identity = (id: string, module = 'applications'): TenantPortableRecordIdentity => ({
  id,
  module,
  collection: module,
  tenantId: 'tenant-a',
});
const client = identity('client');
const user = identity('user', 'users');
const edge: TenantPortableDependency = {
  from: client,
  to: { ...user, meaning: 'user', requirement: 'required' },
};
const recordKey = (record: TenantPortableRecordIdentity) =>
  JSON.stringify([record.tenantId, record.module, record.collection, record.id]);

/** Small test-only index; production must use operation-local persistent scratch storage. */
class Index implements TenantBundleReferenceIndex {
  records = new Map<string, string>();
  edges: { bundleId: string; dependency: TenantPortableDependency }[] = [];
  disposed = false;
  async record(bundleId: string, record: TenantPortableRecordIdentity) {
    const key = recordKey(record);
    if (this.records.has(key)) return false;
    this.records.set(key, bundleId);
    return true;
  }
  async hasRecord(record: TenantPortableRecordIdentity, bundleId?: string) {
    const owner = this.records.get(recordKey(record));
    return owner !== undefined && (!bundleId || owner === bundleId);
  }
  async reference(bundleId: string, dependency: TenantPortableDependency) {
    this.edges.push({ bundleId, dependency });
  }
  async *references() {
    yield* this.edges;
  }
  async dispose() {
    this.disposed = true;
  }
}
let keys: TenantBundleKeyEnvelope[];
beforeAll(async () => {
  keys = await Promise.all(
    [0, 1].map(() => createTenantBundleKeyEnvelope('a fixture only long backup passphrase'))
  );
});
function input(
  kind: 'settings' | 'users',
  inspection: TenantBundleInspection,
  malformed = false
): TenantBundleValidationInput {
  const key = keys[kind === 'settings' ? 0 : 1];
  const expected: TenantBundleManifestExpectation = {
    bundleId: [...key.envelope.slice(1, 17)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join(''),
    source: { tenantId: 'tenant-a', issuer: 'https://issuer.example', productVersion: '0.4.2' },
    selection: {
      settings: kind === 'settings',
      users: kind === 'users',
      admin: false,
      logs: { audit: false, other: false, sensitive: false, period: 'all' },
      artifacts: false,
    },
    datasets: [
      {
        id: kind,
        module: kind === 'settings' ? 'applications' : 'users',
        kind,
        store: 'database',
        schemaVersion: 1,
        disposition: 'include',
      },
    ],
  };
  const payload = new TextEncoder().encode(malformed ? '{invalid' : JSON.stringify(inspection));
  return {
    key,
    expected,
    limits: { maxFrames: 20, maxTotalBytes: 100_000 },
    stream: encodeTenantBundle(
      {
        formatVersion: 1,
        bundleId: expected.bundleId,
        source: expected.source,
        selection: expected.selection,
        snapshotId: 'snapshot',
        boundaryUnixMs: 100,
        inventoryDigestSha256: 'ab'.repeat(32),
        datasets: [...expected.datasets],
      },
      source([{ datasetId: kind, chunks: source([payload]) }]),
      key,
      expected
    ),
  };
}
function factories(state: { disposed: number; finished: number }, failFinish = false) {
  const factory: TenantBundleInspectorFactory = async () => ({
    async chunk(bytes) {
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!Array.isArray(value.records) || !Array.isArray(value.references))
        throw new Error('fixture_schema_invalid');
      return value;
    },
    async finish() {
      state.finished++;
      if (failFinish) throw new Error('fixture_incomplete_record');
    },
    async dispose() {
      state.disposed++;
    },
  });
  return new Map([
    ['settings', factory],
    ['users', factory],
  ]);
}
describe('module and reference validation before a restore plan', () => {
  it('does not expose parser diagnostics containing uploaded secrets', async () => {
    const index = new Index();
    const factory: TenantBundleInspectorFactory = async () => ({
      async chunk() {
        throw new Error('uploaded-private-key-fixture');
      },
      async finish() {},
      async dispose() {},
    });
    await expect(
      validateTenantBundleInputSet(
        [input('settings', { records: [], references: [] })],
        new Map([['settings', factory]]),
        async () => index
      )
    ).rejects.toThrow(/^invalid_tenant_bundle_validation$/);
    expect(index.disposed).toBe(true);
  });
  it('resolves a forward reference across independently selected bundles', async () => {
    const index = new Index();
    const state = { disposed: 0, finished: 0 };
    const result = await validateTenantBundleInputSet(
      [
        input('settings', { records: [client], references: [edge] }),
        input('users', { records: [user], references: [] }),
      ],
      factories(state),
      async () => index
    );
    expect(result.manifests).toHaveLength(2);
    expect(result.unresolvedProvenanceCount).toBe(0);
    expect(state).toEqual({ disposed: 2, finished: 2 });
    expect(index.disposed).toBe(true);
  });
  it.each([
    'missing',
    'duplicate',
    'cross-tenant-record',
    'cross-tenant-reference',
    'unknown-module',
    'orphan-owner',
    'fake-provenance',
  ])('rejects %s and disposes its scratch index', async (mode) => {
    const inspection: TenantBundleInspection = structuredClone({
      records: [client],
      references: [edge],
    });
    if (mode === 'duplicate') inspection.records = [client, client];
    if (mode === 'cross-tenant-record') inspection.records = [{ ...client, tenantId: 'tenant-b' }];
    if (mode === 'cross-tenant-reference')
      inspection.references = [{ ...edge, to: { ...edge.to, tenantId: 'tenant-b' } }];
    if (mode === 'unknown-module') inspection.records = [{ ...client, module: 'unknown' }];
    if (mode === 'orphan-owner')
      inspection.references = [{ ...edge, from: { ...client, id: 'absent' } }];
    if (mode === 'fake-provenance')
      inspection.references = [
        { ...edge, to: { ...edge.to, meaning: 'admin_principal', requirement: 'provenance' } },
      ];
    const index = new Index();
    const state = { disposed: 0, finished: 0 };
    await expect(
      validateTenantBundleInputSet(
        [input('settings', inspection)],
        factories(state),
        async () => index
      )
    ).rejects.toThrow();
    expect(index.disposed).toBe(true);
    expect(state.disposed).toBe(1);
  });
  it('retains historical attribution without creating an executable principal', async () => {
    const index = new Index();
    const result = await validateTenantBundleInputSet(
      [
        input('settings', {
          records: [client],
          references: [
            {
              from: client,
              to: {
                ...identity('old-admin', 'admin'),
                meaning: 'admin_actor',
                requirement: 'provenance',
              },
            },
          ],
        }),
      ],
      factories({ disposed: 0, finished: 0 }),
      async () => index
    );
    expect(result.unresolvedProvenanceCount).toBe(1);
    expect(index.records.size).toBe(1);
  });
  it('requires an installed inspector and successful dataset finalization', async () => {
    for (const missing of [true, false]) {
      const index = new Index();
      const state = { disposed: 0, finished: 0 };
      await expect(
        validateTenantBundleInputSet(
          [input('settings', { records: [], references: [] })],
          missing ? new Map() : factories(state, true),
          async () => index
        )
      ).rejects.toThrow();
      expect(index.disposed).toBe(true);
      expect(state.disposed).toBe(missing ? 0 : 1);
    }
  });
  it('propagates malformed record schema failure without completing validation', async () => {
    const index = new Index();
    const state = { disposed: 0, finished: 0 };
    await expect(
      validateTenantBundleInputSet(
        [input('settings', { records: [], references: [] }, true)],
        factories(state),
        async () => index
      )
    ).rejects.toThrow();
    expect(state).toEqual({ disposed: 1, finished: 0 });
    expect(index.disposed).toBe(true);
  });
});
