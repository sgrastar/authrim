import {
  decodeTenantBackupContainerV2,
  type DecodedTenantBackupContainerV2,
} from './backup-container-v2';
import type { TenantBundleKeyEnvelope } from './bundle-key-envelope';
import type { TenantBackupInputIdentity } from './input-frame-reader';

const RANGE_BYTES = 8 * 1024 * 1024;
const MAX_INPUT_BYTES = 256 * 1024 * 1024;

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

export interface TenantBackupContainerInputBucketV2 {
  get(
    key: string,
    options: { range: { offset: number; length: number }; onlyIf: { etagMatches: string } }
  ): Promise<InputObject | null>;
}

function fail(): never {
  throw new Error('backup_container_v2_input_invalid');
}

/** Read one pinned upload in capacity ranges, then authenticate the complete v2 container once. */
export async function readTenantBackupContainerV2Input(input: {
  bucket: TenantBackupContainerInputBucketV2;
  identity: Readonly<TenantBackupInputIdentity>;
  session: TenantBundleKeyEnvelope;
  signal: AbortSignal;
  assertAuthorized: () => Promise<void>;
}): Promise<DecodedTenantBackupContainerV2> {
  const identity = { ...input.identity };
  if (
    !identity.key ||
    !identity.version ||
    !identity.etag ||
    !Number.isSafeInteger(identity.size) ||
    identity.size < 158 ||
    identity.size > MAX_INPUT_BYTES
  )
    fail();
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < identity.size; offset += RANGE_BYTES) {
    input.signal.throwIfAborted();
    await input.assertAuthorized();
    const length = Math.min(RANGE_BYTES, identity.size - offset);
    const object = await input.bucket.get(identity.key, {
      range: { offset, length },
      onlyIf: { etagMatches: identity.etag },
    });
    if (
      !object?.body ||
      object.version !== identity.version ||
      object.etag !== identity.etag ||
      object.size !== identity.size
    )
      fail();
    const reader = object.body.getReader();
    const bytes = new Uint8Array(length);
    let written = 0;
    let ended = false;
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) {
          ended = true;
          break;
        }
        if (!(item.value instanceof Uint8Array) || item.value.length > length - written) fail();
        bytes.set(item.value, written);
        written += item.value.length;
      }
    } finally {
      if (!ended) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    if (written !== length) fail();
    chunks.push(bytes);
  }
  await input.assertAuthorized();
  const decoded = await decodeTenantBackupContainerV2({ parts: chunks, session: input.session });
  await input.assertAuthorized();
  input.signal.throwIfAborted();
  return decoded;
}
