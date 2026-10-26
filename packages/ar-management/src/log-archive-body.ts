import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';

// Node and Workers disagree on the optional BYOB extensions; only the default reader is used.
interface LogByteStream {
  getReader(): {
    read(): Promise<{ done: boolean; value?: unknown }>;
    cancel(reason?: unknown): Promise<void>;
    releaseLock(): void;
  };
}

/** Reject oversized or malformed streams before buffering a complete decoded archive. */
export async function boundedLogArchiveBytes(
  stream: LogByteStream,
  maximum: number
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error('log_archive_body_chunk_invalid');
      size += value.length;
      if (size > maximum) throw new Error('log_archive_body_limit');
      parts.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

export async function decodeLogArchiveBody(
  body: Uint8Array,
  compression: 'none' | 'gzip_block',
  maximum: number
): Promise<Uint8Array> {
  // The writer concatenates independent gzip members without per-record indexes.
  // Workerd's Web DecompressionStream accepts only one member; node:zlib accepts the format.
  const stream =
    compression === 'gzip_block'
      ? Readable.toWeb(Readable.from([body]).pipe(createGunzip()))
      : new Blob([body]).stream();
  return boundedLogArchiveBytes(stream, maximum);
}
