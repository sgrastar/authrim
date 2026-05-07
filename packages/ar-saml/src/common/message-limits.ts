import * as pako from 'pako';
import { base64Decode } from './xml-utils';

export const SAML_MESSAGE_LIMITS = {
  postBodyBytes: 3 * 1024 * 1024,
  postEncodedChars: 2 * 1024 * 1024,
  postDecodedChars: 768 * 1024,
  redirectEncodedChars: 128 * 1024,
  redirectCompressedBytes: 64 * 1024,
  redirectInflatedChars: 512 * 1024,
} as const;

type PostBindingRequestLike = Request | {
  raw?: Request;
  formData?: () => Promise<FormData>;
};

export async function parsePostBindingFormDataWithLimit(
  requestLike: PostBindingRequestLike
): Promise<FormData> {
  const rawRequest =
    requestLike instanceof Request
      ? requestLike
      : requestLike.raw instanceof Request
        ? requestLike.raw
        : undefined;

  if (!rawRequest) {
    if (typeof (requestLike as { formData?: () => Promise<FormData> }).formData === 'function') {
      return (requestLike as { formData: () => Promise<FormData> }).formData();
    }
    throw new Error('Invalid SAML POST request');
  }

  const contentLength = rawRequest.headers.get('content-length');
  if (contentLength) {
    const parsed = Number.parseInt(contentLength, 10);
    if (Number.isFinite(parsed) && parsed > SAML_MESSAGE_LIMITS.postBodyBytes) {
      throw new Error('SAML POST body exceeds maximum size');
    }
  }

  const contentType = rawRequest.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const body = await readRequestTextWithLimit(rawRequest, SAML_MESSAGE_LIMITS.postBodyBytes);
    const params = new URLSearchParams(body);
    const formData = new FormData();
    for (const [key, value] of params.entries()) {
      formData.append(key, value);
    }
    return formData;
  }

  return rawRequest.formData();
}

async function readRequestTextWithLimit(request: Request, maxBytes: number): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) {
    return '';
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new Error(`SAML POST body exceeds maximum size`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(body);
}

export function decodePostBindingMessage(encoded: string, label: string): string {
  if (encoded.length > SAML_MESSAGE_LIMITS.postEncodedChars) {
    throw new Error(`${label} exceeds maximum encoded size`);
  }

  const decoded = base64Decode(encoded);
  if (decoded.length > SAML_MESSAGE_LIMITS.postDecodedChars) {
    throw new Error(`${label} exceeds maximum decoded size`);
  }

  return decoded;
}

export function inflateRedirectBindingMessage(encoded: string, label: string): string {
  if (encoded.length > SAML_MESSAGE_LIMITS.redirectEncodedChars) {
    throw new Error(`${label} exceeds maximum encoded size`);
  }

  const decoded = base64Decode(encoded);
  const compressed = Uint8Array.from(decoded, (c) => c.charCodeAt(0));
  if (compressed.byteLength > SAML_MESSAGE_LIMITS.redirectCompressedBytes) {
    throw new Error(`${label} exceeds maximum compressed size`);
  }

  return inflateRawToStringLimited(
    compressed,
    SAML_MESSAGE_LIMITS.redirectInflatedChars,
    label
  );
}

export function inflateRawToStringLimited(
  compressed: Uint8Array,
  maxInflatedChars: number,
  label: string
): string {
  const decoder = new TextDecoder();
  const inflator = new pako.Inflate({ raw: true, to: 'string', chunkSize: 16 * 1024 });
  let result = '';

  inflator.onData = (chunk) => {
    const text =
      typeof chunk === 'string'
        ? chunk
        : decoder.decode(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
    if (result.length + text.length > maxInflatedChars) {
      throw new Error(`${label} exceeds maximum inflated size`);
    }
    result += text;
  };

  inflator.push(compressed, true);
  if (inflator.err) {
    throw new Error(inflator.msg || `Invalid compressed ${label}`);
  }

  return result;
}

export function bytesToBinaryString(bytes: Uint8Array): string {
  const chunkSize = 8192;
  let output = '';

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    output += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }

  return output;
}
