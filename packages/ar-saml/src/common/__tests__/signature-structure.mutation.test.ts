/**
 * Reference-level checks of verifyXmlSignatureAndGetReferences that the algorithm-focused tests
 * leave open: missing References and URIs, the failure message of a bad signature, and the exact
 * verified reference list returned.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findElements, parseXml } from '../xml-utils';
import { verifyXmlSignature, verifyXmlSignatureAndGetReferences } from '../signature';
import {
  TEST_CERTIFICATE,
  createSignableResponse,
  signReference,
  signReferences,
} from './helpers/saml-signing-fixture';

const PINNED_NOW = Date.parse('2026-06-01T12:00:00Z');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(PINNED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

const options = { certificateOrKey: TEST_CERTIFICATE };

describe('Reference presence', () => {
  it('rejects a SignedInfo without any Reference', () => {
    const signed = signReference(createSignableResponse('_noref'), '#_noref').replace(
      /<Reference[\s\S]*<\/Reference>/,
      ''
    );

    expect(() => verifyXmlSignature(signed, options)).toThrow('No Reference found in signature');
  });

  it('rejects two References in strict mode', () => {
    const signed = signReferences(createSignableResponse('_two', '_two_a'), '_two', [
      '_two',
      '_two_a',
    ]);

    expect(() => verifyXmlSignature(signed, { ...options, strictXswProtection: true })).toThrow(
      'XSW Protection: Signature must contain exactly one Reference in strict mode'
    );
    expect(verifyXmlSignature(signed, options)).toBe(true);
  });

  it('treats a Reference without a URI attribute as an empty URI', () => {
    const signed = signReference(createSignableResponse('_nouri'), '#_nouri').replace(
      ' URI="#_nouri"',
      ''
    );

    expect(() => verifyXmlSignature(signed, { ...options, strictXswProtection: true })).toThrow(
      'XSW Protection: Reference URI is required in strict mode'
    );
  });

  it('rejects an external Reference URI', () => {
    const signed = signReference(createSignableResponse('_ext'), '#_ext').replace(
      'URI="#_ext"',
      'URI="http://evil.example/x"'
    );

    expect(() => verifyXmlSignature(signed, options)).toThrow(
      'XSW Protection: Reference URI must be a fragment identifier or empty'
    );
  });
});

describe('verification failure and result', () => {
  it('returns the verified URI and canonical bytes of each Reference in order', () => {
    const signed = signReferences(createSignableResponse('_ok', '_ok_a'), '_ok', ['_ok', '_ok_a']);

    const references = verifyXmlSignatureAndGetReferences(signed, options);

    expect(references.map((reference) => reference.uri)).toEqual(['#_ok', '#_ok_a']);
    expect(references[0]?.xml).toContain('ID="_ok"');
    expect(
      findElements(
        parseXml(references[0]?.xml ?? ''),
        'http://www.w3.org/2000/09/xmldsig#',
        'Signature'
      )
    ).toHaveLength(0);
    expect(references[1]?.xml).toMatch(/^<saml:Assertion[^>]* ID="_ok_a"/);
  });

  it('accepts an expectedId that matches a Reference and rejects one that does not', () => {
    const signed = signReference(createSignableResponse('_exp'), '#_exp');

    expect(verifyXmlSignature(signed, { ...options, expectedId: '_exp' })).toBe(true);
    expect(() => verifyXmlSignature(signed, { ...options, expectedId: '_exp_assertion' })).toThrow(
      'XSW Protection: Reference URI does not match expected "#_exp_assertion"'
    );
  });
});
