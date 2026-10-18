import { describe, expect, it } from 'vitest';
import {
  BodyLimitExceededError,
  readRequestBytesWithLimit,
  readRequestTextWithLimit,
} from '../body-limits';

describe('body limit utilities', () => {
  it('reads request text within the configured byte limit', async () => {
    const request = new Request('https://auth.example.test/body', {
      method: 'POST',
      body: 'hello',
    });

    await expect(readRequestTextWithLimit(request, 5)).resolves.toBe('hello');
  });

  it('rejects request text that exceeds the configured byte limit', async () => {
    const request = new Request('https://auth.example.test/body', {
      method: 'POST',
      body: 'hello!',
    });

    await expect(readRequestTextWithLimit(request, 5)).rejects.toThrow('Body exceeds maximum size');
  });

  it('preserves non-UTF-8 request bytes exactly', async () => {
    const expected = new Uint8Array([0x00, 0xff, 0xfe, 0x41]);
    const request = new Request('https://auth.example.test/body', {
      method: 'POST',
      body: expected,
    });

    const body = await readRequestBytesWithLimit(request, expected.byteLength);

    expect(new Uint8Array(body)).toEqual(expected);
  });

  it('cancels a stream as soon as its body exceeds the byte limit', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request('https://auth.example.test/body', {
      method: 'POST',
      body: stream,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    await expect(readRequestBytesWithLimit(request, 4)).rejects.toThrow(
      'Body exceeds maximum size'
    );
    expect(cancelled).toBe(true);
  });

  it('reports a counted overrun as BodyLimitExceededError with the same message', async () => {
    const request = new Request('https://auth.example.test/body', {
      method: 'POST',
      body: 'hello!',
    });

    const error = await readRequestBytesWithLimit(request, 5).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BodyLimitExceededError);
    expect((error as BodyLimitExceededError).message).toBe(
      'Body exceeds maximum size: 6 > 5 bytes'
    );
    expect((error as BodyLimitExceededError).maxBytes).toBe(5);
  });

  it('reports an over-limit Content-Length as BodyLimitExceededError without reading', async () => {
    let pulled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled = true;
          controller.enqueue(new Uint8Array([1]));
        },
      },
      { highWaterMark: 0 }
    );
    const request = new Request('https://auth.example.test/body', {
      method: 'POST',
      headers: { 'Content-Length': '100' },
      body: stream,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    await expect(readRequestBytesWithLimit(request, 5)).rejects.toBeInstanceOf(
      BodyLimitExceededError
    );
    expect(pulled).toBe(false);
  });

  it('does not report a stream failure as BodyLimitExceededError', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('connection reset'));
      },
    });
    const request = new Request('https://auth.example.test/body', {
      method: 'POST',
      body: stream,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    const error = await readRequestBytesWithLimit(request, 5).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(BodyLimitExceededError);
  });
});
