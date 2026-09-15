import type { TenantBundleKeyEnvelope } from './bundle-key-envelope';

interface BackupRsaAlgorithm {
  name: string;
  modulusLength: number;
  hash: { name: string };
}

export interface TenantBackupKeyHandoffContext {
  tenantId: string;
  operationId: string;
  requestDigest: string;
  challengeId: string;
  expiresAt: number;
  /** Required for multi-input imports and absent for exports. */
  inputId?: string;
}

/** Supplied by the authenticated coordinator, never selected from the uploaded bundle. */
export interface TenantBackupKeyRecipient {
  publicKey: CryptoKey;
  context: TenantBackupKeyHandoffContext;
}

function invalid(): never {
  throw new Error('invalid_backup_key_handoff');
}

function checkKey(key: CryptoKey, type: 'public' | 'private'): void {
  const algorithm = key.algorithm as BackupRsaAlgorithm;
  if (
    key.type !== type ||
    algorithm.name !== 'RSA-OAEP' ||
    algorithm.hash?.name !== 'SHA-256' ||
    ![2048, 3072, 4096].includes(algorithm.modulusLength)
  )
    invalid();
}

function label(
  context: TenantBackupKeyHandoffContext,
  envelope: Uint8Array
): Uint8Array<ArrayBuffer> {
  if (
    !context ||
    ![
      context.tenantId,
      context.operationId,
      context.challengeId,
      context.inputId ?? 'export',
    ].every((value) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(value)) ||
    !/^[a-f0-9]{64}$/.test(context.requestDigest) ||
    !Number.isSafeInteger(context.expiresAt) ||
    context.expiresAt < 0 ||
    !(envelope instanceof Uint8Array) ||
    envelope.length !== 93 ||
    envelope[0] !== 1
  )
    invalid();
  const binding = new TextEncoder().encode(
    JSON.stringify([
      'authrim-backup-operation-key-v1',
      context.tenantId,
      context.operationId,
      context.requestDigest,
      context.challengeId,
      context.expiresAt,
      context.inputId ?? null,
    ])
  );
  const result = new Uint8Array(binding.length + envelope.length);
  result.set(binding);
  result.set(envelope, binding.length);
  return result;
}

/** Called while create/unlock owns the temporary raw DEK; only ciphertext escapes. */
export async function sealTenantBackupContentKey(
  raw: Uint8Array<ArrayBuffer>,
  envelope: Uint8Array,
  recipient: TenantBackupKeyRecipient
): Promise<Uint8Array<ArrayBuffer>> {
  try {
    checkKey(recipient.publicKey, 'public');
    if (raw.length !== 32) invalid();
    return new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'RSA-OAEP', label: label(recipient.context, envelope) },
        recipient.publicKey,
        raw
      )
    );
  } catch {
    return invalid();
  }
}

/** Worker path: no passphrase or PBKDF2. The caller must atomically consume the challenge. */
export async function openTenantBackupContentKey(
  ciphertext: Uint8Array,
  envelope: Uint8Array,
  privateKey: CryptoKey,
  expected: TenantBackupKeyHandoffContext,
  now: number
): Promise<TenantBundleKeyEnvelope> {
  let raw: Uint8Array<ArrayBuffer> | undefined;
  try {
    checkKey(privateKey, 'private');
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      now >= expected.expiresAt ||
      !(ciphertext instanceof Uint8Array) ||
      ciphertext.length !== (privateKey.algorithm as BackupRsaAlgorithm).modulusLength / 8
    )
      invalid();
    const savedEnvelope = new Uint8Array(envelope);
    raw = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'RSA-OAEP', label: label(expected, savedEnvelope) },
        privateKey,
        new Uint8Array(ciphertext)
      )
    );
    if (raw.length !== 32) invalid();
    const contentKey = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
    return { envelope: savedEnvelope, contentKey };
  } catch {
    return invalid();
  } finally {
    raw?.fill(0);
  }
}
