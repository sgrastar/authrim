async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  declaredLength: string | null,
  maximumBytes: number,
  errorCode: string
): Promise<ArrayBuffer> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new Error('plugin_response_limit_invalid');
  }
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > maximumBytes) {
      await body?.cancel();
      throw new Error(errorCode);
    }
  }
  if (!body) return new ArrayBuffer(0);

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel(errorCode);
        throw new Error(errorCode);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof Error && error.message === errorCode) throw error;
    throw new Error('plugin_response_read_failed');
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

export function readBoundedRequestBody(
  request: Request,
  maximumBytes: number,
  errorCode: string
): Promise<ArrayBuffer> {
  return readBoundedBody(
    request.body as ReadableStream<Uint8Array> | null,
    request.headers.get('Content-Length'),
    maximumBytes,
    errorCode
  );
}

export function readBoundedResponseBody(
  response: Response,
  maximumBytes: number,
  errorCode: string
): Promise<ArrayBuffer> {
  return readBoundedBody(
    response.body as ReadableStream<Uint8Array> | null,
    response.headers.get('Content-Length'),
    maximumBytes,
    errorCode
  );
}
