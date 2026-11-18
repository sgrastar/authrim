/**
 * SAML message size limits: POST form parsing paths, base64/DEFLATE bounds and streaming inflate.
 */

import { describe, expect, it } from 'vitest';
import * as pako from 'pako';
import {
  SAML_MESSAGE_LIMITS,
  parsePostBindingFormDataWithLimit,
  decodePostBindingMessage,
  inflateRedirectBindingMessage,
  inflateRawToStringLimited,
  bytesToBinaryString,
} from '../message-limits';

const toBase64 = (bytes: Uint8Array) => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};
const deflateBase64 = (text: string) => toBase64(pako.deflateRaw(new TextEncoder().encode(text)));

describe('parsePostBindingFormDataWithLimit', () => {
  it('should use the formData() of a request-like object without a raw Request', async () => {
    const formData = new FormData();
    formData.append('SAMLResponse', 'abc');
    const result = await parsePostBindingFormDataWithLimit({ formData: async () => formData });
    expect(result.get('SAMLResponse')).toBe('abc');
  });

  it('should reject a request-like object with neither raw Request nor formData()', async () => {
    await expect(parsePostBindingFormDataWithLimit({})).rejects.toThrow(
      new Error('Invalid SAML POST request')
    );
  });

  it('should read the raw Request wrapped in a request-like object', async () => {
    const raw = new Request('https://sp.example.test/acs', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body: 'SAMLResponse=a%2Bb&RelayState=r%20s',
    });
    const result = await parsePostBindingFormDataWithLimit({ raw });
    expect(result.get('SAMLResponse')).toBe('a+b');
    expect(result.get('RelayState')).toBe('r s');
  });

  it('should ignore a non-numeric content-length header', async () => {
    const request = new Request('https://sp.example.test/acs', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': 'many' },
      body: 'SAMLResponse=x',
    });
    expect((await parsePostBindingFormDataWithLimit(request)).get('SAMLResponse')).toBe('x');
  });

  it('should accept a content-length exactly at the limit header-wise', async () => {
    const request = new Request('https://sp.example.test/acs', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': String(SAML_MESSAGE_LIMITS.postBodyBytes),
      },
      body: 'SAMLResponse=x',
    });
    expect((await parsePostBindingFormDataWithLimit(request)).get('SAMLResponse')).toBe('x');
  });

  it('should stop reading a streamed body that grows past the limit', async () => {
    const chunk = new Uint8Array(64 * 1024).fill(0x61);
    let pushed = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pushed >= SAML_MESSAGE_LIMITS.postBodyBytes + chunk.length) {
          controller.close();
          return;
        }
        pushed += chunk.length;
        controller.enqueue(chunk);
      },
    });
    const request = new Request('https://sp.example.test/acs', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      // @ts-expect-error Node's undici needs duplex for streamed bodies
      duplex: 'half',
    });
    await expect(parsePostBindingFormDataWithLimit(request)).rejects.toThrow(
      new Error('SAML POST body exceeds maximum size')
    );
  });

  it('should parse multipart form data through a bounded copy of the body', async () => {
    const formData = new FormData();
    formData.append('SAMLRequest', 'req-value');
    formData.append('RelayState', 'rs');
    const request = new Request('https://sp.example.test/slo', { method: 'POST', body: formData });
    expect(request.headers.get('content-type')).toContain('multipart/form-data');
    const result = await parsePostBindingFormDataWithLimit(request);
    expect(result.get('SAMLRequest')).toBe('req-value');
    expect(result.get('RelayState')).toBe('rs');
  });

  it('should return an empty form for a urlencoded request without a body', async () => {
    const request = new Request('https://sp.example.test/acs', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const result = await parsePostBindingFormDataWithLimit(request);
    expect([...result.keys()]).toEqual([]);
  });
});

describe('decodePostBindingMessage', () => {
  it('should decode base64 within the limits', () => {
    expect(decodePostBindingMessage(btoa('<Response/>'), 'SAMLResponse')).toBe('<Response/>');
  });

  it('should reject an encoded message above the encoded limit', () => {
    const encoded = 'A'.repeat(SAML_MESSAGE_LIMITS.postEncodedChars + 1);
    expect(() => decodePostBindingMessage(encoded, 'SAMLResponse')).toThrow(
      new Error('SAMLResponse exceeds maximum encoded size')
    );
  });

  it('should reject a message whose decoded form exceeds the decoded limit', () => {
    const encoded = btoa('a'.repeat(SAML_MESSAGE_LIMITS.postDecodedChars + 1));
    expect(encoded.length).toBeLessThanOrEqual(SAML_MESSAGE_LIMITS.postEncodedChars);
    expect(() => decodePostBindingMessage(encoded, 'SAMLRequest')).toThrow(
      new Error('SAMLRequest exceeds maximum decoded size')
    );
  });
});

describe('inflateRedirectBindingMessage', () => {
  it('should inflate a DEFLATE + base64 message, including multi-byte text', () => {
    const xml = `<LogoutRequest>${'山田太郎🙂'.repeat(5000)}</LogoutRequest>`;
    expect(inflateRedirectBindingMessage(deflateBase64(xml), 'SAMLRequest')).toBe(xml);
  });

  it('should reject an encoded message above the encoded limit', () => {
    const encoded = 'A'.repeat(SAML_MESSAGE_LIMITS.redirectEncodedChars + 1);
    expect(() => inflateRedirectBindingMessage(encoded, 'SAMLRequest')).toThrow(
      new Error('SAMLRequest exceeds maximum encoded size')
    );
  });

  it('should reject compressed bytes above the compressed limit', () => {
    // Random bytes do not compress; feed them as if they were the compressed payload
    const bytes = new Uint8Array(SAML_MESSAGE_LIMITS.redirectCompressedBytes + 1);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff;
    expect(() => inflateRedirectBindingMessage(toBase64(bytes), 'SAMLResponse')).toThrow(
      new Error('SAMLResponse exceeds maximum compressed size')
    );
  });

  it('should stop inflating a message that expands past the inflated limit', () => {
    // 300K identical characters compress to a few hundred bytes
    const encoded = deflateBase64('a'.repeat(SAML_MESSAGE_LIMITS.redirectInflatedChars + 1));
    expect(encoded.length).toBeLessThan(2000);
    expect(() => inflateRedirectBindingMessage(encoded, 'SAMLRequest')).toThrow(
      new Error('SAMLRequest exceeds maximum inflated size')
    );
  });

  it('should reject data that is not a raw DEFLATE stream', () => {
    expect(() =>
      inflateRedirectBindingMessage(btoa('definitely not deflate'), 'SAMLRequest')
    ).toThrow(/invalid|Invalid compressed SAMLRequest/);
  });
});

describe('inflateRawToStringLimited', () => {
  it('should accept output exactly at the limit and reject one character more', () => {
    const exact = pako.deflateRaw(new TextEncoder().encode('b'.repeat(10)));
    expect(inflateRawToStringLimited(exact, 10, 'X')).toBe('b'.repeat(10));
    expect(() => inflateRawToStringLimited(exact, 9, 'X')).toThrow(
      new Error('X exceeds maximum inflated size')
    );
  });

  it('should report an incomplete stream as invalid', () => {
    const complete = pako.deflateRaw(new TextEncoder().encode('hello world '.repeat(100)));
    expect(() =>
      inflateRawToStringLimited(complete.slice(0, complete.length - 4), 100_000, 'SAMLRequest')
    ).toThrow();
  });
});

describe('bytesToBinaryString', () => {
  it('should convert bytes to a latin1 string across chunk boundaries', () => {
    const bytes = new Uint8Array(8192 * 2 + 5);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
    const result = bytesToBinaryString(bytes);
    expect(result.length).toBe(bytes.length);
    expect(result.charCodeAt(0)).toBe(0);
    expect(result.charCodeAt(8192)).toBe(8192 & 0xff);
    expect(result.charCodeAt(bytes.length - 1)).toBe((bytes.length - 1) & 0xff);
    expect(bytesToBinaryString(new Uint8Array())).toBe('');
  });
});
