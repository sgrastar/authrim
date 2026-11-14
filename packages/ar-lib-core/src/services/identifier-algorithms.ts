import { md5 } from './md5';

/**
 * Persistent identifiers that match another identity provider's, so people keep the
 * identifiers they had when a tenant moves to Authrim. Each algorithm reproduces its source's
 * code byte for byte (confirmed against the projects' sources on 2026-11-14):
 *
 * - `authrim_sha256`: base64url(SHA-256(audience ‖ value ‖ salt)), unpadded. The same as
 *   `generatePairwiseSubject` (utils/pairwise.ts) and the OIDC Core §8.1 example.
 * - `shibboleth`: Shibboleth IdP `ComputedPairwiseIdStore` — digest(recipient `!` value `!`
 *   salt) with the salt bytes appended last; SHA-1 by default (`idp.persistentId.algorithm`),
 *   Base64 (padded) by default or Base32 (RFC 4648, upper case, padded).
 * - `keycloak_sha256`: Keycloak `SHA256PairwiseSubMapper` —
 *   `UUID.nameUUIDFromBytes(SHA-256(sector ‖ localSub ‖ salt))`: the 32 raw digest bytes go
 *   through MD5, then the version (3) and IETF variant bits are set.
 * - `simplesamlphp_targeted_id`: SimpleSAMLphp `core:TargetedID` — hex(SHA-1("uidhashbase" S
 *   len:src len:dst len:uid S)), where src and dst are `set<len>:<metadata-set>set<len>:<entityid>`.
 * - `simplesamlphp_persistent_nameid`: SimpleSAMLphp `saml:PersistentNameID` — the same with the
 *   bare entity IDs.
 * - `simplesamlphp_pairwise_id`: SimpleSAMLphp `saml:PairwiseID` —
 *   lower(hex(HMAC-SHA-256(S, uid "|" sp)) "@" scope).
 * - `simplesamlphp_subject_id`: SimpleSAMLphp `saml:SubjectID` with `hashed` —
 *   lower(hex(HMAC-SHA-256(S, uid)) "@" scope).
 *
 * Lengths are byte lengths (PHP `strlen`), not UTF-16 code units. Strings are UTF-8.
 */

export const IDENTIFIER_ALGORITHMS = [
  'authrim_sha256',
  'shibboleth',
  'keycloak_sha256',
  'simplesamlphp_targeted_id',
  'simplesamlphp_persistent_nameid',
  'simplesamlphp_pairwise_id',
  'simplesamlphp_subject_id',
] as const;
export type IdentifierAlgorithm = (typeof IDENTIFIER_ALGORITHMS)[number];

/** Digests Shibboleth can be configured with (Java `MessageDigest` names map onto these). */
export const SHIBBOLETH_DIGESTS = ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'] as const;
export type ShibbolethDigest = (typeof SHIBBOLETH_DIGESTS)[number];

export const SHIBBOLETH_ENCODINGS = ['base64', 'base32'] as const;
export type ShibbolethEncoding = (typeof SHIBBOLETH_ENCODINGS)[number];

export interface IdentifierComputation {
  algorithm: IdentifierAlgorithm;
  /** What the identifier is made from: an Authrim account ID or a migrated attribute value. */
  value: string;
  /**
   * Who it is for. OIDC: the client ID or the sector host. SAML: the service provider's entity
   * ID. Not used by `simplesamlphp_subject_id`, which is the same for every recipient.
   */
  audience: string;
  /** This identity provider's entity ID (SimpleSAMLphp TargetedID / PersistentNameID). */
  issuer?: string;
  /** The salt as bytes: an imported string is its UTF-8 bytes; base64 input is decoded. */
  salt: Uint8Array;
  /** `shibboleth` only. */
  digest?: ShibbolethDigest;
  /** `shibboleth` only. */
  encoding?: ShibbolethEncoding;
  /** SimpleSAMLphp pairwise-id / subject-id: the scope after "@". */
  scope?: string;
  /** SimpleSAMLphp TargetedID: the metadata sets of the source and destination. */
  sourceMetadataSet?: string;
  destinationMetadataSet?: string;
}

const encoder = new TextEncoder();
const utf8 = (value: string): Uint8Array => encoder.encode(value);

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function digestBytes(algorithm: string, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest(algorithm, new Uint8Array(data)));
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, new Uint8Array(data)));
}

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const base64url = (bytes: Uint8Array): string =>
  base64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 Base32, upper case, padded with "=" (Shibboleth's `Base32Support`). */
export function base32(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  while (out.length % 8 !== 0) out += '=';
  return out;
}

/** Java `UUID.nameUUIDFromBytes`: MD5, version 3, IETF variant, lower-case 8-4-4-4-12. */
function javaNameUUIDFromBytes(name: Uint8Array): string {
  const bytes = md5(name);
  bytes[6] = (bytes[6] & 0x0f) | 0x30;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = hex(bytes);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** PHP `strlen($s) . ':' . $s`, with the byte length. */
const lengthPrefixed = (value: string): Uint8Array => {
  const bytes = utf8(value);
  return concat(utf8(`${bytes.length}:`), bytes);
};

/** SimpleSAMLphp TargetedID's getEntityId(): `set<len>:<set>` then `set<len>:<entityid>`. */
function simpleSamlEntityId(metadataSet: string | undefined, entityId: string): Uint8Array {
  const parts: Uint8Array[] = [];
  if (metadataSet !== undefined) parts.push(utf8('set'), lengthPrefixed(metadataSet));
  parts.push(utf8('set'), lengthPrefixed(entityId));
  return concat(...parts);
}

function requireText(value: string | undefined, name: string): string {
  if (!value) throw new IdentifierComputationError(`identifier.${name}_missing`);
  return value;
}

export class IdentifierComputationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'IdentifierComputationError';
  }
}

/** The identifier, before any protocol framing (a scope, NameQualifiers). */
export async function computeIdentifier(input: IdentifierComputation): Promise<string> {
  const value = requireText(input.value, 'value');
  if (input.salt.length === 0) throw new IdentifierComputationError('identifier.salt_missing');
  const salt = input.salt;

  switch (input.algorithm) {
    case 'authrim_sha256': {
      const audience = requireText(input.audience, 'audience');
      return base64url(await digestBytes('SHA-256', concat(utf8(audience), utf8(value), salt)));
    }
    case 'shibboleth': {
      const audience = requireText(input.audience, 'audience');
      const digest = await digestBytes(
        input.digest ?? 'SHA-1',
        concat(utf8(audience), utf8('!'), utf8(value), utf8('!'), salt)
      );
      return (input.encoding ?? 'base64') === 'base32' ? base32(digest) : base64(digest);
    }
    case 'keycloak_sha256': {
      const audience = requireText(input.audience, 'audience');
      const digest = await digestBytes('SHA-256', concat(utf8(audience), utf8(value), salt));
      return javaNameUUIDFromBytes(digest);
    }
    case 'simplesamlphp_targeted_id': {
      const source = simpleSamlEntityId(
        input.sourceMetadataSet,
        requireText(input.issuer, 'issuer')
      );
      const destination = simpleSamlEntityId(
        input.destinationMetadataSet,
        requireText(input.audience, 'audience')
      );
      const data = concat(
        utf8('uidhashbase'),
        salt,
        utf8(`${source.length}:`),
        source,
        utf8(`${destination.length}:`),
        destination,
        lengthPrefixed(value),
        salt
      );
      return hex(await digestBytes('SHA-1', data));
    }
    case 'simplesamlphp_persistent_nameid': {
      const data = concat(
        utf8('uidhashbase'),
        salt,
        lengthPrefixed(requireText(input.issuer, 'issuer')),
        lengthPrefixed(requireText(input.audience, 'audience')),
        lengthPrefixed(value),
        salt
      );
      return hex(await digestBytes('SHA-1', data));
    }
    case 'simplesamlphp_pairwise_id': {
      const audience = requireText(input.audience, 'audience');
      const scope = requireText(input.scope, 'scope');
      const mac = hex(await hmacSha256(salt, utf8(`${value}|${audience}`)));
      return `${mac}@${scope}`.toLowerCase();
    }
    case 'simplesamlphp_subject_id': {
      const scope = requireText(input.scope, 'scope');
      return `${hex(await hmacSha256(salt, utf8(value)))}@${scope}`.toLowerCase();
    }
  }
}

/**
 * OASIS SAML V2.0 Subject Identifier Attributes §3.3/§3.4: a unique part of 1–127 characters
 * starting with a letter or digit, then letters, digits, "=" or "-"; "@"; a scope of 1–127
 * characters starting with a letter or digit, then letters, digits, "-" or ".".
 */
const SUBJECT_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9=-]{0,126}@[A-Za-z0-9][A-Za-z0-9.-]{0,126}$/u;

export function isSubjectIdentifierValue(value: string): boolean {
  return SUBJECT_IDENTIFIER.test(value);
}

export const IDENTIFIER_SCOPE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,126}$/u;
