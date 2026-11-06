/**
 * The lite Login UI's logo: a still PNG or WebP image, small enough to be inlined into every page
 * as a `data:` URI (the lite UI loads nothing else). It is checked when it is saved and again
 * before it is drawn, from the bytes themselves:
 * - `data:image/png;base64,…` or `data:image/webp;base64,…`, strict base64, at most 8 KB decoded;
 * - the container is well formed (PNG chunks / RIFF chunks stay inside the file and end where it
 *   ends) and declares a size of at most 640×160 pixels, which bounds the decoded image;
 * - it is a still image: an APNG chunk (`acTL`, `fcTL`, `fdAT`) or a WebP animation (the VP8X
 *   animation flag, `ANIM`, `ANMF`) is refused, so drawing it cannot keep decoding frames.
 * SVG is not accepted (it would need sanitising).
 */

export const LITE_LOGO_MAX_BYTES = 8 * 1024;
export const LITE_LOGO_MAX_WIDTH = 640;
export const LITE_LOGO_MAX_HEIGHT = 160;

export type LiteLogoMimeType = 'image/png' | 'image/webp';

export type LiteLogoRefusal =
  | 'not_data_uri'
  | 'unsupported_type'
  | 'invalid_base64'
  | 'too_large'
  | 'malformed'
  | 'animated'
  | 'too_wide'
  | 'too_tall';

export type LiteLogoCheck =
  | { ok: true; mimeType: LiteLogoMimeType; width: number; height: number; bytes: number }
  | { ok: false; reason: LiteLogoRefusal };

const PREFIXES: ReadonlyArray<readonly [string, LiteLogoMimeType]> = [
  ['data:image/png;base64,', 'image/png'],
  ['data:image/webp;base64,', 'image/webp'],
];

/** Base64 of at most this many characters decodes to at most LITE_LOGO_MAX_BYTES. */
const MAX_BASE64_LENGTH = Math.ceil(LITE_LOGO_MAX_BYTES / 3) * 4;

function decodeStrictBase64(value: string): Uint8Array | null {
  if (value.length === 0 || value.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) return null;
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function u32be(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

function u32le(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

function u24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

type Dimensions = { width: number; height: number } | LiteLogoRefusal;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const APNG_CHUNKS = new Set(['acTL', 'fcTL', 'fdAT']);

function pngDimensions(bytes: Uint8Array): Dimensions {
  if (bytes.length < 8 || PNG_SIGNATURE.some((value, index) => bytes[index] !== value)) {
    return 'malformed';
  }
  let offset = 8;
  let dimensions: { width: number; height: number } | null = null;
  let ended = false;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) return 'malformed';
    const length = u32be(bytes, offset);
    const type = ascii(bytes, offset + 4, 4);
    const next = offset + 12 + length;
    if (next > bytes.length) return 'malformed';
    if (dimensions === null) {
      // IHDR comes first and holds 13 bytes.
      if (type !== 'IHDR' || length !== 13) return 'malformed';
      dimensions = { width: u32be(bytes, offset + 8), height: u32be(bytes, offset + 12) };
    } else if (type === 'IHDR') {
      return 'malformed';
    }
    if (APNG_CHUNKS.has(type)) return 'animated';
    offset = next;
    if (type === 'IEND') {
      ended = true;
      break;
    }
  }
  if (!ended || offset !== bytes.length || !dimensions) return 'malformed';
  return dimensions;
}

function webpDimensions(bytes: Uint8Array): Dimensions {
  if (bytes.length < 20 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') {
    return 'malformed';
  }
  if (u32le(bytes, 4) !== bytes.length - 8) return 'malformed';
  let offset = 12;
  let dimensions: { width: number; height: number } | null = null;
  let first = true;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) return 'malformed';
    const type = ascii(bytes, offset, 4);
    const length = u32le(bytes, offset + 4);
    const data = offset + 8;
    const next = data + length + (length % 2);
    if (data + length > bytes.length || next > bytes.length) return 'malformed';
    if (type === 'ANIM' || type === 'ANMF') return 'animated';
    if (first) {
      if (type === 'VP8X') {
        if (length < 10) return 'malformed';
        // Bit 1 of the flags: the file is an animation.
        if ((bytes[data] & 0x02) !== 0) return 'animated';
        dimensions = { width: u24le(bytes, data + 4) + 1, height: u24le(bytes, data + 7) + 1 };
      } else if (type === 'VP8 ') {
        // A key frame: 3 bytes of frame tag, the start code 9d 01 2a, then 14-bit sizes.
        if (length < 10) return 'malformed';
        if (bytes[data + 3] !== 0x9d || bytes[data + 4] !== 0x01 || bytes[data + 5] !== 0x2a) {
          return 'malformed';
        }
        dimensions = {
          width: (bytes[data + 6] | (bytes[data + 7] << 8)) & 0x3fff,
          height: (bytes[data + 8] | (bytes[data + 9] << 8)) & 0x3fff,
        };
      } else if (type === 'VP8L') {
        // The signature 0x2f, then 14 bits of width - 1 and 14 bits of height - 1.
        if (length < 5 || bytes[data] !== 0x2f) return 'malformed';
        const bits = u32le(bytes, data + 1);
        dimensions = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      } else {
        return 'malformed';
      }
      first = false;
    }
    offset = next;
  }
  if (offset !== bytes.length || !dimensions) return 'malformed';
  return dimensions;
}

/** Checks a lite logo `data:` URI (see the module comment). */
export function checkLiteLogoDataUri(value: unknown): LiteLogoCheck {
  if (typeof value !== 'string' || !value.startsWith('data:')) {
    return { ok: false, reason: 'not_data_uri' };
  }
  const match = PREFIXES.find(([prefix]) => value.startsWith(prefix));
  if (!match) return { ok: false, reason: 'unsupported_type' };
  const [prefix, mimeType] = match;
  const encoded = value.slice(prefix.length);
  if (encoded.length > MAX_BASE64_LENGTH) return { ok: false, reason: 'too_large' };
  const bytes = decodeStrictBase64(encoded);
  if (!bytes) return { ok: false, reason: 'invalid_base64' };
  if (bytes.length > LITE_LOGO_MAX_BYTES) return { ok: false, reason: 'too_large' };
  const dimensions = mimeType === 'image/png' ? pngDimensions(bytes) : webpDimensions(bytes);
  if (typeof dimensions === 'string') return { ok: false, reason: dimensions };
  if (dimensions.width < 1 || dimensions.height < 1) return { ok: false, reason: 'malformed' };
  if (dimensions.width > LITE_LOGO_MAX_WIDTH) return { ok: false, reason: 'too_wide' };
  if (dimensions.height > LITE_LOGO_MAX_HEIGHT) return { ok: false, reason: 'too_tall' };
  return {
    ok: true,
    mimeType,
    width: dimensions.width,
    height: dimensions.height,
    bytes: bytes.length,
  };
}
