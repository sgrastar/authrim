import { Buffer } from 'node:buffer';
import { gunzipSync } from 'node:zlib';

const MAX_DECOMPRESSED_SECRET_BYTES = 4 * 1024 * 1024;

export function decodeGzipBase64Secret(name, value) {
  const normalized = value.replace(/\s+/g, '');
  if (!normalized || normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new Error(`${name} is not valid base64`);
  }

  try {
    return gunzipSync(Buffer.from(normalized, 'base64'), {
      maxOutputLength: MAX_DECOMPRESSED_SECRET_BYTES,
    }).toString('utf8');
  } catch (error) {
    throw new Error(
      `${name} is not valid gzip data: ${error instanceof Error ? error.message : error}`,
      { cause: error }
    );
  }
}
