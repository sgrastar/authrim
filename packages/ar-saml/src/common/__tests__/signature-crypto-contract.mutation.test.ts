/**
 * Contract between verifyXmlSignatureAndGetReferences and the xml-crypto SignedXml object:
 * failure reporting and the completeness checks on the signed references it returns. xml-crypto
 * is replaced so each answer can be controlled.
 *
 * Note: xml-crypto 6.1.2 records `validationError` per Reference (there is no top-level
 * `validationErrors`), so the failure message is built from SignedXml.getReferences().
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const crypto = vi.hoisted(() => ({
  valid: true,
  references: [] as Array<{ uri: string; validationError?: Error }>,
  signedReferences: [] as unknown[],
  loaded: [] as unknown[],
  throwOnValue: false,
}));

vi.mock('xml-crypto', () => ({
  SignedXml: class {
    publicCert = '';
    loadSignature(node: unknown): void {
      crypto.loaded.push(node);
    }
    checkSignature(): boolean {
      // Real xml-crypto 6.1.2: a signature value failure throws (it does not return false).
      if (crypto.throwOnValue) throw new Error('invalid signature: the signature value is wrong');
      return crypto.valid;
    }
    getReferences(): unknown[] {
      return crypto.references;
    }
    getSignedReferences(): unknown[] {
      return crypto.signedReferences;
    }
  },
}));

import { verifyXmlSignatureAndGetReferences } from '../signature';
import { CANONICALIZATION_ALGORITHMS, DIGEST_ALGORITHMS, SIGNATURE_ALGORITHMS } from '../constants';

const DS = 'http://www.w3.org/2000/09/xmldsig#';

function signature(uri: string): string {
  return `<ds:Signature xmlns:ds="${DS}"><ds:SignedInfo>
    <ds:CanonicalizationMethod Algorithm="${CANONICALIZATION_ALGORITHMS.EXCLUSIVE_C14N}"/>
    <ds:SignatureMethod Algorithm="${SIGNATURE_ALGORITHMS.RSA_SHA256}"/>
    <ds:Reference URI="${uri}"><ds:Transforms>
      <ds:Transform Algorithm="${DS}enveloped-signature"/>
      <ds:Transform Algorithm="${CANONICALIZATION_ALGORITHMS.EXCLUSIVE_C14N}"/>
    </ds:Transforms>
    <ds:DigestMethod Algorithm="${DIGEST_ALGORITHMS.SHA256}"/><ds:DigestValue>AAAA</ds:DigestValue></ds:Reference>
  </ds:SignedInfo><ds:SignatureValue>AAAA</ds:SignatureValue></ds:Signature>`;
}

const DOCUMENT = `<r ID="_r" xmlns:ds="${DS}">${signature('#_r')}<a ID="_a">${signature('#_a')}</a></r>`;
const SINGLE = `<r ID="_r">${signature('#_r')}</r>`;
const options = { certificateOrKey: 'public-key' };

beforeEach(() => {
  crypto.valid = true;
  crypto.references = [];
  crypto.signedReferences = [];
  crypto.loaded = [];
  crypto.throwOnValue = false;
});

describe('signature verification failure', () => {
  it('describes failed References by category and URI without echoing digests', () => {
    crypto.valid = false;
    crypto.references = [
      { uri: '#_r', validationError: new Error('invalid signature: calculated digest is SECRET') },
      { uri: '#_ok' },
    ];

    expect(() => verifyXmlSignatureAndGetReferences(SINGLE, options)).toThrow(
      new Error('Signature verification failed: digest mismatch (#_r)')
    );
  });

  it.each([
    ['could not find such element in the xml', 'referenced element not found'],
    ['something else', 'reference validation failed'],
  ])('categorises the failure %j as %s', (message, category) => {
    crypto.valid = false;
    crypto.references = [{ uri: '#_r', validationError: new Error(message) }];

    expect(() => verifyXmlSignatureAndGetReferences(SINGLE, options)).toThrow(
      new Error(`Signature verification failed: ${category} (#_r)`)
    );
  });

  it.each([
    ['an unsafe character', '#_r"<x>', ''],
    ['a script-like value', 'javascript:alert(1)\nx', ''],
    ['an over-long value', `#${'a'.repeat(100)}`, `#${'a'.repeat(63)}...`],
  ])('sanitises a Reference URI with %s in the message', (_label, uri, shown) => {
    crypto.valid = false;
    crypto.references = [{ uri, validationError: new Error('calculated digest') }];

    expect(() => verifyXmlSignatureAndGetReferences(SINGLE, options)).toThrow(
      new Error(`Signature verification failed: digest mismatch (${shown})`)
    );
  });

  it('propagates the library error when the signature value check throws', () => {
    crypto.throwOnValue = true;

    expect(() => verifyXmlSignatureAndGetReferences(SINGLE, options)).toThrow(
      'invalid signature: the signature value is wrong'
    );
  });

  it('reports an invalid signature value when every Reference digest was valid', () => {
    crypto.valid = false;
    crypto.references = [{ uri: '#_r' }];

    expect(() => verifyXmlSignatureAndGetReferences(SINGLE, options)).toThrow(
      new Error('Signature verification failed: signature value is invalid')
    );
  });
});

describe('signed reference completeness', () => {
  it('rejects a verification that returns fewer signed references than References', () => {
    crypto.signedReferences = [];

    expect(() => verifyXmlSignatureAndGetReferences(SINGLE, options)).toThrow(
      'Signature verification did not return every signed reference'
    );
  });

  it('rejects a verification that returns more signed references than References', () => {
    crypto.signedReferences = ['<r/>', '<extra/>'];

    expect(() => verifyXmlSignatureAndGetReferences(SINGLE, options)).toThrow(
      'Signature verification did not return every signed reference'
    );
  });

  it('rejects an undefined signed reference slot', () => {
    crypto.signedReferences = [undefined];

    expect(() => verifyXmlSignatureAndGetReferences(SINGLE, options)).toThrow(
      'Signature verification returned an incomplete signed reference'
    );
  });

  it('returns each Reference URI with its signed bytes, across every Signature in the document', () => {
    crypto.signedReferences = ['<signed/>'];

    const references = verifyXmlSignatureAndGetReferences(DOCUMENT, options);

    expect(references).toEqual([
      { uri: '#_r', xml: '<signed/>' },
      { uri: '#_a', xml: '<signed/>' },
    ]);
    expect(crypto.loaded).toHaveLength(2);
  });

  it('refuses a document that has no signature at all', () => {
    expect(() => verifyXmlSignatureAndGetReferences('<r ID="_r"/>', options)).toThrow(
      'No signature found in XML'
    );
  });
});
