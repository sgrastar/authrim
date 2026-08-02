export const LOOKUP_VIRTUAL_BUCKET_COUNT = 4096;
export const LOOKUP_NORMALIZATION_VERSION = 1;

export type LookupIdentifierKind = 'email_exact' | 'external_subject' | 'account_id';
export type LookupAliasKind = 'tenant_code' | 'tenant_slug';

export interface LookupBlindIndexKey {
  generation: number;
  secret: string | Uint8Array;
}

export interface LookupBlindIndex {
  indexKind: LookupIdentifierKind;
  normalizationVersion: number;
  hmacKeyGeneration: number;
  digest: string;
  virtualBucket: number;
}

export interface LookupAliasIndex {
  aliasKind: LookupAliasKind;
  digest: string;
  virtualBucket: number;
}

const encoder = new TextEncoder();
const HEX_DIGEST = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_TENANT_ALIAS = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/u;

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function uint32Bytes(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function lengthPrefixed(value: Uint8Array): Uint8Array {
  return concatBytes(uint32Bytes(value.length), value);
}

function bytesToHex(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(value: string): Uint8Array {
  if (!HEX_DIGEST.test(value)) throw new Error('lookup_blind_index_digest_invalid');
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function keyBytes(secret: string | Uint8Array): Uint8Array {
  const bytes = typeof secret === 'string' ? encoder.encode(secret) : secret;
  if (bytes.byteLength < 32) throw new Error('lookup_blind_index_key_too_short');
  return bytes;
}

function requiredGeneration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('lookup_blind_index_key_generation_invalid');
  }
  return value;
}

function requiredBoundedString(value: string, maximumBytes: number, errorCode: string): string {
  if (typeof value !== 'string') throw new Error(errorCode);
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    encoder.encode(normalized).byteLength > maximumBytes ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new Error(errorCode);
  }
  return normalized;
}

export function normalizeLookupEmail(value: string): string {
  const normalized = requiredBoundedString(value, 320, 'lookup_email_invalid').toLowerCase();
  const firstAt = normalized.indexOf('@');
  if (
    firstAt <= 0 ||
    firstAt !== normalized.lastIndexOf('@') ||
    firstAt === normalized.length - 1 ||
    /\s/u.test(normalized)
  ) {
    throw new Error('lookup_email_invalid');
  }
  return normalized;
}

export function normalizeLookupAccountId(value: string): Uint8Array {
  const normalized = requiredBoundedString(value, 255, 'lookup_account_id_invalid');
  if (UUID.test(normalized)) {
    const compact = normalized.replace(/-/g, '').toLowerCase();
    const bytes = new Uint8Array(16);
    for (let index = 0; index < bytes.length; index++) {
      bytes[index] = Number.parseInt(compact.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes;
  }
  return lengthPrefixed(encoder.encode(normalized));
}

export function normalizeLookupExternalSubject(input: {
  issuer: string;
  subject: string;
}): Uint8Array {
  const issuer = requiredBoundedString(
    input.issuer,
    2048,
    'lookup_external_subject_issuer_invalid'
  );
  const subject = requiredBoundedString(
    input.subject,
    1024,
    'lookup_external_subject_value_invalid'
  );
  return concatBytes(
    lengthPrefixed(encoder.encode(issuer)),
    lengthPrefixed(encoder.encode(subject))
  );
}

function normalizeIdentifier(
  indexKind: LookupIdentifierKind,
  value: string | { issuer: string; subject: string }
): Uint8Array {
  switch (indexKind) {
    case 'email_exact':
      if (typeof value !== 'string') throw new Error('lookup_email_invalid');
      return encoder.encode(normalizeLookupEmail(value));
    case 'account_id':
      if (typeof value !== 'string') throw new Error('lookup_account_id_invalid');
      return normalizeLookupAccountId(value);
    case 'external_subject':
      if (typeof value === 'string') throw new Error('lookup_external_subject_invalid');
      return normalizeLookupExternalSubject(value);
  }
}

async function sha256(value: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', value));
}

export async function lookupVirtualBucket(
  indexKind: LookupIdentifierKind,
  blindDigest: string
): Promise<number> {
  const hash = await lookupBlindIndexSecondaryDigest(indexKind, blindDigest);
  return (hash[0] << 4) | (hash[1] >>> 4);
}

export async function lookupBlindIndexSecondaryDigest(
  indexKind: LookupIdentifierKind,
  blindDigest: string
): Promise<Uint8Array> {
  return sha256(
    concatBytes(encoder.encode(indexKind), new Uint8Array([0]), hexToBytes(blindDigest))
  );
}

export async function lookupBlindIndexCacheKeyDigest(index: LookupBlindIndex): Promise<string> {
  return bytesToHex(await lookupBlindIndexSecondaryDigest(index.indexKind, index.digest));
}

export async function createLookupBlindIndex(
  indexKind: LookupIdentifierKind,
  value: string | { issuer: string; subject: string },
  key: LookupBlindIndexKey
): Promise<LookupBlindIndex> {
  const generation = requiredGeneration(key.generation);
  const normalized = normalizeIdentifier(indexKind, value);
  const message = concatBytes(
    encoder.encode(indexKind),
    new Uint8Array([0]),
    uint32Bytes(LOOKUP_NORMALIZATION_VERSION),
    lengthPrefixed(normalized)
  );
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes(key.secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const digest = bytesToHex(await crypto.subtle.sign('HMAC', cryptoKey, message));
  return {
    indexKind,
    normalizationVersion: LOOKUP_NORMALIZATION_VERSION,
    hmacKeyGeneration: generation,
    digest,
    virtualBucket: await lookupVirtualBucket(indexKind, digest),
  };
}

export async function createLookupBlindIndexes(
  indexKind: LookupIdentifierKind,
  value: string | { issuer: string; subject: string },
  keys: readonly LookupBlindIndexKey[]
): Promise<LookupBlindIndex[]> {
  if (keys.length < 1 || keys.length > 2) throw new Error('lookup_blind_index_key_count_invalid');
  const generations = new Set<number>();
  for (const key of keys) {
    const generation = requiredGeneration(key.generation);
    if (generations.has(generation)) throw new Error('lookup_blind_index_key_generation_duplicate');
    generations.add(generation);
  }
  return Promise.all(keys.map((key) => createLookupBlindIndex(indexKind, value, key)));
}

export async function createLookupAliasIndex(
  aliasKind: LookupAliasKind,
  value: string
): Promise<LookupAliasIndex> {
  const normalized = requiredBoundedString(value, 64, 'lookup_alias_invalid').toLowerCase();
  if (!SAFE_TENANT_ALIAS.test(normalized)) throw new Error('lookup_alias_invalid');
  const hash = await sha256(
    concatBytes(encoder.encode(aliasKind), new Uint8Array([0]), encoder.encode(normalized))
  );
  return {
    aliasKind,
    digest: bytesToHex(hash),
    virtualBucket: (hash[0] << 4) | (hash[1] >>> 4),
  };
}
