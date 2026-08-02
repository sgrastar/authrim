import { createSign, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AuthrimConfig } from './config.js';
import { generateEs256KeyPair, type JWK } from './keys.js';
import {
  fetchWithTimeout,
  readResponseJsonWithLimit,
  readResponseTextWithLimit,
} from './http-limits.js';
import { getPortableSqlExpressions } from './sql-portability.js';

export const ADMIN_MACHINE_AUDIENCE = 'authrim:admin-api';
export const SETUP_MACHINE_CLIENT_ID = 'authrim-setup';
export const SETUP_MACHINE_PRINCIPAL_ID = 'amp_authrim_setup';
export const SETUP_MACHINE_PRIVATE_KEY_FILE = 'setup_machine_private.pem';
export const SETUP_MACHINE_PUBLIC_JWK_FILE = 'setup_machine_public.jwk.json';
export const ADMIN_UI_BFF_CLIENT_ID = 'authrim-admin-ui-bff';
export const ADMIN_UI_BFF_PRINCIPAL_ID = 'amp_authrim_admin_ui_bff';
export const ADMIN_UI_BFF_PRIVATE_KEY_FILE = 'admin_ui_bff_private.pem';
export const ADMIN_UI_BFF_PUBLIC_JWK_FILE = 'admin_ui_bff_public.jwk.json';
export const ADMIN_UI_BFF_SCOPES = ['admin-ui:proxy'] as const;

const ADMIN_MACHINE_TOKEN_MAX_ATTEMPTS = 4;

export const SETUP_MACHINE_DEFAULT_SCOPES = [
  'admin:clients:*',
  'admin:settings:*',
  'admin:scopes:*',
  'admin:roles:*',
  'admin:admin_roles:*',
  'admin:iat_tokens:*',
  'admin:runtime_profiles:*',
  'admin:jobs:*',
  'admin:storage_destinations:*',
  'admin:database_connections:*',
  'admin:external_providers:*',
  'admin:saml_providers:*',
  'admin:saml_attribute_presets:*',
  'admin:tenant_domains:*',
  'admin:control_plane:read',
  'admin:control_plane:rotate',
  'admin:control_plane:provision',
] as const;

export interface AdminMachineTokenRequest {
  apiBaseUrl: string;
  keysDir: string;
  tenantId?: string;
  clientId?: string;
  scopes?: readonly string[];
  timeoutMs?: number;
}

export interface AdminMachineTokenResponse {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  scope: string;
}

export interface AdminUiBffWorkerSecrets {
  ADMIN_UI_BFF_CLIENT_ID: string;
  ADMIN_UI_BFF_KEY_ID: string;
  ADMIN_UI_BFF_PRIVATE_KEY_PEM: string;
  ADMIN_UI_BFF_SCOPES: string;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function safeCredentialIdFromKid(kid: string): string {
  const suffix = kid.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 96);
  return `amk_authrim_setup_${suffix}`;
}

function safeAdminUiBffCredentialIdFromKid(kid: string): string {
  const suffix = kid.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 96);
  return `amk_authrim_admin_ui_bff_${suffix}`;
}

function base64UrlJson(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function parseRetryAfterSeconds(body: string): number | null {
  try {
    const parsed = JSON.parse(body) as { retry_after?: unknown };
    return typeof parsed.retry_after === 'number' && parsed.retry_after > 0
      ? parsed.retry_after
      : null;
  } catch {
    return null;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function buildPermissionValuesSql(principalId: string, permissions: readonly string[]): string {
  const sqlExpr = getPortableSqlExpressions('sqlite');
  return permissions
    .map(
      (permission) =>
        `(${sqlString(principalId)}, ${sqlString(permission)}, ${sqlExpr.nowEpochMilliseconds}, 'bootstrap', 'setup')`
    )
    .join(',\n');
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function derToJose(signature: Buffer): Buffer {
  let offset = 0;
  if (signature[offset++] !== 0x30) {
    throw new Error('Invalid ECDSA signature DER sequence');
  }

  let sequenceLength = signature[offset++];
  if (sequenceLength === 0x81) {
    sequenceLength = signature[offset++];
  } else if (sequenceLength === 0x82) {
    sequenceLength = (signature[offset++] << 8) | signature[offset++];
  }

  if (sequenceLength <= 0 || offset + sequenceLength > signature.length) {
    throw new Error('Invalid ECDSA signature DER length');
  }

  const readInteger = (): Buffer => {
    if (signature[offset++] !== 0x02) {
      throw new Error('Invalid ECDSA signature integer');
    }
    const length = signature[offset++];
    const value = signature.subarray(offset, offset + length);
    offset += length;
    return value[0] === 0 ? value.subarray(1) : value;
  };

  const r = readInteger();
  const s = readInteger();
  if (r.length > 32 || s.length > 32) {
    throw new Error('Invalid ES256 signature component length');
  }

  return Buffer.concat([
    Buffer.concat([Buffer.alloc(32 - r.length), r]),
    Buffer.concat([Buffer.alloc(32 - s.length), s]),
  ]);
}

export function getSetupMachinePrivateKeyPath(keysDir: string): string {
  return join(keysDir, SETUP_MACHINE_PRIVATE_KEY_FILE);
}

export function getSetupMachinePublicJwkPath(keysDir: string): string {
  return join(keysDir, SETUP_MACHINE_PUBLIC_JWK_FILE);
}

export function getAdminUiBffPrivateKeyPath(keysDir: string): string {
  return join(keysDir, ADMIN_UI_BFF_PRIVATE_KEY_FILE);
}

export function getAdminUiBffPublicJwkPath(keysDir: string): string {
  return join(keysDir, ADMIN_UI_BFF_PUBLIC_JWK_FILE);
}

export async function loadSetupMachinePublicJwk(keysDir: string): Promise<JWK> {
  const path = getSetupMachinePublicJwkPath(keysDir);
  const content = await readFile(path, 'utf-8');
  return JSON.parse(content) as JWK;
}

async function writeSensitiveFile(path: string, content: string): Promise<void> {
  await writeFile(path, content, 'utf-8');
  await chmod(path, 0o600);
}

async function unlinkIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
}

export async function ensureSetupMachineKeyFiles(
  keysDir: string,
  keyId = 'authrim-setup-ephemeral'
): Promise<{
  created: boolean;
}> {
  const privateKeyPath = getSetupMachinePrivateKeyPath(keysDir);
  const publicJwkPath = getSetupMachinePublicJwkPath(keysDir);
  const hasPrivateKey = existsSync(privateKeyPath);
  const hasPublicJwk = existsSync(publicJwkPath);

  if (hasPrivateKey && hasPublicJwk) {
    return { created: false };
  }

  if (hasPrivateKey !== hasPublicJwk) {
    throw new Error('setup_machine_key_pair_incomplete');
  }

  await mkdir(keysDir, { recursive: true, mode: 0o700 });
  await chmod(keysDir, 0o700);
  const keyPair = generateEs256KeyPair(keyId);
  await writeSensitiveFile(privateKeyPath, keyPair.privateKeyPem);
  await writeSensitiveFile(publicJwkPath, JSON.stringify(keyPair.publicKeyJwk, null, 2));
  return { created: true };
}

export async function deleteSetupMachineKeyFiles(keysDir: string): Promise<void> {
  await unlinkIfExists(getSetupMachinePrivateKeyPath(keysDir));
  await unlinkIfExists(getSetupMachinePublicJwkPath(keysDir));
}

export async function loadAdminUiBffPublicJwk(keysDir: string): Promise<JWK> {
  const path = getAdminUiBffPublicJwkPath(keysDir);
  const content = await readFile(path, 'utf-8');
  return JSON.parse(content) as JWK;
}

export async function loadAdminUiBffWorkerSecrets(
  keysDir: string
): Promise<AdminUiBffWorkerSecrets> {
  const publicJwk = await loadAdminUiBffPublicJwk(keysDir);
  const privateKeyPem = await readFile(getAdminUiBffPrivateKeyPath(keysDir), 'utf-8');
  if (publicJwk.alg !== 'ES256' || typeof publicJwk.kid !== 'string' || !publicJwk.kid) {
    throw new Error('admin_ui_bff_public_jwk_invalid');
  }

  return {
    ADMIN_UI_BFF_CLIENT_ID: ADMIN_UI_BFF_CLIENT_ID,
    ADMIN_UI_BFF_KEY_ID: publicJwk.kid,
    ADMIN_UI_BFF_PRIVATE_KEY_PEM: privateKeyPem,
    ADMIN_UI_BFF_SCOPES: ADMIN_UI_BFF_SCOPES.join(' '),
  };
}

export async function createSetupMachineClientAssertion(options: {
  tokenEndpoint: string;
  keysDir: string;
  clientId?: string;
  nowEpoch?: number;
}): Promise<string> {
  const clientId = options.clientId ?? SETUP_MACHINE_CLIENT_ID;
  const publicJwk = await loadSetupMachinePublicJwk(options.keysDir);
  const privateKeyPath = getSetupMachinePrivateKeyPath(options.keysDir);
  const privateKeyPem = await readFile(privateKeyPath, 'utf-8');
  const now = options.nowEpoch ?? Math.floor(Date.now() / 1000);

  if (publicJwk.alg !== 'ES256' || typeof publicJwk.kid !== 'string') {
    throw new Error('setup_machine_public_jwk_invalid');
  }

  const header = base64UrlJson({
    alg: 'ES256',
    typ: 'JWT',
    kid: publicJwk.kid,
  });
  const payload = base64UrlJson({
    iss: clientId,
    sub: clientId,
    aud: options.tokenEndpoint,
    iat: now,
    exp: now + 300,
    jti: randomBytes(24).toString('base64url'),
  });
  const signingInput = `${header}.${payload}`;
  const signer = createSign('sha256');
  signer.update(signingInput);
  signer.end();
  const derSignature = signer.sign(privateKeyPem);
  return `${signingInput}.${derToJose(derSignature).toString('base64url')}`;
}

export async function requestAdminMachineAccessToken(
  options: AdminMachineTokenRequest
): Promise<AdminMachineTokenResponse> {
  const baseUrl = normalizeBaseUrl(options.apiBaseUrl);
  const tokenEndpoint = `${baseUrl}/token`;
  const clientId = options.clientId ?? SETUP_MACHINE_CLIENT_ID;
  const scopes = options.scopes ?? SETUP_MACHINE_DEFAULT_SCOPES;
  for (let attempt = 1; attempt <= ADMIN_MACHINE_TOKEN_MAX_ATTEMPTS; attempt += 1) {
    const assertion = await createSetupMachineClientAssertion({
      tokenEndpoint,
      keysDir: options.keysDir,
      clientId,
    });

    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: assertion,
      audience: ADMIN_MACHINE_AUDIENCE,
      scope: scopes.join(' '),
    });

    const response = await fetchWithTimeout(
      tokenEndpoint,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          ...(options.tenantId ? { 'X-Tenant-Id': options.tenantId } : {}),
        },
        body: form.toString(),
      },
      options.timeoutMs
    );

    if (!response.ok) {
      const body = await readResponseTextWithLimit(response).catch(() => 'Unknown error');
      const retryAfterSeconds = parseRetryAfterSeconds(body);
      if (
        response.status === 429 &&
        retryAfterSeconds &&
        attempt < ADMIN_MACHINE_TOKEN_MAX_ATTEMPTS
      ) {
        await sleep(retryAfterSeconds * 1000 + 1000);
        continue;
      }
      throw new Error(`admin_machine_token_failed:${response.status}:${body}`);
    }

    const data = await readResponseJsonWithLimit<{
      access_token?: string;
      token_type?: string;
      expires_in?: number;
      scope?: string;
    }>(response);

    if (!data.access_token || data.token_type !== 'Bearer') {
      throw new Error('admin_machine_token_response_invalid');
    }

    return {
      accessToken: data.access_token,
      tokenType: 'Bearer',
      expiresIn: typeof data.expires_in === 'number' ? data.expires_in : 0,
      scope: typeof data.scope === 'string' ? data.scope : '',
    };
  }

  throw new Error('admin_machine_token_retry_exhausted');
}

export async function buildAdminMachineHeaders(
  options: AdminMachineTokenRequest
): Promise<Record<string, string>> {
  const token = await requestAdminMachineAccessToken(options);
  return {
    Authorization: `Bearer ${token.accessToken}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...(options.tenantId ? { 'X-Tenant-Id': options.tenantId } : {}),
  };
}

export function buildSetupMachineAccessBootstrapSql(
  config: AuthrimConfig,
  publicJwk: JWK,
  options: {
    clientId?: string;
    principalId?: string;
    permissions?: readonly string[];
    displayName?: string;
    description?: string;
    principalType?: string;
    tokenTtlSeconds?: number;
    createdByActorId?: string;
  } = {}
): string {
  const sqlExpr = getPortableSqlExpressions('sqlite');
  const clientId = options.clientId ?? SETUP_MACHINE_CLIENT_ID;
  const principalId = options.principalId ?? SETUP_MACHINE_PRINCIPAL_ID;
  const tenantId = config.tenant?.name?.trim() || 'default';
  const permissions = options.permissions ?? SETUP_MACHINE_DEFAULT_SCOPES;
  const displayName = options.displayName ?? 'Authrim Setup Tool';
  const description =
    options.description ??
    'System-managed setup tool machine principal for bootstrap and deployment automation.';
  const principalType = options.principalType ?? 'setup_tool';
  const tokenTtlSeconds = options.tokenTtlSeconds ?? 600;
  const createdByActorId = options.createdByActorId ?? 'setup';

  if (publicJwk.alg !== 'ES256' || typeof publicJwk.kid !== 'string' || !publicJwk.kid) {
    throw new Error('setup_machine_public_jwk_invalid');
  }

  const credentialId = safeCredentialIdFromKid(publicJwk.kid);
  const publicJwkJson = JSON.stringify(publicJwk);
  const permissionValuesSql = buildPermissionValuesSql(principalId, permissions);

  return `
INSERT INTO admin_machine_principals (
  id, client_id, display_name, description, principal_type, status,
  default_audience, token_ttl_seconds, created_by_actor_type, created_by_actor_id,
  created_at, updated_at
)
SELECT
  ${sqlString(principalId)},
  ${sqlString(clientId)},
  ${sqlString(displayName)},
  ${sqlString(description)},
  ${sqlString(principalType)},
  'active',
  ${sqlString(ADMIN_MACHINE_AUDIENCE)},
  ${tokenTtlSeconds},
  'bootstrap',
  ${sqlString(createdByActorId)},
  ${sqlExpr.nowEpochMilliseconds},
  ${sqlExpr.nowEpochMilliseconds}
WHERE NOT EXISTS (
  SELECT 1 FROM admin_machine_principals WHERE id = ${sqlString(principalId)}
);

UPDATE admin_machine_principals
SET client_id = ${sqlString(clientId)},
    display_name = ${sqlString(displayName)},
    description = ${sqlString(description)},
    principal_type = ${sqlString(principalType)},
    status = 'active',
    default_audience = ${sqlString(ADMIN_MACHINE_AUDIENCE)},
    token_ttl_seconds = ${tokenTtlSeconds},
    updated_at = ${sqlExpr.nowEpochMilliseconds},
    disabled_at = NULL,
    disabled_by_actor_type = NULL,
    disabled_by_actor_id = NULL
WHERE id = ${sqlString(principalId)};

INSERT INTO admin_machine_credentials (
  id, principal_id, kid, public_jwk_json, alg, display_name, description, status,
  not_before, expires_at, created_by_actor_type, created_by_actor_id, created_at, updated_at
)
SELECT
  ${sqlString(credentialId)},
  ${sqlString(principalId)},
  ${sqlString(publicJwk.kid)},
  ${sqlString(publicJwkJson)},
  'ES256',
  'Setup tool ES256 key',
  'System-managed setup tool public JWK.',
  'active',
  NULL,
  NULL,
  'bootstrap',
  'setup',
  ${sqlExpr.nowEpochMilliseconds},
  ${sqlExpr.nowEpochMilliseconds}
WHERE NOT EXISTS (
  SELECT 1
  FROM admin_machine_credentials
  WHERE principal_id = ${sqlString(principalId)}
    AND kid = ${sqlString(publicJwk.kid)}
);

UPDATE admin_machine_credentials
SET public_jwk_json = ${sqlString(publicJwkJson)},
    alg = 'ES256',
    display_name = 'Setup tool ES256 key',
    description = 'System-managed setup tool public JWK.',
    status = 'active',
    updated_at = ${sqlExpr.nowEpochMilliseconds},
    revoked_at = NULL,
    revoked_by_actor_type = NULL,
    revoked_by_actor_id = NULL,
    revoke_reason = NULL
WHERE principal_id = ${sqlString(principalId)}
  AND kid = ${sqlString(publicJwk.kid)};

DELETE FROM admin_machine_principal_permissions
WHERE principal_id = ${sqlString(principalId)};

INSERT INTO admin_machine_principal_permissions (
  principal_id, permission, created_at, created_by_actor_type, created_by_actor_id
)
VALUES
${permissionValuesSql};

DELETE FROM admin_machine_principal_tenant_scopes
WHERE principal_id = ${sqlString(principalId)};

INSERT INTO admin_machine_principal_tenant_scopes (
  principal_id, scope_mode, tenant_id, created_at, created_by_actor_type, created_by_actor_id
)
VALUES (
  ${sqlString(principalId)},
  'allow',
  ${sqlString(tenantId)},
  ${sqlExpr.nowEpochMilliseconds},
  'bootstrap',
  'setup'
);
`.trim();
}

export function buildSetupMachineAccessCleanupSql(
  options: {
    clientId?: string;
    principalId?: string;
    principalType?: string;
  } = {}
): string {
  const clientId = options.clientId ?? SETUP_MACHINE_CLIENT_ID;
  const principalId = options.principalId ?? SETUP_MACHINE_PRINCIPAL_ID;
  const principalType = options.principalType ?? 'setup_tool';

  return `
DELETE FROM admin_machine_assertion_jti
WHERE client_id = ${sqlString(clientId)}
   OR credential_id IN (
     SELECT id FROM admin_machine_credentials WHERE principal_id = ${sqlString(principalId)}
   );

DELETE FROM admin_machine_resource_scopes
WHERE principal_id = ${sqlString(principalId)}
   OR credential_id IN (
     SELECT id FROM admin_machine_credentials WHERE principal_id = ${sqlString(principalId)}
   );

DELETE FROM admin_machine_credential_tenant_scopes
WHERE credential_id IN (
  SELECT id FROM admin_machine_credentials WHERE principal_id = ${sqlString(principalId)}
);

DELETE FROM admin_machine_credential_permissions
WHERE credential_id IN (
  SELECT id FROM admin_machine_credentials WHERE principal_id = ${sqlString(principalId)}
);

DELETE FROM admin_machine_principal_tenant_scopes
WHERE principal_id = ${sqlString(principalId)};

DELETE FROM admin_machine_principal_permissions
WHERE principal_id = ${sqlString(principalId)};

DELETE FROM admin_machine_credentials
WHERE principal_id = ${sqlString(principalId)};

DELETE FROM admin_machine_principals
WHERE id = ${sqlString(principalId)}
  AND client_id = ${sqlString(clientId)}
  AND principal_type = ${sqlString(principalType)};
`.trim();
}

export function buildAdminUiBffMachineAccessBootstrapSql(
  config: AuthrimConfig,
  publicJwk: JWK,
  options: {
    clientId?: string;
    principalId?: string;
    permissions?: readonly string[];
  } = {}
): string {
  const sqlExpr = getPortableSqlExpressions('sqlite');
  const clientId = options.clientId ?? ADMIN_UI_BFF_CLIENT_ID;
  const principalId = options.principalId ?? ADMIN_UI_BFF_PRINCIPAL_ID;
  const tenantId = config.tenant?.name?.trim() || 'default';
  const permissions = options.permissions ?? ADMIN_UI_BFF_SCOPES;

  if (publicJwk.alg !== 'ES256' || typeof publicJwk.kid !== 'string' || !publicJwk.kid) {
    throw new Error('admin_ui_bff_public_jwk_invalid');
  }

  const credentialId = safeAdminUiBffCredentialIdFromKid(publicJwk.kid);
  const publicJwkJson = JSON.stringify(publicJwk);
  const permissionValuesSql = buildPermissionValuesSql(principalId, permissions);

  return `
INSERT INTO admin_machine_principals (
  id, client_id, display_name, description, principal_type, status,
  default_audience, token_ttl_seconds, created_by_actor_type, created_by_actor_id,
  created_at, updated_at
)
SELECT
  ${sqlString(principalId)},
  ${sqlString(clientId)},
  'Authrim Admin UI BFF',
  'System-managed Admin UI BFF machine principal for fixed HTTPS upstream transport authentication.',
  'admin_ui_bff',
  'active',
  ${sqlString(ADMIN_MACHINE_AUDIENCE)},
  600,
  'bootstrap',
  'setup',
  ${sqlExpr.nowEpochMilliseconds},
  ${sqlExpr.nowEpochMilliseconds}
WHERE NOT EXISTS (
  SELECT 1 FROM admin_machine_principals WHERE id = ${sqlString(principalId)}
);

UPDATE admin_machine_principals
SET client_id = ${sqlString(clientId)},
    display_name = 'Authrim Admin UI BFF',
    description = 'System-managed Admin UI BFF machine principal for fixed HTTPS upstream transport authentication.',
    principal_type = 'admin_ui_bff',
    status = 'active',
    default_audience = ${sqlString(ADMIN_MACHINE_AUDIENCE)},
    token_ttl_seconds = 600,
    updated_at = ${sqlExpr.nowEpochMilliseconds},
    disabled_at = NULL,
    disabled_by_actor_type = NULL,
    disabled_by_actor_id = NULL
WHERE id = ${sqlString(principalId)};

INSERT INTO admin_machine_credentials (
  id, principal_id, kid, public_jwk_json, alg, display_name, description, status,
  not_before, expires_at, created_by_actor_type, created_by_actor_id, created_at, updated_at
)
SELECT
  ${sqlString(credentialId)},
  ${sqlString(principalId)},
  ${sqlString(publicJwk.kid)},
  ${sqlString(publicJwkJson)},
  'ES256',
  'Admin UI BFF ES256 key',
  'System-managed Admin UI BFF public JWK.',
  'active',
  NULL,
  NULL,
  'bootstrap',
  'setup',
  ${sqlExpr.nowEpochMilliseconds},
  ${sqlExpr.nowEpochMilliseconds}
WHERE NOT EXISTS (
  SELECT 1
  FROM admin_machine_credentials
  WHERE principal_id = ${sqlString(principalId)}
    AND kid = ${sqlString(publicJwk.kid)}
);

UPDATE admin_machine_credentials
SET public_jwk_json = ${sqlString(publicJwkJson)},
    alg = 'ES256',
    display_name = 'Admin UI BFF ES256 key',
    description = 'System-managed Admin UI BFF public JWK.',
    status = 'active',
    updated_at = ${sqlExpr.nowEpochMilliseconds},
    revoked_at = NULL,
    revoked_by_actor_type = NULL,
    revoked_by_actor_id = NULL,
    revoke_reason = NULL
WHERE principal_id = ${sqlString(principalId)}
  AND kid = ${sqlString(publicJwk.kid)};

DELETE FROM admin_machine_principal_permissions
WHERE principal_id = ${sqlString(principalId)};

INSERT INTO admin_machine_principal_permissions (
  principal_id, permission, created_at, created_by_actor_type, created_by_actor_id
)
VALUES
${permissionValuesSql};

DELETE FROM admin_machine_principal_tenant_scopes
WHERE principal_id = ${sqlString(principalId)};

INSERT INTO admin_machine_principal_tenant_scopes (
  principal_id, scope_mode, tenant_id, created_at, created_by_actor_type, created_by_actor_id
)
VALUES (
  ${sqlString(principalId)},
  'allow',
  ${sqlString(tenantId)},
  ${sqlExpr.nowEpochMilliseconds},
  'bootstrap',
  'setup'
);
`.trim();
}

export function setupMachineKeyFilesExist(keysDir: string): boolean {
  return (
    existsSync(getSetupMachinePrivateKeyPath(keysDir)) &&
    existsSync(getSetupMachinePublicJwkPath(keysDir))
  );
}

export function adminUiBffKeyFilesExist(keysDir: string): boolean {
  return (
    existsSync(getAdminUiBffPrivateKeyPath(keysDir)) &&
    existsSync(getAdminUiBffPublicJwkPath(keysDir))
  );
}
