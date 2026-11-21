/**
 * The shared secret of an admin's authenticator-app (TOTP) second factor, sealed for storage.
 *
 * The secret is encrypted with the key admin-managed credentials use (AES-256-GCM, versioned) and
 * is bound to the admin it belongs to: the admin's id is sealed with it, so a row copied to
 * another admin's account does not open. It is returned to nobody after enrolment; only the
 * verification that checks a code opens it.
 */

import type { Env } from '../types/env';
import { decryptValue, encryptValue } from '../utils/pii-encryption';

const SEPARATOR = '\n';

/** The key and version admin-managed secrets are encrypted with, or null when none is configured. */
export function getAdminSecretEncryptionKey(env: Env): { key: string; version: number } | null {
  const key =
    env.ADMIN_CREDENTIAL_ENCRYPTION_KEY || env.RP_TOKEN_ENCRYPTION_KEY || env.PII_ENCRYPTION_KEY;
  if (!key) return null;
  const version = Number.parseInt(env.PII_ENCRYPTION_KEY_VERSION || '1', 10) || 1;
  return { key, version };
}

/** Seal a base32 secret for this admin. Null when no encryption key is configured. */
export async function sealAdminTotpSecret(
  env: Env,
  adminUserId: string,
  secretBase32: string
): Promise<{ encrypted: string; keyVersion: number } | null> {
  const keyInfo = getAdminSecretEncryptionKey(env);
  if (!keyInfo) return null;
  const sealed = await encryptValue(
    `${adminUserId}${SEPARATOR}${secretBase32}`,
    keyInfo.key,
    'AES-256-GCM',
    keyInfo.version
  );
  return { encrypted: sealed.encrypted, keyVersion: sealed.keyVersion };
}

/**
 * Open a sealed secret. Null when it cannot be opened for this admin: no key, a value that is not
 * encrypted (plaintext is never accepted as a secret), a failed decryption, or a secret sealed
 * for another admin.
 */
export async function openAdminTotpSecret(
  env: Env,
  adminUserId: string,
  encrypted: string
): Promise<string | null> {
  const keyInfo = getAdminSecretEncryptionKey(env);
  if (!keyInfo) return null;
  try {
    const opened = await decryptValue(encrypted, keyInfo.key);
    if (!opened.wasEncrypted) return null;
    const prefix = `${adminUserId}${SEPARATOR}`;
    if (!opened.decrypted.startsWith(prefix)) return null;
    const secret = opened.decrypted.slice(prefix.length);
    return secret.length > 0 ? secret : null;
  } catch {
    return null;
  }
}
