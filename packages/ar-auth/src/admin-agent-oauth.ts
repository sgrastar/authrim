import type { Context } from 'hono';
import {
  AdminAgentAccessRepository,
  evaluateAgentMcpFeatureFlag,
  type AgentGrantContract,
  type AgentScope,
} from '@authrim/ar-agent-access/core';
import type { Env, ClientMetadata, PARRequestData, AdminAuthContext } from '@authrim/ar-lib-core';
import {
  authenticateConfidentialOAuthClient,
  buildDOInstanceName,
  generateSecureRandomString,
  getClientCached,
  getPARRequestStoreByUri,
  getPARRequestStoreForNewRequest,
  getTenantIdFromContext,
  hasAdminPermission,
  isRedirectUriRegistered,
  parseOAuthClientAuthenticationParams,
  requireDedicatedAdminDatabaseAdapter,
  validateClientId,
  validateRedirectUri,
} from '@authrim/ar-lib-core';
import { getRequestIssuer } from './issuer';

const ADMIN_AGENT_SCOPES = new Set(['agent:read', 'agent:write', 'agent:execute', 'agent:admin']);
const ADMIN_AGENT_PAR_TTL_SECONDS = 60;
const ADMIN_AGENT_CODE_PREFIX = 'aac_';

type AgentAuthEnv = Env & { ENABLE_AGENT_MCP?: string };

interface AdminAgentParParameters {
  clientId: string;
  redirectUri: string;
  scope: string;
  scopes: string[];
  resource: string;
  state?: string;
  codeChallenge: string;
  authorizationDetails?: string;
}

function oauthError(
  c: Context<{ Bindings: Env }>,
  error: string,
  errorDescription: string,
  status = 400
): Response {
  return c.json({ error, error_description: errorDescription }, status as 400);
}

async function isAgentAccessEnabled(c: Context<{ Bindings: Env }>): Promise<boolean | null> {
  const env = c.env as AgentAuthEnv;
  const tenantId = getTenantIdFromContext(c);
  const settings = env.SETTINGS ?? env.AUTHRIM_CONFIG;
  if (!settings) {
    return evaluateAgentMcpFeatureFlag({
      configurationAvailable: true,
      environmentValue: env.ENABLE_AGENT_MCP,
    }).enabled;
  }
  try {
    const value = await settings.get(`settings:tenant:${tenantId}:agent-access`);
    const parsed: unknown = value ? JSON.parse(value) : undefined;
    const tenantValue =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)['agent.mcp.enabled']
        : parsed;
    return evaluateAgentMcpFeatureFlag({
      configurationAvailable: true,
      tenantValue,
      environmentValue: env.ENABLE_AGENT_MCP,
    }).enabled;
  } catch {
    return null;
  }
}

function adminActor(c: Context<{ Bindings: Env }>): AdminAuthContext | null {
  return (
    (c as unknown as { get(key: 'adminAuth'): AdminAuthContext | undefined }).get('adminAuth') ??
    null
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

function grantAllowsRequest(
  grant: AgentGrantContract,
  par: PARRequestData,
  actor: AdminAuthContext,
  client: ClientMetadata,
  now: number
): boolean {
  if (grant.status !== 'active' || (grant.expiresAt !== undefined && grant.expiresAt <= now)) {
    return false;
  }
  if (
    grant.tenantId !== par.tenant_id ||
    grant.clientId !== par.client_id ||
    grant.delegatorId !== actor.userId ||
    grant.permissions.some((permission) => !hasAdminPermission(actor.permissions ?? [], permission))
  ) {
    return false;
  }
  const allowedGrantScopes = new Set<AgentScope>(grant.scopes);
  const registeredClientScopes = new Set(client.requestable_scopes ?? []);
  return par.scope
    .split(/\s+/u)
    .filter(Boolean)
    .every(
      (scope) => allowedGrantScopes.has(scope as AgentScope) && registeredClientScopes.has(scope)
    );
}

interface AdminAgentAuthorizationContext {
  actor: AdminAuthContext;
  tenantId: string;
  baseIssuer: string;
  canonicalResource: string;
  requestUri: string;
  client: ClientMetadata;
  par: PARRequestData;
  grant: AgentGrantContract;
  repository: AdminAgentAccessRepository;
  parStore: ReturnType<typeof getPARRequestStoreByUri>['stub'];
}

async function resolveAdminAgentAuthorizationContext(
  c: Context<{ Bindings: Env }>,
  requestUri: string,
  clientId: string
): Promise<AdminAgentAuthorizationContext | Response> {
  const actor = adminActor(c);
  if (!actor || actor.authMethod !== 'session') {
    return oauthError(c, 'access_denied', 'A human admin session is required', 401);
  }
  const tenantId = getTenantIdFromContext(c);
  const baseIssuer = getRequestIssuer(c).replace(/\/$/u, '');
  const canonicalResource = `${baseIssuer}/mcp`;
  let parStore: ReturnType<typeof getPARRequestStoreByUri>['stub'];
  let par: PARRequestData | null;
  try {
    parStore = getPARRequestStoreByUri(c.env, requestUri, tenantId).stub;
    par = await parStore.getRequestRpc(requestUri);
  } catch {
    return oauthError(c, 'invalid_request_uri', 'Invalid or expired request_uri');
  }
  if (
    !par ||
    par.consumed ||
    par.authorization_server !== 'admin_agent' ||
    par.tenant_id !== tenantId ||
    par.client_id !== clientId ||
    par.resource !== canonicalResource
  ) {
    return oauthError(c, 'invalid_request_uri', 'Invalid or expired request_uri');
  }
  const client = (await getClientCached(c, c.env, clientId)) as ClientMetadata | null;
  if (
    !client ||
    !isRedirectUriRegistered(par.redirect_uri, client.redirect_uris) ||
    !(client.requestable_scopes ?? []).length
  ) {
    return oauthError(c, 'unauthorized_client', 'Client is not authorized for Agent access');
  }
  const repository = new AdminAgentAccessRepository(
    requireDedicatedAdminDatabaseAdapter(c.env, 'admin-agent-authorization')
  );
  const grant = await repository.findActiveGrantForDelegatorClient(
    tenantId,
    actor.userId,
    clientId
  );
  if (!grant || !grantAllowsRequest(grant, par, actor, client, Date.now())) {
    return oauthError(c, 'access_denied', 'No active Agent Grant allows this request', 403);
  }
  return {
    actor,
    tenantId,
    baseIssuer,
    canonicalResource,
    requestUri,
    client,
    par,
    grant,
    repository,
    parStore,
  };
}

function parseAdminAgentParParameters(
  form: Record<string, string | File>,
  canonicalResource: string
): AdminAgentParParameters | { error: string; description: string } {
  const allowedParameters = new Set([
    'client_id',
    'client_secret',
    'client_assertion',
    'client_assertion_type',
    'response_type',
    'redirect_uri',
    'scope',
    'resource',
    'state',
    'code_challenge',
    'code_challenge_method',
    'authorization_details',
  ]);
  if (Object.keys(form).some((key) => !allowedParameters.has(key))) {
    return { error: 'invalid_request', description: 'Unsupported PAR parameter' };
  }
  const clientId = typeof form.client_id === 'string' ? form.client_id : '';
  const redirectUri = typeof form.redirect_uri === 'string' ? form.redirect_uri : '';
  const scope = typeof form.scope === 'string' ? form.scope : '';
  const resource = typeof form.resource === 'string' ? form.resource : '';
  const responseType = typeof form.response_type === 'string' ? form.response_type : '';
  const codeChallenge = typeof form.code_challenge === 'string' ? form.code_challenge : '';
  const codeChallengeMethod =
    typeof form.code_challenge_method === 'string' ? form.code_challenge_method : '';
  let authorizationDetails: string | undefined;

  if (typeof form.authorization_details === 'string') {
    try {
      const details: unknown = JSON.parse(form.authorization_details);
      if (
        !Array.isArray(details) ||
        details.length === 0 ||
        details.some((detail) => {
          if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return true;
          const record = detail as Record<string, unknown>;
          if (record.type !== 'authrim_admin_agent') return true;
          if (Object.keys(record).some((key) => !['type', 'max_subjects_per_call'].includes(key))) {
            return true;
          }
          return (
            record.max_subjects_per_call !== undefined &&
            (!Number.isInteger(record.max_subjects_per_call) ||
              (record.max_subjects_per_call as number) < 1 ||
              (record.max_subjects_per_call as number) > 50)
          );
        })
      ) {
        return {
          error: 'invalid_authorization_details',
          description: 'authorization_details is outside the Admin Agent contract',
        };
      }
      authorizationDetails = JSON.stringify(details);
    } catch {
      return {
        error: 'invalid_authorization_details',
        description: 'authorization_details must be valid JSON',
      };
    }
  }

  if (!clientId || !redirectUri || !scope || !resource || !responseType || !codeChallenge) {
    return { error: 'invalid_request', description: 'Required PAR parameter is missing' };
  }
  if (responseType !== 'code') {
    return {
      error: 'unsupported_response_type',
      description: 'Only response_type=code is supported',
    };
  }
  if (resource !== canonicalResource) {
    return { error: 'invalid_target', description: 'resource must identify this MCP endpoint' };
  }
  if (
    codeChallengeMethod !== 'S256' ||
    codeChallenge.length < 43 ||
    codeChallenge.length > 128 ||
    !/^[A-Za-z0-9_-]+$/u.test(codeChallenge)
  ) {
    return {
      error: 'invalid_request',
      description: 'PKCE with a valid S256 challenge is required',
    };
  }
  const scopes = scope.split(/\s+/u).filter(Boolean);
  if (scopes.length === 0 || scopes.some((item) => !ADMIN_AGENT_SCOPES.has(item))) {
    return { error: 'invalid_scope', description: 'Only registered agent:* scopes are supported' };
  }
  return {
    clientId,
    redirectUri,
    scope: scopes.join(' '),
    scopes,
    resource,
    state: typeof form.state === 'string' ? form.state : undefined,
    codeChallenge,
    authorizationDetails,
  };
}

async function convertDirectAuthorizationRequestToPar(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  const requestUrl = new URL(c.req.url);
  const baseIssuer = getRequestIssuer(c).replace(/\/$/u, '');
  const canonicalResource = `${baseIssuer}/mcp`;
  const allowedParameters = new Set([
    'client_id',
    'response_type',
    'redirect_uri',
    'scope',
    'resource',
    'state',
    'code_challenge',
    'code_challenge_method',
    'authorization_details',
  ]);
  const form: Record<string, string> = {};
  for (const key of new Set(requestUrl.searchParams.keys())) {
    if (!allowedParameters.has(key)) {
      return oauthError(c, 'invalid_request', 'Unsupported authorization parameter');
    }
    const values = requestUrl.searchParams.getAll(key);
    if (key === 'resource') {
      if (values.length > 10 || values.some((value) => value !== canonicalResource)) {
        return oauthError(c, 'invalid_target', 'resource must identify this MCP server');
      }
      form.resource = canonicalResource;
      continue;
    }
    if (values.length !== 1) {
      return oauthError(c, 'invalid_request', `Duplicate ${key} parameter`);
    }
    form[key] = values[0]!;
  }

  const parsed = parseAdminAgentParParameters(form, canonicalResource);
  if ('error' in parsed) return oauthError(c, parsed.error, parsed.description);
  const clientIdValidation = validateClientId(parsed.clientId);
  if (!clientIdValidation.valid) {
    return oauthError(c, 'invalid_request', 'Invalid client_id');
  }
  const client = (await getClientCached(c, c.env, parsed.clientId)) as ClientMetadata | null;
  if (!client) return oauthError(c, 'unauthorized_client', 'Client is not registered');
  const redirectValidation = validateRedirectUri(parsed.redirectUri, true);
  if (
    !redirectValidation.valid ||
    !isRedirectUriRegistered(parsed.redirectUri, client.redirect_uris)
  ) {
    return oauthError(c, 'invalid_request', 'redirect_uri is not registered for this client');
  }
  const requestableScopes = new Set(client.requestable_scopes ?? []);
  if (
    requestableScopes.size === 0 ||
    parsed.scopes.some((scope) => !requestableScopes.has(scope))
  ) {
    return oauthError(c, 'invalid_scope', 'Client is not registered for the requested scope');
  }
  if (!c.env.PAR_REQUEST_STORE) {
    return oauthError(c, 'server_error', 'PAR request storage unavailable', 500);
  }

  const tenantId = getTenantIdFromContext(c);
  const { stub, requestUri } = await getPARRequestStoreForNewRequest(
    c.env,
    tenantId,
    parsed.clientId,
    crypto.randomUUID()
  );
  await stub.storeRequestRpc({
    requestUri,
    ttl: ADMIN_AGENT_PAR_TTL_SECONDS,
    data: {
      authorization_server: 'admin_agent',
      tenant_id: tenantId,
      client_id: parsed.clientId,
      redirect_uri: parsed.redirectUri,
      response_type: 'code',
      scope: parsed.scope,
      state: parsed.state,
      code_challenge: parsed.codeChallenge,
      code_challenge_method: 'S256',
      resource: parsed.resource,
      authorization_details: parsed.authorizationDetails,
    },
  });
  const target = new URL('/oauth/admin-agent/authorize', baseIssuer);
  target.searchParams.set('request_uri', requestUri);
  target.searchParams.set('client_id', parsed.clientId);
  c.header('Cache-Control', 'no-store');
  return c.redirect(target.toString(), 302);
}

/** RFC 9126 endpoint for the dedicated Admin Agent authorization journey. */
export async function adminAgentParHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  const enabled = await isAgentAccessEnabled(c);
  if (enabled === null) {
    return oauthError(c, 'temporarily_unavailable', 'Agent access configuration unavailable', 503);
  }
  if (!enabled) return c.json({ error: 'not_found' }, 404);
  if (!c.req.header('content-type')?.includes('application/x-www-form-urlencoded')) {
    return oauthError(
      c,
      'invalid_request',
      'Content-Type must be application/x-www-form-urlencoded'
    );
  }

  const form = await c.req.parseBody();
  const baseIssuer = getRequestIssuer(c).replace(/\/$/u, '');
  const parsed = parseAdminAgentParParameters(form, `${baseIssuer}/mcp`);
  if ('error' in parsed) return oauthError(c, parsed.error, parsed.description);

  const clientIdValidation = validateClientId(parsed.clientId);
  if (!clientIdValidation.valid) {
    return oauthError(c, 'invalid_client', 'Client authentication failed', 401);
  }
  const client = (await getClientCached(c, c.env, parsed.clientId)) as ClientMetadata | null;
  if (!client) return oauthError(c, 'invalid_client', 'Client authentication failed', 401);

  const credentials = parseOAuthClientAuthenticationParams({
    clientId: parsed.clientId,
    clientSecret: typeof form.client_secret === 'string' ? form.client_secret : undefined,
    clientAssertion: typeof form.client_assertion === 'string' ? form.client_assertion : undefined,
    clientAssertionType:
      typeof form.client_assertion_type === 'string' ? form.client_assertion_type : undefined,
    authorizationHeader: c.req.header('authorization'),
  });
  if (!credentials.ok) {
    return oauthError(c, credentials.error, credentials.errorDescription, 401);
  }
  // A private_key_jwt client normally has no secret hash; absence of a secret is therefore not
  // evidence that a client is public. Only an explicit `none` registration is public.
  const publicClient = (client.token_endpoint_auth_method as string | undefined) === 'none';
  if (!publicClient) {
    const authenticated = await authenticateConfidentialOAuthClient(
      client,
      `${baseIssuer}/oauth/admin-agent/par`,
      credentials.credentials
    );
    if (!authenticated.ok) {
      return oauthError(c, authenticated.error, authenticated.errorDescription, 401);
    }
  }

  const redirectValidation = validateRedirectUri(parsed.redirectUri, true);
  if (
    !redirectValidation.valid ||
    !isRedirectUriRegistered(parsed.redirectUri, client.redirect_uris)
  ) {
    return oauthError(c, 'invalid_request', 'redirect_uri is not registered for this client');
  }
  const requestableScopes = new Set(client.requestable_scopes ?? []);
  if (
    requestableScopes.size === 0 ||
    parsed.scopes.some((scope) => !requestableScopes.has(scope))
  ) {
    return oauthError(c, 'invalid_scope', 'Client is not registered for the requested scope');
  }
  if (!c.env.PAR_REQUEST_STORE) {
    return oauthError(c, 'server_error', 'PAR request storage unavailable', 500);
  }

  const tenantId = getTenantIdFromContext(c);
  const { stub, requestUri } = await getPARRequestStoreForNewRequest(
    c.env,
    tenantId,
    parsed.clientId,
    crypto.randomUUID()
  );
  await stub.storeRequestRpc({
    requestUri,
    ttl: ADMIN_AGENT_PAR_TTL_SECONDS,
    data: {
      authorization_server: 'admin_agent',
      tenant_id: tenantId,
      client_id: parsed.clientId,
      redirect_uri: parsed.redirectUri,
      response_type: 'code',
      scope: parsed.scope,
      state: parsed.state,
      code_challenge: parsed.codeChallenge,
      code_challenge_method: 'S256',
      resource: parsed.resource,
      authorization_details: parsed.authorizationDetails,
    },
  });
  c.header('Cache-Control', 'no-store');
  return c.json({ request_uri: requestUri, expires_in: ADMIN_AGENT_PAR_TTL_SECONDS }, 201);
}

function authorizationRedirect(
  context: AdminAgentAuthorizationContext,
  params: Record<string, string>
): string {
  const target = new URL(context.par.redirect_uri);
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
  if (context.par.state) target.searchParams.set('state', context.par.state);
  return target.toString();
}

/** Browser authorization/consent endpoint for the dedicated Admin Agent issuer. */
export async function adminAgentAuthorizeHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  const enabled = await isAgentAccessEnabled(c);
  if (enabled === null) {
    return oauthError(c, 'temporarily_unavailable', 'Agent access configuration unavailable', 503);
  }
  if (!enabled) return c.json({ error: 'not_found' }, 404);

  if (c.req.method === 'GET' && !c.req.query('request_uri')) {
    return convertDirectAuthorizationRequestToPar(c);
  }
  const input =
    c.req.method === 'POST'
      ? await c.req.parseBody()
      : ({
          request_uri: c.req.query('request_uri'),
          client_id: c.req.query('client_id'),
        } as Record<string, string | File | undefined>);
  const requestUri = typeof input.request_uri === 'string' ? input.request_uri : '';
  const clientId = typeof input.client_id === 'string' ? input.client_id : '';
  if (!requestUri || !clientId) {
    return oauthError(c, 'invalid_request', 'request_uri and client_id are required');
  }

  const resolved = await resolveAdminAgentAuthorizationContext(c, requestUri, clientId);
  if (resolved instanceof Response) return resolved;

  if (c.req.method === 'GET') {
    c.header('Cache-Control', 'no-store');
    const clientName = resolved.client.client_name ?? resolved.client.client_id;
    return c.html(`<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authrim Agent access consent</title></head>
<body><main><h1>Agentアクセスの確認</h1><p>${escapeHtml(clientName)} に、管理操作を委任します。</p>
<dl><dt>テナント</dt><dd>${escapeHtml(resolved.tenantId)}</dd><dt>スコープ</dt><dd>${escapeHtml(resolved.par.scope)}</dd><dt>Grant</dt><dd>${escapeHtml(resolved.grant.grantId)}</dd></dl>
<h2>委任する管理権限</h2><ul>${resolved.grant.permissions.map((permission) => `<li>${escapeHtml(permission)}</li>`).join('')}</ul>
<form method="post" action="/oauth/admin-agent/authorize">
<input type="hidden" name="request_uri" value="${escapeHtml(requestUri)}"><input type="hidden" name="client_id" value="${escapeHtml(clientId)}">
<button type="submit" name="decision" value="approve">許可</button><button type="submit" name="decision" value="deny">拒否</button>
</form></main></body></html>`);
  }

  const decision = typeof input.decision === 'string' ? input.decision : '';
  if (decision !== 'approve' && decision !== 'deny') {
    return oauthError(c, 'invalid_request', 'A valid consent decision is required');
  }
  let consumed: PARRequestData;
  try {
    consumed = await resolved.parStore.consumeRequestRpc({
      requestUri,
      tenant_id: resolved.tenantId,
      client_id: clientId,
      expected_authorization_server: 'admin_agent',
      expected_resource: resolved.canonicalResource,
    });
  } catch {
    return oauthError(c, 'invalid_request_uri', 'Invalid or expired request_uri');
  }
  if (decision === 'deny') {
    return c.redirect(
      authorizationRedirect(resolved, {
        error: 'access_denied',
        iss: `${resolved.baseIssuer}/oauth/admin-agent`,
      }),
      302
    );
  }

  const now = Date.now();
  const consentBase = {
    tenantId: resolved.tenantId,
    grantId: resolved.grant.grantId,
    userId: resolved.actor.userId,
    clientId,
    consentVersion: resolved.grant.consentVersion,
    scopes: resolved.grant.scopes,
    grantedAt: now,
  };
  await resolved.repository.grantConsentPair({
    delegation: { ...consentBase, id: `agc_${crypto.randomUUID()}`, type: 'delegation' },
    oauthClient: { ...consentBase, id: `agc_${crypto.randomUUID()}`, type: 'oauth_client' },
    audit: {
      id: `audit_${crypto.randomUUID()}`,
      tenantId: resolved.tenantId,
      adminUserId: resolved.actor.userId,
      action: 'agent.consent.granted',
      resourceType: 'admin_agent_grant',
      resourceId: resolved.grant.grantId,
      severity: 'info',
      requestId: c.req.header('x-request-id'),
      actorType: 'admin_user',
      actorSub: `admin_user:${resolved.actor.userId}`,
      grantId: resolved.grant.grantId,
      metadata: {
        grant_id: resolved.grant.grantId,
        client_id: clientId,
        consent_version: resolved.grant.consentVersion,
      },
      createdAt: now,
    },
  });

  const code = `${ADMIN_AGENT_CODE_PREFIX}${generateSecureRandomString(48)}`;
  const codeStoreId = c.env.AUTH_CODE_STORE.idFromName(
    buildDOInstanceName('admin-agent-auth-code', resolved.tenantId)
  );
  const codeStore = c.env.AUTH_CODE_STORE.get(codeStoreId);
  try {
    await codeStore.storeCodeRpc({
      code,
      tenantId: resolved.tenantId,
      clientId,
      redirectUri: consumed.redirect_uri,
      userId: `admin_user:${resolved.actor.userId}`,
      scope: consumed.scope,
      codeChallenge: consumed.code_challenge,
      codeChallengeMethod: 'S256',
      state: consumed.state,
      authorizationDetails: consumed.authorization_details,
      authorizationServer: 'admin_agent',
      subjectType: 'admin_user',
      resource: resolved.canonicalResource,
      agentGrantId: resolved.grant.grantId,
      agentGrantGeneration: resolved.grant.generation,
      agentConsentVersion: resolved.grant.consentVersion,
    });
  } catch {
    return oauthError(c, 'server_error', 'Failed to issue authorization code', 500);
  }
  return c.redirect(
    authorizationRedirect(resolved, {
      code,
      iss: `${resolved.baseIssuer}/oauth/admin-agent`,
    }),
    302
  );
}
