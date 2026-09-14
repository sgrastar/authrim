import { TenantBundleCipherDecoder } from '../bundle-cipher-decoder';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createTenantBundleKeyEnvelope,
  unlockTenantBundleKeyEnvelope,
  type TenantBundleKeyEnvelope,
} from '../bundle-key-envelope';
import {
  decryptTenantBundleStream,
  encryptTenantBundleStream,
  type TenantBundleDecryptionEvent,
} from '../bundle-cipher';
import { decodeTenantBundleFrames, encodeTenantBundleFrames } from '../bundle-framing';

const password = 'fixture only backup passphrase 2026';
const limits = { maxTotalBytes: 8 * 1024 * 1024, maxFrames: 100 };
async function* source<T>(items: T[]) {
  yield* items;
}
async function collect<T>(items: AsyncIterable<T>) {
  const result: T[] = [];
  for await (const item of items) result.push(item);
  return result;
}
let session: TenantBundleKeyEnvelope;
let locked: Uint8Array[];
let frames: Uint8Array[];

beforeAll(async () => {
  session = await createTenantBundleKeyEnvelope(password);
  locked = await collect(
    encryptTenantBundleStream(source([new Uint8Array([1, 2]), new Uint8Array([3, 4])]), session)
  );
  frames = await collect(decodeTenantBundleFrames(source(locked), limits));
});

describe('self-contained backup key wrapping and chunk authentication', () => {
  it('opens using only the saved envelope and passphrase, with a nonextractable content key', async () => {
    const restored = await unlockTenantBundleKeyEnvelope(session.envelope.slice(), password);
    expect(restored.contentKey.extractable).toBe(false);
    expect(await collect(decryptTenantBundleStream(source(locked), restored, limits))).toEqual([
      { kind: 'chunk', bytes: new Uint8Array([1, 2]) },
      { kind: 'chunk', bytes: new Uint8Array([3, 4]) },
      { kind: 'complete', chunks: 2, bytes: 4 },
    ]);
  });
  it('rejects a wrong passphrase and a changed envelope identity', async () => {
    await expect(
      unlockTenantBundleKeyEnvelope(session.envelope, password + 'wrong')
    ).rejects.toThrow('invalid_tenant_bundle_key_envelope');
    const changed = session.envelope.slice();
    changed[2] ^= 1;
    await expect(unlockTenantBundleKeyEnvelope(changed, password)).rejects.toThrow(
      'invalid_tenant_bundle_key_envelope'
    );
  });
  it('rejects unknown envelope suites and malformed passphrases', async () => {
    const changed = session.envelope.slice();
    changed[0] = 2;
    await expect(unlockTenantBundleKeyEnvelope(changed, password)).rejects.toThrow();
    await expect(unlockTenantBundleKeyEnvelope(changed.slice(1), password)).rejects.toThrow();
    for (const pass of ['short', 'x'.repeat(1025), 'x'.repeat(20) + '\ud800']) {
      await expect(createTenantBundleKeyEnvelope(pass)).rejects.toThrow(
        'invalid_tenant_bundle_key_envelope'
      );
    }
  });
  it.each([
    'drop-footer',
    'drop-chunk',
    'swap',
    'duplicate',
    'trailing',
    'ciphertext',
    'header',
    'type',
  ])('does not emit completion for %s', async (mode) => {
    const changed = frames.map((x) => x.slice());
    if (mode === 'drop-footer') changed.pop();
    if (mode === 'drop-chunk') changed.splice(1, 1);
    if (mode === 'swap') [changed[1], changed[2]] = [changed[2], changed[1]];
    if (mode === 'duplicate') changed.splice(2, 0, changed[1]);
    if (mode === 'trailing') changed.push(changed[1]);
    if (mode === 'ciphertext') changed[1][3] ^= 1;
    if (mode === 'header') changed[0][100] ^= 1;
    if (mode === 'type') changed[1][0] = 2;
    const observed: TenantBundleDecryptionEvent[] = [];
    async function run() {
      for await (const event of decryptTenantBundleStream(
        encodeTenantBundleFrames(source(changed)),
        session,
        limits
      ))
        observed.push(event);
    }
    await expect(run()).rejects.toThrow();
    expect(observed.some((x) => x.kind === 'complete')).toBe(false);
  });
  it('uses independent stream keys on retry and rejects cross-stream splicing', async () => {
    const retried = await collect(
      decodeTenantBundleFrames(
        encryptTenantBundleStream(
          source([new Uint8Array([1, 2]), new Uint8Array([3, 4])]),
          session
        ),
        limits
      )
    );
    expect(retried[0]).not.toEqual(frames[0]);
    expect(retried[1]).not.toEqual(frames[1]);
    const splice = [retried[0], frames[1], ...retried.slice(2)];
    await expect(
      collect(decryptTenantBundleStream(encodeTenantBundleFrames(source(splice)), session, limits))
    ).rejects.toThrow();
  });
  it('accepts an authenticated empty stream but never header-only input', async () => {
    expect(
      await collect(
        decryptTenantBundleStream(encryptTenantBundleStream(source([]), session), session, limits)
      )
    ).toEqual([{ kind: 'complete', chunks: 0, bytes: 0 }]);
    await expect(
      collect(
        decryptTenantBundleStream(encodeTenantBundleFrames(source([frames[0]])), session, limits)
      )
    ).rejects.toThrow();
  });
});

it('resumes authenticated frame decoding after every saved checkpoint and repeats uncertain frames exactly', async () => {
  let decoder = await TenantBundleCipherDecoder.create(frames[0], session, limits);
  const output: Uint8Array[] = [];
  for (const frame of frames.slice(1)) {
    const checkpoint = decoder.checkpoint();
    const event = await decoder.step(frame);
    const retry = await TenantBundleCipherDecoder.create(frames[0], session, limits, checkpoint);
    expect(await retry.step(frame)).toEqual(event);
    expect(retry.checkpoint()).toEqual(decoder.checkpoint());
    if (event.kind === 'chunk') output.push(event.bytes);
    decoder = await TenantBundleCipherDecoder.create(
      frames[0],
      session,
      limits,
      JSON.parse(JSON.stringify(decoder.checkpoint()))
    );
  }
  expect(output).toEqual([new Uint8Array([1, 2]), new Uint8Array([3, 4])]);
  expect(decoder.checkpoint()).toMatchObject({ complete: true, chunks: 2, bytes: 4 });
  await expect(decoder.step(frames[1])).rejects.toThrow();
  const checkpoint = decoder.checkpoint();
  checkpoint.chunks = 0;
  expect(decoder.checkpoint().chunks).toBe(2);
  expect(Object.keys(decoder.checkpoint()).sort()).toEqual([
    'bytes',
    'chunks',
    'complete',
    'headerSha256',
    'version',
  ]);
});
it('rejects wrong-header resumes, reordered frames and corrupt frames without advancing state', async () => {
  const decoder = await TenantBundleCipherDecoder.create(frames[0], session, limits);
  const before = decoder.checkpoint();
  await expect(decoder.step(frames[2])).rejects.toThrow();
  expect(decoder.checkpoint()).toEqual(before);
  const damaged = frames[1].slice();
  damaged[damaged.length - 1] ^= 1;
  await expect(decoder.step(damaged)).rejects.toThrow();
  expect(decoder.checkpoint()).toEqual(before);
  const changed = frames[0].slice();
  changed[124] ^= 1;
  await expect(
    TenantBundleCipherDecoder.create(changed, session, limits, before)
  ).rejects.toThrow();
  await expect(
    TenantBundleCipherDecoder.create(frames[0], session, limits, { ...before, chunks: 1, bytes: 0 })
  ).rejects.toThrow();
});
it('enforces cumulative frame and byte limits across resumes and serializes decryption', async () => {
  const decoder = await TenantBundleCipherDecoder.create(frames[0], session, limits);
  const pending = decoder.step(frames[1]);
  await expect(decoder.step(frames[1])).rejects.toThrow();
  await pending;
  const saved = decoder.checkpoint();
  const frameBound = await TenantBundleCipherDecoder.create(
    frames[0],
    session,
    { ...limits, maxFrames: 2 },
    saved
  );
  await expect(frameBound.step(frames[2])).rejects.toThrow();
  const byteBound = await TenantBundleCipherDecoder.create(
    frames[0],
    session,
    { ...limits, maxTotalBytes: 160 },
    saved
  );
  await expect(byteBound.step(frames[2])).rejects.toThrow();
});
