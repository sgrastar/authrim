import type { SecurityMatrixEnvKit } from '../fixtures/env';
import { TEST_ACCOUNT, TEST_TENANT, TEST_USER } from '../fixtures/env';
import { buildRegionInstanceName } from '../../../packages/ar-lib-core/src/utils/region-sharding';
import {
  generatePARRequestUri,
  getPARRequestStoreForNewRequest,
} from '../../../packages/ar-lib-core/src/utils/par-sharding';
import type { PARRequestData } from '../../../packages/ar-lib-core/src/durable-objects/PARRequestStore';
import type {
  SessionData,
  Session,
} from '../../../packages/ar-lib-core/src/durable-objects/SessionStore';
import type { AccountAuthenticationLifecycle } from '../../../packages/ar-lib-core/src/durable-objects/SessionRevocationStore';
import { SESSION_CLIENT_NAMESPACE_VERSION } from '../../../packages/ar-lib-core/src/durable-objects/SessionStore';
import { SESSION_REVOCATION_AUTHORITY } from '../../../packages/ar-lib-core/src/services/session-revocation-store';
import { importPKCS8, SignJWT } from 'jose';

export const CLIENT_A = 'matrix-client-a';
export const CLIENT_PUBLIC = 'matrix-client-public';
export const CLIENT_REQUIRES_PKCE = 'matrix-client-pkce';
export const CLIENT_FOREIGN = 'matrix-client-foreign';
export const CLIENT_JAR = 'matrix-client-jar';
export const REDIRECT = 'https://client.example/callback';
export const ATTACKER_REDIRECT = 'https://attacker.example/callback';
export const MALFORMED_REDIRECT = 'not-a-url';
export const TEST_STATE = 'st_matrix_0001';
export const TEST_NONCE = 'n_matrix_0001';
export const TEST_SCOPE = 'openid';
export const TEST_SCOPE_WIDE = 'openid profile';
export const AUTH_TIME_EPOCH_SECONDS = 1699940; // 60s before the frozen epoch 1700000000
export const REQUEST_TENANT = 'default';
export const FOREIGN_TENANT = 'tenant-other';

export const VALID_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
/**
 * Valid S256 challenge for the authorization endpoint. The authorization endpoint only
 * validates challenge format (base64url, 43-128 characters); verifier matching belongs
 * to the token suite, so a fixed deterministic challenge string is sufficient.
 */
export const VALID_CHALLENGE = 'B0A90cF2v3xYz9qWmN8kLr7tS5uVjP1hE4oG6bD2aIeRXy';
/** Well-formed base64url of valid length that is rejected only for using 'plain'. */
export const PLAIN_CHALLENGE = 'B0A90cF2v3xYz9qWmN8kLr7tS5uVjP1hE4oG6bD2aIeRZz';
/** Too short to pass the base64url length check. */
export const MALFORMED_CHALLENGE = 'short';

export const SESSION_ACTIVE = 'g1:enam:0:session_matrix_active';
export const SESSION_EXPIRED = 'g1:enam:0:session_matrix_expired';
export const SESSION_REVOKED = 'g1:enam:0:session_matrix_revoked';
export const SESSION_LEGACY = 'g1:enam:0:session_matrix_legacy';
export const SESSION_WRONG_TENANT = 'g1:enam:0:session_matrix_wrong_tenant';
export const SESSION_STORE_FAILURE = 'g1:enam:0:session_matrix_store_failure';
export const SESSION_LEGACY_PLAIN = 'legacy-plain-session-id';

export interface SeedClientOptions {
  clientId: string;
  tenantId?: string;
  publicClient?: boolean;
  requirePkce?: boolean;
  scope?: string;
  responseTypes?: string;
  jwks?: string;
}

export function seedClient(kit: SecurityMatrixEnvKit, options: SeedClientOptions): void {
  const {
    clientId,
    tenantId = REQUEST_TENANT,
    publicClient = false,
    requirePkce = true,
    scope = TEST_SCOPE,
    responseTypes = 'code',
    jwks,
  } = options;
  const row: Record<string, unknown> = {
    client_id: clientId,
    client_name: `Matrix ${clientId}`,
    redirect_uris: REDIRECT,
    grant_types: 'authorization_code',
    response_types: responseTypes,
    scope,
    token_endpoint_auth_method: publicClient ? 'none' : 'client_secret_basic',
    client_secret_hash: publicClient
      ? undefined
      : 'aa6b73af0f9d3bd6a7ec2f8c9f6b4e3d2a1c0b9e8f7d6c5b4a3f2e1d0c9b8a7',
    default_resource: 'svc://matrix-api',
    require_pkce: requirePkce ? 1 : 0,
    tenant_id: tenantId,
    created_at: 1700000000,
    updated_at: 1700000000,
  };
  if (jwks) {
    row.jwks = jwks;
  }
  kit.coreAdapter.addBehavior({
    match: (sql, params) =>
      sql.includes('FROM oauth_clients') &&
      sql.includes('client_id') &&
      params[params.length - 1] === clientId,
    result: () => [row],
  });
}

/** Seed the standard client set used by the protocol matrix. */
export function seedProtocolClients(kit: SecurityMatrixEnvKit, jwksJson: string): void {
  // Confidential client without a PKCE requirement (used for plain/missing challenge rows).
  seedClient(kit, { clientId: CLIENT_A, requirePkce: false });
  // Public client: always requires a valid S256 challenge.
  seedClient(kit, { clientId: CLIENT_PUBLIC, publicClient: true, requirePkce: false });
  // Confidential client with require_pkce: valid S256 challenge always required.
  seedClient(kit, { clientId: CLIENT_REQUIRES_PKCE, requirePkce: true });
  // Client with a registered JWKS for signed request-object (JAR) verification.
  seedClient(kit, { clientId: CLIENT_JAR, requirePkce: false, jwks: jwksJson });
}

/**
 * Seed client and tenant SSO settings through the Settings Manager KV format.
 * `clientSso`/`tenantSso`: 'true' | 'false' set explicit KV values; 'default' leaves
 * the KV entry absent; 'failure' makes the settings KV read throw (the Settings
 * Manager then behaves exactly like the next level of the override chain, which the
 * settings-KV ledger makes observable).
 *
 * The Settings Manager resolves `values[key]` against the KV object using the full
 * dotted setting key (`client.sso_enabled` / `oauth.sso_enabled`, settings-manager.ts
 * `resolveValue`), so the seeded JSON must use dotted keys. A source of `default` is
 * not an explicit override, so the tenant setting is inherited for client defaults.
 */
export function seedSsoSettings(
  kit: SecurityMatrixEnvKit,
  clientId: string,
  clientSso: string,
  tenantSso: string,
  tenantId = REQUEST_TENANT
): void {
  if (clientSso === 'true' || clientSso === 'false') {
    kit.settings.seed(
      `settings:client:${tenantId}:${clientId}:client`,
      JSON.stringify({ 'client.sso_enabled': clientSso === 'true' })
    );
  }
  if (clientSso === 'failure') {
    kit.settings.setGetFailure(`settings:client:${tenantId}:${clientId}:client`);
  }
  if (tenantSso === 'true' || tenantSso === 'false') {
    kit.settings.seed(
      `settings:tenant:${tenantId}:oauth`,
      JSON.stringify({ 'oauth.sso_enabled': tenantSso === 'true' })
    );
  }
  if (tenantSso === 'failure') {
    kit.settings.setGetFailure(`settings:tenant:${tenantId}:oauth`);
  }
}

export function sessionStoreInstanceName(tenantId: string, sessionId: string): string {
  const parsed = parseSessionId(sessionId);
  return buildRegionInstanceName(tenantId, parsed.regionKey, 'session', parsed.shardIndex);
}

export function parseSessionId(sessionId: string): {
  generation: number;
  regionKey: string;
  shardIndex: number;
  randomPart: string;
} {
  const match = /^g(\d+):([a-z0-9]+):(\d+):(.+)$/u.exec(sessionId);
  if (!match) {
    throw new Error(`Invalid sharded session id: ${sessionId}`);
  }
  return {
    generation: Number(match[1]),
    regionKey: match[2],
    shardIndex: Number(match[3]),
    randomPart: match[4],
  };
}

function buildSessionRecord(
  sessionId: string,
  tenantId: string,
  data: SessionData | undefined,
  overrides: Partial<Session> = {}
): Session {
  return {
    id: sessionId,
    tenantId,
    userId: TEST_USER,
    accountId: TEST_ACCOUNT,
    expiresAt: 1700000000 + 3600 * 1000,
    createdAt: 1700000000,
    revocationAuthority: SESSION_REVOCATION_AUTHORITY,
    revocationBoundAtMs: 1700000000,
    sessionClientNamespaceVersion: SESSION_CLIENT_NAMESPACE_VERSION,
    data,
    ...overrides,
  };
}

export interface SeedSessionOptions {
  sessionId: string;
  tenantId?: string;
  requestTenantId?: string;
  userId?: string;
  ttlSeconds?: number;
  data?: SessionData;
  failRead?: boolean;
}

export type SeedSessionResult = { sessionId: string };

export async function seedSession(
  kit: SecurityMatrixEnvKit,
  options: SeedSessionOptions
): Promise<SeedSessionResult> {
  const {
    sessionId,
    tenantId = REQUEST_TENANT,
    requestTenantId = REQUEST_TENANT,
    userId = TEST_USER,
    ttlSeconds = 3600,
    data = { authTime: AUTH_TIME_EPOCH_SECONDS },
  } = options;
  const instanceName = sessionStoreInstanceName(requestTenantId, sessionId);
  if (options.failRead) {
    kit.sessionStoreNamespace.getStorage(instanceName).setGetFailure(`session:${sessionId}`);
    return { sessionId };
  }
  const stub = kit.sessionStoreNamespace.get(
    kit.sessionStoreNamespace.idFromName(instanceName)
  ) as unknown as {
    createSessionRpc(
      sessionId: string,
      userId: string,
      ttl: number,
      data: SessionData | undefined,
      tenantId: string
    ): Promise<unknown>;
  };
  await stub.createSessionRpc(sessionId, userId, ttlSeconds, data, tenantId);
  return { sessionId };
}

/** Seed a session that already expired before the frozen epoch. */
export async function seedExpiredSession(
  kit: SecurityMatrixEnvKit,
  sessionId: string
): Promise<void> {
  const instanceName = sessionStoreInstanceName(REQUEST_TENANT, sessionId);
  const storage = kit.sessionStoreNamespace.getStorage(instanceName);
  await storage.put('meta:tenant-context', REQUEST_TENANT);
  await storage.put(
    `session:${sessionId}`,
    buildSessionRecord(
      sessionId,
      REQUEST_TENANT,
      { authTime: AUTH_TIME_EPOCH_SECONDS },
      {
        expiresAt: 1699000000,
      }
    )
  );
}

/** Seed a session record with the legacy client namespace version (dropped as unusable). */
export async function seedLegacySession(
  kit: SecurityMatrixEnvKit,
  sessionId: string
): Promise<void> {
  const instanceName = sessionStoreInstanceName(REQUEST_TENANT, sessionId);
  const storage = kit.sessionStoreNamespace.getStorage(instanceName);
  await storage.put('meta:tenant-context', REQUEST_TENANT);
  await storage.put(
    `session:${sessionId}`,
    buildSessionRecord(
      sessionId,
      REQUEST_TENANT,
      { authTime: AUTH_TIME_EPOCH_SECONDS },
      {
        sessionClientNamespaceVersion: 1,
      }
    )
  );
}

/**
 * Seed a session record directly into a request-tenant session instance whose tenant
 * binding conflicts with the request tenant (wrong-tenant / foreign-tenant dimension).
 * `requestTenantId` selects the instance the request cookie routes to.
 */
export async function seedForeignTenantSession(
  kit: SecurityMatrixEnvKit,
  sessionId: string,
  tenantId: string,
  requestTenantId: string = REQUEST_TENANT
): Promise<void> {
  const instanceName = sessionStoreInstanceName(requestTenantId, sessionId);
  const storage = kit.sessionStoreNamespace.getStorage(instanceName);
  await storage.put('meta:tenant-context', requestTenantId);
  await storage.put(
    `session:${sessionId}`,
    buildSessionRecord(
      sessionId,
      requestTenantId,
      { authTime: AUTH_TIME_EPOCH_SECONDS },
      {
        tenantId,
      }
    )
  );
}

/** Revoke all sessions of the matrix-test user in the given tenant (revoked-as-missing state). */
export async function revokeMatrixUserSessions(
  kit: SecurityMatrixEnvKit,
  tenantId = REQUEST_TENANT
): Promise<void> {
  const stub = kit.sessionRevocationNamespace.get(
    kit.sessionRevocationNamespace.idFromName(`tenant:${tenantId}:user-session:${TEST_USER}`)
  ) as unknown as {
    revokeAllRpc(
      tenantId: string,
      userId: string,
      accountId: string,
      revokedAfterMs: number
    ): Promise<number>;
  };
  await stub.revokeAllRpc(tenantId, TEST_USER, TEST_ACCOUNT, 1700000000);
}

/** Initialize a non-default request tenant's account state for the matrix-test user. */
export async function seedAccountStateForTenant(
  kit: SecurityMatrixEnvKit,
  tenantId: string,
  lifecycle: AccountAuthenticationLifecycle = 'active'
): Promise<void> {
  const stub = kit.sessionRevocationNamespace.get(
    kit.sessionRevocationNamespace.idFromName(`tenant:${tenantId}:user-session:${TEST_USER}`)
  ) as unknown as {
    initializeAccountStateRpc(
      tenantId: string,
      userId: string,
      accountId: string,
      lifecycle: AccountAuthenticationLifecycle,
      sourceVersionMs: number
    ): Promise<unknown>;
  };
  await stub.initializeAccountStateRpc(tenantId, TEST_USER, TEST_ACCOUNT, lifecycle, 1700000000);
}

/** Seed the given session dimension for the request tenant and return the cookie header. */
export async function seedSessionDimension(
  kit: SecurityMatrixEnvKit,
  session: string
): Promise<string | undefined> {
  switch (session) {
    case 'missing':
      return undefined;
    case 'active':
      await seedSession(kit, { sessionId: SESSION_ACTIVE });
      return SESSION_ACTIVE;
    case 'expired':
      await seedExpiredSession(kit, SESSION_EXPIRED);
      return SESSION_EXPIRED;
    case 'revoked':
      await seedSession(kit, { sessionId: SESSION_REVOKED });
      await revokeMatrixUserSessions(kit);
      return SESSION_REVOKED;
    case 'legacy':
      await seedLegacySession(kit, SESSION_LEGACY);
      return SESSION_LEGACY;
    case 'wrong-tenant':
      await seedForeignTenantSession(kit, SESSION_WRONG_TENANT, FOREIGN_TENANT);
      return SESSION_WRONG_TENANT;
    case 'store-failure':
      await seedSession(kit, { sessionId: SESSION_STORE_FAILURE, failRead: true });
      return SESSION_STORE_FAILURE;
    default:
      throw new Error(`Unknown session dimension: ${String(session)}`);
  }
}

export interface SeedConsentOptions {
  tenantId?: string;
  clientId: string;
  userId?: string;
  scope?: string;
  expiresAt?: number | null;
  failLookup?: boolean;
}

/**
 * Seed oauth_client_consents rows via D1 behaviors.
 * - null `expiresAt` = non-expiring (sufficient).
 * - past `expiresAt` = expired consent.
 * - `failLookup` makes the consent read throw (lookup-failure dimension).
 */
export function seedConsent(kit: SecurityMatrixEnvKit, options: SeedConsentOptions): void {
  const {
    tenantId = REQUEST_TENANT,
    clientId,
    userId = TEST_USER,
    scope = TEST_SCOPE,
    expiresAt = null,
    failLookup = false,
  } = options;
  kit.coreAdapter.addBehavior({
    match: (sql, params) =>
      sql.includes('FROM oauth_client_consents') &&
      sql.includes('client_id') &&
      params[params.length - 1] === clientId,
    result: () => {
      if (failLookup) {
        throw new Error('d1 consent lookup failure');
      }
      return [
        {
          scope,
          granted_at: 1699000000,
          expires_at: expiresAt,
        },
      ];
    },
  });
}

/** Seed the consent dimension for a client (sufficient record, trust policy, or nothing). */
export function seedConsentDimension(
  kit: SecurityMatrixEnvKit,
  clientId: string,
  consent: string,
  tenantId: string = REQUEST_TENANT
): void {
  switch (consent) {
    case 'sufficient':
      seedConsent(kit, { tenantId, clientId, scope: TEST_SCOPE_WIDE });
      break;
    case 'expired':
      seedConsent(kit, { tenantId, clientId, scope: TEST_SCOPE_WIDE, expiresAt: 1698000000 });
      break;
    case 'insufficient':
      seedConsent(kit, { tenantId, clientId, scope: TEST_SCOPE });
      break;
    case 'auto-grant':
      seedTrustedClient(kit, clientId);
      break;
    case 'lookup-failure':
      seedConsent(kit, { tenantId, clientId, failLookup: true });
      break;
    case 'missing':
      break;
    default:
      throw new Error(`Unknown consent dimension: ${consent}`);
  }
}

/** Trusted-client trust policy (consent auto-grant dimension). */
export function seedTrustedClient(kit: SecurityMatrixEnvKit, clientId: string): void {
  kit.coreAdapter.addBehavior({
    match: (sql) => sql.includes('FROM client_trust_policies'),
    result: () => [
      {
        target_type: 'oidc_client',
        target_id: clientId,
        first_party: 1,
        trusted: 1,
        skip_authorization_consent: 1,
      },
    ],
  });
}

/** JARM requirement policy via tenant system settings (SETTINGS KV). */
export function seedJarmRequirement(kit: SecurityMatrixEnvKit, required: boolean): void {
  if (!required) return;
  kit.settings.seed(
    'system_settings',
    JSON.stringify({
      fapi: {
        messageSigning: {
          enabled: true,
          requireJarm: true,
          defaultAuthorizationSigningAlgorithm: 'RS256',
        },
      },
    })
  );
}

export interface SeedParOptions {
  tenantId?: string;
  clientId: string;
  responseType: string;
  scope?: string;
  redirectUri?: string;
  state?: string;
  nonce?: string;
  codeChallenge?: string;
  codeChallengeMethod?: 'S256' | 'plain';
  responseMode?: string;
  consumed?: boolean;
  expired?: boolean;
}

export interface SeedParResult {
  requestUri: string;
  instanceName: string;
}

/**
 * Create a PAR request through the real PARRequestStore over memory durable storage.
 * `expired` stores the request with a TTL that expires before the request; `consumed`
 * pre-consume the request exactly like an earlier authenticated authorization.
 */
export async function seedPar(
  kit: SecurityMatrixEnvKit,
  options: SeedParOptions
): Promise<SeedParResult> {
  const {
    tenantId = REQUEST_TENANT,
    clientId,
    responseType,
    scope = TEST_SCOPE,
    redirectUri = REDIRECT,
    state = TEST_STATE,
    nonce = TEST_NONCE,
    codeChallenge = VALID_CHALLENGE,
    codeChallengeMethod,
    responseMode,
    consumed = false,
    expired = false,
  } = options;
  const uuid = `par_${clientId.replace(/[^a-z0-9]/giu, '')}_0000000000000000000000000000000000000000000000000000000000000000`;
  const { stub, requestUri, instanceName } = await getPARRequestStoreForNewRequest(
    kit.env,
    tenantId,
    clientId,
    uuid
  );
  const data: Record<string, unknown> = {
    tenant_id: tenantId,
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    state,
    nonce,
    response_type: responseType,
    ...(codeChallenge !== undefined
      ? { code_challenge: codeChallenge, code_challenge_method: codeChallengeMethod ?? 'S256' }
      : {}),
    ...(responseMode !== undefined ? { response_mode: responseMode } : {}),
  };
  const ttl = expired ? 0 : 600;
  await stub.storeRequestRpc({ requestUri, data, ttl });
  if (consumed) {
    await stub.consumeRequestRpc({
      requestUri,
      tenant_id: tenantId,
      client_id: clientId,
      expected_authorization_server: 'default',
    });
  }
  return { requestUri, instanceName };
}

/**
 * Seed a PAR record into the REQUEST tenant's PAR instance whose stored tenant binding
 * conflicts with the request tenant (par-tenant-mismatch dimension). The record is
 * written DIRECTLY to durable storage without instantiating the real PARRequestStore DO,
 * so the live instance that the request reads never holds an in-memory copy with the
 * overridden tenant. Its `tenant_id` then fails the production tenant-binding check.
 */
export async function seedParTenantMismatch(
  kit: SecurityMatrixEnvKit,
  options: SeedParOptions & { storedTenantId?: string }
): Promise<SeedParResult> {
  const {
    storedTenantId = FOREIGN_TENANT,
    tenantId = REQUEST_TENANT,
    clientId,
    responseType,
    scope = TEST_SCOPE,
    redirectUri = REDIRECT,
    state,
    nonce,
    codeChallenge,
    codeChallengeMethod,
    responseMode,
  } = options;
  const uuid = `par_${clientId.replace(/[^a-z0-9]/giu, '')}_0000000000000000000000000000000000000000000000000000000000000000`;
  const generated = await generatePARRequestUri(kit.env, tenantId, clientId, uuid);
  const requestUri = generated.requestUri;
  const instanceName = buildRegionInstanceName(
    tenantId,
    generated.regionKey,
    'par',
    generated.shardIndex
  );
  const now = 1700000000;
  const record: PARRequestData = {
    tenant_id: storedTenantId,
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    state,
    nonce,
    response_type: responseType,
    code_challenge: codeChallenge,
    code_challenge_method: codeChallengeMethod,
    response_mode: responseMode,
    authorization_server: 'default',
    createdAt: now,
    expiresAt: now + 600 * 1000,
    consumed: false,
  };
  const storage = kit.parNamespace.getStorage(instanceName);
  await storage.put('state', {
    requests: { [requestUri]: record },
    lastCleanup: now,
  });
  return { requestUri, instanceName };
}

/** Read the persisted PAR request state directly from the memory storage. */
export async function readParState(
  kit: SecurityMatrixEnvKit,
  instanceName: string,
  requestUri: string
): Promise<PARRequestData | null> {
  const storage = kit.parNamespace.getStorage(instanceName);
  const raw = await storage.get<{ requests: Record<string, PARRequestData> }>('state');
  return raw?.requests?.[requestUri] ?? null;
}

export interface JarClaims {
  iss: string;
  aud: string;
  client_id: string;
  response_type?: string;
  redirect_uri?: string;
  scope?: string;
  state?: string;
  nonce?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  response_mode?: string;
  [key: string]: unknown;
}

/**
 * Build a signed request object (RFC 9101 JAR) with the fixed fixed test signing key.
 * The production `verifyToken` contract requires `iss=client_id`, `aud=issuer`, and an
 * RS256 signature matching the client's registered JWKS.
 */
export async function buildSignedJar(
  privatePem: string,
  kid: string,
  claims: JarClaims
): Promise<string> {
  const privateKey = await importPKCS8(privatePem, 'RS256');
  const { iss, aud, ...rest } = claims;
  return new SignJWT({ iss, aud, ...rest })
    .setProtectedHeader({ alg: 'RS256', kid })
    .sign(privateKey);
}

/** Assert that a signed request object carries the claims the matrix-test intends. */
export function assertJarInputClaims(requestObject: string): void {
  const parts = requestObject.split('.');
  if (parts.length !== 3) {
    throw new Error('buildSignedJar: expected a compact JWS with three segments');
  }
  const payload = parts[1];
  const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const parsed = JSON.parse(atob(padded)) as Record<string, unknown>;
  if (typeof parsed.iss !== 'string' || typeof parsed.aud !== 'string') {
    throw new Error('buildSignedJar: iss and aud claims are required');
  }
}

export function sessionCookieHeader(sessionId: string | undefined): Record<string, string> {
  if (!sessionId) return {};
  return { Cookie: `authrim_session=${encodeURIComponent(sessionId)}` };
}

/** Expected auth-code shard instance name for the request tenant (frozen shard count 4). */
export function expectedAuthCodeInstanceName(tenantId: string, shardIndex: number): string {
  return `tenant:${tenantId}:auth-code:shard-${shardIndex}`;
}
