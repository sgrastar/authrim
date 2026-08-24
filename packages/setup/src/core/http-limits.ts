const DEFAULT_SETUP_FETCH_TIMEOUT_MS = 30000;
const DEFAULT_SETUP_JSON_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_SETUP_ERROR_LIMIT_BYTES = 16 * 1024;

export async function fetchWithTimeout(
  input: string | URL | Request,
  init: globalThis.RequestInit = {},
  timeoutMs = DEFAULT_SETUP_FETCH_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromCaller = () => controller.abort();
  if (init.signal?.aborted) {
    controller.abort();
  } else {
    init.signal?.addEventListener('abort', abortFromCaller, { once: true });
  }

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
    init.signal?.removeEventListener('abort', abortFromCaller);
  }
}

export async function readResponseTextWithLimit(
  response: Response,
  maxBytes = DEFAULT_SETUP_ERROR_LIMIT_BYTES
): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength) {
    const parsed = Number.parseInt(contentLength, 10);
    if (Number.isFinite(parsed) && parsed > maxBytes) {
      throw new Error(`Response body exceeds maximum size: ${parsed} > ${maxBytes} bytes`);
    }
  }

  if (!response.body) {
    const text = await response.text();
    const byteLength = new TextEncoder().encode(text).byteLength;
    if (byteLength > maxBytes) {
      throw new Error(`Response body exceeds maximum size: ${byteLength} > ${maxBytes} bytes`);
    }
    return text;
  }

  const reader = response.body.getReader();
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
        throw new Error(`Response body exceeds maximum size: ${totalBytes} > ${maxBytes} bytes`);
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

export async function readResponseJsonWithLimit<T>(
  response: Response,
  maxBytes = DEFAULT_SETUP_JSON_LIMIT_BYTES
): Promise<T> {
  return JSON.parse(await readResponseTextWithLimit(response, maxBytes)) as T;
}
