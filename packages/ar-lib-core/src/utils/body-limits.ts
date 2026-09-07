const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;

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
        throw new Error(`Body exceeds maximum size: ${totalBytes} > ${maxBytes} bytes`);
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
      throw new Error(`Body exceeds maximum size: ${parsed} > ${maxBytes} bytes`);
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
