/**
 * XML Encryption of assertions and NameIDs: the exact EncryptedData structure for each algorithm
 * selection, decryption round trips with a real RSA key, refusals and public key import.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  SAML_NAMESPACES,
  XML_ENCRYPTION_ALGORITHMS,
  DIGEST_ALGORITHMS,
} from '../../common/constants';
import {
  findDirectChildElement,
  findElement,
  getAttribute,
  parseXml,
} from '../../common/xml-utils';
import { buildSAMLResponse } from '../assertion';
import {
  applySAMLAssertionEncryptionPolicy,
  encryptSAMLAssertion,
  encryptSAMLNameID,
  importRsaOaepPublicKey,
  resolveXmlEncryptionAlgorithms,
} from '../encryption';
import { RSA_2048_SHA256_PEM } from '../../admin/__fixtures__/certificates';

const RESPONSE = buildSAMLResponse({
  responseId: '_r',
  assertionId: '_a',
  issueInstant: '2026-05-12T10:30:00Z',
  issuer: 'https://idp.example.com',
  destination: 'https://sp.example.com/acs',
  recipientUrl: 'https://sp.example.com/acs',
  audienceRestriction: 'https://sp.example.com',
  nameId: 'user@example.com',
  nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  authnInstant: '2026-05-12T10:30:00Z',
  notBefore: '2026-05-12T10:29:00Z',
  notOnOrAfter: '2026-05-12T10:35:00Z',
  authnContextClassRef: 'urn:oasis:names:tc:SAML:2.0:ac:classes:Password',
});

let pkcs8: ArrayBuffer;
let publicKeyPem: string;

const toBytes = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSA-OAEP',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['encrypt', 'decrypt']
  );
  pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${(toBase64(spki).match(/.{1,64}/g) ?? []).join('\n')}\n-----END PUBLIC KEY-----`;
});

/** Decrypts the EncryptedData of a wrapper element and returns the plaintext element XML. */
async function decrypt(wrapper: Element, hash: 'SHA-1' | 'SHA-256', block: 'AES-GCM' | 'AES-CBC') {
  const encryptedData = findDirectChildElement(
    wrapper,
    SAML_NAMESPACES.XENC,
    'EncryptedData'
  ) as Element;
  const encryptedKey = findElement(encryptedData, SAML_NAMESPACES.XENC, 'EncryptedKey') as Element;
  const keyValue =
    (findElement(encryptedKey, SAML_NAMESPACES.XENC, 'CipherValue') as Element).textContent ?? '';
  const dataCipher = findDirectChildElement(
    encryptedData,
    SAML_NAMESPACES.XENC,
    'CipherData'
  ) as Element;
  const dataValue = toBytes(
    (findElement(dataCipher, SAML_NAMESPACES.XENC, 'CipherValue') as Element).textContent ?? ''
  );
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    pkcs8,
    { name: 'RSA-OAEP', hash },
    false,
    ['decrypt']
  );
  const contentKey = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, toBytes(keyValue))
  );
  expect(contentKey).toHaveLength(32);
  const ivLength = block === 'AES-GCM' ? 12 : 16;
  const iv = dataValue.slice(0, ivLength);
  const aes = await crypto.subtle.importKey('raw', contentKey, { name: block }, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt(
    block === 'AES-GCM' ? { name: 'AES-GCM', iv, tagLength: 128 } : { name: 'AES-CBC', iv },
    aes,
    dataValue.slice(ivLength)
  );
  return new TextDecoder().decode(plain);
}

describe('algorithm resolution', () => {
  it('defaults to AES-256-GCM with RSA-OAEP using SHA-256 and MGF1-SHA256', () => {
    expect(resolveXmlEncryptionAlgorithms({})).toEqual({
      dataAlgorithm: 'aes256-gcm',
      keyAlgorithm: 'rsa-oaep-256',
      dataAlgorithmUri: XML_ENCRYPTION_ALGORITHMS.AES256_GCM,
      keyAlgorithmUri: XML_ENCRYPTION_ALGORITHMS.RSA_OAEP,
      digestAlgorithmUri: DIGEST_ALGORITHMS.SHA256,
      keyHash: 'SHA-256',
      includeMgfSha256: true,
      blockMode: 'AES-GCM',
      ivLength: 12,
    });
  });

  it('defaults to the legacy suite under explicit opt-in', () => {
    expect(resolveXmlEncryptionAlgorithms({ encryptionAlgorithmPolicy: 'legacy_opt_in' })).toEqual({
      dataAlgorithm: 'aes256-cbc',
      keyAlgorithm: 'rsa-oaep-sha1',
      dataAlgorithmUri: XML_ENCRYPTION_ALGORITHMS.AES256_CBC,
      keyAlgorithmUri: XML_ENCRYPTION_ALGORITHMS.RSA_OAEP_MGF1P,
      digestAlgorithmUri: undefined,
      keyHash: 'SHA-1',
      includeMgfSha256: false,
      blockMode: 'AES-CBC',
      ivLength: 16,
    });
  });

  it('lets each algorithm be chosen separately under opt-in, and refuses legacy ones without it', () => {
    const mixed = resolveXmlEncryptionAlgorithms({
      encryptionAlgorithmPolicy: 'legacy_opt_in',
      assertionEncryptionAlgorithm: 'aes256-gcm',
      keyEncryptionAlgorithm: 'rsa-oaep-sha1',
    });
    expect(mixed).toMatchObject({
      blockMode: 'AES-GCM',
      ivLength: 12,
      keyHash: 'SHA-1',
      includeMgfSha256: false,
    });

    expect(() =>
      resolveXmlEncryptionAlgorithms({ assertionEncryptionAlgorithm: 'aes256-cbc' })
    ).toThrow('Legacy SAML XML Encryption algorithms require explicit opt-in');
    expect(() =>
      resolveXmlEncryptionAlgorithms({ keyEncryptionAlgorithm: 'rsa-oaep-sha1' })
    ).toThrow('Legacy SAML XML Encryption algorithms require explicit opt-in');
  });
});

describe('encrypting the assertion', () => {
  it('produces the EncryptedAssertion structure for the default suite and decrypts to the Assertion', async () => {
    const xml = await encryptSAMLAssertion(RESPONSE, publicKeyPem);

    expect(xml).toContain(
      '<saml:EncryptedAssertion xmlns:xenc="http://www.w3.org/2001/04/xmlenc#"'
    );
    expect(xml).toContain('<xenc:EncryptedData Type="http://www.w3.org/2001/04/xmlenc#Element"');
    expect(xml).toContain(
      `<xenc:EncryptionMethod Algorithm="${XML_ENCRYPTION_ALGORITHMS.AES256_GCM}"/>`
    );
    expect(xml).toContain(
      `<xenc:EncryptedKey><xenc:EncryptionMethod Algorithm="${XML_ENCRYPTION_ALGORITHMS.RSA_OAEP}"><ds:DigestMethod Algorithm="${DIGEST_ALGORITHMS.SHA256}"/><xenc11:MGF Algorithm="${XML_ENCRYPTION_ALGORITHMS.MGF1_SHA256}"`
    );
    expect(xml).toContain('<ds:KeyInfo');
    expect(xml).toMatch(
      /<xenc:CipherData><xenc:CipherValue>[A-Za-z0-9+/=]+<\/xenc:CipherValue><\/xenc:CipherData>/
    );
    expect(xml).not.toContain('<saml:Assertion');

    const doc = parseXml(xml);
    const response = findElement(doc, SAML_NAMESPACES.SAML2P, 'Response') as Element;
    const wrapper = findDirectChildElement(
      response,
      SAML_NAMESPACES.SAML2,
      'EncryptedAssertion'
    ) as Element;
    const plaintext = await decrypt(wrapper, 'SHA-256', 'AES-GCM');
    expect(plaintext).toContain('<saml:Assertion ID="_a"');
    expect(plaintext).toContain('user@example.com');
  });

  it('embeds the certificate without PEM armour and whitespace', async () => {
    const xml = await encryptSAMLAssertion(RESPONSE, RSA_2048_SHA256_PEM);

    const body = RSA_2048_SHA256_PEM.replace(/-----[A-Z ]+-----|\s+/g, '');
    expect(xml).toContain(`<ds:X509Certificate>${body}</ds:X509Certificate>`);
  });

  it('writes the legacy suite without DigestMethod or MGF, and it decrypts with SHA-1 OAEP and AES-CBC', async () => {
    const algorithms = resolveXmlEncryptionAlgorithms({
      encryptionAlgorithmPolicy: 'legacy_opt_in',
    });
    const xml = await encryptSAMLAssertion(RESPONSE, publicKeyPem, algorithms);

    expect(xml).toContain(
      `<xenc:EncryptionMethod Algorithm="${XML_ENCRYPTION_ALGORITHMS.AES256_CBC}"/>`
    );
    expect(xml).toContain(
      `<xenc:EncryptionMethod Algorithm="${XML_ENCRYPTION_ALGORITHMS.RSA_OAEP_MGF1P}"/>`
    );
    expect(xml).not.toContain('DigestMethod');
    expect(xml).not.toContain('MGF');
    const doc = parseXml(xml);
    const wrapper = findElement(doc, SAML_NAMESPACES.SAML2, 'EncryptedAssertion') as Element;
    expect(await decrypt(wrapper, 'SHA-1', 'AES-CBC')).toContain('<saml:Assertion ID="_a"');
  });

  it('uses a fresh content key and IV for every encryption', async () => {
    const material = async (xml: string) => {
      const wrapper = findElement(
        parseXml(xml),
        SAML_NAMESPACES.SAML2,
        'EncryptedAssertion'
      ) as Element;
      const encryptedData = findDirectChildElement(
        wrapper,
        SAML_NAMESPACES.XENC,
        'EncryptedData'
      ) as Element;
      const encryptedKey = findElement(
        encryptedData,
        SAML_NAMESPACES.XENC,
        'EncryptedKey'
      ) as Element;
      const wrappedKey =
        (findElement(encryptedKey, SAML_NAMESPACES.XENC, 'CipherValue') as Element).textContent ??
        '';
      const dataCipher = findDirectChildElement(
        encryptedData,
        SAML_NAMESPACES.XENC,
        'CipherData'
      ) as Element;
      const data = toBytes(
        (findElement(dataCipher, SAML_NAMESPACES.XENC, 'CipherValue') as Element).textContent ?? ''
      );
      const privateKey = await crypto.subtle.importKey(
        'pkcs8',
        pkcs8,
        { name: 'RSA-OAEP', hash: 'SHA-256' },
        false,
        ['decrypt']
      );
      const contentKey = new Uint8Array(
        await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, toBytes(wrappedKey))
      );
      return { key: toBase64(contentKey), iv: toBase64(data.slice(0, 12)) };
    };

    const first = await material(await encryptSAMLAssertion(RESPONSE, publicKeyPem));
    const second = await material(await encryptSAMLAssertion(RESPONSE, publicKeyPem));

    expect(first.key).not.toBe(second.key);
    expect(first.iv).not.toBe(second.iv);
  });

  it('refuses a document that is not a Response with a direct Assertion', async () => {
    const assertion = RESPONSE.slice(
      RESPONSE.indexOf('<saml:Assertion'),
      RESPONSE.indexOf('</saml:Assertion>') + 17
    );
    const wrongNamespace = RESPONSE.replace('urn:oasis:names:tc:SAML:2.0:protocol', 'urn:evil');
    const wrongName = RESPONSE.replace(/samlp:Response/g, 'samlp:Other');
    const nested = RESPONSE.replace(assertion, `<samlp:Extensions>${assertion}</samlp:Extensions>`);
    const missing = RESPONSE.replace(assertion, '');

    for (const variant of [wrongNamespace, wrongName, nested, missing]) {
      await expect(encryptSAMLAssertion(variant, publicKeyPem)).rejects.toThrow(
        'Cannot encrypt SAML assertion: missing Assertion element'
      );
    }
  });
});

describe('encrypting the NameID', () => {
  it('replaces the NameID with an EncryptedID that decrypts to it', async () => {
    const xml = await encryptSAMLNameID(RESPONSE, publicKeyPem);

    expect(xml).toContain('<saml:EncryptedID xmlns:xenc=');
    expect(xml).not.toContain('>user@example.com</saml:NameID>');
    const doc = parseXml(xml);
    const assertion = findElement(doc, SAML_NAMESPACES.SAML2, 'Assertion') as Element;
    const subject = findDirectChildElement(assertion, SAML_NAMESPACES.SAML2, 'Subject') as Element;
    const wrapper = findDirectChildElement(
      subject,
      SAML_NAMESPACES.SAML2,
      'EncryptedID'
    ) as Element;
    expect(getAttribute(findElement(wrapper, SAML_NAMESPACES.XENC, 'EncryptedData'), 'Type')).toBe(
      'http://www.w3.org/2001/04/xmlenc#Element'
    );
    expect(await decrypt(wrapper, 'SHA-256', 'AES-GCM')).toContain(
      '>user@example.com</saml:NameID>'
    );
  });

  it('refuses a document without a direct Response/Assertion/Subject/NameID chain', async () => {
    const wrongNamespace = RESPONSE.replace('urn:oasis:names:tc:SAML:2.0:protocol', 'urn:evil');
    const wrongName = RESPONSE.replace(/samlp:Response/g, 'samlp:Other');
    const noNameId = RESPONSE.replace(/<saml:NameID[\s\S]*?<\/saml:NameID>/, '');
    const noSubject = RESPONSE.replace(/<saml:Subject>[\s\S]*<\/saml:Subject>/, '');

    for (const variant of [wrongNamespace, wrongName, noNameId, noSubject]) {
      await expect(encryptSAMLNameID(variant, publicKeyPem)).rejects.toThrow(
        'Cannot encrypt SAML NameID: missing NameID element'
      );
    }
  });
});

describe('policy application', () => {
  it('encrypts the whole assertion in preference to the NameID when both are on', async () => {
    const xml = await applySAMLAssertionEncryptionPolicy(RESPONSE, {
      encryptAssertions: true,
      encryptNameID: true,
      encryptionCertificate: publicKeyPem,
    });

    expect(xml).toContain('EncryptedAssertion');
    expect(xml).not.toContain('EncryptedID');
  });

  it('encrypts only the NameID when assertion encryption is off', async () => {
    const xml = await applySAMLAssertionEncryptionPolicy(RESPONSE, {
      encryptNameID: true,
      encryptionCertificates: [publicKeyPem],
    });

    expect(xml).toContain('EncryptedID');
    expect(xml).toContain('<saml:Assertion');
  });

  it('prefers the single certificate over the list and fails closed without any', async () => {
    const wrongPem = 'not a key';
    await expect(
      applySAMLAssertionEncryptionPolicy(RESPONSE, {
        encryptAssertions: true,
        encryptionCertificate: wrongPem,
        encryptionCertificates: [publicKeyPem],
      })
    ).rejects.toThrow();
    await expect(
      applySAMLAssertionEncryptionPolicy(RESPONSE, {
        encryptNameID: true,
        encryptionCertificates: [],
      })
    ).rejects.toThrow('Cannot encrypt SAML assertion: missing SP encryption certificate');
  });
});

describe('importRsaOaepPublicKey', () => {
  it('imports a public key PEM as a non-extractable encrypt-only OAEP key with the requested hash', async () => {
    const key = await importRsaOaepPublicKey(publicKeyPem, 'SHA-1');

    expect(key.extractable).toBe(false);
    expect(key.usages).toEqual(['encrypt']);
    expect((key.algorithm as RsaHashedKeyAlgorithm).hash.name).toBe('SHA-1');
    expect((key.algorithm as RsaHashedKeyAlgorithm).modulusLength).toBe(2048);
  });

  it('takes the public key out of a certificate', async () => {
    const key = await importRsaOaepPublicKey(RSA_2048_SHA256_PEM, 'SHA-256');

    expect((key.algorithm as RsaHashedKeyAlgorithm).modulusLength).toBe(2048);
    expect((key.algorithm as RsaHashedKeyAlgorithm).hash.name).toBe('SHA-256');
  });

  it('accepts a bare public key that is not wrapped in a certificate', async () => {
    const bare = publicKeyPem.replace(/-----[A-Z ]+-----|\s+/g, '');

    expect(
      ((await importRsaOaepPublicKey(bare, 'SHA-256')).algorithm as RsaHashedKeyAlgorithm)
        .modulusLength
    ).toBe(2048);
  });

  it('falls back to the raw DER when the certificate has no readable key info', async () => {
    const pem = `-----BEGIN CERTIFICATE-----\n${publicKeyPem.replace(/-----[A-Z ]+-----|\s+/g, '')}\n-----END CERTIFICATE-----`;

    expect(
      ((await importRsaOaepPublicKey(pem, 'SHA-256')).algorithm as RsaHashedKeyAlgorithm)
        .modulusLength
    ).toBe(2048);
  });
});
