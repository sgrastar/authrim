/** Binary transport framing. Payload authentication belongs to the bundle codec. */
const MAGIC = new TextEncoder().encode('AUTHRIM1');
export const TENANT_BUNDLE_MAX_FRAME_BYTES = 1024 * 1024 + 65_536;

export interface TenantBundleReadLimits {
  /** Includes framing and payload bytes; fixed by the trusted upload operation. */
  maxTotalBytes: number;
  maxFrames: number;
}

export class TenantBundleFramingError extends Error {
  constructor() {
    super('invalid_tenant_bundle_framing');
    this.name = 'TenantBundleFramingError';
  }
}

function invalid(): never {
  throw new TenantBundleFramingError();
}

/** One bounded allocation per frame; never buffers the complete artifact. */
export async function* encodeTenantBundleFrames(
  frames: AsyncIterable<Uint8Array>
): AsyncGenerator<Uint8Array> {
  yield MAGIC.slice();
  let count = 0;
  for await (const payload of frames) {
    if (
      !(payload instanceof Uint8Array) ||
      !payload.length ||
      payload.length > TENANT_BUNDLE_MAX_FRAME_BYTES
    )
      invalid();
    const frame = new Uint8Array(4 + payload.length);
    new DataView(frame.buffer).setUint32(0, payload.length, false);
    frame.set(payload, 4);
    count++;
    yield frame;
  }
  if (!count) invalid();
}

/**
 * Accepts arbitrary transport segmentation. A clean frame boundary is NOT proof
 * of a complete backup: the authenticated codec must require its final manifest.
 * Limits are trusted operation policy, never taken from an uploaded header.
 */
export async function* decodeTenantBundleFrames(
  source: AsyncIterable<Uint8Array>,
  limits: TenantBundleReadLimits
): AsyncGenerator<Uint8Array> {
  const { maxTotalBytes, maxFrames } = limits;
  if (
    !Number.isSafeInteger(maxTotalBytes) ||
    maxTotalBytes < MAGIC.length ||
    !Number.isSafeInteger(maxFrames) ||
    maxFrames < 1
  )
    invalid();
  const iterator = source[Symbol.asyncIterator]();
  let chunk: Uint8Array = new Uint8Array(0);
  let offset = 0;
  let received = 0;
  let consumed = 0;
  let completed = false;
  let ended = false;
  async function refill(): Promise<boolean> {
    while (offset === chunk.length) {
      if (ended) return false;
      const next = await iterator.next();
      if (next.done) {
        ended = true;
        return false;
      }
      if (!(next.value instanceof Uint8Array)) invalid();
      if (next.value.byteLength > maxTotalBytes - received) invalid();
      received += next.value.byteLength;
      chunk = next.value;
      offset = 0;
    }
    return true;
  }
  async function read(length: number): Promise<Uint8Array> {
    const result = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      if (!(await refill())) invalid();
      const count = Math.min(length - written, chunk.length - offset);
      result.set(chunk.subarray(offset, offset + count), written);
      written += count;
      offset += count;
      consumed += count;
    }
    return result;
  }
  try {
    const magic = await read(MAGIC.length);
    if (!magic.every((byte, index) => byte === MAGIC[index])) invalid();
    let count = 0;
    while (await refill()) {
      if (++count > maxFrames) invalid();
      const prefix = await read(4);
      const length = new DataView(prefix.buffer).getUint32(0, false);
      if (!length || length > TENANT_BUNDLE_MAX_FRAME_BYTES || length > maxTotalBytes - consumed)
        invalid();
      yield await read(length);
    }
    if (!count) invalid();
    completed = true;
  } finally {
    if (!completed && iterator.return) await iterator.return();
  }
}
