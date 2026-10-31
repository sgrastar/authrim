import { describe, expect, it, vi } from 'vitest';
import { readTenantBackupInputFrame } from '../input-frame-reader';

function fixture() {
  const bytes = new Uint8Array([
    ...new TextEncoder().encode('AUTHRIM1'),
    0,
    0,
    0,
    2,
    41,
    42,
    0,
    0,
    0,
    1,
    43,
  ]);
  const identity = { key: 'operation/input', version: 'v1', etag: 'e1', size: bytes.length };
  const get = vi.fn(
    async (_key: string, options: { range: { offset: number; length: number } }) => ({
      ...identity,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            bytes.slice(options.range.offset, options.range.offset + options.range.length)
          );
          controller.close();
        },
      }),
    })
  );
  return {
    bytes,
    get,
    input: {
      bucket: { get },
      identity,
      cursor: { offset: 0, frames: 0 },
      limits: { maxTotalBytes: 100, maxFrames: 2 },
      signal: new AbortController().signal,
      assertAuthorized: vi.fn(async () => {}),
    },
  };
}
describe('immutable input frame ranges', () => {
  it('resumes at each frame and verifies EOF without replaying earlier frames', async () => {
    const { input, get } = fixture();
    const first = await readTenantBackupInputFrame(input);
    expect(first?.payload).toEqual(new Uint8Array([41, 42]));
    get.mockClear();
    const second = await readTenantBackupInputFrame({ ...input, cursor: first!.cursor });
    expect(second?.payload).toEqual(new Uint8Array([43]));
    expect(get.mock.calls.map((call) => call[1].range.offset)).toEqual([14, 18]);
    expect(await readTenantBackupInputFrame({ ...input, cursor: second!.cursor })).toBeNull();
    expect(get).toHaveBeenLastCalledWith(input.identity.key, {
      range: { offset: 18, length: 1 },
      onlyIf: { etagMatches: 'e1' },
    });
  });
  it('rejects replacement between ranges, including the same ETag with a different version', async () => {
    const { input, get } = fixture();
    const original = get.getMockImplementation()!;
    get.mockImplementation(async (key, options) => ({
      ...(await original(key, options)),
      version: options.range.offset ? 'v2' : 'v1',
    }));
    await expect(readTenantBackupInputFrame(input)).rejects.toThrow('backup_input_read_failed');
    expect(input.cursor).toEqual({ offset: 0, frames: 0 });
  });
  it('rejects truncated and oversized range bodies and cancels an oversized response', async () => {
    for (const size of [7, 9]) {
      const { input, get } = fixture();
      const cancel = vi.fn();
      get.mockImplementation(async () => ({
        ...input.identity,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(size));
            if (size === 7) controller.close();
          },
          cancel,
        }),
      }));
      await expect(readTenantBackupInputFrame(input)).rejects.toThrow('backup_input_read_failed');
      if (size === 9) expect(cancel).toHaveBeenCalledOnce();
    }
  });
  it('rejects malformed lengths, truncation, limits and revoked authorization', async () => {
    const { input, bytes } = fixture();
    bytes[11] = 100;
    await expect(readTenantBackupInputFrame(input)).rejects.toThrow('backup_input_read_failed');
    bytes[11] = 0;
    await expect(readTenantBackupInputFrame(input)).rejects.toThrow('backup_input_read_failed');
    await expect(
      readTenantBackupInputFrame({ ...input, limits: { maxTotalBytes: 18, maxFrames: 2 } })
    ).rejects.toThrow();
    input.assertAuthorized.mockRejectedValue(new Error('revoked'));
    await expect(readTenantBackupInputFrame(input)).rejects.toThrow('revoked');
  });
});
