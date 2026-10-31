import { TENANT_BUNDLE_MAX_FRAME_BYTES, type TenantBundleReadLimits } from './bundle-framing';

interface InputObject {
  version: string;
  etag: string;
  size: number;
  body?: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>;
      cancel(): Promise<void>;
      releaseLock(): void;
    };
  };
}
interface InputBucket {
  get(
    key: string,
    options: { range: { offset: number; length: number }; onlyIf: { etagMatches: string } }
  ): Promise<InputObject | null>;
}
export interface TenantBackupInputIdentity {
  key: string;
  version: string;
  etag: string;
  size: number;
}
export interface TenantBackupInputCursor {
  offset: number;
  frames: number;
}
function fail(): never {
  throw new Error('backup_input_read_failed');
}

/**
 * Read one bounded frame from an operation-owned immutable upload receipt. Identity and cursor
 * must come from persisted, authorized operation state, never from an upload request. Persist
 * the returned cursor atomically with decoder and staging state. EOF is transport evidence only;
 * the authenticated footer and complete dataset/reference validation are still required.
 */
export async function readTenantBackupInputFrame(input: {
  bucket: InputBucket;
  identity: Readonly<TenantBackupInputIdentity>;
  cursor: Readonly<TenantBackupInputCursor>;
  limits: Readonly<TenantBundleReadLimits>;
  signal: AbortSignal;
  assertAuthorized: () => Promise<void>;
}): Promise<{ payload: Uint8Array; cursor: TenantBackupInputCursor } | null> {
  const identity = { ...input.identity };
  const cursor = { ...input.cursor };
  const limits = { ...input.limits };
  if (
    !identity.key ||
    !identity.version ||
    !identity.etag ||
    !Number.isSafeInteger(identity.size) ||
    identity.size < 13 ||
    !Number.isSafeInteger(limits.maxTotalBytes) ||
    identity.size > limits.maxTotalBytes ||
    !Number.isSafeInteger(limits.maxFrames) ||
    limits.maxFrames < 1 ||
    !Number.isSafeInteger(cursor.offset) ||
    cursor.offset < 0 ||
    cursor.offset > identity.size ||
    !Number.isSafeInteger(cursor.frames) ||
    cursor.frames < 0 ||
    cursor.frames > limits.maxFrames ||
    (cursor.frames === 0 ? cursor.offset !== 0 : cursor.offset < 13)
  )
    fail();
  async function authorized(): Promise<void> {
    input.signal.throwIfAborted();
    await input.assertAuthorized();
    input.signal.throwIfAborted();
  }
  async function range(offset: number, length: number): Promise<Uint8Array> {
    await authorized();
    if (length > identity.size - offset) fail();
    const object = await input.bucket.get(identity.key, {
      range: { offset, length },
      onlyIf: { etagMatches: identity.etag },
    });
    if (!object?.body) fail();
    const reader = object.body.getReader();
    let ended = false;
    try {
      if (
        object.version !== identity.version ||
        object.etag !== identity.etag ||
        object.size !== identity.size
      )
        fail();
      const bytes = new Uint8Array(length);
      let written = 0;
      while (true) {
        input.signal.throwIfAborted();
        const item = await reader.read();
        if (item.done) {
          ended = true;
          break;
        }
        if (!(item.value instanceof Uint8Array) || item.value.length > length - written) fail();
        bytes.set(item.value, written);
        written += item.value.length;
      }
      if (written !== length) fail();
      await authorized();
      return bytes;
    } finally {
      if (!ended) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  await authorized();
  if (cursor.offset === identity.size) {
    // Recheck the pinned object even when resuming directly at EOF.
    await range(identity.size - 1, 1);
    return null;
  }
  if (cursor.frames === limits.maxFrames) fail();
  let offset = cursor.offset;
  if (offset === 0) {
    const magic = await range(0, 8);
    if (!magic.every((byte, index) => byte === 'AUTHRIM1'.charCodeAt(index))) fail();
    offset = 8;
  }
  const prefix = await range(offset, 4);
  const length = new DataView(prefix.buffer).getUint32(0, false);
  if (!length || length > TENANT_BUNDLE_MAX_FRAME_BYTES) fail();
  const payload = await range(offset + 4, length);
  return { payload, cursor: { offset: offset + 4 + length, frames: cursor.frames + 1 } };
}
