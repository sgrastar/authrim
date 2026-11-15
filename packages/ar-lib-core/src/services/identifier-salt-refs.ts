/**
 * Where identifier salts live in a tenant's key manager. The tenant's own salt is made on first
 * use; salts brought from other identity providers are imported under their own prefix (and only
 * there), base64 of their bytes, and are never made up when missing.
 */
export const DEFAULT_IDENTIFIER_SALT_REF = 'identifier-salt:default';
export const IMPORTED_IDENTIFIER_SALT_PREFIX = 'identifier-salt:import:';

/**
 * The key the imported salts' fingerprints are an HMAC under. Internal: made by the first salt
 * import (never by a read), never returned, and refused by the private create / rotate paths.
 */
export const IDENTIFIER_SALT_FINGERPRINT_KEY_REF = 'identifier-salt:fingerprint-key';

/**
 * The key the retired identifier values are kept under as an HMAC: a value that was replaced or
 * erased is kept only as this HMAC, so it can be refused for any other account without the value
 * itself (personal data) being kept. Internal like the fingerprint key.
 */
export const IDENTIFIER_VALUE_HMAC_KEY_REF = 'identifier-salt:value-hmac-key';

export const importedIdentifierSaltRef = (name: string): string =>
  `${IMPORTED_IDENTIFIER_SALT_PREFIX}${name}`;

interface KeyManagerSecretReader {
  idFromName(name: string): unknown;
  get(id: unknown): unknown;
}

/** An imported salt by name, as stored (base64); null when there is none or it cannot be read. */
export async function readImportedIdentifierSalt(
  keyManager: KeyManagerSecretReader | undefined,
  tenantId: string,
  name: string
): Promise<string | null> {
  if (!keyManager) return null;
  const stub = keyManager.get(keyManager.idFromName(`${tenantId}-v3`)) as {
    getExistingSecretRpc?: (ref: string) => Promise<{ active?: { value?: unknown } } | null>;
  };
  if (typeof stub.getExistingSecretRpc !== 'function') return null;
  const secret = await stub.getExistingSecretRpc(importedIdentifierSaltRef(name));
  return typeof secret?.active?.value === 'string' ? secret.active.value : null;
}
