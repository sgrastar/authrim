/**
 * Browser / CLI passphrase wrapping. Do not invoke the KDF in a Worker request:
 * workerd's default PBKDF2 ceiling is below this format's fixed work factor.
 * Workers receive an operation-protected content key through the coordinator.
 */
export const TENANT_BUNDLE_KDF_ITERATIONS = 600_000;
const DOMAIN = new TextEncoder().encode('authrim-tenant-bundle-key-v1');
const HEADER_BYTES = 45; // suite byte, bundle ID (16), salt (16), wrap nonce (12)
const ENVELOPE_BYTES = HEADER_BYTES + 48; // 32-byte key + GCM tag

export interface TenantBundleKeyEnvelope {
  /** Immutable-by-convention binary envelope; never includes tenant data. */
  envelope: Uint8Array;
  /** HKDF base key. Each stream derives its own AES key with a fresh stream salt. */
  contentKey: CryptoKey;
}

export class TenantBundleKeyError extends Error {
  constructor() {
    super('invalid_tenant_bundle_key_envelope');
    this.name = 'TenantBundleKeyError';
  }
}

function aad(header: Uint8Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(DOMAIN.length + header.length);
  bytes.set(DOMAIN);
  bytes.set(header, DOMAIN.length);
  return bytes;
}

function parseEnvelope(input: Uint8Array): Uint8Array<ArrayBuffer> {
  if (!(input instanceof Uint8Array) || input.length !== ENVELOPE_BYTES || input[0] !== 1) {
    throw new TenantBundleKeyError();
  }
  return new Uint8Array(input);
}

async function wrappingKey(passphrase: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  // Preserve exact Unicode and whitespace. Normalization could change a backup password.
  if (typeof passphrase !== 'string' || passphrase.length < 16 || passphrase.length > 1024)
    throw new TenantBundleKeyError();
  const bytes = new TextEncoder().encode(passphrase);
  try {
    if (new TextDecoder().decode(bytes) !== passphrase) throw new TenantBundleKeyError();
    const base = await crypto.subtle.importKey('raw', bytes, 'PBKDF2', false, ['deriveKey']);
    return await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: TENANT_BUNDLE_KDF_ITERATIONS, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  } finally {
    bytes.fill(0);
  }
}

async function importContentKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
}

/** Generates an independent backup key, never copies an environment root key. */
export async function createTenantBundleKeyEnvelope(
  passphrase: string
): Promise<TenantBundleKeyEnvelope> {
  const header = crypto.getRandomValues(new Uint8Array(HEADER_BYTES));
  header[0] = 1;
  const raw = crypto.getRandomValues(new Uint8Array(32));
  try {
    const key = await wrappingKey(passphrase, header.slice(17, 33));
    const wrapped = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: header.slice(33), additionalData: aad(header), tagLength: 128 },
        key,
        raw
      )
    );
    const envelope = new Uint8Array(ENVELOPE_BYTES);
    envelope.set(header);
    envelope.set(wrapped, HEADER_BYTES);
    return { envelope, contentKey: await importContentKey(raw) };
  } finally {
    raw.fill(0);
  }
}

/** Has no storage/network side effects; errors never contain passphrase or plaintext. */
export async function unlockTenantBundleKeyEnvelope(
  input: Uint8Array,
  passphrase: string
): Promise<TenantBundleKeyEnvelope> {
  const envelope = parseEnvelope(input);
  const key = await wrappingKey(passphrase, envelope.slice(17, 33));
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: envelope.slice(33, 45),
          additionalData: aad(envelope.slice(0, HEADER_BYTES)),
          tagLength: 128,
        },
        key,
        envelope.slice(HEADER_BYTES)
      )
    );
  } catch {
    throw new TenantBundleKeyError();
  }
  try {
    return { envelope, contentKey: await importContentKey(raw) };
  } finally {
    raw.fill(0);
  }
}

/**
 * Worker-compatible per-stream key derivation. Fresh random salt on every encoding
 * prevents nonce reuse even if a job retries with the same wrapped content key.
 */
export async function deriveTenantBundleStreamKey(
  contentKey: CryptoKey,
  streamSalt: Uint8Array
): Promise<CryptoKey> {
  if (!(streamSalt instanceof Uint8Array) || streamSalt.length !== 32)
    throw new TenantBundleKeyError();
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(streamSalt), info: DOMAIN },
    contentKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}
