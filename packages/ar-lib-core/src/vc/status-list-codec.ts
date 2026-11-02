/**
 * Status List Codec
 *
 * Bit packing and compression for the two status list formats Authrim stores:
 * - `w3c_bitstring_v1`: W3C Bitstring Status List (gzip, MSB-first, 1 bit per entry). Existing lists.
 * - `ietf_tsl_v1`: IETF Token Status List draft-14 (zlib, LSB-first, `bits` per entry). New lists.
 *
 * @see https://datatracker.ietf.org/doc/draft-ietf-oauth-status-list/ (section 4.1)
 */

export type StatusListFormat = 'w3c_bitstring_v1' | 'ietf_tsl_v1';

export const W3C_BITSTRING_FORMAT: StatusListFormat = 'w3c_bitstring_v1';
export const IETF_TSL_FORMAT: StatusListFormat = 'ietf_tsl_v1';

/** Token Status List status values (draft-14 section 7.1) */
export const TSL_STATUS_VALID = 0x00;
export const TSL_STATUS_INVALID = 0x01;
export const TSL_STATUS_SUSPENDED = 0x02;

/** Bits per entry for new lists */
export const TSL_BITS = 2;

/** Largest decoded list a reader or writer accepts (2^27 one-bit entries) */
export const MAX_STATUS_LIST_BYTES = 16 * 1024 * 1024;

export type StatusListBitOrder = 'lsb' | 'msb';

export function isStatusListFormat(value: unknown): value is StatusListFormat {
  return value === W3C_BITSTRING_FORMAT || value === IETF_TSL_FORMAT;
}

export function isValidStatusBits(bits: unknown): bits is 1 | 2 | 4 | 8 {
  return bits === 1 || bits === 2 || bits === 4 || bits === 8;
}

/** Bytes needed to hold `capacity` entries of `bits` bits each */
export function statusListByteLength(capacity: number, bits: number): number {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || !isValidStatusBits(bits)) {
    throw new Error('Invalid status list capacity or bits');
  }
  return Math.ceil((capacity * bits) / 8);
}

export function bitOrderForFormat(format: StatusListFormat): StatusListBitOrder {
  return format === IETF_TSL_FORMAT ? 'lsb' : 'msb';
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(value: string): Uint8Array {
  // Padding and the standard alphabet are tolerated for lists written before base64url was enforced.
  if (typeof value !== 'string' || !/^[A-Za-z0-9_+/-]*=*$/.test(value)) {
    throw new Error('Invalid base64url status list');
  }
  const base64 = value.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '==='.slice(0, (4 - (base64.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

async function pipeThrough(
  stream: CompressionStream | DecompressionStream,
  input: Uint8Array,
  maxBytes?: number
): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const writing = (async () => {
    await writer.write(input);
    await writer.close();
  })();
  const reading = (async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (maxBytes !== undefined && total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error('Decoded status list exceeds maximum size');
      }
      chunks.push(value);
    }
  })();
  // A decompression failure rejects both sides; surface the first.
  const [writeResult, readResult] = await Promise.allSettled([writing, reading]);
  if (readResult.status === 'rejected') throw readResult.reason;
  if (writeResult.status === 'rejected') throw writeResult.reason;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** gzip for W3C lists, zlib (`deflate` in the Compression Streams API) for Token Status Lists */
function compressionFor(format: StatusListFormat): 'gzip' | 'deflate' {
  return format === IETF_TSL_FORMAT ? 'deflate' : 'gzip';
}

export async function encodeStatusListBytes(
  bytes: Uint8Array,
  format: StatusListFormat
): Promise<string> {
  const compressed = await pipeThrough(new CompressionStream(compressionFor(format)), bytes);
  return toBase64Url(compressed);
}

/**
 * Decode a stored/published list. Token Status Lists must be zlib; W3C lists must be gzip (as the
 * Bitstring Status List specification requires). Anything else is an error, never a guess: reading
 * a compressed stream as raw bits would report arbitrary statuses.
 */
export async function decodeStatusListBytes(
  encoded: string,
  format: StatusListFormat,
  maxBytes: number = MAX_STATUS_LIST_BYTES
): Promise<Uint8Array> {
  const compressed = fromBase64Url(encoded);
  if (compressed.length > maxBytes + 1024) {
    throw new Error('Compressed status list exceeds maximum size');
  }
  if (format === IETF_TSL_FORMAT) {
    // zlib header: CM = 8 (deflate) and (CMF * 256 + FLG) divisible by 31
    const valid =
      compressed.length >= 2 &&
      (compressed[0] & 0x0f) === 8 &&
      ((compressed[0] << 8) | compressed[1]) % 31 === 0;
    if (!valid) throw new Error('Unsupported status list compression');
    return pipeThrough(new DecompressionStream('deflate'), compressed, maxBytes);
  }
  if (compressed.length >= 2 && compressed[0] === 0x1f && compressed[1] === 0x8b) {
    return pipeThrough(new DecompressionStream('gzip'), compressed, maxBytes);
  }
  throw new Error('Unsupported status list compression');
}

function slot(
  index: number,
  bits: number,
  order: StatusListBitOrder
): { byteIndex: number; shift: number } {
  const perByte = 8 / bits;
  const byteIndex = Math.floor(index / perByte);
  const position = index % perByte;
  return { byteIndex, shift: (order === 'lsb' ? position : perByte - 1 - position) * bits };
}

/** Read the entry at `index`; throws for an index outside the list */
export function readStatusEntry(
  bytes: Uint8Array,
  index: number,
  bits: number,
  order: StatusListBitOrder
): number {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`Index must be a non-negative integer, got: ${index}`);
  }
  if (!isValidStatusBits(bits)) throw new Error('bitsPerStatus must be 1, 2, 4, or 8');
  const { byteIndex, shift } = slot(index, bits, order);
  if (byteIndex >= bytes.length) {
    throw new Error(`Index ${index} out of bounds (max: ${bytes.length * (8 / bits) - 1})`);
  }
  return (bytes[byteIndex] >> shift) & ((1 << bits) - 1);
}

/** Write `value` at `index` (in place); throws for an index outside the list or a value over `bits` */
export function writeStatusEntry(
  bytes: Uint8Array,
  index: number,
  bits: number,
  order: StatusListBitOrder,
  value: number
): void {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`Index must be a non-negative integer, got: ${index}`);
  }
  if (!isValidStatusBits(bits)) throw new Error('bitsPerStatus must be 1, 2, 4, or 8');
  const mask = (1 << bits) - 1;
  if (!Number.isInteger(value) || value < 0 || value > mask) {
    throw new Error(`Status value ${value} does not fit in ${bits} bits`);
  }
  const { byteIndex, shift } = slot(index, bits, order);
  if (byteIndex >= bytes.length) {
    throw new Error(`Index ${index} out of bounds (max: ${bytes.length * (8 / bits) - 1})`);
  }
  bytes[byteIndex] = (bytes[byteIndex] & ~(mask << shift)) | (value << shift);
}
