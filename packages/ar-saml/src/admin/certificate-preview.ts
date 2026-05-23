import { SAMLMetadataValidationError } from './errors';

export interface SAMLTrustCertificatePreview {
  certificate: string;
  source: 'url' | 'pem' | 'der';
  subject: string;
  issuer: string;
  serialNumber: string;
  version: string;
  validFrom: string;
  validTo: string;
  signatureAlgorithm: string;
  publicKeyAlgorithm: string;
  publicKeySizeBits?: number;
  fingerprintSha1: string;
  fingerprintSha256: string;
  warnings: string[];
}

interface DerNode {
  tag: number;
  headerLength: number;
  length: number;
  start: number;
  end: number;
}

const OID_LABELS: Record<string, string> = {
  '1.2.840.113549.1.1.1': 'RSA',
  '1.2.840.113549.1.1.4': 'MD5 with RSA',
  '1.2.840.113549.1.1.5': 'SHA1 with RSA',
  '1.2.840.113549.1.1.11': 'SHA256 with RSA',
  '1.2.840.113549.1.1.12': 'SHA384 with RSA',
  '1.2.840.113549.1.1.13': 'SHA512 with RSA',
  '1.2.840.10045.2.1': 'EC public key',
  '1.2.840.10045.3.1.7': 'P-256',
  '1.3.132.0.34': 'P-384',
  '1.3.132.0.35': 'P-521',
  '1.2.840.10045.4.3.2': 'SHA256 with ECDSA',
  '1.2.840.10045.4.3.3': 'SHA384 with ECDSA',
  '1.2.840.10045.4.3.4': 'SHA512 with ECDSA',
  '2.5.4.3': 'CN',
  '2.5.4.6': 'C',
  '2.5.4.7': 'L',
  '2.5.4.8': 'ST',
  '2.5.4.10': 'O',
  '2.5.4.11': 'OU',
  '2.5.4.5': 'serialNumber',
  '1.2.840.113549.1.9.1': 'emailAddress',
};

export async function previewTrustCertificate(
  input: Uint8Array | string,
  source: SAMLTrustCertificatePreview['source']
): Promise<SAMLTrustCertificatePreview> {
  const der = typeof input === 'string' ? decodeCertificateText(input) : decodeCertificateBytes(input);
  const certificate = toPem(der);
  const parsed = parseX509Certificate(der);
  const [fingerprintSha1, fingerprintSha256] = await Promise.all([
    digestHex(der, 'SHA-1'),
    digestHex(der, 'SHA-256'),
  ]);
  const warnings = buildCertificateWarnings(parsed);

  return {
    certificate,
    source,
    ...parsed,
    fingerprintSha1,
    fingerprintSha256,
    warnings,
  };
}

export function decodeCertificateBytes(value: Uint8Array): Uint8Array {
  const firstContentByte = value.find((byte) => byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x20);
  if (firstContentByte === 0x30) {
    return value;
  }

  return decodeCertificateText(new TextDecoder().decode(value));
}

export function decodeCertificateText(value: string): Uint8Array {
  const trimmed = value.trim();
  const pemMatch = trimmed.match(
    /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/
  );
  const base64 = pemMatch ? pemMatch[1] : trimmed;
  const normalized = base64.replace(/\s+/g, '');
  if (!normalized || !/^[A-Za-z0-9+/]+=*$/.test(normalized)) {
    throw new SAMLMetadataValidationError('Input is not a PEM or base64 encoded certificate');
  }

  try {
    return Uint8Array.from(atob(normalized), (char) => char.charCodeAt(0));
  } catch {
    throw new SAMLMetadataValidationError('Input is not a valid certificate encoding');
  }
}

function parseX509Certificate(der: Uint8Array): Omit<
  SAMLTrustCertificatePreview,
  'certificate' | 'source' | 'fingerprintSha1' | 'fingerprintSha256' | 'warnings'
> {
  const certificate = readNode(der, 0);
  if (certificate.tag !== 0x30 || certificate.end !== der.length) {
    throw new SAMLMetadataValidationError('Input is not a DER encoded X.509 certificate');
  }

  const certChildren = childNodes(der, certificate);
  const tbs = certChildren[0];
  const outerSignatureAlgorithm = certChildren[1];
  if (!tbs || tbs.tag !== 0x30 || !outerSignatureAlgorithm || outerSignatureAlgorithm.tag !== 0x30) {
    throw new SAMLMetadataValidationError('Input is not a valid X.509 certificate');
  }

  const tbsChildren = childNodes(der, tbs);
  let index = 0;
  let version = 'v1';
  if (tbsChildren[index]?.tag === 0xa0) {
    const versionNode = childNodes(der, tbsChildren[index])[0];
    version = `v${Number(readInteger(der, versionNode)) + 1}`;
    index += 1;
  }

  const serialNumber = bytesToHex(valueBytes(der, tbsChildren[index++])).toUpperCase();
  index += 1; // tbs signature algorithm
  const issuer = parseName(der, tbsChildren[index++]);
  const validity = childNodes(der, tbsChildren[index++]);
  const validFrom = parseTime(der, validity[0]);
  const validTo = parseTime(der, validity[1]);
  const subject = parseName(der, tbsChildren[index++]);
  const subjectPublicKeyInfoNode = tbsChildren[index++];
  const subjectPublicKeyInfo = childNodes(der, subjectPublicKeyInfoNode);
  const publicKeyAlgorithm = formatAlgorithmIdentifier(der, subjectPublicKeyInfo[0]);

  return {
    subject,
    issuer,
    serialNumber,
    version,
    validFrom,
    validTo,
    signatureAlgorithm: formatAlgorithmIdentifier(der, outerSignatureAlgorithm),
    publicKeyAlgorithm,
    publicKeySizeBits: parsePublicKeySizeBits(der, subjectPublicKeyInfoNode, publicKeyAlgorithm),
  };
}

function buildCertificateWarnings(
  parsed: Pick<
    SAMLTrustCertificatePreview,
    'validFrom' | 'validTo' | 'signatureAlgorithm' | 'publicKeyAlgorithm' | 'publicKeySizeBits'
  >
): string[] {
  const warnings: string[] = [];
  const now = Date.now();
  const validFrom = Date.parse(parsed.validFrom);
  const validTo = Date.parse(parsed.validTo);
  if (Number.isFinite(validFrom) && now < validFrom) {
    warnings.push('Certificate is not valid yet.');
  }
  if (Number.isFinite(validTo) && now > validTo) {
    warnings.push('Certificate is expired.');
  }
  const signatureAlgorithm = parsed.signatureAlgorithm.toLowerCase();
  if (signatureAlgorithm.includes('md5')) {
    warnings.push('Certificate signature uses MD5. Do not use this certificate in production.');
  }
  if (signatureAlgorithm.includes('sha1')) {
    warnings.push('Certificate signature uses SHA-1. Accept only for an explicit legacy compatibility exception.');
  }
  if (
    parsed.publicKeyAlgorithm.toLowerCase().includes('rsa') &&
    typeof parsed.publicKeySizeBits === 'number' &&
    parsed.publicKeySizeBits < 2048
  ) {
    warnings.push(`RSA public key is ${parsed.publicKeySizeBits} bits. Use RSA 2048 bits or stronger.`);
  }
  return warnings;
}

function parsePublicKeySizeBits(
  bytes: Uint8Array,
  subjectPublicKeyInfo: DerNode,
  publicKeyAlgorithm: string
): number | undefined {
  if (!publicKeyAlgorithm.toLowerCase().includes('rsa')) {
    return undefined;
  }

  const [, publicKeyBitString] = childNodes(bytes, subjectPublicKeyInfo);
  if (!publicKeyBitString || publicKeyBitString.tag !== 0x03) {
    return undefined;
  }

  const bitString = valueBytes(bytes, publicKeyBitString);
  if (bitString.length < 2 || bitString[0] !== 0x00) {
    return undefined;
  }

  const rsaPublicKey = readNode(bitString, 1);
  if (rsaPublicKey.tag !== 0x30) {
    return undefined;
  }

  const [modulus] = childNodes(bitString, rsaPublicKey);
  if (!modulus || modulus.tag !== 0x02) {
    return undefined;
  }
  const modulusBytes = valueBytes(bitString, modulus);
  const firstNonZeroIndex = modulusBytes.findIndex((byte) => byte !== 0);
  const normalized =
    firstNonZeroIndex >= 0 ? modulusBytes.slice(firstNonZeroIndex) : new Uint8Array([0]);
  if (normalized.length === 0) {
    return undefined;
  }
  const leadingBits = normalized[0].toString(2).length;
  return (normalized.length - 1) * 8 + leadingBits;
}

function readNode(bytes: Uint8Array, offset: number): DerNode {
  if (offset + 2 > bytes.length) {
    throw new SAMLMetadataValidationError('Invalid DER certificate');
  }
  const tag = bytes[offset];
  const firstLength = bytes[offset + 1];
  let length = 0;
  let headerLength = 2;
  if ((firstLength & 0x80) === 0) {
    length = firstLength;
  } else {
    const lengthBytes = firstLength & 0x7f;
    if (lengthBytes === 0 || lengthBytes > 4 || offset + 2 + lengthBytes > bytes.length) {
      throw new SAMLMetadataValidationError('Invalid DER certificate length');
    }
    headerLength += lengthBytes;
    for (let i = 0; i < lengthBytes; i += 1) {
      length = (length << 8) | bytes[offset + 2 + i];
    }
  }
  const start = offset + headerLength;
  const end = start + length;
  if (end > bytes.length) {
    throw new SAMLMetadataValidationError('Invalid DER certificate length');
  }
  return { tag, headerLength, length, start, end };
}

function childNodes(bytes: Uint8Array, parent: DerNode): DerNode[] {
  const nodes: DerNode[] = [];
  let offset = parent.start;
  while (offset < parent.end) {
    const node = readNode(bytes, offset);
    nodes.push(node);
    offset = node.end;
  }
  if (offset !== parent.end) {
    throw new SAMLMetadataValidationError('Invalid DER certificate structure');
  }
  return nodes;
}

function valueBytes(bytes: Uint8Array, node: DerNode | undefined): Uint8Array {
  if (!node) throw new SAMLMetadataValidationError('Invalid DER certificate structure');
  return bytes.slice(node.start, node.end);
}

function readInteger(bytes: Uint8Array, node: DerNode | undefined): bigint {
  if (!node || node.tag !== 0x02) {
    throw new SAMLMetadataValidationError('Invalid DER integer');
  }
  let value = 0n;
  for (const byte of valueBytes(bytes, node)) {
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}

function parseName(bytes: Uint8Array, node: DerNode | undefined): string {
  if (!node || node.tag !== 0x30) {
    throw new SAMLMetadataValidationError('Invalid X.509 name');
  }
  const parts: string[] = [];
  for (const rdn of childNodes(bytes, node)) {
    for (const attr of childNodes(bytes, rdn)) {
      const [oidNode, valueNode] = childNodes(bytes, attr);
      const oid = parseOid(valueBytes(bytes, oidNode));
      parts.push(`${OID_LABELS[oid] ?? oid}=${decodeDirectoryString(bytes, valueNode)}`);
    }
  }
  return parts.join(', ');
}

function parseTime(bytes: Uint8Array, node: DerNode | undefined): string {
  if (!node || (node.tag !== 0x17 && node.tag !== 0x18)) {
    throw new SAMLMetadataValidationError('Invalid X.509 validity time');
  }
  const text = new TextDecoder().decode(valueBytes(bytes, node));
  const match =
    node.tag === 0x17
      ? text.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z$/)
      : text.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z$/);
  if (!match) return text;
  const [, y, month, day, hour, minute, second = '00'] = match;
  const year =
    node.tag === 0x17 ? (Number(y) >= 50 ? `19${y}` : `20${y}`) : y;
  return new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second))
  ).toISOString();
}

function formatAlgorithmIdentifier(bytes: Uint8Array, node: DerNode | undefined): string {
  if (!node || node.tag !== 0x30) {
    throw new SAMLMetadataValidationError('Invalid X.509 algorithm identifier');
  }
  const [algorithm, parameter] = childNodes(bytes, node);
  const oid = parseOid(valueBytes(bytes, algorithm));
  const label = OID_LABELS[oid] ?? oid;
  if (parameter?.tag === 0x06) {
    const parameterOid = parseOid(valueBytes(bytes, parameter));
    return `${label} (${OID_LABELS[parameterOid] ?? parameterOid})`;
  }
  return label;
}

function parseOid(bytes: Uint8Array): string {
  if (bytes.length === 0) {
    throw new SAMLMetadataValidationError('Invalid OID');
  }
  const values = [Math.floor(bytes[0] / 40), bytes[0] % 40];
  let value = 0;
  for (const byte of bytes.slice(1)) {
    value = (value << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) {
      values.push(value);
      value = 0;
    }
  }
  return values.join('.');
}

function decodeDirectoryString(bytes: Uint8Array, node: DerNode | undefined): string {
  if (!node) return '';
  const value = valueBytes(bytes, node);
  if (node.tag === 0x1e) {
    let text = '';
    for (let i = 0; i + 1 < value.length; i += 2) {
      text += String.fromCharCode((value[i] << 8) | value[i + 1]);
    }
    return text;
  }
  return new TextDecoder().decode(value);
}

function toPem(der: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < der.length; offset += 0x8000) {
    binary += String.fromCharCode(...der.slice(offset, offset + 0x8000));
  }
  const base64 = btoa(binary);
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----`;
}

async function digestHex(bytes: Uint8Array, algorithm: 'SHA-1' | 'SHA-256'): Promise<string> {
  const input = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  const digest = await crypto.subtle.digest(
    algorithm,
    input
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0').toUpperCase())
    .join(':');
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join(':');
}
