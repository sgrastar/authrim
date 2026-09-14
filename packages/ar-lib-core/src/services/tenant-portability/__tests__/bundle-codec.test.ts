import {
  decodeTenantBackupInputStep,
  type TenantBackupInputDecodeCheckpoint,
} from '../input-decode-step';
import { TenantBundleContentDecoder } from '../bundle-content-decoder';
import {
  TenantBundleContentEncoder,
  type TenantBundleEncoderCommand,
} from '../bundle-encoder-state';
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

describe('durable content encoder checkpoints', () => {
  it('reconstructs the encoder after every frame and preserves the existing decoder contract', async () => {
    const commands: TenantBundleEncoderCommand[] = [
      { kind: 'manifest' },
      { kind: 'chunk', datasetId: 'core.clients', bytes: new TextEncoder().encode('first') },
      { kind: 'chunk', datasetId: 'core.clients', bytes: new TextEncoder().encode('second') },
      { kind: 'end', datasetId: 'core.clients' },
      { kind: 'end', datasetId: 'assets.branding' },
    ];
    let encoder = await TenantBundleContentEncoder.create(manifest, expected);
    const frames: Uint8Array[] = [];
    for (const command of commands) {
      const before = encoder.checkpoint();
      const frame = await encoder.step(command);
      const retry = await TenantBundleContentEncoder.create(manifest, expected, before);
      expect(await retry.step(command)).toEqual(frame);
      frames.push(frame);
      encoder = await TenantBundleContentEncoder.create(
        manifest,
        expected,
        JSON.parse(JSON.stringify(encoder.checkpoint()))
      );
    }
    expect(encoder.checkpoint().phase).toBe('done');
    const events = await collect(
      decodeTenantBundle(
        encryptTenantBundleStream(source(frames), session),
        session,
        expected,
        limits
      )
    );
    expect(
      events.filter((e) => e.kind === 'chunk').map((e) => new TextDecoder().decode(e.bytes))
    ).toEqual(['first', 'second']);
    expect(events.at(-1)?.kind).toBe('complete');
    // Content frame wire fields remain v1: type=2, dataset=0, chunk ordinal=1.
    expect([...frames[2].subarray(0, 7)]).toEqual([2, 0, 0, 0, 0, 0, 1]);
  });
  it('rejects changed manifest and impossible saved counters without accepting uploaded state', async () => {
    const encoder = await TenantBundleContentEncoder.create(manifest, expected);
    const state = encoder.checkpoint();
    await expect(
      TenantBundleContentEncoder.create({ ...manifest, boundaryUnixMs: 124 }, expected, state)
    ).rejects.toThrow('encoder_state');
    for (const patch of [
      { version: 2 },
      { datasetIndex: 99 },
      { chunks: -1 },
      { bytes: 1 },
      { chainSha256: 'not-a-digest' },
      { phase: 'done' },
      { phase: 'unknown' },
    ])
      await expect(
        TenantBundleContentEncoder.create(manifest, expected, {
          ...state,
          ...patch,
        } as typeof state)
      ).rejects.toThrow('encoder_state');
    await expect(encoder.step({ kind: 'end', datasetId: 'core.clients' })).rejects.toThrow(
      'encoder_state'
    );
    expect(encoder.checkpoint()).toEqual(state);
  });
  it('rejects concurrent transitions and exposes only a detached checkpoint', async () => {
    const encoder = await TenantBundleContentEncoder.create(manifest, expected);
    await encoder.step({ kind: 'manifest' });
    const write = encoder.step({
      kind: 'chunk',
      datasetId: 'core.clients',
      bytes: new Uint8Array([1]),
    });
    expect(() => encoder.checkpoint()).toThrow('encoder_state');
    await expect(encoder.step({ kind: 'end', datasetId: 'core.clients' })).rejects.toThrow(
      'encoder_state'
    );
    await write;
    const detached = encoder.checkpoint();
    detached.bytes = 999;
    expect(encoder.checkpoint().bytes).toBe(1);
  });
});

it('resumes content validation after every frame with identical events and a detached checkpoint', async () => {
  let decoder = await TenantBundleContentDecoder.create(manifest, expected);
  const events = [];
  for (const frame of plaintext) {
    const before = decoder.checkpoint();
    const event = await decoder.step(frame);
    const retry = await TenantBundleContentDecoder.create(manifest, expected, before);
    expect(await retry.step(frame)).toEqual(event);
    expect(retry.checkpoint()).toEqual(decoder.checkpoint());
    events.push(event);
    decoder = await TenantBundleContentDecoder.create(
      manifest,
      expected,
      JSON.parse(JSON.stringify(decoder.checkpoint()))
    );
  }
  expect(events.map((event) => event.kind)).toEqual([
    'manifest',
    'chunk',
    'dataset_end',
    'dataset_end',
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
  expect(decoder.finish()).toEqual({ kind: 'complete', manifest });
  expect(() => decoder.finish()).toThrow();
  await expect(decoder.step(plaintext[0])).rejects.toThrow();
});

it('rejects changed ordinals, counts and chain digests without advancing the saved input state', async () => {
  const decoder = await TenantBundleContentDecoder.create(manifest, expected);
  await decoder.step(plaintext[0]);
  const before = decoder.checkpoint();
  for (const offset of [1, 3]) {
    const changed = plaintext[1].slice();
    changed[offset] ^= 1;
    await expect(decoder.step(changed)).rejects.toThrow();
    expect(decoder.checkpoint()).toEqual(before);
  }
  await decoder.step(plaintext[1]);
  const after = decoder.checkpoint();
  for (const offset of [3, 11, 19]) {
    const changed = plaintext[2].slice();
    changed[offset] ^= 1;
    await expect(decoder.step(changed)).rejects.toThrow();
    expect(decoder.checkpoint()).toEqual(after);
  }
  expect(() => decoder.finish()).toThrow();
  await expect(
    TenantBundleContentDecoder.create({ ...manifest, boundaryUnixMs: 124 }, expected, after)
  ).rejects.toThrow();
});

describe('resumable uploaded bundle decode step', () => {
  function input() {
    const bytes = new Uint8Array(encoded.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of encoded) {
      bytes.set(part, offset);
      offset += part.length;
    }
    const identity = { key: 'owned/input', version: 'v1', etag: 'etag1', size: bytes.length };
    return {
      session,
      manifest,
      expected,
      limits,
      identity,
      signal: new AbortController().signal,
      assertAuthorized: async () => {},
      bucket: {
        get: async (_key: string, options: { range: { offset: number; length: number } }) => ({
          ...identity,
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                bytes.slice(options.range.offset, options.range.offset + options.range.length)
              );
              controller.close();
            },
          }),
        }),
      },
    };
  }
  it('replays an uncommitted slice and completes only after footer plus EOF', async () => {
    const request = input();
    let checkpoint: TenantBackupInputDecodeCheckpoint | null = null;
    const events: string[] = [];
    while (!checkpoint?.complete) {
      const before = structuredClone(checkpoint);
      const result = await decodeTenantBackupInputStep({ ...request, checkpoint });
      const retry = await decodeTenantBackupInputStep({ ...request, checkpoint });
      expect(retry).toEqual(result);
      expect(checkpoint).toEqual(before);
      events.push(result.event.kind);
      checkpoint = JSON.parse(JSON.stringify(result.checkpoint));
    }
    expect(events).toEqual([
      'header',
      'manifest',
      'chunk',
      'dataset_end',
      'dataset_end',
      'footer',
      'complete',
    ]);
    await expect(decodeTenantBackupInputStep({ ...request, checkpoint })).rejects.toThrow(
      'backup_input_checkpoint_invalid'
    );
  });
  it('rejects mixed object/cursor/cipher checkpoints before exposing data', async () => {
    const request = input();
    const { checkpoint } = await decodeTenantBackupInputStep({ ...request, checkpoint: null });
    for (const changed of [
      { ...checkpoint, identity: { ...checkpoint.identity, version: 'different' } },
      {
        ...checkpoint,
        transport: { ...checkpoint.transport, offset: checkpoint.transport.offset + 1 },
      },
      { ...checkpoint, transport: { ...checkpoint.transport, frames: 2 } },
      { ...checkpoint, cipher: { ...checkpoint.cipher, headerSha256: '00'.repeat(32) } },
    ])
      await expect(
        decodeTenantBackupInputStep({ ...request, checkpoint: changed })
      ).rejects.toThrow();
  });
});
