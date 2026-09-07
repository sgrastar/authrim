const ENVELOPE_VERSION = 1 as const;
const ENVELOPE_ALGORITHM = 'RSA-OAEP-256+A256GCM' as const;
const SYMMETRIC_ENVELOPE_VERSION = 2 as const;
const SYMMETRIC_ENVELOPE_ALGORITHM = 'A256GCM' as const;
const MAX_PLAINTEXT_BYTES = 128 * 1024;
const MAX_ENVELOPE_BYTES = 192 * 1024;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const SAFE_KEY_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const SAFE_KIND = /^[a-z][a-z0-9._:-]{0,127}$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;

export interface NotificationIntentEnvelopeContext {
  environmentId: string;
  tenantId: string;
  intentId: string;
  notificationKind: string;
  payloadVersion: 1;
}

export interface NotificationIntentEnvelopeV1 {
  version: typeof ENVELOPE_VERSION;
  algorithm: typeof ENVELOPE_ALGORITHM;
  keyId: string;
  wrappedKey: string;
  iv: string;
  ciphertext: string;
}

export interface NotificationIntentEnvelopeV2 {
  version: typeof SYMMETRIC_ENVELOPE_VERSION;
  algorithm: typeof SYMMETRIC_ENVELOPE_ALGORITHM;
  keyId: string;
  iv: string;
  ciphertext: string;
}

interface JsonWebKeySet {
  keys: NotificationJsonWebKey[];
}

interface NotificationJsonWebKey {
  kty: string;
  n?: string;
  e?: string;
  d?: string;
  p?: string;
  q?: string;
  dp?: string;
  dq?: string;
  qi?: string;
  ext?: boolean;
  key_ops?: string[];
  kid?: string;
  use?: string;
  alg?: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function fromBase64url(value: string): Uint8Array {
  if (!BASE64URL.test(value)) throw new Error('notification_envelope_invalid');
  const padded =
    value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new Error('notification_envelope_invalid');
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function assertContext(context: NotificationIntentEnvelopeContext): void {
  if (
    !SAFE_ID.test(context.environmentId) ||
    !SAFE_ID.test(context.tenantId) ||
    !SAFE_ID.test(context.intentId) ||
    !SAFE_KIND.test(context.notificationKind) ||
    context.payloadVersion !== 1
  ) {
    throw new Error('notification_envelope_context_invalid');
  }
}

function aad(
  context: NotificationIntentEnvelopeContext,
  envelopeVersion: 1 | 2 = ENVELOPE_VERSION
): Uint8Array {
  assertContext(context);
  return encoder.encode(
    JSON.stringify([
      'authrim-notification-intent',
      envelopeVersion,
      context.environmentId,
      context.tenantId,
      context.intentId,
      context.notificationKind,
      context.payloadVersion,
    ])
  );
}

function parseJwks(value: string): JsonWebKeySet {
  if (value.length < 1 || value.length > 32_768) {
    throw new Error('notification_encryption_key_invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error('notification_encryption_key_invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('notification_encryption_key_invalid');
  }
  const keys = (parsed as { keys?: unknown }).keys;
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > 2) {
    throw new Error('notification_encryption_key_invalid');
  }
  const normalized: NotificationJsonWebKey[] = [];
  const keyIds = new Set<string>();
  for (const candidate of keys as unknown[]) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('notification_encryption_key_invalid');
    }
    const key = candidate as Record<string, unknown>;
    if (typeof key.kty !== 'string' || typeof key.kid !== 'string' || !SAFE_KEY_ID.test(key.kid)) {
      throw new Error('notification_encryption_key_invalid');
    }
    if (keyIds.has(key.kid)) throw new Error('notification_encryption_key_invalid');
    keyIds.add(key.kid);
    const keyOperations: string[] = [];
    if (Array.isArray(key.key_ops)) {
      for (const operation of key.key_ops as unknown[]) {
        if (typeof operation !== 'string') {
          throw new Error('notification_encryption_key_invalid');
        }
        keyOperations.push(operation);
      }
    }
    normalized.push({
      kty: key.kty,
      kid: key.kid,
      n: typeof key.n === 'string' ? key.n : undefined,
      e: typeof key.e === 'string' ? key.e : undefined,
      d: typeof key.d === 'string' ? key.d : undefined,
      p: typeof key.p === 'string' ? key.p : undefined,
      q: typeof key.q === 'string' ? key.q : undefined,
      dp: typeof key.dp === 'string' ? key.dp : undefined,
      dq: typeof key.dq === 'string' ? key.dq : undefined,
      qi: typeof key.qi === 'string' ? key.qi : undefined,
      ext: typeof key.ext === 'boolean' ? key.ext : undefined,
      key_ops: keyOperations,
      use: typeof key.use === 'string' ? key.use : undefined,
      alg: typeof key.alg === 'string' ? key.alg : undefined,
    });
  }
  return { keys: normalized };
}

function assertRsaJwk(jwk: NotificationJsonWebKey, keyId: string, privateKey: boolean): void {
  const operations: unknown[] = Array.isArray(jwk.key_ops) ? jwk.key_ops : [];
  const publicParametersValid =
    typeof jwk.n === 'string' &&
    BASE64URL.test(jwk.n) &&
    typeof jwk.e === 'string' &&
    BASE64URL.test(jwk.e);
  const privateFields = ['d', 'p', 'q', 'dp', 'dq', 'qi'] as const;
  const privateParametersValid = privateFields.every(
    (field) => typeof jwk[field] === 'string' && BASE64URL.test(jwk[field])
  );
  if (
    jwk.kty !== 'RSA' ||
    jwk.kid !== keyId ||
    jwk.use !== 'enc' ||
    jwk.alg !== 'RSA-OAEP-256' ||
    !publicParametersValid ||
    operations.length !== 1 ||
    operations[0] !== (privateKey ? 'decrypt' : 'encrypt') ||
    (privateKey ? !privateParametersValid : privateFields.some((field) => jwk[field] !== undefined))
  ) {
    throw new Error('notification_encryption_key_invalid');
  }
}

function parseEnvelope(value: string): NotificationIntentEnvelopeV1 | NotificationIntentEnvelopeV2 {
  if (value.length < 1 || value.length > MAX_ENVELOPE_BYTES) {
    throw new Error('notification_envelope_invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error('notification_envelope_invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('notification_envelope_invalid');
  }
  const envelope = parsed as Record<string, unknown>;
  const sharedValid =
    typeof envelope.keyId !== 'string' ||
    !SAFE_KEY_ID.test(envelope.keyId) ||
    typeof envelope.iv !== 'string' ||
    typeof envelope.ciphertext !== 'string';
  if (sharedValid) {
    throw new Error('notification_envelope_invalid');
  }
  const keyId = envelope.keyId as string;
  const iv = envelope.iv as string;
  const ciphertext = envelope.ciphertext as string;
  if (
    envelope.version === ENVELOPE_VERSION &&
    envelope.algorithm === ENVELOPE_ALGORITHM &&
    Object.keys(envelope).sort().join(',') === 'algorithm,ciphertext,iv,keyId,version,wrappedKey' &&
    typeof envelope.wrappedKey === 'string'
  ) {
    return {
      version: ENVELOPE_VERSION,
      algorithm: ENVELOPE_ALGORITHM,
      keyId,
      wrappedKey: envelope.wrappedKey,
      iv,
      ciphertext,
    };
  }
  if (
    envelope.version === SYMMETRIC_ENVELOPE_VERSION &&
    envelope.algorithm === SYMMETRIC_ENVELOPE_ALGORITHM &&
    Object.keys(envelope).sort().join(',') === 'algorithm,ciphertext,iv,keyId,version'
  ) {
    return {
      version: SYMMETRIC_ENVELOPE_VERSION,
      algorithm: SYMMETRIC_ENVELOPE_ALGORITHM,
      keyId,
      iv,
      ciphertext,
    };
  }
  throw new Error('notification_envelope_invalid');
}

export function notificationIntentEnvelopeKeyId(value: string): string {
  return parseEnvelope(value).keyId;
}

async function deriveNotificationPayloadKey(secret: string): Promise<CryptoKey> {
  if (secret.length < 32 || secret.length > 16_384) {
    throw new Error('notification_encryption_key_invalid');
  }
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode('authrim-notification-payload-salt-v2'),
      info: encoder.encode('authrim-notification-payload-a256gcm-v2'),
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptNotificationIntentPayloadWithSecret(input: {
  secret: string;
  keyId: string;
  context: NotificationIntentEnvelopeContext;
  payload: unknown;
}): Promise<string> {
  if (!SAFE_KEY_ID.test(input.keyId)) throw new Error('notification_encryption_key_invalid');
  let plaintext: Uint8Array;
  try {
    plaintext = encoder.encode(JSON.stringify(input.payload));
  } catch {
    throw new Error('notification_payload_invalid');
  }
  if (plaintext.length < 2 || plaintext.length > MAX_PLAINTEXT_BYTES) {
    throw new Error('notification_payload_invalid');
  }
  const key = await deriveNotificationPayloadKey(input.secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: aad(input.context, SYMMETRIC_ENVELOPE_VERSION),
      tagLength: 128,
    },
    key,
    plaintext
  );
  const encoded = JSON.stringify({
    version: SYMMETRIC_ENVELOPE_VERSION,
    algorithm: SYMMETRIC_ENVELOPE_ALGORITHM,
    keyId: input.keyId,
    iv: base64url(iv),
    ciphertext: base64url(new Uint8Array(ciphertext)),
  } satisfies NotificationIntentEnvelopeV2);
  if (encoded.length > MAX_ENVELOPE_BYTES) throw new Error('notification_payload_invalid');
  return encoded;
}

export async function encryptNotificationIntentPayload(input: {
  publicJwks: string;
  activeKeyId: string;
  context: NotificationIntentEnvelopeContext;
  payload: unknown;
}): Promise<string> {
  if (!SAFE_KEY_ID.test(input.activeKeyId)) throw new Error('notification_encryption_key_invalid');
  const key = parseJwks(input.publicJwks).keys.find(
    (candidate) => candidate.kid === input.activeKeyId
  );
  if (!key) throw new Error('notification_encryption_key_invalid');
  assertRsaJwk(key, input.activeKeyId, false);

  let plaintext: Uint8Array;
  try {
    plaintext = encoder.encode(JSON.stringify(input.payload));
  } catch {
    throw new Error('notification_payload_invalid');
  }
  if (plaintext.length < 2 || plaintext.length > MAX_PLAINTEXT_BYTES) {
    throw new Error('notification_payload_invalid');
  }

  const generatedContentKey = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt']
  );
  if (!('type' in generatedContentKey)) throw new Error('notification_encryption_failed');
  const contentKey = generatedContentKey;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(input.context), tagLength: 128 },
    contentKey,
    plaintext
  );
  const exportedContentKey = await crypto.subtle.exportKey('raw', contentKey);
  if (!(exportedContentKey instanceof ArrayBuffer))
    throw new Error('notification_encryption_failed');
  const rawContentKey = exportedContentKey;
  const wrappingKey = await crypto.subtle.importKey(
    'jwk',
    key,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt']
  );
  const wrappedKey = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, wrappingKey, rawContentKey);
  const envelope: NotificationIntentEnvelopeV1 = {
    version: ENVELOPE_VERSION,
    algorithm: ENVELOPE_ALGORITHM,
    keyId: input.activeKeyId,
    wrappedKey: base64url(new Uint8Array(wrappedKey)),
    iv: base64url(iv),
    ciphertext: base64url(new Uint8Array(ciphertext)),
  };
  const encoded = JSON.stringify(envelope);
  if (encoded.length > MAX_ENVELOPE_BYTES) throw new Error('notification_payload_invalid');
  return encoded;
}

export async function decryptNotificationIntentPayload(input: {
  privateJwks?: string;
  symmetricKeys?: Array<{ keyId: string; secret: string }>;
  context: NotificationIntentEnvelopeContext;
  envelope: string;
}): Promise<unknown> {
  const envelope = parseEnvelope(input.envelope);
  if (envelope.version === SYMMETRIC_ENVELOPE_VERSION) {
    const symmetricKey = input.symmetricKeys?.find(
      (candidate) => candidate.keyId === envelope.keyId
    );
    if (!symmetricKey) throw new Error('notification_encryption_key_unavailable');
    let plaintext: ArrayBuffer;
    try {
      const key = await deriveNotificationPayloadKey(symmetricKey.secret);
      plaintext = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: fromBase64url(envelope.iv),
          additionalData: aad(input.context, SYMMETRIC_ENVELOPE_VERSION),
          tagLength: 128,
        },
        key,
        fromBase64url(envelope.ciphertext)
      );
    } catch (error) {
      if (error instanceof Error && error.message === 'notification_encryption_key_invalid') {
        throw error;
      }
      if (error instanceof Error && error.message === 'notification_envelope_context_invalid') {
        throw error;
      }
      if (error instanceof Error && error.message === 'notification_envelope_invalid') throw error;
      throw new Error('notification_envelope_payload_authentication_failed');
    }
    if (plaintext.byteLength < 2 || plaintext.byteLength > MAX_PLAINTEXT_BYTES) {
      throw new Error('notification_envelope_invalid');
    }
    try {
      return JSON.parse(decoder.decode(plaintext)) as unknown;
    } catch {
      throw new Error('notification_envelope_invalid');
    }
  }
  if (!input.privateJwks) throw new Error('notification_encryption_key_unavailable');
  const key = parseJwks(input.privateJwks).keys.find(
    (candidate) => candidate.kid === envelope.keyId
  );
  if (!key) throw new Error('notification_encryption_key_unavailable');
  assertRsaJwk(key, envelope.keyId, true);
  let unwrappingKey: CryptoKey;
  try {
    unwrappingKey = await crypto.subtle.importKey(
      'jwk',
      key,
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      false,
      ['decrypt']
    );
  } catch {
    throw new Error('notification_envelope_private_key_import_failed');
  }
  let rawContentKey: ArrayBuffer;
  try {
    rawContentKey = await crypto.subtle.decrypt(
      { name: 'RSA-OAEP' },
      unwrappingKey,
      fromBase64url(envelope.wrappedKey)
    );
  } catch (error) {
    if (error instanceof Error && error.message === 'notification_envelope_invalid') throw error;
    throw new Error('notification_envelope_key_unwrap_failed');
  }
  let plaintext: ArrayBuffer;
  try {
    const contentKey = await crypto.subtle.importKey(
      'raw',
      rawContentKey,
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    );
    plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: fromBase64url(envelope.iv),
        additionalData: aad(input.context),
        tagLength: 128,
      },
      contentKey,
      fromBase64url(envelope.ciphertext)
    );
  } catch (error) {
    if (error instanceof Error && error.message === 'notification_envelope_context_invalid') {
      throw error;
    }
    if (error instanceof Error && error.message === 'notification_envelope_invalid') throw error;
    throw new Error('notification_envelope_payload_authentication_failed');
  }
  if (plaintext.byteLength < 2 || plaintext.byteLength > MAX_PLAINTEXT_BYTES) {
    throw new Error('notification_envelope_invalid');
  }
  try {
    return JSON.parse(decoder.decode(plaintext)) as unknown;
  } catch {
    throw new Error('notification_envelope_invalid');
  }
}
