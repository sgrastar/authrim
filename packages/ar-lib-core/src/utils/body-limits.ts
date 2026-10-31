const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;

/**
 * Thrown when a body (declared by Content-Length or counted from the stream)
 * exceeds the byte limit. Callers that must answer "too large" differently from
 * a broken stream can tell the two apart with `instanceof`. The message format is
 * unchanged for callers that only match on text.
 */
export class BodyLimitExceededError extends Error {
  constructor(
    readonly observedBytes: number,
    readonly maxBytes: number
  ) {
    super(`Body exceeds maximum size: ${observedBytes} > ${maxBytes} bytes`);
    this.name = 'BodyLimitExceededError';
  }
}

export async function readStreamTextWithLimit(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes = DEFAULT_BODY_LIMIT_BYTES
): Promise<string> {
  const body = await readStreamBytesWithLimit(stream, maxBytes);
  return new TextDecoder().decode(body);
}

export async function readStreamBytesWithLimit(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes = DEFAULT_BODY_LIMIT_BYTES
): Promise<ArrayBuffer> {
  if (maxBytes <= 0) {
    throw new Error('Body size limit must be greater than zero');
  }
  if (!stream) {
    return new ArrayBuffer(0);
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new BodyLimitExceededError(totalBytes, maxBytes);
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

  return body.buffer;
}

export async function readRequestBytesWithLimit(
  request: Request,
  maxBytes = DEFAULT_BODY_LIMIT_BYTES
): Promise<ArrayBuffer> {
  const contentLength = request.headers.get('content-length');
  if (contentLength) {
    const parsed = Number.parseInt(contentLength, 10);
    if (Number.isFinite(parsed) && parsed > maxBytes) {
      throw new BodyLimitExceededError(parsed, maxBytes);
    }
  }

  return readStreamBytesWithLimit(request.body, maxBytes);
}

export async function readRequestTextWithLimit(
  request: Request,
  maxBytes = DEFAULT_BODY_LIMIT_BYTES
): Promise<string> {
  const body = await readRequestBytesWithLimit(request, maxBytes);
  return new TextDecoder().decode(body);
}

export async function readRequestJsonWithLimit<T>(
  request: Request,
  maxBytes = DEFAULT_BODY_LIMIT_BYTES
): Promise<T> {
  const text = await readRequestTextWithLimit(request, maxBytes);
  return JSON.parse(text) as T;
}

export async function readR2ObjectTextWithLimit(
  object: R2ObjectBody,
  maxBytes = DEFAULT_BODY_LIMIT_BYTES
): Promise<string> {
  if (typeof object.size === 'number' && object.size > maxBytes) {
    throw new Error(`Object exceeds maximum size: ${object.size} > ${maxBytes} bytes`);
  }

  if (object.body) {
    return readStreamTextWithLimit(object.body, maxBytes);
  }

  const text = await object.text();
  const byteLength = new TextEncoder().encode(text).byteLength;
  if (byteLength > maxBytes) {
    throw new Error(`Object exceeds maximum size: ${byteLength} > ${maxBytes} bytes`);
  }
  return text;
}
