import { describe, expect, it } from 'vitest';
import { readRequestBytesWithLimit, readRequestTextWithLimit } from '../body-limits';

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
});
