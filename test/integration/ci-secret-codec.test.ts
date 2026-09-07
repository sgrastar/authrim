import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeGzipBase64Secret } from '../../scripts/lib/ci-secret-codec.mjs';

describe('CI secret codec', () => {
  it('restores gzip-compressed JSON from base64 with optional whitespace', () => {
    expect.hasAssertions();
    const json = JSON.stringify({ env: 'test', resources: ['alpha', 'beta'] });
    const encoded = gzipSync(json).toString('base64');
    const wrapped = `${encoded.slice(0, 20)}\n${encoded.slice(20)}`;

    expect(decodeGzipBase64Secret('LOCK', wrapped)).toBe(json);
  });

  it('rejects malformed base64', () => {
    expect.hasAssertions();
    expect(() => decodeGzipBase64Secret('LOCK', 'not-base64!')).toThrow('LOCK is not valid base64');
  });

  it('rejects base64 that is not gzip data', () => {
    expect.hasAssertions();
    expect(() =>
      decodeGzipBase64Secret('LOCK', Buffer.from('plain text').toString('base64'))
    ).toThrow('LOCK is not valid gzip data');
  });

  it('rejects decompressed values larger than the restoration limit', () => {
    expect.hasAssertions();
    const encoded = gzipSync('x'.repeat(4 * 1024 * 1024 + 1)).toString('base64');

    expect(() => decodeGzipBase64Secret('LOCK', encoded)).toThrow('LOCK is not valid gzip data');
  });
});
