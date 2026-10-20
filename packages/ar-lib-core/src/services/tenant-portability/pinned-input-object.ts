import { TENANT_BACKUP_CONTAINER_V2_MAX_OBJECT_BYTES } from './backup-container-v2';
import type { TenantBackupInputIdentity } from './input-frame-reader';

/**
 * Largest input an import accepts: the container cap that export and verification share. Uploads
 * could be larger (8 MiB × 10,000 parts), but nothing can produce or restore such a container.
 */
export const TENANT_BACKUP_MAX_INPUT_BYTES = TENANT_BACKUP_CONTAINER_V2_MAX_OBJECT_BYTES;
/** Objects up to this size are fetched once and served from memory for the rest of the invocation. */
const WHOLE_OBJECT_BYTES = 4 * 1024 * 1024;
/** Authorization is re-checked before the first range request and then before every 16th. */
const AUTHORIZE_EVERY = 16;

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

/**
 * Range reads of one pinned upload. Every request is conditional on the accepted ETag and must
 * return the accepted version and size, so a replaced object can never be read under the old
 * receipt. Authorization is re-checked periodically between network reads.
 */
export class PinnedTenantBackupInputObject {
  private whole: Promise<Uint8Array<ArrayBuffer>> | undefined;
  private reads = 0;

  constructor(
    private readonly input: {
      bucket: TenantBackupContainerInputBucketV2;
      identity: Readonly<TenantBackupInputIdentity>;
      signal: AbortSignal;
      assertAuthorized: () => Promise<void>;
    }
  ) {
    const identity = input.identity;
    if (
      !identity.key ||
      !identity.version ||
      !identity.etag ||
      !Number.isSafeInteger(identity.size) ||
      identity.size < 158 ||
      identity.size > TENANT_BACKUP_MAX_INPUT_BYTES
    )
      fail();
  }

  get size(): number {
    return this.input.identity.size;
  }

  /** Number of R2 range requests issued so far (each one is a subrequest). */
  get requests(): number {
    return this.reads;
  }

  async read(offset: number, length: number): Promise<Uint8Array<ArrayBuffer>> {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 1 ||
      offset + length > this.size
    )
      fail();
    if (this.size <= WHOLE_OBJECT_BYTES) {
      this.whole ??= this.fetch(0, this.size);
      try {
        return (await this.whole).subarray(offset, offset + length);
      } catch (error) {
        this.whole = undefined;
        throw error;
      }
    }
    return this.fetch(offset, length);
  }

  private async fetch(offset: number, length: number): Promise<Uint8Array<ArrayBuffer>> {
    const { bucket, identity, signal } = this.input;
    signal.throwIfAborted();
    // Callers' checks cost several D1 queries; checking on every frame prefix would multiply a
    // walk's subrequests. Steps still authorize before they write anything.
    if (this.reads % AUTHORIZE_EVERY === 0) {
      await this.input.assertAuthorized();
      signal.throwIfAborted();
    }
    this.reads++;
    const object = await bucket.get(identity.key, {
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
    return bytes;
  }
}
