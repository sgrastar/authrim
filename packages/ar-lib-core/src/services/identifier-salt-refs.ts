/**
 * Where identifier salts live in a tenant's key manager. The tenant's own salt is made on first
 * use; salts brought from other identity providers are imported under their own prefix (and only
 * there), base64 of their bytes, and are never made up when missing.
 */
export const DEFAULT_IDENTIFIER_SALT_REF = 'identifier-salt:default';
export const IMPORTED_IDENTIFIER_SALT_PREFIX = 'identifier-salt:import:';

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
