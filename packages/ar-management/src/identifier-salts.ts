import type { Context } from 'hono';
import {
  createAuditLog,
  getTenantIdFromContext,
  importedIdentifierSaltRef,
  IMPORTED_IDENTIFIER_SALT_PREFIX,
  type AdminAuthContext,
  type Env,
} from '@authrim/ar-lib-core';

/**
 * Salts brought from another identity provider (Shibboleth `idp.persistentId.salt`, Keycloak's
 * pairwise mapper salt, SimpleSAMLphp `secretsalt`), so a persistent_identifier step can make
 * the identifiers people already have. A salt is written once and never read back: the API and
 * the audit log only ever show its fingerprint.
 */

type AdminContext = Context<{ Bindings: Env }>;

const SALT_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/u;
/**
 * The salt the other IdP used, whatever its length: the identifiers are only kept if it is taken
 * as it was (Shibboleth itself asks for 16 bytes, SimpleSAMLphp and Keycloak for none).
 */
const MIN_SALT_BYTES = 1;
const MAX_SALT_BYTES = 4096;
const FINGERPRINT = /^[0-9a-f]{16}$/u;

interface KeyManagerSaltStub {
  importSecretRpc(input: {
    secretRef: string;
    value: string;
    replaceFingerprint?: string;
  }): Promise<{ fingerprint: string; outcome: 'created' | 'unchanged' | 'replaced' }>;
  listImportedSecretsRpc(): Promise<
    Array<{ secretRef: string; fingerprint: string; updatedAt: number }>
  >;
}

function keyManager(env: Env, tenantId: string): KeyManagerSaltStub | null {
  if (!env.KEY_MANAGER) return null;
  return env.KEY_MANAGER.get(env.KEY_MANAGER.idFromName(`${tenantId}-v3`));
}

const invalid = (c: AdminContext, description: string) =>
  c.json({ error: 'invalid_request', error_description: description }, 400);

export async function adminIdentifierSaltsListHandler(c: AdminContext): Promise<Response> {
  const tenantId = getTenantIdFromContext(c);
  const stub = keyManager(c.env, tenantId);
  if (!stub) {
    return c.json({ error: 'unavailable', error_description: 'Key manager unavailable' }, 503);
  }
  const salts = await stub.listImportedSecretsRpc();
  return c.json({
    salts: salts.map((salt) => ({
      name: salt.secretRef.slice(IMPORTED_IDENTIFIER_SALT_PREFIX.length),
      fingerprint: salt.fingerprint,
      updatedAt: salt.updatedAt,
    })),
  });
}

/**
 * PUT a salt under a name. `encoding: 'utf8'` takes the text as the IdP held it (Shibboleth
 * `idp.persistentId.salt`, Keycloak, SimpleSAMLphp); `'base64'` takes bytes (Shibboleth
 * `idp.persistentId.encodedSalt`). Putting the same salt again changes nothing; a different one
 * replaces the current salt only with the current fingerprint in `replaceFingerprint`.
 */
export async function adminIdentifierSaltPutHandler(c: AdminContext): Promise<Response> {
  const tenantId = getTenantIdFromContext(c);
  const name = c.req.param('name') ?? '';
  if (!SALT_NAME.test(name)) return invalid(c, 'name is invalid');
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return invalid(c, 'Request body must be valid JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return invalid(c, 'Request body must be an object');
  }
  const { value, encoding, replaceFingerprint } = body as Record<string, unknown>;
  if (typeof value !== 'string' || value.length === 0) return invalid(c, 'value is required');
  if (encoding !== 'utf8' && encoding !== 'base64') {
    return invalid(c, 'encoding must be utf8 or base64');
  }
  if (
    replaceFingerprint !== undefined &&
    (typeof replaceFingerprint !== 'string' || !FINGERPRINT.test(replaceFingerprint))
  ) {
    return invalid(c, 'replaceFingerprint is invalid');
  }
  const bytes = encoding === 'utf8' ? new TextEncoder().encode(value) : decodeBase64(value);
  if (!bytes) return invalid(c, 'value is not base64');
  if (bytes.length < MIN_SALT_BYTES || bytes.length > MAX_SALT_BYTES) {
    return invalid(c, `value must be ${MIN_SALT_BYTES} to ${MAX_SALT_BYTES} bytes`);
  }

  const stub = keyManager(c.env, tenantId);
  if (!stub) {
    return c.json({ error: 'unavailable', error_description: 'Key manager unavailable' }, 503);
  }
  let result: Awaited<ReturnType<KeyManagerSaltStub['importSecretRpc']>>;
  try {
    result = await stub.importSecretRpc({
      secretRef: importedIdentifierSaltRef(name),
      value: encodeBase64(bytes),
      ...(typeof replaceFingerprint === 'string' ? { replaceFingerprint } : {}),
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'imported_secret_replace_mismatch') {
      return c.json(
        {
          error: 'conflict',
          error_description:
            'A different salt is kept under this name; send its fingerprint to replace it',
        },
        409
      );
    }
    if (error instanceof Error && error.message === 'imported_secret_limit') {
      return c.json(
        { error: 'conflict', error_description: 'No more salts can be imported for this tenant' },
        409
      );
    }
    // Never the error itself: it may carry what was sent.
    return c.json({ error: 'server_error', error_description: 'The salt was not saved' }, 500);
  }

  if (result.outcome !== 'unchanged') {
    const admin = (c as unknown as { get(key: string): unknown }).get(
      'adminAuth'
    ) as AdminAuthContext | null;
    await createAuditLog(c.env, {
      tenantId,
      userId: admin?.userId ?? 'unknown',
      action: `identifier_salt.${result.outcome}`,
      resource: 'identifier_salt',
      resourceId: name,
      severity: 'warning',
      ipAddress: c.req.header('CF-Connecting-IP') ?? 'unknown',
      userAgent: c.req.header('User-Agent') ?? 'unknown',
      metadata: JSON.stringify({ fingerprint: result.fingerprint, encoding }),
    });
  }
  return c.json({ name, fingerprint: result.fingerprint, outcome: result.outcome });
}

function decodeBase64(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value) || value.length % 4 !== 0) return null;
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
