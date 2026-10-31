import { describe, expect, it } from 'vitest';
import {
  decodeTenantBundleFrames,
  encodeTenantBundleFrames,
  TENANT_BUNDLE_MAX_FRAME_BYTES,
} from '../bundle-framing';

async function* chunks(parts: Uint8Array[]) {
  yield* parts;
}
async function collect(source: AsyncIterable<Uint8Array>) {
  const result: Uint8Array[] = [];
  for await (const frame of source) result.push(frame);
  return result;
}
const limits = { maxTotalBytes: 1024, maxFrames: 10 };
const frame = new Uint8Array([7, 8, 9]);

describe('portable bundle binary framing', () => {
  it('roundtrips binary frames across every possible single transport split', async () => {
    const encoded = Buffer.concat(await collect(encodeTenantBundleFrames(chunks([frame, frame]))));
    for (let i = 0; i <= encoded.length; i++) {
      expect(
        await collect(
          decodeTenantBundleFrames(chunks([encoded.subarray(0, i), encoded.subarray(i)]), limits)
        )
      ).toEqual([frame, frame]);
    }
    expect(
      await collect(
        decodeTenantBundleFrames(chunks([...encoded].map((x) => new Uint8Array([x]))), limits)
      )
    ).toEqual([frame, frame]);
  });

  it('rejects every truncation inside the magic, prefix, or body', async () => {
    const encoded = Buffer.concat(await collect(encodeTenantBundleFrames(chunks([frame]))));
    for (let i = 0; i < encoded.length; i++) {
      await expect(
        collect(decodeTenantBundleFrames(chunks([encoded.subarray(0, i)]), limits))
      ).rejects.toThrow('invalid_tenant_bundle_framing');
    }
  });

  it.each([0, TENANT_BUNDLE_MAX_FRAME_BYTES + 1, 0xffffffff])(
    'rejects length %s before reading its body',
    async (length) => {
      let bodyRead = false;
      let closed = false;
      async function* invalidInput() {
        try {
          yield new TextEncoder().encode('AUTHRIM1');
          const prefix = new Uint8Array(4);
          new DataView(prefix.buffer).setUint32(0, length);
          yield prefix;
          bodyRead = true;
          yield frame;
        } finally {
          closed = true;
        }
      }
      await expect(collect(decodeTenantBundleFrames(invalidInput(), limits))).rejects.toThrow();
      expect(bodyRead).toBe(false);
      expect(closed).toBe(true);
    }
  );

  it('enforces total upload and frame-count budgets', async () => {
    const encoded = await collect(encodeTenantBundleFrames(chunks([frame, frame])));
    await expect(
      collect(decodeTenantBundleFrames(chunks(encoded), { ...limits, maxTotalBytes: 14 }))
    ).rejects.toThrow();
    await expect(
      collect(decodeTenantBundleFrames(chunks(encoded), { ...limits, maxFrames: 1 }))
    ).rejects.toThrow();
  });

  it('rejects invalid trusted budgets and wire versions', async () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity]) {
      await expect(
        collect(decodeTenantBundleFrames(chunks([]), { ...limits, maxFrames: bad }))
      ).rejects.toThrow();
    }
    await expect(
      collect(decodeTenantBundleFrames(chunks([new TextEncoder().encode('AUTHRIM2')]), limits))
    ).rejects.toThrow();
  });

  it('releases the upstream source on early consumer cancellation without eager reads', async () => {
    let readSecond = false;
    let closed = false;
    async function* input() {
      try {
        yield frame;
        readSecond = true;
        yield frame;
      } finally {
        closed = true;
      }
    }
    for await (const decoded of decodeTenantBundleFrames(
      encodeTenantBundleFrames(input()),
      limits
    )) {
      expect(decoded).toEqual(frame);
      break;
    }
    expect(readSecond).toBe(false);
    expect(closed).toBe(true);
  });

  it('rejects empty and oversized outgoing frames', async () => {
    for (const payload of [new Uint8Array(), new Uint8Array(TENANT_BUNDLE_MAX_FRAME_BYTES + 1)]) {
      await expect(collect(encodeTenantBundleFrames(chunks([payload])))).rejects.toThrow();
    }
    await expect(collect(encodeTenantBundleFrames(chunks([])))).rejects.toThrow();
  });
});
