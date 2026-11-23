/**
 * Minimal X.509 certificate support for the Authrim VC certificate profile.
 *
 * Authrim signs SD-JWT VCs and Token Status Lists with ECDSA P-256 / ES256 keys and delivers the
 * issuer certificate chain in the `x5c` header (HAIP 1.0 section 6.1.1). This module builds and
 * reads exactly that profile, nothing more: ECDSA P-256 keys, `ecdsa-with-SHA256` signatures, v3
 * certificates with the extensions below. It is not a general X.509 library.
 *
 * Profile:
 * - leaf: `CA:false`, `keyUsage digitalSignature`, `subjectAltName` dNSName, SKI and AKI
 * - issuing CA: `CA:true` with `pathLen`, `keyUsage keyCertSign|cRLSign`, SKI and AKI
 * - the chain delivered to wallets never contains the trust anchor and never a self-signed
 *   certificate (HAIP: "The X.509 certificate signing the request MUST NOT be self-signed")
 *
 * @see https://openid.net/specs/openid4vc-high-assurance-interoperability-profile-1_0.html
 */

import type { JWK } from 'jose';

type Bytes = Uint8Array;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// ---------------------------------------------------------------------------
// Object identifiers
// ---------------------------------------------------------------------------

const OID_EC_PUBLIC_KEY = '1.2.840.10045.2.1';
const OID_PRIME256V1 = '1.2.840.10045.3.1.7';
const OID_ECDSA_SHA256 = '1.2.840.10045.4.3.2';
const OID_COMMON_NAME = '2.5.4.3';
const OID_ORGANIZATION = '2.5.4.10';
const OID_SUBJECT_KEY_IDENTIFIER = '2.5.29.14';
const OID_KEY_USAGE = '2.5.29.15';
const OID_SUBJECT_ALT_NAME = '2.5.29.17';
const OID_BASIC_CONSTRAINTS = '2.5.29.19';
const OID_AUTHORITY_KEY_IDENTIFIER = '2.5.29.35';
const OID_EXTENDED_KEY_USAGE = '2.5.29.37';

// ---------------------------------------------------------------------------
// DER encoding
// ---------------------------------------------------------------------------

function concat(...parts: Bytes[]): Bytes {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function derLength(length: number): Bytes {
  if (length < 0x80) return Uint8Array.of(length);
  const bytes: number[] = [];
  let rest = length;
  while (rest > 0) {
    bytes.unshift(rest & 0xff);
    rest = Math.floor(rest / 256);
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function tlv(tag: number, ...content: Bytes[]): Bytes {
  const body = concat(...content);
  return concat(Uint8Array.of(tag), derLength(body.length), body);
}

const sequence = (...content: Bytes[]): Bytes => tlv(0x30, ...content);
const set = (...content: Bytes[]): Bytes => tlv(0x31, ...content);
const octetString = (content: Bytes): Bytes => tlv(0x04, content);
const utf8String = (value: string): Bytes => tlv(0x0c, textEncoder.encode(value));
const booleanTrue = (): Bytes => tlv(0x01, Uint8Array.of(0xff));
const bitString = (content: Bytes, unusedBits = 0): Bytes =>
  tlv(0x03, Uint8Array.of(unusedBits), content);
const explicit = (n: number, ...content: Bytes[]): Bytes => tlv(0xa0 | n, ...content);

function base128(value: bigint): number[] {
  const chunk: number[] = [Number(value & 0x7fn)];
  let rest = value >> 7n;
  while (rest > 0n) {
    chunk.unshift(Number(rest & 0x7fn) | 0x80);
    rest >>= 7n;
  }
  return chunk;
}

/** DER OBJECT IDENTIFIER of a dotted string; arcs of any size (exported for tests). */
export function derOid(dotted: string): Bytes {
  const parts = dotted.split('.');
  if (parts.length < 2 || parts.some((part) => !/^(?:0|[1-9]\d*)$/u.test(part))) {
    throw new Error('invalid_oid');
  }
  const arcs = parts.map((part) => BigInt(part));
  if (arcs[0] > 2n || (arcs[0] < 2n && arcs[1] >= 40n)) throw new Error('invalid_oid');
  // The first two arcs share one sub-identifier, itself a base-128 integer (X.690 8.19.4).
  const body = [...base128(arcs[0] * 40n + arcs[1]), ...arcs.slice(2).flatMap(base128)];
  return tlv(0x06, Uint8Array.from(body));
}

function derInteger(unsigned: Bytes): Bytes {
  let start = 0;
  while (start < unsigned.length - 1 && unsigned[start] === 0) start += 1;
  const trimmed = unsigned.slice(start);
  const needsPad = (trimmed[0] ?? 0) >= 0x80;
  return tlv(0x02, needsPad ? concat(Uint8Array.of(0), trimmed) : trimmed);
}

function smallInteger(value: number): Bytes {
  if (!Number.isInteger(value) || value < 0 || value > 255) throw new Error('invalid_integer');
  return derInteger(Uint8Array.of(value));
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function derTime(date: Date): Bytes {
  const year = date.getUTCFullYear();
  const body = `${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}${pad2(date.getUTCHours())}${pad2(date.getUTCMinutes())}${pad2(date.getUTCSeconds())}Z`;
  if (year >= 1950 && year < 2050) {
    return tlv(0x17, textEncoder.encode(`${pad2(year % 100)}${body}`));
  }
  return tlv(0x18, textEncoder.encode(`${String(year).padStart(4, '0')}${body}`));
}

function name(commonName: string, organization?: string): Bytes {
  const rdn = (oid: string, value: string): Bytes => set(sequence(derOid(oid), utf8String(value)));
  return sequence(
    ...(organization ? [rdn(OID_ORGANIZATION, organization)] : []),
    rdn(OID_COMMON_NAME, commonName)
  );
}

function extension(oid: string, critical: boolean, value: Bytes): Bytes {
  return sequence(derOid(oid), ...(critical ? [booleanTrue()] : []), octetString(value));
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

function base64UrlToBytes(value: string): Bytes {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

export function bytesToBase64(bytes: Bytes): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(value: string): Bytes {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value) || value.length % 4 !== 0) {
    throw new Error('invalid_base64');
  }
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

/** The uncompressed point `04 || X || Y` of a P-256 public JWK. */
export function p256PointFromJwk(jwk: JWK): Bytes {
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string') {
    throw new Error('unsupported_public_key');
  }
  if (typeof jwk.y !== 'string' || 'd' in jwk) throw new Error('unsupported_public_key');
  const x = base64UrlToBytes(jwk.x);
  const y = base64UrlToBytes(jwk.y);
  if (x.length !== 32 || y.length !== 32) throw new Error('unsupported_public_key');
  return concat(Uint8Array.of(0x04), x, y);
}

function spkiFromPoint(point: Bytes): Bytes {
  return sequence(sequence(derOid(OID_EC_PUBLIC_KEY), derOid(OID_PRIME256V1)), bitString(point));
}

async function sha1(data: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest('SHA-1', data));
}

/** RFC 5280 section 4.2.1.2 method 1: SHA-1 of the subjectPublicKey bits. */
export async function keyIdentifier(point: Bytes): Promise<Bytes> {
  return sha1(point);
}

// ---------------------------------------------------------------------------
// ECDSA signature encoding
// ---------------------------------------------------------------------------

/** WebCrypto returns `r || s`; X.509 carries `SEQUENCE { INTEGER r, INTEGER s }`. */
export function ecdsaRawToDer(raw: Bytes): Bytes {
  if (raw.length !== 64) throw new Error('invalid_ecdsa_signature');
  return sequence(derInteger(raw.slice(0, 32)), derInteger(raw.slice(32)));
}

export function ecdsaDerToRaw(der: Bytes): Bytes {
  try {
    const outer = expectTag(readTlv(der, 0), 0x30);
    if (outer.end !== der.length) throw new Error('invalid_der');
    const parts = readChildren(der, outer);
    if (parts.length !== 2) throw new Error('invalid_der');
    const out = new Uint8Array(64);
    out.set(integerTo32(unsignedInteger(der, parts[0])), 0);
    out.set(integerTo32(unsignedInteger(der, parts[1])), 32);
    return out;
  } catch {
    throw new Error('invalid_ecdsa_signature');
  }
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

export interface CertificateSubject {
  commonName: string;
  organization?: string;
}

export interface BuildCertificateInput {
  subject: CertificateSubject;
  /** The issuer's name. Ignored when `issuerNameDer` is given. */
  issuer?: CertificateSubject;
  /**
   * The issuer name exactly as the issuing certificate carries it as its subject (the DER of its
   * Name, from `ParsedCertificate.subjectName`). Use this for a certificate issued by an existing
   * CA so the two names match byte for byte.
   */
  issuerNameDer?: Bytes;
  /** The subject's public key. */
  subjectPublicKey: JWK;
  /** The issuer's public key, used for the Authority Key Identifier. */
  issuerPublicKey: JWK;
  notBefore: Date;
  notAfter: Date;
  /** dNSName entries of `subjectAltName`. Required for a leaf. */
  dnsNames?: string[];
  /** `true` builds an issuing CA certificate, `false` a leaf. */
  isCA: boolean;
  /** `pathLenConstraint`, for a CA. */
  pathLength?: number;
  /** 16 random bytes by default. Kept as given: positive, non-zero, at most 20 octets encoded. */
  serial?: Bytes;
  /** Extensions outside the profile; `value` is the DER of the extension's value. */
  extraExtensions?: { oid: string; critical: boolean; value: Bytes }[];
  /**
   * `keyUsage` bit positions to set (0 digitalSignature ... 5 keyCertSign, 6 cRLSign ...
   * 8 decipherOnly). Default: digitalSignature for a leaf, keyCertSign and cRLSign for a CA.
   */
  keyUsageBits?: number[];
  /** Leave out a key identifier, or mark it critical. Only for exercising strict verifiers. */
  subjectKeyIdentifier?: 'omit' | 'critical';
  authorityKeyIdentifier?: 'omit' | 'critical';
  /** The issuer's recorded subject key identifier, when it is not derived from its public key. */
  issuerKeyIdentifier?: Bytes;
}

/** Minimal DER BIT STRING content (unused-bits octet, then the data octets) for key usage bits. */
function keyUsageBitString(positions: number[]): Bytes {
  if (
    positions.length === 0 ||
    positions.some((bit) => !Number.isInteger(bit) || bit < 0 || bit > 8)
  ) {
    throw new Error('invalid_key_usage');
  }
  const highest = Math.max(...positions);
  const octets = new Uint8Array(Math.floor(highest / 8) + 1);
  for (const bit of positions) octets[Math.floor(bit / 8)] |= 0x80 >> (bit % 8);
  return concat(Uint8Array.of(octets.length * 8 - (highest + 1)), octets);
}

/** Signs the DER TBSCertificate with the issuer key and returns the raw `r || s` signature. */
export type TbsSigner = (tbs: Bytes) => Promise<Bytes>;

const MAX_SERIAL_OCTETS = 20;
/** `ub-common-name` of X.520 (RFC 5280 Appendix A.1). */
const MAX_COMMON_NAME_LENGTH = 64;

/** A caller-supplied serial is kept as given: positive, non-zero, at most 20 octets encoded. */
function positiveSerial(serial: Bytes): Bytes {
  let start = 0;
  while (start < serial.length && serial[start] === 0) start += 1;
  const value = serial.slice(start);
  if (value.length === 0) throw new Error('invalid_serial');
  const encodedLength = value.length + (value[0] >= 0x80 ? 1 : 0);
  if (encodedLength > MAX_SERIAL_OCTETS) throw new Error('invalid_serial');
  return value;
}

/** 16 random octets with the top bit cleared (always positive) and never all zero. */
function randomSerial(): Bytes {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[0] = bytes[0] & 0x7f;
    if (bytes.some((byte) => byte !== 0)) return bytes;
  }
}

function assertCertificateTime(date: Date): void {
  const time = date.getTime();
  const year = date.getUTCFullYear();
  if (!Number.isFinite(time) || year < 1950 || year > 9999) throw new Error('invalid_validity');
}

const HOST_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

/** A DNS name usable as a dNSName: lower-case ASCII host, no wildcard, no trailing dot. */
export function isCertificateHostName(value: string): boolean {
  return HOST_PATTERN.test(value);
}

/**
 * Builds a DER certificate for the Authrim profile. Returns the certificate DER.
 * The caller supplies the signer so the issuing CA key never has to be exported.
 */
export async function buildCertificate(
  input: BuildCertificateInput,
  sign: TbsSigner
): Promise<Bytes> {
  if (!input.issuerNameDer && !input.issuer) throw new Error('issuer_required');
  const issuerNameDer =
    input.issuerNameDer ?? name(input.issuer!.commonName, input.issuer!.organization);
  assertCertificateTime(input.notBefore);
  assertCertificateTime(input.notAfter);
  if (input.notAfter.getTime() <= input.notBefore.getTime()) throw new Error('invalid_validity');
  const subjectPoint = p256PointFromJwk(input.subjectPublicKey);
  const issuerPoint = p256PointFromJwk(input.issuerPublicKey);
  const dnsNames = input.dnsNames ?? [];
  if (!input.isCA) {
    // The Authrim leaf is named by the issuer host alone, and X.520 limits a commonName to 64.
    if (input.subject.organization !== undefined) {
      throw new Error('leaf_subject_must_be_common_name_only');
    }
    if (input.subject.commonName.length > MAX_COMMON_NAME_LENGTH) {
      throw new Error('common_name_too_long');
    }
    if (dnsNames.length === 0) throw new Error('leaf_requires_dns_name');
    if (input.pathLength !== undefined) throw new Error('path_length_requires_ca');
  }
  for (const host of dnsNames) {
    if (!isCertificateHostName(host)) throw new Error('invalid_dns_name');
  }

  const serial = input.serial ? positiveSerial(input.serial) : randomSerial();

  const basicConstraints = sequence(
    ...(input.isCA ? [booleanTrue()] : []),
    ...(input.isCA && input.pathLength !== undefined ? [smallInteger(input.pathLength)] : [])
  );
  const usage = keyUsageBitString(input.keyUsageBits ?? (input.isCA ? [5, 6] : [0]));
  const keyUsage = tlv(0x03, usage);

  const extensions = [
    extension(OID_BASIC_CONSTRAINTS, true, basicConstraints),
    extension(OID_KEY_USAGE, true, keyUsage),
    ...(dnsNames.length > 0
      ? [
          extension(
            OID_SUBJECT_ALT_NAME,
            false,
            sequence(...dnsNames.map((host) => tlv(0x82, textEncoder.encode(host))))
          ),
        ]
      : []),
    ...(input.subjectKeyIdentifier === 'omit'
      ? []
      : [
          extension(
            OID_SUBJECT_KEY_IDENTIFIER,
            input.subjectKeyIdentifier === 'critical',
            octetString(await keyIdentifier(subjectPoint))
          ),
        ]),
    ...(input.authorityKeyIdentifier === 'omit'
      ? []
      : [
          extension(
            OID_AUTHORITY_KEY_IDENTIFIER,
            input.authorityKeyIdentifier === 'critical',
            sequence(tlv(0x80, input.issuerKeyIdentifier ?? (await keyIdentifier(issuerPoint))))
          ),
        ]),
    ...(input.extraExtensions ?? []).map((extra) =>
      extension(extra.oid, extra.critical, extra.value)
    ),
  ];

  const signatureAlgorithm = sequence(derOid(OID_ECDSA_SHA256));
  const tbs = sequence(
    explicit(0, smallInteger(2)),
    derInteger(serial),
    signatureAlgorithm,
    issuerNameDer,
    sequence(derTime(input.notBefore), derTime(input.notAfter)),
    name(input.subject.commonName, input.subject.organization),
    spkiFromPoint(subjectPoint),
    explicit(3, sequence(...extensions))
  );
  const signature = ecdsaRawToDer(await sign(tbs));
  return sequence(tbs, signatureAlgorithm, bitString(signature));
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

interface Tlv {
  tag: number;
  /** Offset of the tag byte. */
  start: number;
  contentStart: number;
  end: number;
}

/** Reads one TLV that must lie inside `[offset, limit)`; DER only (minimal lengths, no tag 31). */
function readTlv(buffer: Bytes, offset: number, limit: number = buffer.length): Tlv {
  if (offset + 2 > limit) throw new Error('invalid_der');
  const tag = buffer[offset];
  if ((tag & 0x1f) === 0x1f) throw new Error('invalid_der');
  const first = buffer[offset + 1];
  let length: number;
  let contentStart: number;
  if (first < 0x80) {
    length = first;
    contentStart = offset + 2;
  } else {
    const count = first & 0x7f;
    if (count === 0 || count > 4 || offset + 2 + count > limit) throw new Error('invalid_der');
    if (buffer[offset + 2] === 0) throw new Error('invalid_der');
    length = 0;
    for (let i = 0; i < count; i += 1) length = length * 256 + buffer[offset + 2 + i];
    if (length < 0x80) throw new Error('invalid_der');
    contentStart = offset + 2 + count;
  }
  const end = contentStart + length;
  if (end > limit) throw new Error('invalid_der');
  return { tag, start: offset, contentStart, end };
}

function expectTag(tlv: Tlv, tag: number): Tlv {
  if (tlv.tag !== tag) throw new Error('invalid_der');
  return tlv;
}

/** The children of a constructed element; they must fill it exactly. */
function readChildren(buffer: Bytes, parent: Tlv): Tlv[] {
  const children: Tlv[] = [];
  let at = parent.contentStart;
  while (at < parent.end) {
    const child = readTlv(buffer, at, parent.end);
    children.push(child);
    at = child.end;
  }
  return children;
}

function content(buffer: Bytes, tlv: Tlv): Bytes {
  return buffer.slice(tlv.contentStart, tlv.end);
}

/** Dotted string of a DER OBJECT IDENTIFIER's content octets (exported for tests). */
export function decodeOid(bytes: Bytes): string {
  if (bytes.length === 0 || (bytes[bytes.length - 1] & 0x80) !== 0) throw new Error('invalid_der');
  // Base-128 sub-identifiers are minimal: one never starts with the continuation octet 0x80.
  const subIdentifiers: bigint[] = [];
  let value = 0n;
  let arcStart = true;
  for (const byte of bytes) {
    if (arcStart && byte === 0x80) throw new Error('invalid_der');
    value = (value << 7n) | BigInt(byte & 0x7f);
    if ((byte & 0x80) === 0) {
      subIdentifiers.push(value);
      value = 0n;
      arcStart = true;
    } else {
      arcStart = false;
    }
  }
  // The first sub-identifier carries the first two arcs: 0.x and 1.x below 80, 2.x from 80 up.
  const first = subIdentifiers[0];
  const arcs = first < 40n ? [0n, first] : first < 80n ? [1n, first - 40n] : [2n, first - 80n];
  return [...arcs, ...subIdentifiers.slice(1)].map((arc) => arc.toString()).join('.');
}

/** ASCII only: certificate times and dNSNames are IA5/printable text. */
function asciiText(bytes: Bytes): string {
  if (bytes.some((byte) => byte >= 0x80)) throw new Error('invalid_der');
  return String.fromCharCode(...bytes);
}

/** UTF-8 text, with a stable error instead of a TypeError for malformed input. */
function utf8Text(bytes: Bytes): string {
  try {
    return textDecoder.decode(bytes);
  } catch {
    throw new Error('invalid_der');
  }
}

/** A DER INTEGER that must be non-negative and minimally encoded; returns the magnitude bytes. */
function unsignedInteger(buffer: Bytes, tlv: Tlv): Bytes {
  expectTag(tlv, 0x02);
  const bytes = content(buffer, tlv);
  if (bytes.length === 0) throw new Error('invalid_der');
  if ((bytes[0] & 0x80) !== 0) throw new Error('invalid_der');
  if (bytes.length > 1 && bytes[0] === 0 && (bytes[1] & 0x80) === 0) throw new Error('invalid_der');
  return bytes.length > 1 && bytes[0] === 0 ? bytes.slice(1) : bytes;
}

function integerTo32(value: Bytes): Bytes {
  if (value.length > 32 || value.every((byte) => byte === 0))
    throw new Error('invalid_ecdsa_signature');
  const out = new Uint8Array(32);
  out.set(value, 32 - value.length);
  return out;
}

function parseTime(tlv: Tlv, buffer: Bytes): Date {
  const text = asciiText(content(buffer, tlv));
  const match =
    tlv.tag === 0x17
      ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/u.exec(text)
      : tlv.tag === 0x18
        ? /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/u.exec(text)
        : null;
  if (!match) throw new Error('invalid_der');
  let year = Number(match[1]);
  if (tlv.tag === 0x17) year += year >= 50 ? 1900 : 2000;
  const [month, day, hour, minute, second] = match.slice(2).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  // Date.UTC rolls impossible dates over (February 30th becomes March 2nd): refuse them.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    throw new Error('invalid_der');
  }
  return date;
}

const ECDSA_SHA256_ALGORITHM = sequence(derOid(OID_ECDSA_SHA256));
const EC_P256_KEY_ALGORITHM = sequence(derOid(OID_EC_PUBLIC_KEY), derOid(OID_PRIME256V1));

export interface ParsedCertificate {
  der: Bytes;
  /** The serial number magnitude (without a DER sign octet). */
  serial: Bytes;
  /** `commonName` values of the subject, in order. */
  subjectCommonNames: string[];
  /** Whether the subject carries attributes other than `commonName`. */
  subjectHasOtherAttributes: boolean;
  hasBasicConstraints: boolean;
  basicConstraintsCritical: boolean;
  /** The `keyUsage` BIT STRING content (unused-bits octet, then every data octet), if present. */
  keyUsageValue?: Bytes;
  keyUsageCritical: boolean;
  hasExtendedKeyUsage: boolean;
  tbs: Bytes;
  issuerName: Bytes;
  subjectName: Bytes;
  notBefore: Date;
  notAfter: Date;
  /** Uncompressed P-256 point `04 || X || Y`. */
  publicPoint: Bytes;
  signatureDer: Bytes;
  isCA: boolean;
  pathLength?: number;
  keyCertSign: boolean;
  digitalSignature: boolean;
  dnsNames: string[];
  /** `subjectAltName` carries entries other than dNSName. */
  hasNonDnsSubjectAltName: boolean;
  subjectKeyIdentifier?: Bytes;
  subjectKeyIdentifierCritical: boolean;
  authorityKeyIdentifier?: Bytes;
  authorityKeyIdentifierCritical: boolean;
}

function equalBytes(a: Bytes, b: Bytes): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * The attributes of a Name as `[oid, text]` pairs. Only a `commonName` is decoded, and only from a
 * text string type; every other attribute (and a `commonName` of another string type) yields
 * `null`, so a CA name with attributes in any string type still reads.
 */
function readNameAttributes(buffer: Bytes, name: Tlv): [string, string | null][] {
  const out: [string, string | null][] = [];
  for (const rdn of readChildren(buffer, expectTag(name, 0x30))) {
    for (const attribute of readChildren(buffer, expectTag(rdn, 0x31))) {
      const parts = readChildren(buffer, expectTag(attribute, 0x30));
      if (parts.length !== 2) throw new Error('invalid_der');
      const oid = decodeOid(content(buffer, expectTag(parts[0], 0x06)));
      const decodable = oid === OID_COMMON_NAME && [0x0c, 0x13, 0x16].includes(parts[1].tag);
      out.push([oid, decodable ? utf8Text(content(buffer, parts[1])) : null]);
    }
  }
  return out;
}

const SUPPORTED_EXTENSIONS = new Set([
  OID_BASIC_CONSTRAINTS,
  OID_KEY_USAGE,
  OID_SUBJECT_ALT_NAME,
  OID_SUBJECT_KEY_IDENTIFIER,
  OID_AUTHORITY_KEY_IDENTIFIER,
]);

/**
 * Reads a certificate of the Authrim profile. Anything outside it (other key types, other
 * signature algorithms, non-minimal DER, trailing or missing elements, unknown critical
 * extensions) is rejected.
 */
export function parseCertificate(der: Bytes): ParsedCertificate {
  const cert = expectTag(readTlv(der, 0), 0x30);
  if (cert.end !== der.length) throw new Error('invalid_certificate');
  const top = readChildren(der, cert);
  if (top.length !== 3) throw new Error('invalid_certificate');
  const [tbsTlv, algTlv, sigTlv] = top;
  expectTag(tbsTlv, 0x30);
  if (!equalBytes(der.slice(algTlv.start, algTlv.end), ECDSA_SHA256_ALGORITHM)) {
    throw new Error('unsupported_signature_algorithm');
  }
  expectTag(sigTlv, 0x03);
  if (sigTlv.end - sigTlv.contentStart < 2 || der[sigTlv.contentStart] !== 0) {
    throw new Error('invalid_certificate');
  }
  const signatureDer = der.slice(sigTlv.contentStart + 1, sigTlv.end);

  const fields = readChildren(der, tbsTlv);
  let at = 0;
  const next = (): Tlv => {
    const field = fields[at];
    if (!field) throw new Error('invalid_certificate');
    at += 1;
    return field;
  };

  const versionTlv = expectTag(next(), 0xa0);
  const versionChildren = readChildren(der, versionTlv);
  if (versionChildren.length !== 1) throw new Error('invalid_certificate');
  const version = unsignedInteger(der, versionChildren[0]);
  if (version.length !== 1 || version[0] !== 2) throw new Error('unsupported_certificate_version');

  const serialTlv = next();
  const serial = unsignedInteger(der, serialTlv);
  // RFC 5280 4.1.2.2: at most 20 octets of INTEGER content, the sign octet included.
  if (
    serialTlv.end - serialTlv.contentStart > MAX_SERIAL_OCTETS ||
    serial.every((byte) => byte === 0)
  ) {
    throw new Error('invalid_certificate');
  }
  const tbsAlg = next();
  if (!equalBytes(der.slice(tbsAlg.start, tbsAlg.end), ECDSA_SHA256_ALGORITHM)) {
    throw new Error('signature_algorithm_mismatch');
  }
  const issuerTlv = expectTag(next(), 0x30);
  const validityTlv = expectTag(next(), 0x30);
  const validity = readChildren(der, validityTlv);
  if (validity.length !== 2) throw new Error('invalid_certificate');
  const notBefore = parseTime(validity[0], der);
  const notAfter = parseTime(validity[1], der);
  const subjectTlv = expectTag(next(), 0x30);
  const subjectAttributes = readNameAttributes(der, subjectTlv);
  const spkiTlv = expectTag(next(), 0x30);

  const spki = readChildren(der, spkiTlv);
  if (spki.length !== 2) throw new Error('invalid_certificate');
  if (!equalBytes(der.slice(spki[0].start, spki[0].end), EC_P256_KEY_ALGORITHM)) {
    throw new Error('unsupported_public_key');
  }
  expectTag(spki[1], 0x03);
  if (der[spki[1].contentStart] !== 0) throw new Error('invalid_certificate');
  const publicPoint = der.slice(spki[1].contentStart + 1, spki[1].end);
  if (publicPoint.length !== 65 || publicPoint[0] !== 0x04) {
    throw new Error('unsupported_public_key');
  }

  let isCA = false;
  let hasBasicConstraints = false;
  let basicConstraintsCritical = false;
  let keyUsageValue: Bytes | undefined;
  let keyUsageCritical = false;
  let hasExtendedKeyUsage = false;
  let pathLength: number | undefined;
  let keyCertSign = false;
  let digitalSignature = false;
  const dnsNames: string[] = [];
  let hasNonDnsSubjectAltName = false;
  let subjectKeyIdentifier: Bytes | undefined;
  let subjectKeyIdentifierCritical = false;
  let authorityKeyIdentifier: Bytes | undefined;
  let authorityKeyIdentifierCritical = false;

  if (at < fields.length) {
    const extWrapper = expectTag(next(), 0xa3);
    if (at !== fields.length) throw new Error('invalid_certificate');
    const wrapped = readChildren(der, extWrapper);
    if (wrapped.length !== 1) throw new Error('invalid_certificate');
    const seen = new Set<string>();
    for (const ext of readChildren(der, expectTag(wrapped[0], 0x30))) {
      const parts = readChildren(der, expectTag(ext, 0x30));
      if (parts.length < 2 || parts.length > 3) throw new Error('invalid_certificate');
      const oid = decodeOid(content(der, expectTag(parts[0], 0x06)));
      let critical = false;
      if (parts.length === 3) {
        expectTag(parts[1], 0x01);
        // DER: a BOOLEAN that is present must be TRUE (FALSE is the omitted default).
        if (parts[1].end - parts[1].contentStart !== 1 || der[parts[1].contentStart] !== 0xff) {
          throw new Error('invalid_certificate');
        }
        critical = true;
      }
      const valueTlv = expectTag(parts[parts.length - 1], 0x04);
      if (seen.has(oid)) throw new Error('duplicate_extension');
      seen.add(oid);
      // A restricted extended key usage applies whether or not it is marked critical.
      if (oid === OID_EXTENDED_KEY_USAGE) hasExtendedKeyUsage = true;
      if (!SUPPORTED_EXTENSIONS.has(oid)) {
        if (critical) throw new Error('unsupported_critical_extension');
        continue;
      }
      const value = content(der, valueTlv);
      const body = readTlv(value, 0);
      if (body.end !== value.length) throw new Error('invalid_certificate');
      if (oid === OID_BASIC_CONSTRAINTS) {
        hasBasicConstraints = true;
        basicConstraintsCritical = critical;
        expectTag(body, 0x30);
        const items = readChildren(value, body);
        let index = 0;
        if (items[index]?.tag === 0x01) {
          if (
            items[index].end - items[index].contentStart !== 1 ||
            value[items[index].contentStart] !== 0xff
          ) {
            throw new Error('invalid_certificate');
          }
          isCA = true;
          index += 1;
        }
        if (items[index]?.tag === 0x02) {
          const magnitude = unsignedInteger(value, items[index]);
          if (!isCA || magnitude.length > 2) throw new Error('invalid_certificate');
          pathLength = magnitude.reduce((total, byte) => total * 256 + byte, 0);
          index += 1;
        }
        if (index !== items.length) throw new Error('invalid_certificate');
      } else if (oid === OID_KEY_USAGE) {
        expectTag(body, 0x03);
        const bits = content(value, body);
        if (bits.length < 2 || bits[0] > 7) throw new Error('invalid_certificate');
        // The unused trailing bits of a BIT STRING are zero in DER.
        if ((bits[bits.length - 1] & ((1 << bits[0]) - 1)) !== 0) {
          throw new Error('invalid_certificate');
        }
        keyUsageValue = bits;
        keyUsageCritical = critical;
        digitalSignature = (bits[1] & 0x80) !== 0;
        keyCertSign = (bits[1] & 0x04) !== 0;
      } else if (oid === OID_SUBJECT_ALT_NAME) {
        expectTag(body, 0x30);
        for (const entry of readChildren(value, body)) {
          if (entry.tag === 0x82) {
            const bytes = content(value, entry);
            dnsNames.push(asciiText(bytes));
          } else {
            hasNonDnsSubjectAltName = true;
          }
        }
      } else if (oid === OID_SUBJECT_KEY_IDENTIFIER) {
        subjectKeyIdentifier = content(value, expectTag(body, 0x04));
        subjectKeyIdentifierCritical = critical;
      } else if (oid === OID_AUTHORITY_KEY_IDENTIFIER) {
        expectTag(body, 0x30);
        // The profile uses the keyIdentifier form only.
        const items = readChildren(value, body);
        if (items.length !== 1 || items[0].tag !== 0x80) throw new Error('invalid_certificate');
        authorityKeyIdentifier = content(value, items[0]);
        authorityKeyIdentifierCritical = critical;
      }
    }
  }
  if (at !== fields.length) throw new Error('invalid_certificate');

  return {
    der,
    serial,
    subjectCommonNames: subjectAttributes.flatMap(([oid, text]) =>
      oid === OID_COMMON_NAME && text !== null ? [text] : []
    ),
    // A commonName that could not be read as text counts as another attribute.
    subjectHasOtherAttributes: subjectAttributes.some(
      ([oid, text]) => oid !== OID_COMMON_NAME || text === null
    ),
    hasBasicConstraints,
    basicConstraintsCritical,
    keyUsageValue,
    keyUsageCritical,
    hasExtendedKeyUsage,
    tbs: der.slice(tbsTlv.start, tbsTlv.end),
    issuerName: der.slice(issuerTlv.start, issuerTlv.end),
    subjectName: der.slice(subjectTlv.start, subjectTlv.end),
    notBefore,
    notAfter,
    publicPoint,
    signatureDer,
    isCA,
    pathLength,
    keyCertSign,
    digitalSignature,
    dnsNames,
    hasNonDnsSubjectAltName,
    subjectKeyIdentifier,
    subjectKeyIdentifierCritical,
    authorityKeyIdentifier,
    authorityKeyIdentifierCritical,
  };
}

/** Verifies the ECDSA P-256 / SHA-256 signature of `certificate` with the issuer's public point. */
export async function verifyCertificateSignature(
  certificate: ParsedCertificate,
  issuerPublicPoint: Bytes
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      issuerPublicPoint,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      ecdsaDerToRaw(certificate.signatureDer),
      certificate.tbs
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Chain validation for a VC signing key
// ---------------------------------------------------------------------------

export interface VcSigningChainCheck {
  /** The VC signing key the leaf must certify. */
  publicKey: JWK;
  /** The credential issuer host the leaf must name, and be the only name it carries. */
  issuerHost: string;
  /** Epoch milliseconds. */
  now: number;
  /** When set, the chain must have exactly this many certificates (Authrim: leaf plus issuing CA). */
  expectedLength?: number;
  /**
   * The Authrim certificate profile (design D-B): the leaf has `basicConstraints CA:false`, is
   * named by the issuer host as its only common name, and no certificate carries an extended key
   * usage; the issuing CA has `pathLen 0`. Requires a chain of leaf plus issuing CA.
   */
  authrimProfile?: boolean;
  /**
   * When set, the last certificate of the chain must be one of these (lower-case hex SHA-256 of the
   * DER). This ties the chain to the CA the wallets are configured to trust.
   */
  trustedFinalCertificateSha256?: string[];
}

export interface VcSigningChainInfo {
  /** `notAfter` of the leaf, epoch milliseconds. */
  leafNotAfter: number;
  /** The earliest `notAfter` of any certificate in the chain, epoch milliseconds. */
  chainNotAfter: number;
  /** Lower-case hex SHA-256 of the last certificate of the chain (the issuing CA). */
  finalCertificateSha256: string;
  /** Base64 DER entries, ready for the `x5c` header (leaf first, trust anchor excluded). */
  x5c: string[];
}

const MAX_CHAIN_LENGTH = 4;
/** Per certificate and in total (DER octets): the chain travels in every credential's header. */
const MAX_CERTIFICATE_DER_BYTES = 3 * 1024;
const MAX_CHAIN_DER_BYTES = 6 * 1024;

async function sha256Hex(bytes: Bytes): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Validates the chain stored for a VC signing key: the leaf certifies exactly that key and is
 * named for exactly the issuer host, every certificate is inside its validity period, every
 * certificate is signed by the next one, every issuer is a CA, no certificate is self-signed (the
 * trust anchor is never part of the chain Authrim delivers), and, when asked, the last certificate
 * is the configured issuing CA. Throws an Error whose message is a stable code.
 */
export async function validateVcSigningChain(
  chain: string[],
  check: VcSigningChainCheck
): Promise<VcSigningChainInfo> {
  if (!Array.isArray(chain) || chain.length < 2 || chain.length > MAX_CHAIN_LENGTH) {
    throw new Error('invalid_certificate_chain');
  }
  if (check.expectedLength !== undefined && chain.length !== check.expectedLength) {
    throw new Error('invalid_certificate_chain');
  }
  if (check.authrimProfile && chain.length !== 2) throw new Error('invalid_certificate_chain');
  const host = check.issuerHost.toLowerCase();
  if (!isCertificateHostName(host)) throw new Error('invalid_issuer_host');
  // The Authrim leaf repeats the host as its commonName, which X.520 limits to 64 characters.
  if (check.authrimProfile && host.length > MAX_COMMON_NAME_LENGTH) {
    throw new Error('common_name_too_long');
  }

  let totalBytes = 0;
  const certificates: ParsedCertificate[] = chain.map((entry) => {
    if (typeof entry !== 'string' || entry.length > MAX_CERTIFICATE_DER_BYTES * 2) {
      throw new Error('invalid_certificate_chain');
    }
    const der = base64ToBytes(entry);
    totalBytes += der.length;
    if (der.length > MAX_CERTIFICATE_DER_BYTES || totalBytes > MAX_CHAIN_DER_BYTES) {
      throw new Error('certificate_chain_too_large');
    }
    return parseCertificate(der);
  });

  const leaf = certificates[0];
  if (leaf.isCA) throw new Error('leaf_must_not_be_ca');
  if (!leaf.digitalSignature) throw new Error('leaf_requires_digital_signature');
  if (!equalBytes(leaf.publicPoint, p256PointFromJwk(check.publicKey))) {
    throw new Error('leaf_key_mismatch');
  }
  // dNSName comparison ignores ASCII case (RFC 5280 7.2); the names were checked to be ASCII.
  if (
    leaf.dnsNames.length !== 1 ||
    leaf.dnsNames[0].toLowerCase() !== host ||
    leaf.hasNonDnsSubjectAltName
  ) {
    throw new Error('leaf_host_mismatch');
  }
  if (check.authrimProfile) {
    const issuingCa = certificates[1];
    if (!leaf.hasBasicConstraints || !issuingCa.hasBasicConstraints) {
      throw new Error('basic_constraints_missing');
    }
    if (!leaf.basicConstraintsCritical || !issuingCa.basicConstraintsCritical) {
      throw new Error('basic_constraints_not_critical');
    }
    // The leaf signs credentials and nothing else; the issuing CA signs certificates only.
    // Exactly these bits and no others: [unused-bits octet, data octets], minimal DER.
    if (
      !leaf.keyUsageValue ||
      !issuingCa.keyUsageValue ||
      !equalBytes(leaf.keyUsageValue, Uint8Array.of(0x07, 0x80)) ||
      !equalBytes(issuingCa.keyUsageValue, Uint8Array.of(0x01, 0x06)) ||
      !leaf.keyUsageCritical ||
      !issuingCa.keyUsageCritical
    ) {
      throw new Error('key_usage_invalid');
    }
    const [commonName] = leaf.subjectCommonNames;
    if (
      leaf.subjectCommonNames.length !== 1 ||
      leaf.subjectHasOtherAttributes ||
      commonName === undefined ||
      [...commonName].some((character) => character.charCodeAt(0) > 0x7f) ||
      commonName.toLowerCase() !== host
    ) {
      throw new Error('leaf_subject_mismatch');
    }
    if (issuingCa.pathLength !== 0) throw new Error('issuing_ca_path_length');
    if (certificates.some((certificate) => certificate.hasExtendedKeyUsage)) {
      throw new Error('extended_key_usage_not_allowed');
    }
    // The leaf names its issuer's key: path builders (OpenSSL) match AKI against SKI.
    // Both identifiers exist on both certificates and are non-critical (RFC 5280 4.2.1.1-2).
    for (const certificate of [leaf, issuingCa]) {
      if (
        !certificate.subjectKeyIdentifier ||
        certificate.subjectKeyIdentifier.length === 0 ||
        !certificate.authorityKeyIdentifier ||
        certificate.authorityKeyIdentifier.length === 0
      ) {
        throw new Error('key_identifier_missing');
      }
      if (certificate.subjectKeyIdentifierCritical || certificate.authorityKeyIdentifierCritical) {
        throw new Error('key_identifier_critical');
      }
    }
    const leafAuthorityKeyId = leaf.authorityKeyIdentifier;
    const caSubjectKeyId = issuingCa.subjectKeyIdentifier;
    if (!leafAuthorityKeyId || !caSubjectKeyId || !equalBytes(leafAuthorityKeyId, caSubjectKeyId)) {
      throw new Error('authority_key_identifier_mismatch');
    }
  }

  for (let index = 0; index < certificates.length; index += 1) {
    const certificate = certificates[index];
    // Self-signed means signed by its own key, whatever the names say. A renewed CA that keeps its
    // name but is signed by an older key is self-issued, not self-signed, and is judged below.
    if (await verifyCertificateSignature(certificate, certificate.publicPoint)) {
      throw new Error('self_signed_certificate_in_chain');
    }
    if (check.now < certificate.notBefore.getTime() || check.now > certificate.notAfter.getTime()) {
      throw new Error('certificate_not_valid_now');
    }
    const issuer = certificates[index + 1];
    if (issuer) {
      if (!issuer.isCA || !issuer.keyCertSign) throw new Error('issuer_is_not_ca');
      if (issuer.pathLength !== undefined && index > issuer.pathLength) {
        throw new Error('path_length_exceeded');
      }
      if (!equalBytes(certificate.issuerName, issuer.subjectName)) {
        throw new Error('issuer_name_mismatch');
      }
      if (!(await verifyCertificateSignature(certificate, issuer.publicPoint))) {
        throw new Error('invalid_certificate_signature');
      }
    }
  }

  const finalCertificateSha256 = await sha256Hex(certificates[certificates.length - 1].der);
  if (
    check.trustedFinalCertificateSha256 !== undefined &&
    !check.trustedFinalCertificateSha256.includes(finalCertificateSha256)
  ) {
    throw new Error('untrusted_issuing_ca');
  }
  return {
    finalCertificateSha256,
    leafNotAfter: leaf.notAfter.getTime(),
    chainNotAfter: Math.min(...certificates.map((certificate) => certificate.notAfter.getTime())),
    // Re-encoded from the parsed DER: whatever spelling the caller used, `x5c` is canonical.
    x5c: certificates.map((certificate) => bytesToBase64(certificate.der)),
  };
}
