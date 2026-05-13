import { describe, expect, it } from 'vitest';
import { SAML_NAMESPACES, XML_ENCRYPTION_ALGORITHMS } from '../../common/constants';
import { findElement, getAttribute, parseXml } from '../../common/xml-utils';
import { buildSAMLResponse } from '../assertion';
import {
  applySAMLAssertionEncryptionPolicy,
  encryptSAMLAssertion,
  encryptSAMLNameID,
} from '../encryption';

describe('SAML assertion encryption', () => {
  const baseResponse = buildSAMLResponse({
    responseId: '_response123',
    assertionId: '_assertion456',
    issueInstant: '2026-05-12T10:30:00Z',
    issuer: 'https://idp.example.com/saml/idp',
    destination: 'https://sp.example.com/acs',
    inResponseTo: '_request789',
    recipientUrl: 'https://sp.example.com/acs',
    audienceRestriction: 'https://sp.example.com/saml/sp',
    nameId: 'user@example.com',
    nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    authnInstant: '2026-05-12T10:30:00Z',
    sessionIndex: '_session123',
    notBefore: '2026-05-12T10:29:00Z',
    notOnOrAfter: '2026-05-12T10:35:00Z',
    authnContextClassRef: 'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport',
    attributes: [{ name: 'email', values: ['user@example.com'] }],
  });

  it('replaces Assertion with EncryptedAssertion', async () => {
    const publicKeyPem = await generateRsaOaepPublicKeyPem();
    const encrypted = await encryptSAMLAssertion(baseResponse, publicKeyPem);
    const doc = parseXml(encrypted);
    const response = findElement(doc, SAML_NAMESPACES.SAML2P, 'Response');
    const assertion = findElement(response!, SAML_NAMESPACES.SAML2, 'Assertion');
    const encryptedAssertion = findElement(response!, SAML_NAMESPACES.SAML2, 'EncryptedAssertion');
    const encryptedData = findElement(encryptedAssertion!, SAML_NAMESPACES.XENC, 'EncryptedData');
    const dataEncryptionMethod = findElement(
      encryptedData!,
      SAML_NAMESPACES.XENC,
      'EncryptionMethod'
    );
    const encryptedKey = findElement(encryptedData!, SAML_NAMESPACES.XENC, 'EncryptedKey');
    const keyEncryptionMethod = findElement(
      encryptedKey!,
      SAML_NAMESPACES.XENC,
      'EncryptionMethod'
    );

    expect(assertion).toBeNull();
    expect(encryptedAssertion).toBeDefined();
    expect(getAttribute(encryptedData!, 'Type')).toBe('http://www.w3.org/2001/04/xmlenc#Element');
    expect(getAttribute(dataEncryptionMethod!, 'Algorithm')).toBe(
      XML_ENCRYPTION_ALGORITHMS.AES256_GCM
    );
    expect(getAttribute(keyEncryptionMethod!, 'Algorithm')).toBe(
      XML_ENCRYPTION_ALGORITHMS.RSA_OAEP
    );
  });

  it('replaces NameID with EncryptedID when full assertion encryption is disabled', async () => {
    const publicKeyPem = await generateRsaOaepPublicKeyPem();
    const encrypted = await encryptSAMLNameID(baseResponse, publicKeyPem);
    const doc = parseXml(encrypted);
    const assertion = findElement(doc, SAML_NAMESPACES.SAML2, 'Assertion');
    const nameId = findElement(assertion!, SAML_NAMESPACES.SAML2, 'NameID');
    const encryptedId = findElement(assertion!, SAML_NAMESPACES.SAML2, 'EncryptedID');

    expect(assertion).toBeDefined();
    expect(nameId).toBeNull();
    expect(encryptedId).toBeDefined();
  });

  it('is a no-op when no encryption policy is enabled', async () => {
    await expect(applySAMLAssertionEncryptionPolicy(baseResponse, {})).resolves.toBe(baseResponse);
  });

  it('fails closed when encryption is required without an SP certificate', async () => {
    await expect(
      applySAMLAssertionEncryptionPolicy(baseResponse, { encryptAssertions: true })
    ).rejects.toThrow('missing SP encryption certificate');
  });

  it('uses legacy XML Encryption algorithms only with explicit opt-in', async () => {
    const publicKeyPem = await generateRsaOaepPublicKeyPem();
    const encrypted = await applySAMLAssertionEncryptionPolicy(baseResponse, {
      encryptAssertions: true,
      encryptionCertificate: publicKeyPem,
      encryptionAlgorithmPolicy: 'legacy_opt_in',
    });
    const doc = parseXml(encrypted);
    const encryptedAssertion = findElement(doc, SAML_NAMESPACES.SAML2, 'EncryptedAssertion');
    const encryptedData = findElement(encryptedAssertion!, SAML_NAMESPACES.XENC, 'EncryptedData');
    const dataEncryptionMethod = findElement(
      encryptedData!,
      SAML_NAMESPACES.XENC,
      'EncryptionMethod'
    );
    const encryptedKey = findElement(encryptedData!, SAML_NAMESPACES.XENC, 'EncryptedKey');
    const keyEncryptionMethod = findElement(
      encryptedKey!,
      SAML_NAMESPACES.XENC,
      'EncryptionMethod'
    );
    const digestMethod = findElement(keyEncryptionMethod!, SAML_NAMESPACES.DS, 'DigestMethod');
    const mgf = findElement(keyEncryptionMethod!, SAML_NAMESPACES.XENC11, 'MGF');

    expect(getAttribute(dataEncryptionMethod!, 'Algorithm')).toBe(
      XML_ENCRYPTION_ALGORITHMS.AES256_CBC
    );
    expect(getAttribute(keyEncryptionMethod!, 'Algorithm')).toBe(
      XML_ENCRYPTION_ALGORITHMS.RSA_OAEP_MGF1P
    );
    expect(digestMethod).toBeNull();
    expect(mgf).toBeNull();
  });

  it('rejects legacy algorithm selection without legacy opt-in', async () => {
    const publicKeyPem = await generateRsaOaepPublicKeyPem();

    await expect(
      applySAMLAssertionEncryptionPolicy(baseResponse, {
        encryptAssertions: true,
        encryptionCertificate: publicKeyPem,
        assertionEncryptionAlgorithm: 'aes256-cbc',
      })
    ).rejects.toThrow('Legacy SAML XML Encryption algorithms require explicit opt-in');

    await expect(
      applySAMLAssertionEncryptionPolicy(baseResponse, {
        encryptAssertions: true,
        encryptionCertificate: publicKeyPem,
        keyEncryptionAlgorithm: 'rsa-oaep-sha1',
      })
    ).rejects.toThrow('Legacy SAML XML Encryption algorithms require explicit opt-in');
  });
});

async function generateRsaOaepPublicKeyPem(): Promise<string> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'RSA-OAEP',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['encrypt', 'decrypt']
  );
  const spki = await crypto.subtle.exportKey('spki', keyPair.publicKey);
  const base64 = bytesToBase64(new Uint8Array(spki));
  const lines = base64.match(/.{1,64}/g) || [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
