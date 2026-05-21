import type { SAMLSPConfig } from '@authrim/ar-lib-core';
import { DIGEST_ALGORITHMS, SAML_NAMESPACES, XML_ENCRYPTION_ALGORITHMS } from '../common/constants';
import {
  createElement,
  findDirectChildElement,
  parseXml,
  serializeXml,
  setAttribute,
  setTextContent,
  type XMLDocument,
  type XMLElement,
} from '../common/xml-utils';

const ENCRYPTED_ELEMENT_TYPE = 'http://www.w3.org/2001/04/xmlenc#Element';

export interface SAMLAssertionEncryptionOptions {
  encryptAssertions?: boolean;
  encryptNameID?: boolean;
  encryptionCertificate?: string;
  encryptionCertificates?: string[];
  encryptionAlgorithmPolicy?: SAMLSPConfig['encryptionAlgorithmPolicy'];
  assertionEncryptionAlgorithm?: SAMLSPConfig['assertionEncryptionAlgorithm'];
  keyEncryptionAlgorithm?: SAMLSPConfig['keyEncryptionAlgorithm'];
}

interface ResolvedSAMLXmlEncryptionAlgorithms {
  dataAlgorithm: NonNullable<SAMLSPConfig['assertionEncryptionAlgorithm']>;
  keyAlgorithm: NonNullable<SAMLSPConfig['keyEncryptionAlgorithm']>;
  dataAlgorithmUri: string;
  keyAlgorithmUri: string;
  digestAlgorithmUri?: string;
  keyHash: 'SHA-1' | 'SHA-256';
  includeMgfSha256: boolean;
  blockMode: 'AES-GCM' | 'AES-CBC';
  ivLength: number;
}

export async function applySAMLAssertionEncryptionPolicy(
  xml: string,
  spConfig: Pick<
    SAMLSPConfig,
    | 'encryptAssertions'
    | 'encryptNameID'
    | 'encryptionCertificate'
    | 'encryptionCertificates'
    | 'encryptionAlgorithmPolicy'
    | 'assertionEncryptionAlgorithm'
    | 'keyEncryptionAlgorithm'
  >
): Promise<string> {
  if (!spConfig.encryptAssertions && !spConfig.encryptNameID) {
    return xml;
  }

  const encryptionCertificate = resolveEncryptionCertificate(spConfig);
  if (!encryptionCertificate) {
    throw new Error('Cannot encrypt SAML assertion: missing SP encryption certificate');
  }

  if (spConfig.encryptAssertions) {
    return encryptSAMLAssertion(
      xml,
      encryptionCertificate,
      resolveXmlEncryptionAlgorithms(spConfig)
    );
  }

  return encryptSAMLNameID(xml, encryptionCertificate, resolveXmlEncryptionAlgorithms(spConfig));
}

export async function encryptSAMLAssertion(
  xml: string,
  encryptionCertificate: string,
  algorithms: ResolvedSAMLXmlEncryptionAlgorithms = resolveXmlEncryptionAlgorithms({})
): Promise<string> {
  const doc = parseXml(xml);
  const responseElement = doc.documentElement;
  const isResponseElement =
    responseElement?.namespaceURI === SAML_NAMESPACES.SAML2P &&
    responseElement.localName === 'Response';
  const assertionElement = responseElement
    ? findDirectChildElement(responseElement, SAML_NAMESPACES.SAML2, 'Assertion')
    : null;

  if (!responseElement || !isResponseElement || !assertionElement) {
    throw new Error('Cannot encrypt SAML assertion: missing Assertion element');
  }

  const encryptedAssertion = await buildEncryptedSAMLWrapper(
    doc,
    'EncryptedAssertion',
    assertionElement,
    encryptionCertificate,
    algorithms
  );
  responseElement.replaceChild(encryptedAssertion, assertionElement);
  return serializeXml(doc);
}

export async function encryptSAMLNameID(
  xml: string,
  encryptionCertificate: string,
  algorithms: ResolvedSAMLXmlEncryptionAlgorithms = resolveXmlEncryptionAlgorithms({})
): Promise<string> {
  const doc = parseXml(xml);
  const responseElement = doc.documentElement;
  const assertionElement =
    responseElement?.namespaceURI === SAML_NAMESPACES.SAML2P &&
    responseElement.localName === 'Response'
      ? findDirectChildElement(responseElement, SAML_NAMESPACES.SAML2, 'Assertion')
      : null;
  const subjectElement = assertionElement
    ? findDirectChildElement(assertionElement, SAML_NAMESPACES.SAML2, 'Subject')
    : null;
  const nameIdElement = subjectElement
    ? findDirectChildElement(subjectElement, SAML_NAMESPACES.SAML2, 'NameID')
    : null;

  if (!subjectElement || !nameIdElement) {
    throw new Error('Cannot encrypt SAML NameID: missing NameID element');
  }

  const encryptedId = await buildEncryptedSAMLWrapper(
    doc,
    'EncryptedID',
    nameIdElement,
    encryptionCertificate,
    algorithms
  );
  subjectElement.replaceChild(encryptedId, nameIdElement);
  return serializeXml(doc);
}

async function buildEncryptedSAMLWrapper(
  doc: XMLDocument,
  wrapperLocalName: 'EncryptedAssertion' | 'EncryptedID',
  plaintextElement: XMLElement,
  encryptionCertificate: string,
  algorithms: ResolvedSAMLXmlEncryptionAlgorithms
): Promise<XMLElement> {
  const encryptedPayload = await encryptXmlElement(
    serializeXml(plaintextElement),
    encryptionCertificate,
    algorithms
  );
  const wrapper = createElement(doc, SAML_NAMESPACES.SAML2, wrapperLocalName, 'saml');
  wrapper.setAttribute('xmlns:xenc', SAML_NAMESPACES.XENC);
  wrapper.setAttribute('xmlns:xenc11', SAML_NAMESPACES.XENC11);
  wrapper.setAttribute('xmlns:ds', SAML_NAMESPACES.DS);

  const encryptedData = createElement(doc, SAML_NAMESPACES.XENC, 'EncryptedData', 'xenc');
  setAttribute(encryptedData, 'Type', ENCRYPTED_ELEMENT_TYPE);

  const dataEncryptionMethod = createElement(doc, SAML_NAMESPACES.XENC, 'EncryptionMethod', 'xenc');
  setAttribute(dataEncryptionMethod, 'Algorithm', algorithms.dataAlgorithmUri);
  encryptedData.appendChild(dataEncryptionMethod);

  const keyInfo = createElement(doc, SAML_NAMESPACES.DS, 'KeyInfo', 'ds');
  keyInfo.appendChild(
    buildEncryptedKey(doc, encryptedPayload.encryptedKey, encryptionCertificate, algorithms)
  );
  encryptedData.appendChild(keyInfo);

  encryptedData.appendChild(buildCipherData(doc, encryptedPayload.encryptedData));
  wrapper.appendChild(encryptedData);
  return wrapper;
}

function buildEncryptedKey(
  doc: XMLDocument,
  encryptedKey: string,
  encryptionCertificate: string,
  algorithms: ResolvedSAMLXmlEncryptionAlgorithms
): XMLElement {
  const encryptedKeyElement = createElement(doc, SAML_NAMESPACES.XENC, 'EncryptedKey', 'xenc');
  const keyEncryptionMethod = createElement(doc, SAML_NAMESPACES.XENC, 'EncryptionMethod', 'xenc');
  setAttribute(keyEncryptionMethod, 'Algorithm', algorithms.keyAlgorithmUri);

  if (algorithms.digestAlgorithmUri) {
    const digestMethod = createElement(doc, SAML_NAMESPACES.DS, 'DigestMethod', 'ds');
    setAttribute(digestMethod, 'Algorithm', algorithms.digestAlgorithmUri);
    keyEncryptionMethod.appendChild(digestMethod);
  }

  if (algorithms.includeMgfSha256) {
    const mgf = createElement(doc, SAML_NAMESPACES.XENC11, 'MGF', 'xenc11');
    setAttribute(mgf, 'Algorithm', XML_ENCRYPTION_ALGORITHMS.MGF1_SHA256);
    keyEncryptionMethod.appendChild(mgf);
  }
  encryptedKeyElement.appendChild(keyEncryptionMethod);

  const keyInfo = createElement(doc, SAML_NAMESPACES.DS, 'KeyInfo', 'ds');
  const x509Data = createElement(doc, SAML_NAMESPACES.DS, 'X509Data', 'ds');
  const x509Certificate = createElement(doc, SAML_NAMESPACES.DS, 'X509Certificate', 'ds');
  setTextContent(x509Certificate, cleanPem(encryptionCertificate));
  x509Data.appendChild(x509Certificate);
  keyInfo.appendChild(x509Data);
  encryptedKeyElement.appendChild(keyInfo);

  encryptedKeyElement.appendChild(buildCipherData(doc, encryptedKey));
  return encryptedKeyElement;
}

function buildCipherData(doc: XMLDocument, value: string): XMLElement {
  const cipherData = createElement(doc, SAML_NAMESPACES.XENC, 'CipherData', 'xenc');
  const cipherValue = createElement(doc, SAML_NAMESPACES.XENC, 'CipherValue', 'xenc');
  setTextContent(cipherValue, value);
  cipherData.appendChild(cipherValue);
  return cipherData;
}

async function encryptXmlElement(
  plaintextXml: string,
  encryptionCertificate: string,
  algorithms: ResolvedSAMLXmlEncryptionAlgorithms
): Promise<{ encryptedData: string; encryptedKey: string }> {
  const contentKeyBytes = new Uint8Array(32);
  crypto.getRandomValues(contentKeyBytes);
  const iv = new Uint8Array(algorithms.ivLength);
  crypto.getRandomValues(iv);

  const contentKey = await crypto.subtle.importKey(
    'raw',
    contentKeyBytes,
    { name: algorithms.blockMode, length: 256 },
    true,
    ['encrypt']
  );
  const encryptionParams =
    algorithms.blockMode === 'AES-GCM'
      ? { name: 'AES-GCM', iv, tagLength: 128 }
      : { name: 'AES-CBC', iv };
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      encryptionParams,
      contentKey,
      new TextEncoder().encode(plaintextXml)
    )
  );

  const publicKey = await importRsaOaepPublicKey(encryptionCertificate, algorithms.keyHash);
  const encryptedKey = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, contentKeyBytes)
  );

  return {
    encryptedData: bytesToBase64(concatBytes(iv, ciphertext)),
    encryptedKey: bytesToBase64(encryptedKey),
  };
}

async function importRsaOaepPublicKey(pem: string, hash: 'SHA-1' | 'SHA-256'): Promise<CryptoKey> {
  const der = pemToDer(pem);
  const spki = pem.includes('BEGIN CERTIFICATE')
    ? extractSubjectPublicKeyInfoWithFallback(der)
    : der;
  return crypto.subtle.importKey('spki', toArrayBuffer(spki), { name: 'RSA-OAEP', hash }, false, [
    'encrypt',
  ]);
}

function extractSubjectPublicKeyInfoWithFallback(certDer: Uint8Array): Uint8Array {
  try {
    return extractSubjectPublicKeyInfo(certDer);
  } catch {
    return certDer;
  }
}

function resolveEncryptionCertificate(
  spConfig: Pick<SAMLSPConfig, 'encryptionCertificate' | 'encryptionCertificates'>
): string | undefined {
  return spConfig.encryptionCertificate || spConfig.encryptionCertificates?.[0];
}

function resolveXmlEncryptionAlgorithms(
  spConfig: Pick<
    SAMLSPConfig,
    'encryptionAlgorithmPolicy' | 'assertionEncryptionAlgorithm' | 'keyEncryptionAlgorithm'
  >
): ResolvedSAMLXmlEncryptionAlgorithms {
  const legacyOptIn = spConfig.encryptionAlgorithmPolicy === 'legacy_opt_in';
  const dataAlgorithm =
    spConfig.assertionEncryptionAlgorithm ?? (legacyOptIn ? 'aes256-cbc' : 'aes256-gcm');
  const keyAlgorithm =
    spConfig.keyEncryptionAlgorithm ?? (legacyOptIn ? 'rsa-oaep-sha1' : 'rsa-oaep-256');

  if (!legacyOptIn && (dataAlgorithm === 'aes256-cbc' || keyAlgorithm === 'rsa-oaep-sha1')) {
    throw new Error('Legacy SAML XML Encryption algorithms require explicit opt-in');
  }

  return {
    dataAlgorithm,
    keyAlgorithm,
    dataAlgorithmUri:
      dataAlgorithm === 'aes256-cbc'
        ? XML_ENCRYPTION_ALGORITHMS.AES256_CBC
        : XML_ENCRYPTION_ALGORITHMS.AES256_GCM,
    keyAlgorithmUri:
      keyAlgorithm === 'rsa-oaep-sha1'
        ? XML_ENCRYPTION_ALGORITHMS.RSA_OAEP_MGF1P
        : XML_ENCRYPTION_ALGORITHMS.RSA_OAEP,
    digestAlgorithmUri: keyAlgorithm === 'rsa-oaep-sha1' ? undefined : DIGEST_ALGORITHMS.SHA256,
    keyHash: keyAlgorithm === 'rsa-oaep-sha1' ? 'SHA-1' : 'SHA-256',
    includeMgfSha256: keyAlgorithm !== 'rsa-oaep-sha1',
    blockMode: dataAlgorithm === 'aes256-cbc' ? 'AES-CBC' : 'AES-GCM',
    ivLength: dataAlgorithm === 'aes256-cbc' ? 16 : 12,
  };
}

function cleanPem(pem: string): string {
  return pem
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/-----BEGIN PUBLIC KEY-----/g, '')
    .replace(/-----END PUBLIC KEY-----/g, '')
    .replace(/\s+/g, '');
}

function pemToDer(pem: string): Uint8Array {
  return Uint8Array.from(atob(cleanPem(pem)), (char) => char.charCodeAt(0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.length;
  }
  return combined;
}

interface Asn1Element {
  tag: number;
  length: number;
  data: Uint8Array;
  headerLength: number;
}

function parseAsn1Element(data: Uint8Array, offset: number): Asn1Element {
  const tag = data[offset];
  let length = data[offset + 1];
  let headerLength = 2;

  if (length > 127) {
    const numLengthBytes = length & 0x7f;
    length = 0;
    for (let i = 0; i < numLengthBytes; i++) {
      length = (length << 8) | data[offset + 2 + i];
    }
    headerLength = 2 + numLengthBytes;
  }

  return {
    tag,
    length,
    data: data.subarray(offset + headerLength, offset + headerLength + length),
    headerLength,
  };
}

function extractSubjectPublicKeyInfo(certDer: Uint8Array): Uint8Array {
  const certSeq = parseAsn1Element(certDer, 0);
  if (certSeq.tag !== 0x30) {
    throw new Error('Invalid certificate: expected SEQUENCE');
  }

  const tbsSeq = parseAsn1Element(certSeq.data, 0);
  if (tbsSeq.tag !== 0x30) {
    throw new Error('Invalid TBSCertificate: expected SEQUENCE');
  }

  let pos = 0;
  let fieldIndex = 0;

  while (pos < tbsSeq.data.length && fieldIndex < 7) {
    const element = parseAsn1Element(tbsSeq.data, pos);

    if (fieldIndex === 0 && element.tag === 0xa0) {
      pos += element.headerLength + element.length;
      fieldIndex++;
      continue;
    }

    if (fieldIndex === 6) {
      const start = pos;
      const end = pos + element.headerLength + element.length;
      return tbsSeq.data.subarray(start, end);
    }

    pos += element.headerLength + element.length;
    fieldIndex++;
  }

  throw new Error('SubjectPublicKeyInfo not found in certificate');
}
