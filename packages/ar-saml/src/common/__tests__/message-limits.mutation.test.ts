/**
 * Exact size boundaries of the SAML message limits: POST body bytes, encoded/decoded characters
 * and the HTTP-Redirect compressed and inflated sizes.
 */

import { describe, expect, it } from 'vitest';
import * as pako from 'pako';
import {
  SAML_MESSAGE_LIMITS,
  bytesToBinaryString,
  decodePostBindingMessage,
  inflateRawToStringLimited,
  inflateRedirectBindingMessage,
  parsePostBindingFormDataWithLimit,
} from '../message-limits';

const toBase64 = (bytes: Uint8Array) => btoa(bytesToBinaryString(bytes));

/** A raw DEFLATE stream of one stored block holding `length` bytes of "a". */
function storedBlock(length: number): Uint8Array {
  const out = new Uint8Array(5 + length);
  out[0] = 0x01; // BFINAL = 1, BTYPE = 00 (stored)
  out[1] = length & 0xff;
  out[2] = length >> 8;
  out[3] = ~length & 0xff;
  out[4] = (~length >> 8) & 0xff;
  out.fill(0x61, 5);
  return out;
}

function formRequest(bodyBytes: number, headers: Record<string, string> = {}) {
  const prefix = 'SAMLRequest=';
  return new Request('https://tenant.example.test/acs', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: prefix + 'a'.repeat(bodyBytes - prefix.length),
  });
}

describe('parsePostBindingFormDataWithLimit', () => {
  it('accepts a body of exactly the limit and rejects one byte more', async () => {
    const ok = await parsePostBindingFormDataWithLimit(
      formRequest(SAML_MESSAGE_LIMITS.postBodyBytes)
    );
    expect((ok.get('SAMLRequest') as string).length).toBe(
      SAML_MESSAGE_LIMITS.postBodyBytes - 'SAMLRequest='.length
    );

    await expect(
      parsePostBindingFormDataWithLimit(formRequest(SAML_MESSAGE_LIMITS.postBodyBytes + 1))
    ).rejects.toThrow('SAML POST body exceeds maximum size');
  });

  it('rejects an oversized declared Content-Length without reading the body', async () => {
    const request = new Request('https://tenant.example.test/acs', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': String(SAML_MESSAGE_LIMITS.postBodyBytes + 1),
      },
      body: 'SAMLRequest=a',
    });

    await expect(parsePostBindingFormDataWithLimit(request)).rejects.toThrow(
      'SAML POST body exceeds maximum size'
    );
  });

  it('ignores a Content-Length that is within the limit or not a number', async () => {
    const within = formRequest(100, {
      'content-length': String(SAML_MESSAGE_LIMITS.postBodyBytes),
    });
    const garbage = formRequest(100, { 'content-length': 'many' });

    expect((await parsePostBindingFormDataWithLimit(within)).has('SAMLRequest')).toBe(true);
    expect((await parsePostBindingFormDataWithLimit(garbage)).has('SAMLRequest')).toBe(true);
  });

  it('parses urlencoded fields in order and decodes percent-escapes and plus signs', async () => {
    const request = new Request('https://tenant.example.test/acs', {
      method: 'POST',
      headers: { 'content-type': 'Application/X-WWW-Form-Urlencoded; charset=UTF-8' },
      body: 'SAMLResponse=a%2Bb+c&RelayState=r&RelayState=s',
    });

    const form = await parsePostBindingFormDataWithLimit(request);

    expect(form.get('SAMLResponse')).toBe('a+b c');
    expect(form.getAll('RelayState')).toEqual(['r', 's']);
  });

  it('parses multipart bodies and applies the same size limit', async () => {
    const multipart = new FormData();
    multipart.set('SAMLRequest', 'abc');
    const source = new Request('https://tenant.example.test/acs', {
      method: 'POST',
      body: multipart,
    });

    const form = await parsePostBindingFormDataWithLimit(source);
    expect(form.get('SAMLRequest')).toBe('abc');

    const big = new FormData();
    big.set('SAMLRequest', 'a'.repeat(SAML_MESSAGE_LIMITS.postBodyBytes));
    await expect(
      parsePostBindingFormDataWithLimit(
        new Request('https://tenant.example.test/acs', { method: 'POST', body: big })
      )
    ).rejects.toThrow('SAML POST body exceeds maximum size');
  });

  it('refuses other content types, including a missing one', async () => {
    const json = new Request('https://tenant.example.test/acs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const none = new Request('https://tenant.example.test/acs', { method: 'POST' });

    for (const request of [json, none]) {
      await expect(parsePostBindingFormDataWithLimit(request)).rejects.toThrow(
        'SAML POST binding requires application/x-www-form-urlencoded'
      );
    }
  });

  it('uses the raw request of a framework request, or its formData(), else refuses', async () => {
    const raw = formRequest(100);
    const rawForm = await parsePostBindingFormDataWithLimit({ raw });
    expect((rawForm.get('SAMLRequest') as string).length).toBe(88);

    const form = new FormData();
    form.set('k', 'v');
    expect((await parsePostBindingFormDataWithLimit({ formData: async () => form })).get('k')).toBe(
      'v'
    );
    await expect(parsePostBindingFormDataWithLimit({})).rejects.toThrow(
      'Invalid SAML POST request'
    );
  });

  it('treats a request without a body as an empty form', async () => {
    const request = new Request('https://tenant.example.test/acs', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });

    expect([...(await parsePostBindingFormDataWithLimit(request)).keys()]).toEqual([]);
  });
});

describe('decodePostBindingMessage', () => {
  it('accepts an encoded message of exactly the limit and rejects one character more', () => {
    const exact = 'A'.repeat(SAML_MESSAGE_LIMITS.postEncodedChars);

    // 393216 base64 characters decode to 294912 characters, beyond the decoded limit.
    expect(() => decodePostBindingMessage(exact, 'X')).toThrow('X exceeds maximum decoded size');
    expect(() => decodePostBindingMessage(`${exact}A`, 'X')).toThrow(
      'X exceeds maximum encoded size'
    );
  });

  it('accepts a decoded message of exactly the limit and rejects one character more', () => {
    const exact = btoa('a'.repeat(SAML_MESSAGE_LIMITS.postDecodedChars));

    expect(decodePostBindingMessage(exact, 'X')).toHaveLength(SAML_MESSAGE_LIMITS.postDecodedChars);
    expect(() =>
      decodePostBindingMessage(btoa('a'.repeat(SAML_MESSAGE_LIMITS.postDecodedChars + 1)), 'X')
    ).toThrow('X exceeds maximum decoded size');
  });
});

describe('inflateRedirectBindingMessage', () => {
  it('refuses an encoded message longer than the limit before decoding it', () => {
    expect(() =>
      inflateRedirectBindingMessage('A'.repeat(SAML_MESSAGE_LIMITS.redirectEncodedChars + 1), 'X')
    ).toThrow('X exceeds maximum encoded size');
  });

  it('lets an encoded message of exactly the limit reach the compressed-size check', () => {
    expect(() =>
      inflateRedirectBindingMessage('A'.repeat(SAML_MESSAGE_LIMITS.redirectEncodedChars), 'X')
    ).toThrow('X exceeds maximum compressed size');
  });

  it('accepts compressed data of exactly the limit and refuses one byte more', () => {
    const exact = storedBlock(SAML_MESSAGE_LIMITS.redirectCompressedBytes - 5);
    expect(exact.byteLength).toBe(SAML_MESSAGE_LIMITS.redirectCompressedBytes);

    expect(inflateRedirectBindingMessage(toBase64(exact), 'X')).toHaveLength(
      SAML_MESSAGE_LIMITS.redirectCompressedBytes - 5
    );
    expect(() =>
      inflateRedirectBindingMessage(
        toBase64(storedBlock(SAML_MESSAGE_LIMITS.redirectCompressedBytes - 4)),
        'X'
      )
    ).toThrow('X exceeds maximum compressed size');
  });

  it('inflates a normal deflated message', () => {
    const xml = '<samlp:AuthnRequest>ünïcode</samlp:AuthnRequest>';

    expect(inflateRedirectBindingMessage(toBase64(pako.deflateRaw(xml)), 'X')).toBe(xml);
  });
});

describe('inflateRawToStringLimited', () => {
  const deflate = (text: string) => pako.deflateRaw(new TextEncoder().encode(text));

  it('accepts output of exactly the limit across several chunks and refuses one character more', () => {
    const limit = 100_000;

    expect(inflateRawToStringLimited(deflate('a'.repeat(limit)), limit, 'X')).toHaveLength(limit);
    expect(() => inflateRawToStringLimited(deflate('a'.repeat(limit + 1)), limit, 'X')).toThrow(
      'X exceeds maximum inflated size'
    );
  });

  it('counts the characters of the output, not the bytes of the input', () => {
    const text = 'あ'.repeat(10);

    expect(inflateRawToStringLimited(deflate(text), 10, 'X')).toBe(text);
    expect(() => inflateRawToStringLimited(deflate(text), 9, 'X')).toThrow(
      'X exceeds maximum inflated size'
    );
  });

  it('flushes a multi-byte sequence that is cut at the end of the stream', () => {
    const cut = new Uint8Array([0x61, 0xe3, 0x81]);

    expect(inflateRawToStringLimited(pako.deflateRaw(cut), 100, 'X')).toBe('a�');
  });

  it('keeps a multi-byte character that spans chunk boundaries intact', () => {
    const text = 'あ'.repeat(20_000);

    expect(inflateRawToStringLimited(deflate(text), 100_000, 'X')).toBe(text);
  });

  it('reports the decompressor message for corrupt data', () => {
    expect(() =>
      inflateRawToStringLimited(new Uint8Array([0xff, 0xff, 0xff, 0xff]), 100, 'X')
    ).toThrow('invalid block type');
  });

  it('fails for a stream that is cut off', () => {
    const cut = deflate('hello world, hello world, hello world').slice(0, 5);

    expect(() => inflateRawToStringLimited(cut, 100, 'X')).toThrow();
  });
});

describe('bytesToBinaryString', () => {
  it('maps every byte to one character, across chunk boundaries', () => {
    const bytes = Uint8Array.from({ length: 20_000 }, (_, index) => index % 256);

    const text = bytesToBinaryString(bytes);

    expect(text).toHaveLength(20_000);
    expect(text.charCodeAt(0)).toBe(0);
    expect(text.charCodeAt(8191)).toBe(8191 % 256);
    expect(text.charCodeAt(8192)).toBe(0);
    expect(text.charCodeAt(19_999)).toBe(19_999 % 256);
    expect(bytesToBinaryString(new Uint8Array())).toBe('');
  });
});
