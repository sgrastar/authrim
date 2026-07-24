import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, expect, it } from 'vitest';
import { createSourceByteLimitStream } from '../core/source';

describe('source archive limits', () => {
  it('rejects streamed data after the configured byte ceiling without relying on Content-Length', async () => {
    const source = Readable.from([Buffer.alloc(6), Buffer.alloc(5)]);
    await expect(
      pipeline(source, createSourceByteLimitStream(10, 'Expanded source archive'))
    ).rejects.toThrow('Expanded source archive exceeds maximum size');
  });

  it('allows a stream exactly at the configured byte ceiling', async () => {
    const source = Readable.from([Buffer.alloc(4), Buffer.alloc(6)]);
    await expect(
      pipeline(source, createSourceByteLimitStream(10, 'Source tarball'))
    ).resolves.toBeUndefined();
  });
});
