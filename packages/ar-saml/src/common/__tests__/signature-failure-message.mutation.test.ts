/**
 * Failure messages of a real (not mocked) tampered signature: xml-crypto 6.1.2 records
 * `validationError` per Reference, and the message must say what failed without echoing digests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyXmlSignature } from '../signature';
import {
  TEST_CERTIFICATE,
  createSignableResponse,
  signReference,
} from './helpers/saml-signing-fixture';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.parse('2026-06-01T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

const options = { certificateOrKey: TEST_CERTIFICATE };

function messageOf(xml: string): string {
  try {
    verifyXmlSignature(xml, options);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected verification to fail');
}

describe('real tampered signature failure message', () => {
  it('reports a digest mismatch for the tampered Reference without leaking digest values', () => {
    const signed = signReference(createSignableResponse('_resp1'), '#_resp1');
    const digest = /<(?:\w+:)?DigestValue>([^<]+)</.exec(signed)?.[1];
    const tampered = signed.replace('https://idp.example.com', 'https://evil.example.com');

    const message = messageOf(tampered);

    expect(message).toBe('Signature verification failed: digest mismatch (#_resp1)');
    expect(digest).toBeTruthy();
    expect(message).not.toContain(digest as string);
  });
});

describe('real invalid signature value', () => {
  it('rejects a Signature whose value was altered', () => {
    const signed = signReference(createSignableResponse('_resp1'), '#_resp1');
    const altered = signed.replace(
      /(<(?:\w+:)?SignatureValue>)([A-Za-z0-9+/])/,
      (_m, tag: string, ch: string) => `${tag}${ch === 'A' ? 'B' : 'A'}`
    );
    expect(altered).not.toBe(signed);

    expect(() => verifyXmlSignature(altered, options)).toThrow();
  });
});
