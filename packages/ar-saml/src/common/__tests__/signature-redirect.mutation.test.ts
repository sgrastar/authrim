/**
 * HTTP-Redirect binding signature input parsing, SHA-1 opt-in verification and
 * certificate extraction from signed XML.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  extractCertificateFromSignature,
  parseRedirectBindingSignatureInput,
  verifyRedirectBindingSignature,
} from '../signature';
import { SIGNATURE_ALGORITHMS } from '../constants';
import {
  TEST_CERTIFICATE,
  TEST_PRIVATE_KEY,
  createSignableResponse,
  signReference,
} from './helpers/saml-signing-fixture';

const PINNED_NOW = Date.parse('2026-06-01T12:00:00Z');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(PINNED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('parseRedirectBindingSignatureInput', () => {
  it('keeps raw encoded values and decodes only Signature and SigAlg', () => {
    const parsed = parseRedirectBindingSignatureInput(
      '?SAMLRequest=abc%2Bdef&RelayState=a%20b&SigAlg=http%3A%2F%2Falg&Signature=s%2Fg+h',
      'SAMLRequest'
    );

    expect(parsed).toEqual({
      samlMessage: 'abc%2Bdef',
      relayState: 'a%20b',
      sigAlg: 'http://alg',
      signature: 's/g h',
    });
  });

  it('works without a leading question mark and omits absent optional parameters', () => {
    expect(parseRedirectBindingSignatureInput('SAMLResponse=x', 'SAMLResponse')).toEqual({
      samlMessage: 'x',
    });
  });

  it('treats a parameter without "=" as present with an empty value', () => {
    const parsed = parseRedirectBindingSignatureInput(
      'SAMLRequest=a&RelayState&Signature&SigAlg',
      'SAMLRequest'
    );

    expect(parsed).toEqual({ samlMessage: 'a', relayState: '', signature: '', sigAlg: '' });
  });

  it('keeps "=" characters inside a value', () => {
    expect(parseRedirectBindingSignatureInput('SAMLRequest=a=b==', 'SAMLRequest')).toEqual({
      samlMessage: 'a=b==',
    });
  });

  it('skips empty segments', () => {
    expect(parseRedirectBindingSignatureInput('&&SAMLRequest=a&&', 'SAMLRequest')).toEqual({
      samlMessage: 'a',
    });
  });

  it.each(['SAMLRequest', 'RelayState', 'SigAlg', 'Signature'])(
    'rejects a duplicated %s parameter',
    (name) => {
      const query = `SAMLRequest=a&RelayState=r&SigAlg=s&Signature=g&${name}=again`;
      expect(() => parseRedirectBindingSignatureInput(query, 'SAMLRequest')).toThrow(
        `Duplicate HTTP-Redirect parameter: ${name}`
      );
    }
  );

  it('detects a duplicate whose name is percent-encoded', () => {
    expect(() =>
      parseRedirectBindingSignatureInput('SAMLRequest=a&SAML%52equest=b', 'SAMLRequest')
    ).toThrow('Duplicate HTTP-Redirect parameter: SAMLRequest');
  });

  it('rejects a message carrying the opposite SAML parameter', () => {
    expect(() =>
      parseRedirectBindingSignatureInput('SAMLRequest=a&SAMLResponse=b', 'SAMLRequest')
    ).toThrow('HTTP-Redirect message cannot contain both SAMLRequest and SAMLResponse');
    expect(() =>
      parseRedirectBindingSignatureInput('SAMLResponse=a&SAMLRequest=b', 'SAMLResponse')
    ).toThrow('HTTP-Redirect message cannot contain both SAMLRequest and SAMLResponse');
  });

  it('rejects a missing SAML parameter', () => {
    expect(() => parseRedirectBindingSignatureInput('RelayState=r', 'SAMLRequest')).toThrow(
      'Missing SAMLRequest parameter'
    );
  });

  it('rejects malformed percent-encoding in decoded components', () => {
    expect(() =>
      parseRedirectBindingSignatureInput('SAMLRequest=a&Signature=%E0%A4%A', 'SAMLRequest')
    ).toThrow('Malformed HTTP-Redirect query encoding');
  });
});

describe('verifyRedirectBindingSignature with SHA-1', () => {
  async function signSha1(input: string): Promise<string> {
    const der = Uint8Array.from(
      atob(TEST_PRIVATE_KEY.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '')),
      (c) => c.charCodeAt(0)
    );
    const key = await crypto.subtle.importKey(
      'pkcs8',
      der,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-1' },
      false,
      ['sign']
    );
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      key,
      new TextEncoder().encode(input)
    );
    return btoa(String.fromCharCode(...new Uint8Array(signature)));
  }

  it('verifies an RSA-SHA1 signature with SHA-1 only when that algorithm is accepted', async () => {
    const sigAlg = SIGNATURE_ALGORITHMS.RSA_SHA1;
    const signature = await signSha1(
      `SAMLRequest=abc&RelayState=rs&SigAlg=${encodeURIComponent(sigAlg)}`
    );

    await expect(
      verifyRedirectBindingSignature(
        'SAMLRequest',
        'abc',
        'rs',
        signature,
        sigAlg,
        TEST_CERTIFICATE
      )
    ).rejects.toThrow(`Unsupported signature algorithm: ${sigAlg}`);
    await expect(
      verifyRedirectBindingSignature(
        'SAMLRequest',
        'abc',
        'rs',
        signature,
        sigAlg,
        TEST_CERTIFICATE,
        {
          acceptedSignatureAlgorithms: [sigAlg],
        }
      )
    ).resolves.toBe(true);
  });

  it('includes RelayState in the signed string only when one is given', async () => {
    const sigAlg = SIGNATURE_ALGORITHMS.RSA_SHA1;
    const withoutRelay = await signSha1(`SAMLRequest=abc&SigAlg=${encodeURIComponent(sigAlg)}`);
    const accepted = { acceptedSignatureAlgorithms: [sigAlg] };

    await expect(
      verifyRedirectBindingSignature(
        'SAMLRequest',
        'abc',
        undefined,
        withoutRelay,
        sigAlg,
        TEST_CERTIFICATE,
        accepted
      )
    ).resolves.toBe(true);
    await expect(
      verifyRedirectBindingSignature(
        'SAMLRequest',
        'abc',
        '',
        withoutRelay,
        sigAlg,
        TEST_CERTIFICATE,
        accepted
      )
    ).resolves.toBe(false);
  });
});

describe('extractCertificateFromSignature', () => {
  it('returns the embedded certificate re-wrapped as PEM with 64-character lines', () => {
    const signed = signReference(createSignableResponse('_cert'), '#_cert');

    const pem = extractCertificateFromSignature(signed);

    const body = TEST_CERTIFICATE.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
    const expectedLines = body.match(/.{1,64}/g) ?? [];
    expect(pem).toBe(
      `-----BEGIN CERTIFICATE-----\n${expectedLines.join('\n')}\n-----END CERTIFICATE-----`
    );
  });

  it('returns null without a certificate or with an empty one', () => {
    const ds = 'http://www.w3.org/2000/09/xmldsig#';
    expect(extractCertificateFromSignature(`<a xmlns:ds="${ds}"/>`)).toBeNull();
    expect(
      extractCertificateFromSignature(
        `<a xmlns:ds="${ds}"><ds:X509Certificate>  \n </ds:X509Certificate></a>`
      )
    ).toBeNull();
  });
});
