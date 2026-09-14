import { beforeAll, describe, expect, it } from 'vitest';
import { encodeTenantBundle, decodeTenantBundle } from '../bundle-codec';
import {
  createTenantBundleKeyEnvelope,
  type TenantBundleKeyEnvelope,
} from '../bundle-key-envelope';
import { decryptTenantBundleStream, encryptTenantBundleStream } from '../bundle-cipher';
import type { TenantBundleManifest, TenantBundleManifestExpectation } from '../bundle-manifest';

async function* source<T>(items: T[]) {
  yield* items;
}
async function collect<T>(items: AsyncIterable<T>) {
  const output: T[] = [];
  for await (const item of items) output.push(item);
  return output;
}
const limits = { maxFrames: 100, maxTotalBytes: 8 * 1024 * 1024 };
let session: TenantBundleKeyEnvelope;
let expected: TenantBundleManifestExpectation;
let manifest: TenantBundleManifest;
let encoded: Uint8Array[];
let plaintext: Uint8Array[];

beforeAll(async () => {
  session = await createTenantBundleKeyEnvelope('only a fixture passphrase for codec');
  expected = {
    bundleId: [...session.envelope.slice(1, 17)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join(''),
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
        id: 'core.clients',
        module: 'applications',
        kind: 'settings',
        store: 'database',
        schemaVersion: 1,
        disposition: 'include',
      },
      {
        id: 'assets.branding',
        module: 'flows-ui',
        kind: 'settings',
        store: 'object',
        schemaVersion: 1,
        disposition: 'include',
      },
    ],
  };
  manifest = {
    formatVersion: 1,
    bundleId: expected.bundleId,
    source: expected.source,
    snapshotId: 'capture-1',
    boundaryUnixMs: 123,
    inventoryDigestSha256: 'af'.repeat(32),
    selection: expected.selection,
    datasets: [...expected.datasets],
  };
  encoded = await collect(
    encodeTenantBundle(
      manifest,
      source([
        {
          datasetId: 'core.clients',
          chunks: source([new TextEncoder().encode('{"id":"client-a"}')]),
        },
        { datasetId: 'assets.branding', chunks: source([]) },
      ]),
      session,
      expected
    )
  );
  plaintext = (await collect(decryptTenantBundleStream(source(encoded), session, limits))).flatMap(
    (event) => (event.kind === 'chunk' ? [event.bytes] : [])
  );
});

describe('streaming dataset bundle codec', () => {
  it('authenticates a manifest and accounts for both populated and empty datasets', async () => {
    const events = await collect(decodeTenantBundle(source(encoded), session, expected, limits));
    expect(events.map((e) => e.kind)).toEqual([
      'manifest',
      'chunk',
      'dataset_end',
      'dataset_end',
      'complete',
    ]);
    expect(events[1]).toEqual({
      kind: 'chunk',
      datasetId: 'core.clients',
      ordinal: 0,
      bytes: new TextEncoder().encode('{"id":"client-a"}'),
    });
    expect(events[3]).toMatchObject({
      kind: 'dataset_end',
      datasetId: 'assets.branding',
      chunks: 0,
      bytes: 0,
    });
  });
  it.each([
    'missing-end',
    'missing-dataset',
    'wrong-dataset',
    'wrong-ordinal',
    'bad-digest',
    'bad-count',
    'data-after-end',
    'second-manifest',
  ])('rejects authenticated but inconsistent content: %s', async (mode) => {
    const changed = plaintext.map((bytes) => bytes.slice());
    if (mode === 'missing-end') changed.splice(2, 1);
    if (mode === 'missing-dataset') changed.pop();
    if (mode === 'wrong-dataset') changed[1][2] = 1;
    if (mode === 'wrong-ordinal') changed[1][6] = 1;
    if (mode === 'bad-digest') changed[2][50] ^= 1;
    if (mode === 'bad-count') changed[2][10] ^= 1;
    if (mode === 'data-after-end') changed.push(changed[1]);
    if (mode === 'second-manifest') changed.splice(1, 0, changed[0]);
    let completed = false;
    async function run() {
      for await (const event of decodeTenantBundle(
        encryptTenantBundleStream(source(changed), session),
        session,
        expected,
        limits
      )) {
        if (event.kind === 'complete') completed = true;
      }
    }
    await expect(run()).rejects.toThrow('invalid_tenant_bundle_content');
    expect(completed).toBe(false);
  });
  it('cannot omit empty datasets during encoding', async () => {
    await expect(
      collect(encodeTenantBundle(manifest, source([]), session, expected))
    ).rejects.toThrow();
  });
  it('detaches the manifest event from parser state', async () => {
    let completed = false;
    for await (const event of decodeTenantBundle(source(encoded), session, expected, limits)) {
      if (event.kind === 'manifest') event.manifest.datasets.length = 0;
      if (event.kind === 'complete') {
        completed = true;
        expect(event.manifest.datasets).toHaveLength(2);
      }
    }
    expect(completed).toBe(true);
  });
  it('binds the manifest bundle ID to the passphrase envelope', async () => {
    const different = { ...expected, bundleId: '00'.repeat(16) };
    await expect(
      collect(decodeTenantBundle(source(encoded), session, different, limits))
    ).rejects.toThrow();
  });
});
