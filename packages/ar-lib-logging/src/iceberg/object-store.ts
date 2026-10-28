import {
  IcebergBatchCollisionError,
  IcebergBudgetError,
  type IcebergObjectStore,
} from './types.js';

/** The catalog may reference only this table's keys in this private R2 binding. */
export class R2IcebergObjectStore implements IcebergObjectStore {
  private readonly prefix: string;
  constructor(
    private readonly bucket: Pick<R2Bucket, 'get' | 'head' | 'put'>,
    private readonly tableLocation: string
  ) {
    const url = new URL(tableLocation);
    if (
      url.protocol !== 's3:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.hostname ||
      url.pathname.length < 2 ||
      url.pathname.includes('%') ||
      url.pathname.split('/').some((s) => s === '..' || s === '.')
    ) {
      throw new Error('Invalid Iceberg table location');
    }
    this.prefix = tableLocation.replace(/\/$/, '') + '/';
  }
  objectKey(path: string): string {
    if (
      !path.startsWith(this.prefix) ||
      path.includes('%') ||
      path.includes('?') ||
      path.includes('#') ||
      path
        .slice(this.prefix.length)
        .split('/')
        .some((s) => s === '..' || s === '.' || s === '')
    ) {
      throw new Error('Iceberg object outside configured table');
    }
    return new URL(path).pathname.slice(1);
  }
  async read(path: string, maximumBytes: number): Promise<Uint8Array> {
    const object = await this.bucket.get(this.objectKey(path));
    if (!object) throw new Error('Iceberg object missing');
    if (object.size > maximumBytes) {
      await object.body.cancel();
      throw new IcebergBudgetError('Iceberg object exceeds read limit');
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.byteLength > maximumBytes)
      throw new IcebergBudgetError('Iceberg object exceeds read limit');
    return bytes;
  }
  async size(path: string): Promise<number> {
    const object = await this.bucket.head(this.objectKey(path));
    if (!object) throw new Error('Iceberg object missing');
    return object.size;
  }
  async readRange(path: string, offset: number, length: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1)
      throw new Error('Invalid Iceberg range');
    const object = await this.bucket.get(this.objectKey(path), { range: { offset, length } });
    if (!object) throw new Error('Iceberg object missing');
    if (object.size < offset + length) {
      await object.body.cancel();
      throw new Error('Iceberg range outside object');
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.byteLength !== length) throw new Error('Iceberg range length mismatch');
    return bytes;
  }
  async putImmutable(path: string, bytes: Uint8Array, identity: string): Promise<void> {
    const key = this.objectKey(path);
    const sha256 = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer);
    const digest = [...new Uint8Array(sha256)].map((v) => v.toString(16).padStart(2, '0')).join('');
    const created = await this.bucket.put(key, Uint8Array.from(bytes).buffer, {
      onlyIf: { etagDoesNotMatch: '*' },
      sha256,
      customMetadata: { authrim_identity: identity, authrim_sha256: digest },
    });
    if (created) return;
    const existing = await this.bucket.head(key);
    // Avro's random sync marker can differ on a retry. The fixed logical
    // identity binds the existing artifact to the same batch/schema/base.
    if (
      !existing ||
      existing.customMetadata?.authrim_identity !== identity ||
      existing.size !== bytes.byteLength
    ) {
      throw new IcebergBatchCollisionError('Iceberg immutable artifact collision');
    }
  }
}
