import type { Context } from 'hono';
import {
  AGENT_ACCESS_SETTING_KEYS,
  AdminAgentAccessRepository,
  evaluateAgentMcpFeatureFlag,
  isSelfServiceClientMetadataDocumentId,
  normalizeSelfServiceAgentAuthorizationDetails,
  parseAgentAccessSettings,
  type JsonObject,
} from '@authrim/ar-agent-access/core';
import type { AccessTokenClaims, ClientMetadata, Env } from '@authrim/ar-lib-core';
import {
  AdminMachineAccessRepository,
  authenticateConfidentialOAuthClient,
  buildDOInstanceName,
  createAccessToken,
  createAuthContextFromHono,
  createRefreshToken,
  createRefreshTokenFamily,
  generateSecureRandomString,
  getClientCached,
  getPublicKeyByKid,
  getRefreshTokenRotatorStubByJti,
  getTenantIdFromContext,
  hasAdminPermission,
  isTokenRevoked,
  parseTokenHeader,
  parseOAuthClientAuthenticationParams,
  validateRegisteredClientAuthenticationMethod,
  requireDedicatedAdminDatabaseAdapter,
  revokeToken,
  validateClientId,
  validateDPoPProof,
  verifyToken,
} from '@authrim/ar-lib-core';
import { importPKCS8, SignJWT } from 'jose';
import { getRequestIssuer } from './issuer';

const ADMIN_AGENT_CODE_PREFIX = 'aac_';
const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
const AGENT_DELEGATION_TOKEN_TYPE = 'urn:authrim:token-type:agent-delegation';

type AgentTokenEnv = Env & { ENABLE_AGENT_MCP?: string };
type LoadedAgentSettings = { enabled: boolean; maxTokenTtlSeconds: number };
type AgentTokenForm = Record<string, string>;

const PUBLIC_REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
const CONFIDENTIAL_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const PUBLIC_REFRESH_IDLE_SECONDS = 12 * 60 * 60;
const CONFIDENTIAL_REFRESH_IDLE_SECONDS = 24 * 60 * 60;

function selfServiceClientIsActive(client: ClientMetadata, now = Date.now()): boolean {
  return (
    client.agent_access_registration_mode === undefined ||
    (client.agent_access_expires_at !== undefined && client.agent_access_expires_at > now)
  );
}

async function touchSelfServiceClient(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  client: ClientMetadata
): Promise<void> {
  if (client.agent_access_registration_mode === undefined) return;
  const now = Date.now();
  try {
    await createAuthContextFromHono(c, tenantId).coreAdapter.execute(
      `UPDATE oauth_clients SET agent_access_last_used_at = ?, agent_access_expires_at = ?,
         updated_at = ? WHERE tenant_id = ? AND client_id = ?
         AND agent_access_registration_mode IS NOT NULL`,
      [now, now + 30 * 24 * 60 * 60 * 1000, now, tenantId, client.client_id]
    );
  } catch {
    // The inactivity marker is lifecycle metadata. Never turn an already-rotated or already-issued
    // token response into an ambiguous failure when this best-effort extension cannot be stored.
  }
}

function errorResponse(
  c: Context<{ Bindings: Env }>,
  error: string,
  description: string,
  status = 400
): Response {
  return c.json({ error, error_description: description }, status as 400);
}

async function loadAgentSettings(
  c: Context<{ Bindings: Env }>
): Promise<LoadedAgentSettings | null> {
  const env = c.env as AgentTokenEnv;
  const tenantId = getTenantIdFromContext(c);
  const settings = env.SETTINGS ?? env.AUTHRIM_CONFIG;
  if (!settings) {
    return {
      ...parseAgentAccessSettings(null),
      enabled: evaluateAgentMcpFeatureFlag({
        configurationAvailable: true,
        environmentValue: env.ENABLE_AGENT_MCP,
      }).enabled,
    };
  }
  try {
    const raw = await settings.get(`settings:tenant:${tenantId}:agent-access`);
    const parsed: unknown = raw ? JSON.parse(raw) : undefined;
    const tenantValue =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)['agent.mcp.enabled']
        : parsed;
    return {
      ...parseAgentAccessSettings(parsed),
      enabled: evaluateAgentMcpFeatureFlag({
        configurationAvailable: true,
        tenantValue:
          parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)[AGENT_ACCESS_SETTING_KEYS.enabled]
            : tenantValue,
        environmentValue: env.ENABLE_AGENT_MCP,
      }).enabled,
    };
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringClaim(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseAdminAgentAuthorizationDetails(value: unknown): JsonObject[] | undefined {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return normalizeSelfServiceAgentAuthorizationDetails(parsed).authorizationDetails;
}

function scopeSubset(requested: string, allowed: string): boolean {
  const allowedSet = new Set(allowed.split(/\s+/u).filter(Boolean));
  return requested
    .split(/\s+/u)
    .filter(Boolean)
    .every((scope) => allowedSet.has(scope));
}

async function signingKey(env: Env, tenantId: string) {
  if (!env.KEY_MANAGER) throw new Error('KEY_MANAGER binding not available');
  const stub = env.KEY_MANAGER.get(env.KEY_MANAGER.idFromName(`${tenantId}-v3`));
  const keyData =
    (await stub.getActiveKeyWithPrivateRpc()) ?? (await stub.rotateKeysWithPrivateRpc());
  return {
    kid: keyData.kid,
    privateKey: await importPKCS8(keyData.privatePEM, 'RS256'),
  };
}

interface ModeBMachineActor {
  principalId: string;
  credentialId: string;
  clientId: string;
  dpopJkt: string;
  permissions: string[];
}

function explicitTenantAllowed(
  scopes: readonly { scopeMode: string; tenantId: string | null }[],
  tenantId: string
): boolean {
  return (
    scopes.length > 0 &&
    scopes.every((scope) => scope.scopeMode === 'allow') &&
    scopes.some((scope) => scope.tenantId === tenantId)
  );
}

async function modeALinkedPrincipalPermissionLimit(
  env: Env,
  tenantId: string,
  principalId: string | undefined
): Promise<string[] | null | undefined> {
  if (!principalId) return undefined;
  const repository = new AdminMachineAccessRepository(
    requireDedicatedAdminDatabaseAdapter(env, 'admin-agent-mode-a-principal-limit')
  );
  const [principal, scopes, permissions] = await Promise.all([
    repository.findPrincipalById(principalId),
    repository.getPrincipalTenantScopes(principalId),
    repository.getPrincipalPermissions(principalId),
  ]);
  return principal?.status === 'active' && explicitTenantAllowed(scopes, tenantId)
    ? permissions
    : null;
}

function linkedPrincipalCoversGrant(
  permissions: readonly string[] | null | undefined,
  grantPermissions: readonly string[]
): boolean {
  return (
    permissions === undefined ||
    (permissions !== null &&
      grantPermissions.every((permission) => hasAdminPermission([...permissions], permission)))
  );
}

async function authenticateModeBActor(
  c: Context<{ Bindings: Env }>,
  actorToken: string,
  dpopProof: string | undefined
): Promise<ModeBMachineActor | null> {
  if (!dpopProof) return null;
  const tenantId = getTenantIdFromContext(c);
  let payload: Record<string, unknown>;
  try {
    const header = parseTokenHeader(actorToken);
    if (!header.kid) return null;
    const publicKey = await getPublicKeyByKid(c.env, tenantId, header.kid);
    if (!publicKey) return null;
    payload = (await verifyToken(actorToken, publicKey, getRequestIssuer(c), {
      audience: 'authrim:admin-api',
    })) as Record<string, unknown>;
  } catch {
    return null;
  }
  const principalId = typeof payload.actor_id === 'string' ? payload.actor_id : '';
  const credentialId = typeof payload.credential_id === 'string' ? payload.credential_id : '';
  const clientId = typeof payload.client_id === 'string' ? payload.client_id : '';
  const jti = typeof payload.jti === 'string' ? payload.jti : '';
  const cnf = isRecord(payload.cnf) && typeof payload.cnf.jkt === 'string' ? payload.cnf.jkt : '';
  if (
    payload.actor_type !== 'machine' ||
    payload.sender_constrained !== true ||
    !principalId ||
    !credentialId ||
    !clientId ||
    !jti ||
    !cnf ||
    (await isTokenRevoked(c.env, jti, tenantId))
  ) {
    return null;
  }
  const dpop = await validateDPoPProof(
    dpopProof,
    'POST',
    c.req.url,
    actorToken,
    c.env,
    clientId,
    tenantId
  );
  if (!dpop.valid || dpop.jkt !== cnf) return null;

  const machine = new AdminMachineAccessRepository(
    requireDedicatedAdminDatabaseAdapter(c.env, 'admin-agent-mode-b-actor')
  );
  const [principal, credential] = await Promise.all([
    machine.findPrincipalById(principalId),
    machine.findCredentialById(credentialId),
  ]);
  if (
    !principal ||
    !credential ||
    principal.status !== 'active' ||
    (credential.status !== 'active' && credential.status !== 'rotating') ||
    credential.principalId !== principal.id ||
    principal.clientId !== clientId
  ) {
    return null;
  }
  const [principalPermissions, credentialPermissions, principalScopes, credentialScopes] =
    await Promise.all([
      machine.getPrincipalPermissions(principal.id),
      machine.getCredentialPermissions(credential.id),
      machine.getPrincipalTenantScopes(principal.id),
      machine.getCredentialTenantScopes(credential.id),
    ]);
  if (
    !explicitTenantAllowed(principalScopes, tenantId) ||
    (credentialScopes.length > 0 && !explicitTenantAllowed(credentialScopes, tenantId))
  ) {
    return null;
  }
  const permissions =
    credentialPermissions.length === 0
      ? principalPermissions
      : principalPermissions.filter((permission) =>
          credentialPermissions.some((limit) => hasAdminPermission([limit], permission))
        );
  return { principalId, credentialId, clientId, dpopJkt: cnf, permissions };
}

async function issueInitialRefreshToken(input: {
  c: Context<{ Bindings: Env }>;
  repository: AdminAgentAccessRepository;
  codeStore: Env['AUTH_CODE_STORE'] extends { get(id: infer _I): infer S } ? S : never;
  code: string;
  accessTokenJti: string;
  tenantId: string;
  issuer: string;
  resource: string;
  clientId: string;
  delegatorId: string;
  grantId: string;
  grantGeneration: number;
  consentVersion: number;
  scope: string;
  authorizationDetails?: JsonObject[];
  publicClient: boolean;
  dpopJkt?: string;
  privateKey: CryptoKey;
  kid: string;
}): Promise<{ token: string; familyId: string; familyJti: string } | null> {
  const familyId = `agf_${crypto.randomUUID()}`;
  const finalizationNonce = generateSecureRandomString(128);
  const now = Date.now();
  const ttl = input.publicClient
    ? PUBLIC_REFRESH_TOKEN_TTL_SECONDS
    : CONFIDENTIAL_REFRESH_TOKEN_TTL_SECONDS;
  let created: Awaited<ReturnType<typeof createRefreshTokenFamily>> | null = null;
  try {
    created = await createRefreshTokenFamily(input.c.env, {
      userId: familyId,
      clientId: input.clientId,
      scope: input.scope,
      ttl,
      tenantId: input.tenantId,
      resourceAudience: input.resource,
    });
    await input.repository.createPendingTokenFamily({
      familyId,
      familyJti: created.jti,
      tenantId: input.tenantId,
      grantId: input.grantId,
      grantGeneration: input.grantGeneration,
      adminUserId: input.delegatorId,
      clientId: input.clientId,
      consentVersion: input.consentVersion,
      finalizationNonce,
      expiresAt: now + ttl * 1000,
      createdAt: now,
    });
    const refresh = await createRefreshToken(
      {
        iss: input.issuer,
        sub: `admin_user:${input.delegatorId}`,
        aud: input.clientId,
        scope: input.scope,
        client_id: input.clientId,
        tenant_id: input.tenantId,
        resource_aud: input.resource,
        agent_family_id: familyId,
        grant_id: input.grantId,
        grant_generation: input.grantGeneration,
        consent_version: input.consentVersion,
        actor_mode: 'mode_a',
        actor_assurance: input.publicClient ? 'public_client_transaction' : 'confidential_client',
        ...(input.authorizationDetails
          ? { authorization_details: input.authorizationDetails }
          : {}),
        ...(input.dpopJkt ? { cnf: { jkt: input.dpopJkt } } : {}),
      },
      input.privateKey,
      input.kid,
      ttl,
      created.family.newJti,
      created.family.version
    );
    const registered = await input.codeStore.registerIssuedTokensRpc(
      input.code,
      input.accessTokenJti,
      created.jti
    );
    const finalized =
      registered &&
      (await input.repository.finalizeTokenFamily({
        familyId,
        finalizationNonce,
        tenantId: input.tenantId,
        grantId: input.grantId,
        grantGeneration: input.grantGeneration,
        adminUserId: input.delegatorId,
        clientId: input.clientId,
        consentVersion: input.consentVersion,
        now: Date.now(),
      }));
    if (!finalized) throw new Error('agent_refresh_family_finalization_failed');
    return { token: refresh.token, familyId, familyJti: created.jti };
  } catch {
    if (created) {
      try {
        const { stub } = getRefreshTokenRotatorStubByJti(
          input.c.env,
          input.clientId,
          created.jti,
          input.tenantId
        );
        await stub.revokeFamilyRpc(familyId, 'initialization_failed');
      } catch {
        // No token is returned; the short-lived orphan is unusable without a finalized DB row.
      }
    }
    return null;
  }
}

async function handleAdminAgentRefresh(
  c: Context<{ Bindings: Env }>,
  form: AgentTokenForm,
  agentSettings: LoadedAgentSettings
): Promise<Response> {
  const allowed = new Set([
    'grant_type',
    'refresh_token',
    'scope',
    'client_id',
    'client_secret',
    'client_assertion',
    'client_assertion_type',
    'resource',
  ]);
  if (
    Object.keys(form).some((key) => !allowed.has(key)) ||
    !form.refresh_token ||
    !form.client_id
  ) {
    return errorResponse(
      c,
      'invalid_request',
      'Required or supported refresh parameter is invalid'
    );
  }
  const clientIdValidation = validateClientId(form.client_id);
  if (!clientIdValidation.valid && !isSelfServiceClientMetadataDocumentId(form.client_id)) {
    return errorResponse(c, 'invalid_client', 'Client authentication failed', 401);
  }
  const tenantId = getTenantIdFromContext(c);
  const baseIssuer = getRequestIssuer(c).replace(/\/$/u, '');
  const issuer = `${baseIssuer}/oauth/admin-agent`;
  const resource = `${baseIssuer}/mcp`;
  if (form.resource && form.resource !== resource) {
    return errorResponse(c, 'invalid_target', 'resource must identify this MCP endpoint');
  }
  const client = (await getClientCached(c, c.env, form.client_id)) as ClientMetadata | null;
  if (!client || !selfServiceClientIsActive(client)) {
    return errorResponse(c, 'invalid_client', 'Client authentication failed', 401);
  }
  const credentials = parseOAuthClientAuthenticationParams({
    clientId: form.client_id,
    clientSecret: form.client_secret,
    clientAssertion: form.client_assertion,
    clientAssertionType: form.client_assertion_type,
    authorizationHeader: c.req.header('authorization'),
  });
  if (!credentials.ok) {
    return errorResponse(c, credentials.error, credentials.errorDescription, 401);
  }
  const publicClient = (client.token_endpoint_auth_method as string | undefined) === 'none';
  if (publicClient) {
    const methodValidation = validateRegisteredClientAuthenticationMethod(
      client,
      credentials.credentials.presentation
    );
    if (!methodValidation.valid) {
      return errorResponse(c, 'invalid_client', 'Client authentication failed', 401);
    }
  } else {
    const authenticated = await authenticateConfidentialOAuthClient(
      client,
      `${baseIssuer}/oauth/admin-agent/token`,
      credentials.credentials,
      { replayProtection: { env: c.env, tenantId } }
    );
    if (!authenticated.ok) {
      return errorResponse(c, authenticated.error, authenticated.errorDescription, 401);
    }
  }

  let payload: Record<string, unknown>;
  try {
    const header = parseTokenHeader(form.refresh_token);
    if (header.alg !== 'RS256' || header.typ !== 'JWT' || !header.kid) {
      throw new Error('invalid_refresh_header');
    }
    const publicKey = await getPublicKeyByKid(c.env, tenantId, header.kid);
    if (!publicKey) throw new Error('refresh_key_unavailable');
    const verified: unknown = await verifyToken(form.refresh_token, publicKey, issuer, {
      audience: form.client_id,
    });
    if (!isRecord(verified)) throw new Error('invalid_refresh_claims');
    payload = verified;
  } catch {
    return errorResponse(c, 'invalid_grant', 'Refresh token is invalid or expired');
  }

  const subject = stringClaim(payload.sub);
  const familyId = stringClaim(payload.agent_family_id);
  const grantId = stringClaim(payload.grant_id);
  const tokenClientId = stringClaim(payload.client_id);
  const tokenTenant = stringClaim(payload.tenant_id) ?? tenantId;
  const tokenResource = stringClaim(payload.resource_aud);
  const tokenScope = stringClaim(payload.scope);
  const jti = stringClaim(payload.jti);
  const grantGeneration = payload.grant_generation;
  const consentVersion = payload.consent_version;
  const incomingVersion = payload.rtv;
  if (
    !subject?.startsWith('admin_user:') ||
    !familyId ||
    !grantId ||
    tokenClientId !== form.client_id ||
    tokenTenant !== tenantId ||
    tokenResource !== resource ||
    !tokenScope ||
    !jti ||
    !Number.isSafeInteger(grantGeneration) ||
    !Number.isSafeInteger(consentVersion) ||
    !Number.isSafeInteger(incomingVersion)
  ) {
    return errorResponse(c, 'invalid_grant', 'Refresh token binding is invalid');
  }
  let authorizationDetails: JsonObject[] | undefined;
  try {
    authorizationDetails = parseAdminAgentAuthorizationDetails(payload.authorization_details);
  } catch {
    return errorResponse(c, 'invalid_grant', 'Refresh token authorization_details is invalid');
  }
  const delegatorId = subject.slice('admin_user:'.length);
  const requestedScope = form.scope || tokenScope;
  if (!scopeSubset(requestedScope, tokenScope)) {
    return errorResponse(c, 'invalid_scope', 'Requested scope exceeds the original grant');
  }

  const boundJkt = isRecord(payload.cnf) ? stringClaim(payload.cnf.jkt) : null;
  const dpopProof = c.req.header('dpop');
  let dpopJkt: string | undefined;
  if (boundJkt && !dpopProof) {
    return errorResponse(c, 'invalid_dpop_proof', 'DPoP proof is required');
  }
  if (dpopProof) {
    const validation = await validateDPoPProof(
      dpopProof,
      'POST',
      `${baseIssuer}/oauth/admin-agent/token`,
      undefined,
      c.env,
      form.client_id,
      tenantId
    );
    if (!validation.valid || !validation.jkt || (boundJkt && validation.jkt !== boundJkt)) {
      return errorResponse(c, 'invalid_dpop_proof', 'DPoP proof validation failed');
    }
    dpopJkt = validation.jkt;
  } else if (client.dpop_bound_access_tokens) {
    return errorResponse(c, 'invalid_dpop_proof', 'DPoP proof is required for this client');
  }

  const repository = new AdminAgentAccessRepository(
    requireDedicatedAdminDatabaseAdapter(c.env, 'admin-agent-refresh')
  );
  const now = Date.now();
  const [grant, currentPermissions, familyUsable] = await Promise.all([
    repository.getGrant(tenantId, grantId),
    repository.getActiveDelegatorPermissions(tenantId, delegatorId, now),
    repository.isTokenFamilyUsable({
      familyId,
      tenantId,
      grantId,
      grantGeneration: grantGeneration as number,
      adminUserId: delegatorId,
      clientId: form.client_id,
      consentVersion: consentVersion as number,
      now,
    }),
  ]);
  const principalPermissionLimit = await modeALinkedPrincipalPermissionLimit(
    c.env,
    tenantId,
    grant?.machinePrincipalId
  );
  const registeredScopes = new Set(client.requestable_scopes ?? []);
  if (
    !grant ||
    !familyUsable ||
    grant.status !== 'active' ||
    (grant.expiresAt !== undefined && grant.expiresAt <= now) ||
    grant.clientId !== form.client_id ||
    grant.delegatorId !== delegatorId ||
    grant.generation !== grantGeneration ||
    grant.consentVersion !== consentVersion ||
    !currentPermissions ||
    grant.permissions.some((permission) => !hasAdminPermission(currentPermissions, permission)) ||
    !linkedPrincipalCoversGrant(principalPermissionLimit, grant.permissions) ||
    requestedScope
      .split(/\s+/u)
      .filter(Boolean)
      .some(
        (scope) =>
          !grant.scopes.includes(scope as (typeof grant.scopes)[number]) ||
          !registeredScopes.has(scope)
      )
  ) {
    return errorResponse(c, 'invalid_grant', 'Agent Grant is no longer valid');
  }

  const { stub: rotator } = getRefreshTokenRotatorStubByJti(c.env, form.client_id, jti, tenantId);
  const family = await rotator.getFamilyRpc(familyId);
  const idleSeconds = publicClient
    ? PUBLIC_REFRESH_IDLE_SECONDS
    : CONFIDENTIAL_REFRESH_IDLE_SECONDS;
  if (
    !family ||
    family.user_id !== familyId ||
    family.tenant_id !== tenantId ||
    family.client_id !== form.client_id ||
    family.last_used_at + idleSeconds * 1000 <= now
  ) {
    if (family) await rotator.revokeFamilyRpc(familyId, 'idle_or_binding_expired');
    return errorResponse(c, 'invalid_grant', 'Refresh token is invalid or expired');
  }

  let rotated;
  try {
    rotated = await rotator.rotateRpc({
      incomingVersion: incomingVersion as number,
      incomingJti: jti,
      userId: familyId,
      clientId: form.client_id,
      tenantId,
      requestedScope,
    });
  } catch {
    return errorResponse(c, 'invalid_grant', 'Refresh token reuse or rotation failure detected');
  }

  const key = await signingKey(c.env, tenantId);
  const assurance = publicClient ? 'public_client_transaction' : 'confidential_client';
  const accessClaims = {
    iss: issuer,
    sub: subject,
    aud: resource,
    scope: requestedScope,
    client_id: form.client_id,
    azp: form.client_id,
    tenant_id: tenantId,
    grant_id: grant.grantId,
    grant_generation: grant.generation,
    consent_version: grant.consentVersion,
    actor_mode: 'mode_a',
    actor_assurance: assurance,
    token_binding: dpopJkt ? 'dpop' : 'bearer',
    act: { sub: `client:${form.client_id}` },
    ...(authorizationDetails ? { authorization_details: authorizationDetails } : {}),
    ...(dpopJkt ? { cnf: { jkt: dpopJkt } } : {}),
  } satisfies Omit<AccessTokenClaims, 'iat' | 'exp' | 'jti'>;
  const access = await createAccessToken(
    accessClaims,
    key.privateKey,
    key.kid,
    agentSettings.maxTokenTtlSeconds,
    generateSecureRandomString(96)
  );
  const refresh = await createRefreshToken(
    {
      iss: issuer,
      sub: subject,
      aud: form.client_id,
      scope: requestedScope,
      client_id: form.client_id,
      tenant_id: tenantId,
      resource_aud: resource,
      agent_family_id: familyId,
      grant_id: grant.grantId,
      grant_generation: grant.generation,
      consent_version: grant.consentVersion,
      actor_mode: 'mode_a',
      actor_assurance: assurance,
      ...(authorizationDetails ? { authorization_details: authorizationDetails } : {}),
      ...(dpopJkt ? { cnf: { jkt: dpopJkt } } : {}),
    },
    key.privateKey,
    key.kid,
    rotated.expiresIn,
    rotated.newJti,
    rotated.newVersion
  );
  await repository.writeAudit({
    id: `audit_${crypto.randomUUID()}`,
    tenantId,
    adminUserId: delegatorId,
    action: 'agent.token.refreshed',
    resourceType: 'admin_agent_grant',
    resourceId: grant.grantId,
    severity: 'info',
    requestId: c.req.header('x-request-id'),
    actorType: 'agent',
    actorSub: `client:${form.client_id}`,
    actorMode: 'mode_a',
    actorAssurance: assurance,
    tokenBinding: dpopJkt ? 'dpop' : 'bearer',
    actClientId: form.client_id,
    actPrincipalId: grant.machinePrincipalId,
    grantId: grant.grantId,
    metadata: { family_id: familyId, grant_generation: grant.generation },
    createdAt: Date.now(),
  });
  await touchSelfServiceClient(c, tenantId, client);
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  return c.json({
    access_token: access.token,
    refresh_token: refresh.token,
    token_type: dpopJkt ? 'DPoP' : 'Bearer',
    expires_in: agentSettings.maxTokenTtlSeconds,
    scope: requestedScope,
    ...(authorizationDetails ? { authorization_details: authorizationDetails } : {}),
  });
}

function dpopAuthorization(c: Context<{ Bindings: Env }>): string | null {
  const authorization = c.req.header('authorization') ?? '';
  const match = /^DPoP\s+(.+)$/iu.exec(authorization);
  return match?.[1] ?? null;
}

function requestedAgentScopes(value: string | undefined): string[] {
  return [...new Set((value ?? '').split(/\s+/u).filter(Boolean))];
}

/** Issues a short-lived, one-time JIT delegation JWT for a live Mode B Grant. */
export async function adminAgentDelegationHandler(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  const settings = await loadAgentSettings(c);
  if (!settings?.enabled) return c.json({ error: 'not_found' }, 404);
  if (!c.req.header('content-type')?.includes('application/x-www-form-urlencoded')) {
    return errorResponse(c, 'invalid_request', 'Form encoding is required');
  }
  const parsed = await c.req.parseBody();
  const form = Object.fromEntries(
    Object.entries(parsed).map(([key, value]) => [key, typeof value === 'string' ? value : ''])
  );
  if (
    Object.keys(form).some((key) => !['grant_id', 'scope', 'resource'].includes(key)) ||
    !form.grant_id
  ) {
    return errorResponse(c, 'invalid_request', 'Mode B delegation request is invalid');
  }
  const actorToken = dpopAuthorization(c);
  const actor = actorToken
    ? await authenticateModeBActor(c, actorToken, c.req.header('dpop'))
    : null;
  if (!actor) return errorResponse(c, 'invalid_token', 'DPoP-bound machine actor required', 401);
  const tenantId = getTenantIdFromContext(c);
  const baseIssuer = getRequestIssuer(c).replace(/\/$/u, '');
  const resource = `${baseIssuer}/mcp`;
  if (form.resource && form.resource !== resource) {
    return errorResponse(c, 'invalid_target', 'resource must identify this MCP endpoint');
  }
  const repository = new AdminAgentAccessRepository(
    requireDedicatedAdminDatabaseAdapter(c.env, 'admin-agent-mode-b-delegation')
  );
  const grant = await repository.getGrant(tenantId, form.grant_id);
  if (
    !grant ||
    grant.status !== 'active' ||
    grant.machinePrincipalId !== actor.principalId ||
    grant.clientId !== actor.clientId ||
    grant.delegationMode === 'user_consent' ||
    (grant.expiresAt !== undefined && grant.expiresAt <= Date.now())
  ) {
    return errorResponse(c, 'invalid_grant', 'Mode B Grant is not active');
  }
  const delegatorPermissions = await repository.getActiveDelegatorPermissions(
    tenantId,
    grant.delegatorId,
    Date.now()
  );
  const [currentConsent, client] = await Promise.all([
    grant
      ? repository.hasCurrentConsent(
          tenantId,
          grant.grantId,
          grant.delegatorId,
          grant.clientId,
          grant.consentVersion
        )
      : Promise.resolve(false),
    getClientCached(c, c.env, actor.clientId) as Promise<ClientMetadata | null>,
  ]);
  if (
    !delegatorPermissions ||
    !currentConsent ||
    !client ||
    grant.permissions.some(
      (permission) =>
        !hasAdminPermission(delegatorPermissions, permission) ||
        !hasAdminPermission(actor.permissions, permission)
    )
  ) {
    return errorResponse(c, 'invalid_grant', 'Mode B permission ceiling changed');
  }
  const requested = requestedAgentScopes(form.scope);
  const scopes = requested.length > 0 ? requested : grant.scopes;
  const registeredScopes = new Set(client.requestable_scopes ?? []);
  if (
    scopes.some(
      (scope) =>
        !grant.scopes.includes(scope as (typeof grant.scopes)[number]) ||
        !registeredScopes.has(scope)
    )
  ) {
    return errorResponse(c, 'invalid_scope', 'Requested scope exceeds the Agent Grant');
  }
  const key = await signingKey(c.env, tenantId);
  const now = Math.floor(Date.now() / 1000);
  const jti = `adj_${crypto.randomUUID()}`;
  const token = await new SignJWT({
    token_use: 'agent_delegation',
    grant_id: grant.grantId,
    grant_generation: grant.generation,
    consent_version: grant.consentVersion,
    tenant_id: tenantId,
    client_id: grant.clientId,
    scope: scopes.join(' '),
    resource,
    may_act: { sub: `machine:${actor.principalId}` },
    cnf: { jkt: actor.dpopJkt },
  })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: key.kid })
    .setIssuer(`${baseIssuer}/oauth/admin-agent`)
    .setSubject(`admin_user:${grant.delegatorId}`)
    .setAudience(`${baseIssuer}/oauth/admin-agent/token`)
    .setJti(jti)
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + 300)
    .sign(key.privateKey);
  await repository.writeAudit({
    id: `audit_${crypto.randomUUID()}`,
    tenantId,
    adminUserId: grant.delegatorId,
    action: 'agent.delegation_token.issued',
    resourceType: 'admin_agent_grant',
    resourceId: grant.grantId,
    severity: 'info',
    result: 'success',
    actorType: 'agent',
    actorSub: `machine:${actor.principalId}`,
    actorMode: 'mode_b',
    actorAssurance: 'machine_key',
    tokenBinding: 'dpop',
    actClientId: actor.clientId,
    actPrincipalId: actor.principalId,
    grantId: grant.grantId,
    metadata: { delegation_jti: jti, expires_at: (now + 300) * 1000 },
    createdAt: Date.now(),
  });
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  return c.json({
    delegation_token: token,
    delegation_token_type: AGENT_DELEGATION_TOKEN_TYPE,
    expires_in: 300,
    scope: scopes.join(' '),
  });
}

async function handleAdminAgentModeBExchange(
  c: Context<{ Bindings: Env }>,
  form: AgentTokenForm,
  settings: LoadedAgentSettings
): Promise<Response> {
  const allowed = new Set([
    'grant_type',
    'subject_token',
    'subject_token_type',
    'actor_token',
    'actor_token_type',
    'requested_token_type',
    'client_id',
    'scope',
    'resource',
  ]);
  if (
    Object.keys(form).some((key) => !allowed.has(key)) ||
    !form.subject_token ||
    form.subject_token_type !== AGENT_DELEGATION_TOKEN_TYPE ||
    !form.actor_token ||
    form.actor_token_type !== ACCESS_TOKEN_TYPE ||
    (form.requested_token_type && form.requested_token_type !== ACCESS_TOKEN_TYPE)
  ) {
    return errorResponse(c, 'invalid_request', 'Mode B token exchange request is invalid');
  }
  const actor = await authenticateModeBActor(c, form.actor_token, c.req.header('dpop'));
  if (!actor || (form.client_id && form.client_id !== actor.clientId)) {
    return errorResponse(c, 'invalid_actor_token', 'Machine actor validation failed', 401);
  }
  const tenantId = getTenantIdFromContext(c);
  const baseIssuer = getRequestIssuer(c).replace(/\/$/u, '');
  const issuer = `${baseIssuer}/oauth/admin-agent`;
  const resource = `${baseIssuer}/mcp`;
  if (form.resource !== resource) {
    return errorResponse(c, 'invalid_target', 'resource must identify this MCP endpoint');
  }
  let delegation: Record<string, unknown>;
  try {
    const header = parseTokenHeader(form.subject_token);
    if (!header.kid) throw new TypeError('Delegation token kid is required');
    const publicKey = await getPublicKeyByKid(c.env, tenantId, header.kid);
    if (!publicKey) throw new TypeError('Delegation verification key is unavailable');
    delegation = (await verifyToken(form.subject_token, publicKey, issuer, {
      audience: `${issuer}/token`,
    })) as Record<string, unknown>;
  } catch {
    return errorResponse(c, 'invalid_grant', 'Agent delegation token is invalid');
  }
  const mayAct = isRecord(delegation.may_act) ? delegation.may_act.sub : undefined;
  const cnf = isRecord(delegation.cnf) ? delegation.cnf.jkt : undefined;
  const grantId = typeof delegation.grant_id === 'string' ? delegation.grant_id : '';
  const jti = typeof delegation.jti === 'string' ? delegation.jti : '';
  const expiresAt = typeof delegation.exp === 'number' ? delegation.exp * 1000 : 0;
  if (
    delegation.token_use !== 'agent_delegation' ||
    delegation.tenant_id !== tenantId ||
    delegation.client_id !== actor.clientId ||
    delegation.resource !== resource ||
    mayAct !== `machine:${actor.principalId}` ||
    cnf !== actor.dpopJkt ||
    typeof delegation.sub !== 'string' ||
    !delegation.sub.startsWith('admin_user:') ||
    !grantId ||
    !jti
  ) {
    return errorResponse(c, 'invalid_grant', 'Agent delegation binding is invalid');
  }
  const repository = new AdminAgentAccessRepository(
    requireDedicatedAdminDatabaseAdapter(c.env, 'admin-agent-mode-b-exchange')
  );
  const consumed = await repository.consumeModeBDelegationJti({
    jti,
    tenantId,
    grantId,
    machinePrincipalId: actor.principalId,
    expiresAt,
    consumedAt: Date.now(),
  });
  if (!consumed) return errorResponse(c, 'invalid_grant', 'Agent delegation replay detected');
  const grant = await repository.getGrant(tenantId, grantId);
  const delegatorId = delegation.sub.slice('admin_user:'.length);
  const delegatorPermissions = await repository.getActiveDelegatorPermissions(
    tenantId,
    delegatorId,
    Date.now()
  );
  const [currentConsent, client] = await Promise.all([
    grant
      ? repository.hasCurrentConsent(
          tenantId,
          grant.grantId,
          grant.delegatorId,
          grant.clientId,
          grant.consentVersion
        )
      : Promise.resolve(false),
    getClientCached(c, c.env, actor.clientId) as Promise<ClientMetadata | null>,
  ]);
  const tokenScopes =
    typeof delegation.scope === 'string' ? requestedAgentScopes(delegation.scope) : [];
  const requested = requestedAgentScopes(form.scope);
  const scopes = requested.length > 0 ? requested : tokenScopes;
  if (
    !grant ||
    grant.status !== 'active' ||
    (grant.expiresAt !== undefined && grant.expiresAt <= Date.now()) ||
    grant.delegatorId !== delegatorId ||
    grant.clientId !== actor.clientId ||
    grant.machinePrincipalId !== actor.principalId ||
    grant.generation !== delegation.grant_generation ||
    grant.consentVersion !== delegation.consent_version ||
    !currentConsent ||
    !client ||
    !delegatorPermissions ||
    grant.permissions.some(
      (permission) =>
        !hasAdminPermission(delegatorPermissions, permission) ||
        !hasAdminPermission(actor.permissions, permission)
    ) ||
    scopes.length === 0 ||
    scopes.some(
      (scope) =>
        !tokenScopes.includes(scope) ||
        !grant.scopes.includes(scope as (typeof grant.scopes)[number]) ||
        !(client.requestable_scopes ?? []).includes(scope)
    )
  ) {
    return errorResponse(c, 'invalid_grant', 'Agent Grant is no longer valid');
  }
  const key = await signingKey(c.env, tenantId);
  const access = await createAccessToken(
    {
      iss: issuer,
      sub: `admin_user:${delegatorId}`,
      aud: resource,
      scope: scopes.join(' '),
      client_id: actor.clientId,
      azp: actor.clientId,
      tenant_id: tenantId,
      grant_id: grant.grantId,
      grant_generation: grant.generation,
      consent_version: grant.consentVersion,
      actor_mode: 'mode_b',
      actor_assurance: 'machine_key',
      token_binding: 'dpop',
      act: { sub: `machine:${actor.principalId}` },
      act_principal_id: actor.principalId,
      act_credential_id: actor.credentialId,
      cnf: { jkt: actor.dpopJkt },
    } as Omit<AccessTokenClaims, 'iat' | 'exp' | 'jti'>,
    key.privateKey,
    key.kid,
    Math.min(settings.maxTokenTtlSeconds, 300),
    generateSecureRandomString(96)
  );
  await repository.writeAudit({
    id: `audit_${crypto.randomUUID()}`,
    tenantId,
    adminUserId: delegatorId,
    action: 'agent.token.issued',
    resourceType: 'admin_agent_grant',
    resourceId: grant.grantId,
    severity: 'info',
    requestId: c.req.header('x-request-id'),
    actorType: 'agent',
    actorSub: `machine:${actor.principalId}`,
    actorMode: 'mode_b',
    actorAssurance: 'machine_key',
    tokenBinding: 'dpop',
    actClientId: actor.clientId,
    actPrincipalId: actor.principalId,
    grantId: grant.grantId,
    metadata: { delegation_jti: jti, access_token_jti: access.jti },
    createdAt: Date.now(),
  });
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  return c.json({
    access_token: access.token,
    issued_token_type: ACCESS_TOKEN_TYPE,
    token_type: 'DPoP',
    expires_in: Math.min(settings.maxTokenTtlSeconds, 300),
    scope: scopes.join(' '),
  });
}

/** Authorization Code exchange for the dedicated Admin Agent issuer. */
export async function adminAgentTokenHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  const agentSettings = await loadAgentSettings(c);
  if (agentSettings === null) {
    return errorResponse(
      c,
      'temporarily_unavailable',
      'Agent access configuration unavailable',
      503
    );
  }
  if (!agentSettings.enabled) return c.json({ error: 'not_found' }, 404);
  if (!c.req.header('content-type')?.includes('application/x-www-form-urlencoded')) {
    return errorResponse(
      c,
      'invalid_request',
      'Content-Type must be application/x-www-form-urlencoded'
    );
  }

  const parsedBody = await c.req.parseBody();
  const form = Object.fromEntries(
    Object.entries(parsedBody).map(([key, value]) => [key, typeof value === 'string' ? value : ''])
  );
  if (form.grant_type === 'refresh_token') {
    return handleAdminAgentRefresh(c, form, agentSettings);
  }
  if (form.grant_type === TOKEN_EXCHANGE_GRANT) {
    return handleAdminAgentModeBExchange(c, form, agentSettings);
  }
  const allowed = new Set([
    'grant_type',
    'code',
    'redirect_uri',
    'client_id',
    'client_secret',
    'client_assertion',
    'client_assertion_type',
    'code_verifier',
    'resource',
  ]);
  if (Object.keys(form).some((key) => !allowed.has(key))) {
    return errorResponse(c, 'invalid_request', 'Unsupported token parameter');
  }
  if (form.grant_type !== 'authorization_code') {
    return errorResponse(
      c,
      'unsupported_grant_type',
      'Only authorization_code, refresh_token, and token exchange are implemented'
    );
  }
  if (
    !form.code?.startsWith(ADMIN_AGENT_CODE_PREFIX) ||
    !form.redirect_uri ||
    !form.client_id ||
    !form.code_verifier ||
    !form.resource
  ) {
    return errorResponse(c, 'invalid_request', 'Required token parameter is missing');
  }
  const clientIdValidation = validateClientId(form.client_id);
  if (!clientIdValidation.valid && !isSelfServiceClientMetadataDocumentId(form.client_id)) {
    return errorResponse(c, 'invalid_client', 'Client authentication failed', 401);
  }

  const tenantId = getTenantIdFromContext(c);
  const baseIssuer = getRequestIssuer(c).replace(/\/$/u, '');
  const issuer = `${baseIssuer}/oauth/admin-agent`;
  const resource = `${baseIssuer}/mcp`;
  if (form.resource !== resource) {
    return errorResponse(c, 'invalid_target', 'resource must identify this MCP endpoint');
  }
  const client = (await getClientCached(c, c.env, form.client_id)) as ClientMetadata | null;
  if (!client || !selfServiceClientIsActive(client)) {
    return errorResponse(c, 'invalid_client', 'Client authentication failed', 401);
  }
  const credentials = parseOAuthClientAuthenticationParams({
    clientId: form.client_id,
    clientSecret: form.client_secret,
    clientAssertion: form.client_assertion,
    clientAssertionType: form.client_assertion_type,
    authorizationHeader: c.req.header('authorization'),
  });
  if (!credentials.ok) {
    return errorResponse(c, credentials.error, credentials.errorDescription, 401);
  }
  const publicClient = (client.token_endpoint_auth_method as string | undefined) === 'none';
  if (publicClient) {
    const methodValidation = validateRegisteredClientAuthenticationMethod(
      client,
      credentials.credentials.presentation
    );
    if (!methodValidation.valid) {
      return errorResponse(c, 'invalid_client', 'Client authentication failed', 401);
    }
  } else {
    const result = await authenticateConfidentialOAuthClient(
      client,
      `${baseIssuer}/oauth/admin-agent/token`,
      credentials.credentials,
      { replayProtection: { env: c.env, tenantId } }
    );
    if (!result.ok) return errorResponse(c, result.error, result.errorDescription, 401);
  }

  let dpopJkt: string | undefined;
  const dpopProof = c.req.header('dpop');
  if (dpopProof) {
    const result = await validateDPoPProof(
      dpopProof,
      'POST',
      `${baseIssuer}/oauth/admin-agent/token`,
      undefined,
      c.env,
      form.client_id,
      tenantId
    );
    if (!result.valid || !result.jkt) {
      return errorResponse(
        c,
        result.error ?? 'invalid_dpop_proof',
        result.error_description ?? 'DPoP proof validation failed'
      );
    }
    dpopJkt = result.jkt;
  } else if (client.dpop_bound_access_tokens) {
    return errorResponse(c, 'invalid_dpop_proof', 'DPoP proof is required for this client');
  }

  const codeStore = c.env.AUTH_CODE_STORE.get(
    c.env.AUTH_CODE_STORE.idFromName(buildDOInstanceName('admin-agent-auth-code', tenantId))
  );
  const accessTokenJti = generateSecureRandomString(96);
  let codeData: Awaited<ReturnType<typeof codeStore.consumeCodeRpc>>;
  try {
    codeData = await codeStore.consumeCodeRpc({
      code: form.code,
      tenantId,
      clientId: form.client_id,
      codeVerifier: form.code_verifier,
      expectedAuthorizationServer: 'admin_agent',
      expectedSubjectType: 'admin_user',
      expectedResource: resource,
      expectedRedirectUri: form.redirect_uri,
      enforceDpopBinding: true,
      expectedDpopJkt: dpopJkt,
      accessTokenJti,
    });
  } catch {
    return errorResponse(c, 'invalid_grant', 'Authorization code is invalid or expired');
  }
  if (codeData.replayAttack) {
    const { accessTokenJti, refreshTokenJti } = codeData.replayAttack;
    if (accessTokenJti) {
      try {
        await revokeToken(
          c.env,
          accessTokenJti,
          agentSettings.maxTokenTtlSeconds,
          'Admin Agent authorization code replay',
          tenantId
        );
      } catch {
        // The replay is rejected even if the revocation service is temporarily unavailable.
      }
    }
    if (refreshTokenJti) {
      try {
        const { stub } = getRefreshTokenRotatorStubByJti(
          c.env,
          form.client_id,
          refreshTokenJti,
          tenantId
        );
        await stub.revokeByJtiRpc(refreshTokenJti, 'Admin Agent authorization code replay');
      } catch {
        // The replay is rejected even if the revocation service is temporarily unavailable.
      }
    }
    return errorResponse(c, 'invalid_grant', 'Authorization code replay detected');
  }
  if (
    codeData.redirectUri !== form.redirect_uri ||
    (codeData.dpopJkt !== undefined && codeData.dpopJkt !== dpopJkt) ||
    !codeData.userId.startsWith('admin_user:') ||
    !codeData.agentGrantId ||
    codeData.agentGrantGeneration === undefined ||
    codeData.agentConsentVersion === undefined
  ) {
    return errorResponse(c, 'invalid_grant', 'Authorization code binding is invalid');
  }
  const delegatorId = codeData.userId.slice('admin_user:'.length);
  const repository = new AdminAgentAccessRepository(
    requireDedicatedAdminDatabaseAdapter(c.env, 'admin-agent-token')
  );
  const grant = await repository.getGrant(tenantId, codeData.agentGrantId);
  const currentPermissions = await repository.getActiveDelegatorPermissions(
    tenantId,
    delegatorId,
    Date.now()
  );
  const currentConsent = await repository.hasCurrentConsent(
    tenantId,
    codeData.agentGrantId,
    delegatorId,
    form.client_id,
    codeData.agentConsentVersion
  );
  const registeredScopes = new Set(client.requestable_scopes ?? []);
  const requestedScopes = codeData.scope.split(/\s+/u).filter(Boolean);
  const principalPermissionLimit = await modeALinkedPrincipalPermissionLimit(
    c.env,
    tenantId,
    grant?.machinePrincipalId
  );
  if (
    !grant ||
    grant.status !== 'active' ||
    grant.clientId !== form.client_id ||
    grant.delegatorId !== delegatorId ||
    grant.generation !== codeData.agentGrantGeneration ||
    grant.consentVersion !== codeData.agentConsentVersion ||
    (grant.expiresAt !== undefined && grant.expiresAt <= Date.now()) ||
    !currentPermissions ||
    grant.permissions.some((permission) => !hasAdminPermission(currentPermissions, permission)) ||
    !linkedPrincipalCoversGrant(principalPermissionLimit, grant.permissions) ||
    !currentConsent ||
    requestedScopes.some(
      (scope) =>
        !grant.scopes.includes(scope as (typeof grant.scopes)[number]) ||
        !registeredScopes.has(scope)
    )
  ) {
    return errorResponse(c, 'invalid_grant', 'Agent Grant is no longer valid');
  }

  let authorizationDetails: JsonObject[] | undefined;
  try {
    authorizationDetails = parseAdminAgentAuthorizationDetails(codeData.authorizationDetails);
  } catch {
    return errorResponse(c, 'invalid_grant', 'authorization_details is invalid');
  }

  const assurance = publicClient ? 'public_client_transaction' : 'confidential_client';
  const claims = {
    iss: issuer,
    sub: codeData.userId,
    aud: resource,
    scope: codeData.scope,
    client_id: form.client_id,
    azp: form.client_id,
    tenant_id: tenantId,
    grant_id: grant.grantId,
    grant_generation: grant.generation,
    consent_version: grant.consentVersion,
    ...(authorizationDetails ? { authorization_details: authorizationDetails } : {}),
    actor_mode: 'mode_a',
    actor_assurance: assurance,
    token_binding: dpopJkt ? 'dpop' : 'bearer',
    act: { sub: `client:${form.client_id}` },
    ...(dpopJkt ? { cnf: { jkt: dpopJkt } } : {}),
  } satisfies Omit<AccessTokenClaims, 'iat' | 'exp' | 'jti'>;
  const key = await signingKey(c.env, tenantId);
  const access = await createAccessToken(
    claims,
    key.privateKey,
    key.kid,
    agentSettings.maxTokenTtlSeconds,
    accessTokenJti
  );
  const refresh = await issueInitialRefreshToken({
    c,
    repository,
    codeStore,
    code: form.code,
    accessTokenJti: access.jti,
    tenantId,
    issuer,
    resource,
    clientId: form.client_id,
    delegatorId,
    grantId: grant.grantId,
    grantGeneration: grant.generation,
    consentVersion: grant.consentVersion,
    scope: codeData.scope,
    authorizationDetails,
    publicClient,
    dpopJkt,
    privateKey: key.privateKey,
    kid: key.kid,
  });
  if (!refresh) {
    return errorResponse(c, 'temporarily_unavailable', 'Refresh token initialization failed', 503);
  }
  await repository.writeAudit({
    id: `audit_${crypto.randomUUID()}`,
    tenantId,
    adminUserId: delegatorId,
    action: 'agent.token.issued',
    resourceType: 'admin_agent_grant',
    resourceId: grant.grantId,
    severity: 'info',
    requestId: c.req.header('x-request-id'),
    actorType: 'agent',
    actorSub: `client:${form.client_id}`,
    actorMode: 'mode_a',
    actorAssurance: assurance,
    tokenBinding: dpopJkt ? 'dpop' : 'bearer',
    actClientId: form.client_id,
    actPrincipalId: grant.machinePrincipalId,
    grantId: grant.grantId,
    metadata: {
      grant_generation: grant.generation,
      consent_version: grant.consentVersion,
      access_token_jti: access.jti,
    },
    createdAt: Date.now(),
  });
  await touchSelfServiceClient(c, tenantId, client);

  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  return c.json({
    access_token: access.token,
    refresh_token: refresh.token,
    token_type: dpopJkt ? 'DPoP' : 'Bearer',
    expires_in: agentSettings.maxTokenTtlSeconds,
    scope: codeData.scope,
    ...(authorizationDetails ? { authorization_details: authorizationDetails } : {}),
  });
}
