import type { CallLedger } from './call-ledger';

interface MemoryR2ObjectBody {
  key: string;
  size: number;
  etag: string;
  httpEtag: string;
  uploaded: Date;
  httpMetadata: unknown;
  customMetadata: unknown;
  range: unknown;
  checksums: unknown;
  bodyUsed: boolean;
  version: string;
  storageClass: string;
  writeHttpMetadata(): void;
  body: ReadableStream<Uint8Array> | null;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
  blob(): Promise<Blob>;
}

class MemoryR2Object implements MemoryR2ObjectBody {
  key: string;
  size: number;
  etag: string;
  httpEtag: string;
  uploaded: Date;
  httpMetadata: unknown = null;
  customMetadata: unknown = null;
  range: unknown = null;
  checksums: unknown = null;
  bodyUsed = false;
  version = '1';
  storageClass = 'Standard';
  private bytes: Uint8Array;

  constructor(key: string, bytes: Uint8Array) {
    this.key = key;
    this.bytes = bytes;
    this.size = bytes.length;
    this.etag = `etag-${key}`;
    this.httpEtag = `"etag-${key}"`;
    this.uploaded = new Date(0);
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    this.bodyUsed = true;
    return this.bytes.slice().buffer as ArrayBuffer;
  }

  async text(): Promise<string> {
    this.bodyUsed = true;
    return new TextDecoder().decode(this.bytes);
  }

  async json<T = unknown>(): Promise<T> {
    return JSON.parse(await this.text()) as T;
  }

  get body(): ReadableStream<Uint8Array> | null {
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(this.bytes);
        controller.close();
      },
    });
    return stream;
  }

  writeHttpMetadata(): void {
    return undefined;
  }

  async blob(): Promise<Blob> {
    return new Blob([this.bytes]);
  }
}

interface MemoryR2ListEntry {
  key: string;
  size: number;
  etag: string;
  httpEtag: string;
  uploaded: Date;
  httpMetadata: unknown;
  customMetadata: unknown;
  range: unknown;
  checksums: unknown;
  version: string;
  storageClass: string;
}

interface MemoryR2ListResult {
  objects: MemoryR2ListEntry[];
  truncated: boolean;
  cursor?: string;
  delimitedPrefixes: string[];
}

/**
 * In-memory R2 bucket fake. Records reads/writes in the call ledger. Structurally compatible
 * with `R2Bucket` (cast at the Env boundary).
 */
export class MemoryR2Bucket {
  private objects = new Map<string, MemoryR2Object>();

  constructor(
    private readonly ledger?: CallLedger,
    private readonly label = 'r2'
  ) {}

  async get(key: string, _options?: unknown): Promise<MemoryR2ObjectBody | null> {
    this.ledger?.record('r2.get', `${this.label}:${key}`);
    return this.objects.get(key) ?? null;
  }

  async put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
    _options?: unknown
  ): Promise<MemoryR2ObjectBody | null> {
    this.ledger?.record('r2.put', `${this.label}:${key}`);
    let bytes: Uint8Array;
    if (typeof value === 'string') {
      bytes = new TextEncoder().encode(value);
    } else if (value instanceof ArrayBuffer) {
      bytes = new Uint8Array(value);
    } else if (ArrayBuffer.isView(value)) {
      bytes = new Uint8Array(value.buffer as ArrayBuffer);
    } else if (value instanceof Blob) {
      bytes = new Uint8Array(await value.arrayBuffer());
    } else if (value) {
      const reader = value.getReader();
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        chunks.push(chunk as Uint8Array);
      }
      const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
    } else {
      bytes = new Uint8Array(0);
    }
    const object = new MemoryR2Object(key, bytes);
    this.objects.set(key, object);
    return object;
  }

  async delete(keys: string | string[]): Promise<void> {
    const keyList = Array.isArray(keys) ? keys : [keys];
    for (const key of keyList) {
      this.objects.delete(key);
    }
  }

  async head(key: string): Promise<MemoryR2ListEntry | null> {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      key: object.key,
      size: object.size,
      etag: object.etag,
      httpEtag: object.httpEtag,
      uploaded: object.uploaded,
      httpMetadata: object.httpMetadata,
      customMetadata: object.customMetadata,
      range: object.range,
      checksums: object.checksums,
      version: object.version,
      storageClass: object.storageClass,
    };
  }

  async list(options?: { prefix?: string }): Promise<MemoryR2ListResult> {
    const names = Array.from(this.objects.keys()).sort();
    const prefix = options?.prefix ?? '';
    const filtered = prefix ? names.filter((name) => name.startsWith(prefix)) : names;
    const entries: MemoryR2ListEntry[] = [];
    for (const name of filtered) {
      const object = this.objects.get(name);
      if (!object) continue;
      entries.push({
        key: object.key,
        size: object.size,
        etag: object.etag,
        httpEtag: object.httpEtag,
        uploaded: object.uploaded,
        httpMetadata: object.httpMetadata,
        customMetadata: object.customMetadata,
        range: object.range,
        checksums: object.checksums,
        version: object.version,
        storageClass: object.storageClass,
      });
    }
    return { objects: entries, truncated: false, delimitedPrefixes: [] };
  }

  async createMultipartUpload(_key: string, _options?: unknown): Promise<unknown> {
    throw new Error('memory r2: multipart upload is not supported');
  }

  async resumeMultipartUpload(_key: string, _uploadId: string): Promise<unknown> {
    throw new Error('memory r2: multipart upload is not supported');
  }

  seed(key: string, value: string): void {
    this.objects.set(key, new MemoryR2Object(key, new TextEncoder().encode(value)));
  }
}
