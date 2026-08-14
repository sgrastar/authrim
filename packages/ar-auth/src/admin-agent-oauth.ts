import type { Context } from 'hono';
import {
  AdminAgentAccessRepository,
  evaluateAgentMcpFeatureFlag,
  normalizeSelfServiceAgentAuthorizationDetails,
  normalizeSelfServiceAgentScopes,
  resolveSelfServiceAgentAccessSnapshot,
  isSelfServiceClientMetadataDocumentId,
  canonicalizeJson,
  sha256Base64Url,
  SELF_SERVICE_AGENT_SCOPES,
  SELF_SERVICE_GRANT_TTL_MS,
  selfServiceRevocationOutboxId,
  type AgentGrantContract,
  type AgentScope,
  type JsonValue,
} from '@authrim/ar-agent-access/core';
import { createAdminToolCatalog } from '@authrim/ar-agent-access/protocol/mcp';
import type { Env, ClientMetadata, PARRequestData, AdminAuthContext } from '@authrim/ar-lib-core';
import {
  authenticateConfidentialOAuthClient,
  buildDOInstanceName,
  ClientRepository,
  createAuthContextFromHono,
  generateSecureRandomString,
  getClientCached,
  getPARRequestStoreByUri,
  getPARRequestStoreForNewRequest,
  getTenantIdFromContext,
  hasAdminPermission,
  isRedirectUriRegistered,
  parseOAuthClientAuthenticationParams,
  requireDedicatedAdminDatabaseAdapter,
  safeFetchJson,
  validateClientId,
  validateRegisteredClientAuthenticationMethod,
  validateRedirectUri,
} from '@authrim/ar-lib-core';
import { getRequestIssuer } from './issuer';

const ADMIN_AGENT_SCOPES = new Set([
  'agent:read',
  'agent:user-data:read',
  'agent:write',
  'agent:execute',
  'agent:admin',
]);
const ADMIN_AGENT_PAR_TTL_SECONDS = 60;
const ADMIN_AGENT_CODE_PREFIX = 'aac_';
const ADMIN_AGENT_AUTHORIZATION_DETAILS_MAX_BYTES = 16 * 1024;

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

interface ClientIdMetadataDocument {
  client_id: string;
  client_name?: string;
  client_uri?: string;
  logo_uri?: string;
  redirect_uris: string[];
  token_endpoint_auth_method?: string;
  grant_types?: string[];
  response_types?: string[];
  scope?: string;
  dpop_bound_access_tokens?: boolean;
}

/**
 * Claude Code and some other native MCP hosts publish a portless localhost callback in their
 * Client ID Metadata Document, then bind an ephemeral localhost port for each login. Keep this
 * compatibility rule scoped to CIMD clients: ordinary pre-registered/DCR clients continue to use
 * the shared exact/RFC 8252 IP-literal comparison.
 */
function isCimdPortlessLocalhostRedirectMatch(providedUri: string, registeredUri: string): boolean {
  const registeredAuthority = /^http:\/\/localhost(?:[/?]|$)/iu;
  const providedAuthority = /^http:\/\/localhost:([0-9]{1,5})(?:[/?]|$)/iu;
  const portMatch = providedAuthority.exec(providedUri);
  if (!registeredAuthority.test(registeredUri) || !portMatch) return false;

  const port = Number(portMatch[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return false;

  try {
    const provided = new URL(providedUri);
    const registered = new URL(registeredUri);
    return (
      provided.protocol === 'http:' &&
      registered.protocol === 'http:' &&
      provided.hostname === 'localhost' &&
      registered.hostname === 'localhost' &&
      provided.port === String(port) &&
      registered.port === '' &&
      provided.username === '' &&
      provided.password === '' &&
      registered.username === '' &&
      registered.password === '' &&
      provided.hash === '' &&
      registered.hash === '' &&
      provided.pathname === registered.pathname &&
      provided.search === registered.search
    );
  } catch {
    return false;
  }
}

function isAdminAgentRedirectUriRegistered(providedUri: string, client: ClientMetadata): boolean {
  if (isRedirectUriRegistered(providedUri, client.redirect_uris)) return true;
  if (client.agent_access_registration_mode !== 'cimd') return false;
  return client.redirect_uris.some((registeredUri) =>
    isCimdPortlessLocalhostRedirectMatch(providedUri, registeredUri)
  );
}

function isValidOptionalClientMetadataUri(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' && url.username === '' && url.password === '' && url.hash === ''
    );
  } catch {
    return false;
  }
}

async function fetchClientIdMetadataDocument(
  clientId: string
): Promise<{ metadata: ClientIdMetadataDocument; hash: string } | null> {
  if (!isSelfServiceClientMetadataDocumentId(clientId)) return null;
  let value: unknown;
  try {
    value = await safeFetchJson(clientId, {
      requireHttps: true,
      allowLocalhost: false,
      timeoutMs: 3000,
      maxResponseSize: 64 * 1024,
      redirect: 'error',
    });
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const metadata = value as Partial<ClientIdMetadataDocument>;
  const scopes = [
    ...new Set(
      (metadata.scope ?? SELF_SERVICE_AGENT_SCOPES.join(' ')).split(/\s+/u).filter(Boolean)
    ),
  ];
  if (
    metadata.client_id !== clientId ||
    typeof metadata.client_name !== 'string' ||
    metadata.client_name.trim().length === 0 ||
    metadata.client_name.length > 100 ||
    !isValidOptionalClientMetadataUri(metadata.client_uri) ||
    !isValidOptionalClientMetadataUri(metadata.logo_uri) ||
    !Array.isArray(metadata.redirect_uris) ||
    metadata.redirect_uris.length === 0 ||
    metadata.redirect_uris.length > 10 ||
    metadata.redirect_uris.some(
      (uri) => typeof uri !== 'string' || uri.length > 2048 || !validateRedirectUri(uri, true).valid
    ) ||
    (metadata.token_endpoint_auth_method ?? 'none') !== 'none' ||
    (metadata.grant_types ?? ['authorization_code', 'refresh_token']).some(
      (grant) => grant !== 'authorization_code' && grant !== 'refresh_token'
    ) ||
    (metadata.response_types ?? ['code']).some((responseType) => responseType !== 'code') ||
    scopes.some(
      (scope) =>
        !SELF_SERVICE_AGENT_SCOPES.includes(scope as (typeof SELF_SERVICE_AGENT_SCOPES)[number])
    ) ||
    (scopes.length > 0 && !scopes.includes('agent:read'))
  ) {
    return null;
  }
  const normalized: ClientIdMetadataDocument = {
    client_id: clientId,
    ...(typeof metadata.client_name === 'string' ? { client_name: metadata.client_name } : {}),
    ...(typeof metadata.client_uri === 'string' ? { client_uri: metadata.client_uri } : {}),
    ...(typeof metadata.logo_uri === 'string' ? { logo_uri: metadata.logo_uri } : {}),
    redirect_uris: [...metadata.redirect_uris],
    token_endpoint_auth_method: 'none',
    grant_types: metadata.grant_types ?? ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    scope: scopes.length > 0 ? scopes.join(' ') : SELF_SERVICE_AGENT_SCOPES.join(' '),
    dpop_bound_access_tokens: metadata.dpop_bound_access_tokens === true,
  };
  return {
    metadata: normalized,
    hash: await sha256Base64Url(canonicalizeJson(normalized as unknown as JsonValue)),
  };
}

async function resolveAdminAgentClient(
  c: Context<{ Bindings: Env }>,
  clientId: string,
  canonicalResource: string
): Promise<ClientMetadata | null> {
  const existing = (await getClientCached(c, c.env, clientId)) as ClientMetadata | null;
  if (existing?.agent_access_registration_mode === 'cimd') {
    const document = await fetchClientIdMetadataDocument(clientId);
    if (!document) return null;
    if (document.hash !== existing.client_metadata_hash) {
      const tenantId = getTenantIdFromContext(c);
      const now = Date.now();
      const repository = new AdminAgentAccessRepository(
        requireDedicatedAdminDatabaseAdapter(c.env, 'admin-agent-cimd-change')
      );
      await repository.suspendForClientMetadataChange({
        tenantId,
        clientId,
        oldHash: existing.client_metadata_hash ?? 'missing',
        newHash: document.hash,
        transitionId: `transition_${crypto.randomUUID()}`,
        outboxId: `outbox_${crypto.randomUUID()}`,
        now,
      });
      await createAuthContextFromHono(c, tenantId).coreAdapter.execute(
        `UPDATE oauth_clients SET agent_access_expires_at = 0, client_metadata_hash = ?,
          client_metadata_fetched_at = ?, updated_at = ? WHERE tenant_id = ? AND client_id = ?`,
        [document.hash, now, now, tenantId, clientId]
      );
      return null;
    }
    if (!existing.agent_access_expires_at || existing.agent_access_expires_at <= Date.now()) {
      const tenantId = getTenantIdFromContext(c);
      const now = Date.now();
      const expiresAt = now + 30 * 24 * 60 * 60 * 1000;
      const result = await createAuthContextFromHono(c, tenantId).coreAdapter.execute(
        `UPDATE oauth_clients SET agent_access_expires_at = ?, client_metadata_fetched_at = ?,
          updated_at = ? WHERE tenant_id = ? AND client_id = ?
          AND agent_access_registration_mode = 'cimd' AND client_metadata_hash = ?`,
        [expiresAt, now, now, tenantId, clientId, document.hash]
      );
      if (result.rowsAffected !== 1) return null;
      return {
        ...existing,
        agent_access_expires_at: expiresAt,
        client_metadata_fetched_at: now,
      };
    }
    return existing;
  }
  if (existing) return existing;
  const document = await fetchClientIdMetadataDocument(clientId);
  if (!document) return null;
  const tenantId = getTenantIdFromContext(c);
  const now = Date.now();
  const coreAdapter = createAuthContextFromHono(c, tenantId).coreAdapter;
  const repository = new ClientRepository(coreAdapter, tenantId);
  try {
    await repository.create({
      client_id: clientId,
      client_name: document.metadata.client_name ?? new URL(clientId).hostname,
      tenant_id: tenantId,
      redirect_uris: document.metadata.redirect_uris,
      grant_types: document.metadata.grant_types,
      response_types: ['code'],
      scope: document.metadata.scope,
      requestable_scopes: document.metadata.scope?.split(/\s+/u).filter(Boolean),
      token_endpoint_auth_method: 'none',
      require_pkce: true,
      application_type: 'native',
      client_uri: document.metadata.client_uri,
      logo_uri: document.metadata.logo_uri,
      default_resource: canonicalResource,
      is_trusted: false,
      skip_consent: false,
    });
    await coreAdapter.execute(
      `UPDATE oauth_clients SET agent_access_registration_mode = 'cimd',
        agent_access_expires_at = ?, client_metadata_url = ?, client_metadata_hash = ?,
        client_metadata_fetched_at = ? WHERE tenant_id = ? AND client_id = ?`,
      [now + 30 * 24 * 60 * 60 * 1000, clientId, document.hash, now, tenantId, clientId]
    );
  } catch {
    return null;
  }
  return {
    client_id: clientId,
    client_name: document.metadata.client_name,
    client_uri: document.metadata.client_uri,
    logo_uri: document.metadata.logo_uri,
    redirect_uris: document.metadata.redirect_uris,
    grant_types: document.metadata.grant_types,
    response_types: ['code'],
    scope: document.metadata.scope,
    requestable_scopes: document.metadata.scope?.split(/\s+/u).filter(Boolean),
    token_endpoint_auth_method: 'none',
    require_pkce: true,
    application_type: 'native',
    default_resource: canonicalResource,
    tenant_id: tenantId,
    created_at: now,
    updated_at: now,
    agent_access_registration_mode: 'cimd',
    agent_access_expires_at: now + 30 * 24 * 60 * 60 * 1000,
    client_metadata_url: clientId,
    client_metadata_hash: document.hash,
    client_metadata_fetched_at: now,
    dpop_bound_access_tokens: document.metadata.dpop_bound_access_tokens,
  } as ClientMetadata;
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
  grant?: AgentGrantContract;
  grantPurpose?: string;
  grantTaskSetCatalogVersion?: string;
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
  const client = await resolveAdminAgentClient(c, clientId, canonicalResource);
  if (
    !client ||
    (client.agent_access_registration_mode !== undefined &&
      (!client.agent_access_expires_at || client.agent_access_expires_at <= Date.now())) ||
    !isAdminAgentRedirectUriRegistered(par.redirect_uri, client) ||
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
  const grantRecord = grant ? await repository.getGrantRecord(tenantId, grant.grantId) : null;
  const grantTaskSetCatalogVersion =
    grant &&
    grantRecord?.purpose === 'interactive_self_service' &&
    grant.taskSetId &&
    grant.taskSetVersion
      ? await repository.getSystemManagedTaskSetCatalogVersion(
          tenantId,
          grant.taskSetId,
          grant.taskSetVersion
        )
      : undefined;
  if (
    grant &&
    grantRecord?.purpose !== 'interactive_self_service' &&
    !grantAllowsRequest(grant, par, actor, client, Date.now())
  ) {
    return oauthError(c, 'access_denied', 'No active Agent Grant allows this request', 403);
  }
  if (
    !grant &&
    par.scope
      .split(/\s+/u)
      .filter(Boolean)
      .some(
        (scope) =>
          !SELF_SERVICE_AGENT_SCOPES.includes(scope as (typeof SELF_SERVICE_AGENT_SCOPES)[number])
      )
  ) {
    return oauthError(c, 'invalid_scope', 'Advanced Agent scopes require a managed Grant', 403);
  }
  return {
    actor,
    tenantId,
    baseIssuer,
    canonicalResource,
    requestUri,
    client,
    par,
    grant: grant
      ? {
          ...grant,
          ...(grantRecord?.authorizationDetails
            ? { authorizationDetails: grantRecord.authorizationDetails }
            : {}),
        }
      : undefined,
    grantPurpose: grantRecord?.purpose,
    grantTaskSetCatalogVersion: grantTaskSetCatalogVersion ?? undefined,
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
      if (
        new TextEncoder().encode(form.authorization_details).byteLength >
        ADMIN_AGENT_AUTHORIZATION_DETAILS_MAX_BYTES
      ) {
        throw new TypeError('authorization_details is too large');
      }
      const details: unknown = JSON.parse(form.authorization_details);
      const normalized = normalizeSelfServiceAgentAuthorizationDetails(details);
      authorizationDetails = JSON.stringify(normalized.authorizationDetails);
    } catch {
      return {
        error: 'invalid_authorization_details',
        description: 'authorization_details is outside the Admin Agent contract',
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
  if (!clientIdValidation.valid && !isSelfServiceClientMetadataDocumentId(parsed.clientId)) {
    return oauthError(c, 'invalid_request', 'Invalid client_id');
  }
  const client = await resolveAdminAgentClient(c, parsed.clientId, canonicalResource);
  if (!client) return oauthError(c, 'unauthorized_client', 'Client is not registered');
  const redirectValidation = validateRedirectUri(parsed.redirectUri, true);
  if (!redirectValidation.valid || !isAdminAgentRedirectUriRegistered(parsed.redirectUri, client)) {
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
  if (!clientIdValidation.valid && !isSelfServiceClientMetadataDocumentId(parsed.clientId)) {
    return oauthError(c, 'invalid_client', 'Client authentication failed', 401);
  }
  const client = await resolveAdminAgentClient(c, parsed.clientId, `${baseIssuer}/mcp`);
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
  if (publicClient) {
    const methodValidation = validateRegisteredClientAuthenticationMethod(
      client,
      credentials.credentials.presentation
    );
    if (!methodValidation.valid) {
      return oauthError(c, 'invalid_client', 'Client authentication failed', 401);
    }
  } else {
    const authenticated = await authenticateConfidentialOAuthClient(
      client,
      `${baseIssuer}/oauth/admin-agent/par`,
      credentials.credentials,
      { replayProtection: { env: c.env, tenantId: getTenantIdFromContext(c) } }
    );
    if (!authenticated.ok) {
      return oauthError(c, authenticated.error, authenticated.errorDescription, 401);
    }
  }

  const redirectValidation = validateRedirectUri(parsed.redirectUri, true);
  if (!redirectValidation.valid || !isAdminAgentRedirectUriRegistered(parsed.redirectUri, client)) {
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

type AdminAgentConsentLocale = 'en' | 'ja';

interface AdminAgentConsentCopy {
  htmlLang: AdminAgentConsentLocale;
  pageTitle: string;
  secureConnection: string;
  heading: string;
  introduction: (clientName: string) => string;
  tenant: string;
  connection: string;
  interactiveConnection: string;
  expires: string;
  expiryValue: string;
  maximum: string;
  maximumValue: (maximum: number) => string;
  chooseScopes: string;
  scopeGuidance: string;
  required: string;
  optional: string;
  advancedScope: string;
  notice: string;
  approve: string;
  deny: string;
  scopes: Record<
    (typeof SELF_SERVICE_AGENT_SCOPES)[number],
    { title: string; description: string; optional: boolean }
  >;
}

const ADMIN_AGENT_CONSENT_COPY: Record<AdminAgentConsentLocale, AdminAgentConsentCopy> = {
  en: {
    htmlLang: 'en',
    pageTitle: 'Review Agent Access | Authrim',
    secureConnection: 'Secure agent connection',
    heading: 'Review Agent Access',
    introduction: (clientName) =>
      `${clientName} is requesting permission to perform administrative operations on your behalf.`,
    tenant: 'Tenant',
    connection: 'Connection',
    interactiveConnection: 'Interactive connection',
    expires: 'Access expires',
    expiryValue: 'Up to 7 days after approval',
    maximum: 'Per-operation limit',
    maximumValue: (maximum) => `${maximum} resources`,
    chooseScopes: 'Choose what to allow',
    scopeGuidance:
      'Basic read access is required. Select access to personal data or changes only when needed.',
    required: 'Required',
    optional: 'Optional',
    advancedScope: 'An advanced Agent scope assigned to this connection by an administrator.',
    notice: 'You can suspend or revoke this connection at any time from Admin, Agent Access.',
    approve: 'Allow access',
    deny: 'Deny',
    scopes: {
      'agent:read': {
        title: 'Read settings and diagnostics',
        description:
          'Read current authentication settings, configuration, and audit information. User personal data is excluded.',
        optional: false,
      },
      'agent:user-data:read': {
        title: 'Read masked user data',
        description:
          'Masked user search and detail results may be sent to the connected MCP client and its AI model.',
        optional: true,
      },
      'agent:write': {
        title: 'Create and apply configuration Plans',
        description:
          'Make permitted changes through a Plan, diff review, apply, and verification flow. High-risk operations require separate approval.',
        optional: true,
      },
    },
  },
  ja: {
    htmlLang: 'ja',
    pageTitle: 'Agentアクセスの確認 | Authrim',
    secureConnection: '安全なAgent接続',
    heading: 'Agentアクセスの確認',
    introduction: (clientName) =>
      `${clientName} が、あなたに代わって管理操作を行うための許可を求めています。`,
    tenant: '対象テナント',
    connection: '接続方式',
    interactiveConnection: '対話接続',
    expires: '有効期限',
    expiryValue: '許可から最長7日',
    maximum: '1回あたりの対象上限',
    maximumValue: (maximum) => `${maximum}件`,
    chooseScopes: '許可する操作を選択',
    scopeGuidance:
      '基本の読取権限は必須です。個人データと設定変更は、必要な場合だけ選択してください。',
    required: '必須',
    optional: '任意',
    advancedScope: '管理者がこの接続へ割り当てた高度なAgent scopeです。',
    notice: 'この接続は、管理画面の「Agent Access」からいつでも停止または失効できます。',
    approve: 'アクセスを許可',
    deny: '拒否',
    scopes: {
      'agent:read': {
        title: '設定と診断情報を読む',
        description: 'ユーザー個人データを除く、現在の認証設定・構成・監査情報を読み取ります。',
        optional: false,
      },
      'agent:user-data:read': {
        title: 'マスク済みユーザーデータを読む',
        description:
          'ユーザー検索・詳細のマスク済み結果が、接続先MCPクライアントとAIモデルへ送られる場合があります。',
        optional: true,
      },
      'agent:write': {
        title: '設定変更Planを作成・適用する',
        description:
          '許可された設定変更をPlan、差分確認、適用、検証の順に実行します。高リスク操作は別途確認が必要です。',
        optional: true,
      },
    },
  },
};

function resolveAdminAgentConsentLocale(
  acceptLanguage: string | undefined
): AdminAgentConsentLocale {
  if (!acceptLanguage) return 'en';
  const preferences = acceptLanguage
    .split(',')
    .map((part, index) => {
      const [rawTag, ...parameters] = part.trim().split(';');
      const qualityParameter = parameters.find((parameter) => parameter.trim().startsWith('q='));
      const parsedQuality = qualityParameter ? Number(qualityParameter.trim().slice(2)) : 1;
      return {
        tag: rawTag?.trim().toLowerCase() ?? '',
        quality: Number.isFinite(parsedQuality) ? parsedQuality : 0,
        index,
      };
    })
    .filter((preference) => preference.quality > 0)
    .sort((left, right) => right.quality - left.quality || left.index - right.index);
  for (const preference of preferences) {
    const language = preference.tag.split('-')[0];
    if (language === 'ja' || language === 'en') return language;
  }
  return 'en';
}

function requestedSelfServiceScopes(par: PARRequestData): AgentScope[] {
  return normalizeSelfServiceAgentScopes(par.scope.split(/\s+/u).filter(Boolean));
}

function requestedManagedScopes(par: PARRequestData): AgentScope[] {
  const scopes = [...new Set(par.scope.split(/\s+/u).filter(Boolean))];
  if (scopes.length === 0 || scopes.some((scope) => !ADMIN_AGENT_SCOPES.has(scope))) {
    throw new TypeError('Managed Agent scopes are invalid');
  }
  return scopes as AgentScope[];
}

function approvedSelfServiceScopes(
  input: Record<string, string | File | undefined>,
  requested: readonly AgentScope[]
): AgentScope[] {
  const approved: string[] = ['agent:read'];
  if (
    requested.includes('agent:user-data:read') &&
    input.scope_user_data_read === 'agent:user-data:read'
  ) {
    approved.push('agent:user-data:read');
  }
  if (requested.includes('agent:write') && input.scope_write === 'agent:write') {
    approved.push('agent:write');
  }
  return normalizeSelfServiceAgentScopes(approved);
}

function sameScopes(left: readonly AgentScope[], right: readonly AgentScope[]): boolean {
  return left.length === right.length && left.every((scope) => right.includes(scope));
}

function sameAuthorizationDetails(left: unknown, right: unknown): boolean {
  return (
    canonicalizeJson((left ?? []) as JsonValue) === canonicalizeJson((right ?? []) as JsonValue)
  );
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
    const selfService = !resolved.grant || resolved.grantPurpose === 'interactive_self_service';
    let requestedScopes: AgentScope[];
    try {
      requestedScopes = selfService
        ? requestedSelfServiceScopes(resolved.par)
        : requestedManagedScopes(resolved.par);
    } catch {
      return oauthError(c, 'invalid_scope', 'Agent scopes are invalid');
    }
    let requestMaximum: number | undefined;
    try {
      requestMaximum = resolved.par.authorization_details
        ? normalizeSelfServiceAgentAuthorizationDetails(
            JSON.parse(resolved.par.authorization_details)
          ).maxSubjectsPerCall
        : undefined;
    } catch {
      return oauthError(
        c,
        'invalid_authorization_details',
        'Stored authorization_details is outside the Admin Agent contract'
      );
    }
    const grantMaximum = resolved.grant?.resolvedScopeConstraints?.maxPerCall;
    const effectiveMaximum =
      requestMaximum === undefined
        ? selfService
          ? normalizeSelfServiceAgentAuthorizationDetails(undefined).maxSubjectsPerCall
          : grantMaximum
        : grantMaximum === undefined
          ? requestMaximum
          : Math.min(requestMaximum, grantMaximum);
    const locale = resolveAdminAgentConsentLocale(c.req.header('accept-language'));
    const copy = ADMIN_AGENT_CONSENT_COPY[locale];
    const maximumSummary =
      effectiveMaximum === undefined
        ? ''
        : `<div class="summary-item"><dt>${escapeHtml(copy.maximum)}</dt><dd>${escapeHtml(copy.maximumValue(effectiveMaximum))}</dd></div>`;
    const scopeFields = requestedScopes
      .map((scope, index) => {
        const presentation = copy.scopes[scope as keyof typeof copy.scopes] ?? {
          title: scope,
          description: copy.advancedScope,
          optional: false,
        };
        const name =
          scope === 'agent:user-data:read'
            ? 'scope_user_data_read'
            : scope === 'agent:write'
              ? 'scope_write'
              : scope === 'agent:execute'
                ? 'scope_execute'
                : scope === 'agent:admin'
                  ? 'scope_admin'
                  : 'scope_read';
        const required = !selfService || !presentation.optional;
        const inputId = `agent-scope-${index}`;
        const descriptionId = `${inputId}-description`;
        return `<label class="scope-option" for="${inputId}">
  <input class="scope-checkbox" id="${inputId}" type="checkbox" name="${name}" value="${escapeHtml(scope)}" aria-describedby="${descriptionId}" ${required ? 'checked disabled' : ''}>
  <span class="scope-copy">
    <span class="scope-heading"><strong>${escapeHtml(presentation.title)}</strong><span class="scope-status">${escapeHtml(required ? copy.required : copy.optional)}</span></span>
    <span class="scope-description" id="${descriptionId}">${escapeHtml(presentation.description)}</span>
    <code>${escapeHtml(scope)}</code>
  </span>
</label>${required ? `<input type="hidden" name="${name}" value="${escapeHtml(scope)}">` : ''}`;
      })
      .join('');
    const styleNonce = generateSecureRandomString(24);
    const html = `<!doctype html>
<html lang="${copy.htmlLang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${escapeHtml(copy.pageTitle)}</title>
  <style nonce="${styleNonce}">
    :root {
      color-scheme: light dark;
      --page: #f4f6f8;
      --surface: #fcfcfd;
      --surface-muted: #f1f3f5;
      --text: #17191c;
      --muted: #626871;
      --border: #dfe3e8;
      --accent: #2458c6;
      --accent-hover: #1d48a4;
      --accent-soft: #e9effc;
      --focus: #79a2ff;
      --shadow: 0 24px 70px rgb(34 45 62 / 14%);
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      min-height: 100dvh;
      margin: 0;
      padding: 32px 20px;
      display: grid;
      place-items: center;
      background: var(--page);
      color: var(--text);
      line-height: 1.55;
      -webkit-font-smoothing: antialiased;
    }
    main {
      width: min(100%, 680px);
      border: 1px solid var(--border);
      border-radius: 16px;
      background: var(--surface);
      box-shadow: var(--shadow);
      overflow: hidden;
    }
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 20px 28px;
      border-bottom: 1px solid var(--border);
    }
    .brand {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      color: var(--text);
      font-weight: 720;
      letter-spacing: -0.02em;
    }
    .brand-mark {
      display: grid;
      width: 30px;
      height: 30px;
      place-items: center;
      border-radius: 9px;
      background: var(--text);
      color: var(--surface);
      font-size: 15px;
      font-weight: 760;
    }
    .connection-label {
      color: var(--muted);
      font-size: 13px;
      font-weight: 650;
    }
    .content { padding: 34px 36px 36px; }
    h1, h2, p { margin-top: 0; }
    h1 {
      margin-bottom: 10px;
      font-size: clamp(27px, 5vw, 36px);
      line-height: 1.15;
      letter-spacing: -0.035em;
    }
    .introduction {
      max-width: 58ch;
      margin-bottom: 26px;
      color: var(--muted);
      font-size: 16px;
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 1px;
      margin: 0 0 34px;
      overflow: hidden;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: var(--border);
    }
    .summary-item {
      min-width: 0;
      padding: 15px 17px;
      background: var(--surface-muted);
    }
    dt {
      margin-bottom: 3px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 650;
    }
    dd {
      margin: 0;
      overflow-wrap: anywhere;
      font-size: 14px;
      font-weight: 650;
    }
    h2 {
      margin-bottom: 7px;
      font-size: 19px;
      letter-spacing: -0.02em;
    }
    .scope-guidance {
      margin-bottom: 18px;
      color: var(--muted);
      font-size: 14px;
    }
    .scope-list {
      display: grid;
      gap: 10px;
    }
    .scope-option {
      display: grid;
      grid-template-columns: 22px minmax(0, 1fr);
      gap: 13px;
      padding: 16px;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: var(--surface);
      cursor: pointer;
    }
    .scope-option:has(.scope-checkbox:checked) {
      border-color: color-mix(in srgb, var(--accent) 52%, var(--border));
      background: var(--accent-soft);
    }
    .scope-option:focus-within {
      outline: 3px solid color-mix(in srgb, var(--focus) 55%, transparent);
      outline-offset: 2px;
    }
    .scope-checkbox {
      width: 19px;
      height: 19px;
      margin: 2px 0 0;
      accent-color: var(--accent);
    }
    .scope-checkbox:disabled { opacity: 1; }
    .scope-copy { min-width: 0; }
    .scope-heading {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
    }
    .scope-heading strong { font-size: 15px; }
    .scope-status {
      flex: none;
      border-radius: 999px;
      padding: 2px 8px;
      background: color-mix(in srgb, var(--accent) 12%, var(--surface));
      color: var(--accent);
      font-size: 11px;
      font-weight: 720;
    }
    .scope-description {
      display: block;
      margin-top: 4px;
      color: var(--muted);
      font-size: 13px;
    }
    code {
      display: inline-block;
      margin-top: 9px;
      color: var(--muted);
      font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
      font-size: 11px;
    }
    .notice {
      margin: 20px 0 0;
      padding: 13px 15px;
      border-left: 3px solid var(--accent);
      background: var(--surface-muted);
      color: var(--muted);
      font-size: 13px;
    }
    .actions {
      display: grid;
      grid-template-columns: 1fr 1.5fr;
      gap: 10px;
      margin-top: 26px;
    }
    button {
      min-height: 46px;
      border-radius: 10px;
      padding: 0 18px;
      font: inherit;
      font-size: 14px;
      font-weight: 720;
      cursor: pointer;
    }
    button:focus-visible {
      outline: 3px solid var(--focus);
      outline-offset: 2px;
    }
    .deny {
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--text);
    }
    .approve {
      border: 1px solid var(--accent);
      background: var(--accent);
      color: #f8faff;
    }
    .deny:hover { background: var(--surface-muted); }
    .approve:hover { border-color: var(--accent-hover); background: var(--accent-hover); }
    button:active { transform: translateY(1px); }
    @media (prefers-color-scheme: dark) {
      :root {
        --page: #111418;
        --surface: #191d22;
        --surface-muted: #22272e;
        --text: #edf0f4;
        --muted: #a8b0bb;
        --border: #343b45;
        --accent: #83a9ff;
        --accent-hover: #9bb9ff;
        --accent-soft: #202c43;
        --focus: #83a9ff;
        --shadow: 0 24px 70px rgb(0 0 0 / 38%);
      }
      .approve { color: #111826; }
    }
    @media (max-width: 560px) {
      body { padding: 0; place-items: stretch; }
      main { min-height: 100dvh; border: 0; border-radius: 0; box-shadow: none; }
      .topbar { padding: 18px 20px; }
      .connection-label { display: none; }
      .content { padding: 28px 20px 24px; }
      .summary { grid-template-columns: 1fr; }
      .actions { grid-template-columns: 1fr; }
      .approve { grid-row: 1; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { scroll-behavior: auto !important; }
    }
  </style>
</head>
<body>
  <main>
    <div class="topbar">
      <div class="brand"><span class="brand-mark" aria-hidden="true">A</span><span>Authrim</span></div>
      <span class="connection-label">${escapeHtml(copy.secureConnection)}</span>
    </div>
    <div class="content">
      <h1>${escapeHtml(copy.heading)}</h1>
      <p class="introduction">${escapeHtml(copy.introduction(clientName))}</p>
      <dl class="summary">
        <div class="summary-item"><dt>${escapeHtml(copy.tenant)}</dt><dd>${escapeHtml(resolved.tenantId)}</dd></div>
        <div class="summary-item"><dt>${escapeHtml(copy.connection)}</dt><dd>${escapeHtml(copy.interactiveConnection)}</dd></div>
        <div class="summary-item"><dt>${escapeHtml(copy.expires)}</dt><dd>${escapeHtml(copy.expiryValue)}</dd></div>
        ${maximumSummary}
      </dl>
      <h2>${escapeHtml(copy.chooseScopes)}</h2>
      <p class="scope-guidance">${escapeHtml(copy.scopeGuidance)}</p>
      <form method="post" action="/oauth/admin-agent/authorize">
        <input type="hidden" name="request_uri" value="${escapeHtml(requestUri)}">
        <input type="hidden" name="client_id" value="${escapeHtml(clientId)}">
        <div class="scope-list">${scopeFields}</div>
        <p class="notice">${escapeHtml(copy.notice)}</p>
        <div class="actions">
          <button class="deny" type="submit" name="decision" value="deny">${escapeHtml(copy.deny)}</button>
          <button class="approve" type="submit" name="decision" value="approve">${escapeHtml(copy.approve)}</button>
        </div>
      </form>
    </div>
  </main>
</body>
</html>`;
    return c.html(html, 200, {
      'Cache-Control': 'no-store',
      'Content-Language': copy.htmlLang,
      'Content-Security-Policy': [
        "default-src 'none'",
        `style-src 'nonce-${styleNonce}'`,
        "form-action 'self'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
      ].join('; '),
      'Referrer-Policy': 'no-referrer',
      'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Origin-Agent-Cluster': '?1',
      'X-DNS-Prefetch-Control': 'off',
      'X-Download-Options': 'noopen',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'X-Permitted-Cross-Domain-Policies': 'none',
      Vary: 'Accept-Language',
    });
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
  let approvedScopes: AgentScope[];
  try {
    approvedScopes =
      resolved.grant && resolved.grantPurpose !== 'interactive_self_service'
        ? requestedManagedScopes(consumed)
        : approvedSelfServiceScopes(input, requestedSelfServiceScopes(consumed));
  } catch {
    return oauthError(c, 'invalid_scope', 'Approved Agent scopes are invalid');
  }
  let requestedAuthorizationDetails: ReturnType<
    typeof normalizeSelfServiceAgentAuthorizationDetails
  >;
  try {
    requestedAuthorizationDetails = normalizeSelfServiceAgentAuthorizationDetails(
      consumed.authorization_details ? JSON.parse(consumed.authorization_details) : undefined
    );
  } catch {
    return oauthError(
      c,
      'invalid_authorization_details',
      'Stored authorization_details is outside the Admin Agent contract'
    );
  }
  const toolCatalog = createAdminToolCatalog();
  const selfServiceSnapshotIsStale =
    resolved.grantPurpose === 'interactive_self_service' &&
    resolved.grantTaskSetCatalogVersion !== toolCatalog.version;
  let authorizedGrant = resolved.grant;
  if (!authorizedGrant) {
    const grantId = `aag_${crypto.randomUUID()}`;
    const expiresAt = now + SELF_SERVICE_GRANT_TTL_MS;
    let snapshot;
    try {
      snapshot = await resolveSelfServiceAgentAccessSnapshot({
        tenantId: resolved.tenantId,
        adminUserId: resolved.actor.userId,
        clientId,
        grantId,
        approvedScopes,
        authorizationDetails: requestedAuthorizationDetails.authorizationDetails,
        adminPermissions: resolved.actor.permissions ?? [],
        catalog: toolCatalog,
        expiresAt,
      });
    } catch (error) {
      return oauthError(
        c,
        'access_denied',
        error instanceof Error ? error.message : 'No Agent Tools are available',
        403
      );
    }
    const consentVersion = 1;
    const consentBase = {
      tenantId: resolved.tenantId,
      grantId,
      userId: resolved.actor.userId,
      clientId,
      consentVersion,
      scopes: approvedScopes,
      grantedAt: now,
    };
    const grant = {
      grantId,
      tenantId: resolved.tenantId,
      clientId,
      grantorId: resolved.actor.userId,
      delegatorId: resolved.actor.userId,
      permissions: snapshot.permissions,
      scopes: approvedScopes,
      authorizationDetails: requestedAuthorizationDetails.authorizationDetails,
      resolvedScopeConstraints: snapshot.resolvedScopeConstraints,
      consentVersion,
      generation: 1,
      status: 'active' as const,
      delegationMode: 'user_consent' as const,
      taskSetId: snapshot.taskSetId,
      taskSetVersion: snapshot.taskSetVersion,
      scopePolicyId: snapshot.scopePolicyId,
      scopePolicyVersion: snapshot.scopePolicyVersion,
      resolvedTools: snapshot.resolvedTools,
      accessSnapshotHash: snapshot.accessSnapshotHash,
      expiresAt,
      createdAt: now,
      purpose: 'interactive_self_service',
      managementMode: 'system_managed' as const,
    };
    const auditBase = {
      tenantId: resolved.tenantId,
      adminUserId: resolved.actor.userId,
      resourceType: 'admin_agent_grant',
      resourceId: grantId,
      severity: 'info' as const,
      requestId: c.req.header('x-request-id'),
      actorType: 'admin_user' as const,
      actorSub: `admin_user:${resolved.actor.userId}`,
      grantId,
      createdAt: now,
    };
    await resolved.repository.createSelfServiceAuthorization({
      grant,
      taskSet: {
        id: snapshot.taskSetId,
        version: snapshot.taskSetVersion,
        digest: snapshot.taskSetDigest,
        resolved: snapshot.taskSetResolved,
      },
      scopePolicy: {
        id: snapshot.scopePolicyId,
        version: snapshot.scopePolicyVersion,
        digest: snapshot.scopePolicyDigest,
        definition: snapshot.scopePolicyDefinition,
        selectorCatalogVersion: 'agent-scope-selectors-v1',
      },
      delegationConsent: {
        ...consentBase,
        id: `agc_${crypto.randomUUID()}`,
        type: 'delegation',
      },
      oauthClientConsent: {
        ...consentBase,
        id: `agc_${crypto.randomUUID()}`,
        type: 'oauth_client',
      },
      audit: {
        ...auditBase,
        id: `audit_${crypto.randomUUID()}`,
        action: 'agent.grant.created',
        metadata: {
          grant_id: grantId,
          client_id: clientId,
          management_mode: 'system_managed',
          scopes: approvedScopes,
          max_subjects_per_call: requestedAuthorizationDetails.maxSubjectsPerCall,
        },
      },
      consentAudit: {
        ...auditBase,
        id: `audit_${crypto.randomUUID()}`,
        action: 'agent.consent.granted',
        metadata: {
          grant_id: grantId,
          client_id: clientId,
          consent_version: consentVersion,
          max_subjects_per_call: requestedAuthorizationDetails.maxSubjectsPerCall,
        },
      },
    });
    authorizedGrant = grant;
  } else {
    let consentPersisted = false;
    if (
      resolved.grantPurpose === 'interactive_self_service' &&
      (selfServiceSnapshotIsStale ||
        !sameScopes(authorizedGrant.scopes, approvedScopes) ||
        !sameAuthorizationDetails(
          authorizedGrant.authorizationDetails,
          requestedAuthorizationDetails.authorizationDetails
        ) ||
        authorizedGrant.expiresAt === undefined ||
        authorizedGrant.expiresAt <= now)
    ) {
      const nextConsentVersion = authorizedGrant.consentVersion + 1;
      const expiresAt = now + SELF_SERVICE_GRANT_TTL_MS;
      let snapshot;
      try {
        snapshot = await resolveSelfServiceAgentAccessSnapshot({
          tenantId: resolved.tenantId,
          adminUserId: resolved.actor.userId,
          clientId,
          grantId: authorizedGrant.grantId,
          taskSetId: `system_agent_task_set_${authorizedGrant.grantId}_cv${nextConsentVersion}`,
          taskSetVersion: 1,
          scopePolicyId: `system_agent_scope_policy_${authorizedGrant.grantId}_cv${nextConsentVersion}`,
          scopePolicyVersion: 1,
          approvedScopes,
          authorizationDetails: requestedAuthorizationDetails.authorizationDetails,
          adminPermissions: resolved.actor.permissions ?? [],
          catalog: toolCatalog,
          expiresAt,
        });
      } catch (error) {
        return oauthError(
          c,
          'access_denied',
          error instanceof Error ? error.message : 'No Agent Tools are available',
          403
        );
      }
      const nextGrant = {
        ...authorizedGrant,
        permissions: snapshot.permissions,
        scopes: approvedScopes,
        authorizationDetails: requestedAuthorizationDetails.authorizationDetails,
        resolvedScopeConstraints: snapshot.resolvedScopeConstraints,
        consentVersion: nextConsentVersion,
        generation: authorizedGrant.generation + 1,
        taskSetId: snapshot.taskSetId,
        taskSetVersion: snapshot.taskSetVersion,
        scopePolicyId: snapshot.scopePolicyId,
        scopePolicyVersion: snapshot.scopePolicyVersion,
        resolvedTools: snapshot.resolvedTools,
        accessSnapshotHash: snapshot.accessSnapshotHash,
        expiresAt,
        createdAt: now,
        purpose: 'interactive_self_service',
        managementMode: 'system_managed' as const,
      };
      const consentBase = {
        tenantId: resolved.tenantId,
        grantId: nextGrant.grantId,
        userId: resolved.actor.userId,
        clientId,
        consentVersion: nextConsentVersion,
        scopes: approvedScopes,
        grantedAt: now,
      };
      const transitionId = `transition_${crypto.randomUUID()}`;
      const auditBase = {
        tenantId: resolved.tenantId,
        adminUserId: resolved.actor.userId,
        resourceType: 'admin_agent_grant',
        resourceId: nextGrant.grantId,
        severity: 'info' as const,
        requestId: c.req.header('x-request-id'),
        actorType: 'admin_user' as const,
        actorSub: `admin_user:${resolved.actor.userId}`,
        grantId: nextGrant.grantId,
        createdAt: now,
      };
      await resolved.repository.replaceSelfServiceAuthorization({
        grant: nextGrant,
        expectedGeneration: authorizedGrant.generation,
        transitionId,
        outboxId: selfServiceRevocationOutboxId(transitionId),
        taskSet: {
          id: snapshot.taskSetId,
          version: snapshot.taskSetVersion,
          digest: snapshot.taskSetDigest,
          resolved: snapshot.taskSetResolved,
        },
        scopePolicy: {
          id: snapshot.scopePolicyId,
          version: snapshot.scopePolicyVersion,
          digest: snapshot.scopePolicyDigest,
          definition: snapshot.scopePolicyDefinition,
          selectorCatalogVersion: 'agent-scope-selectors-v1',
        },
        delegationConsent: {
          ...consentBase,
          id: `agc_${crypto.randomUUID()}`,
          type: 'delegation',
        },
        oauthClientConsent: {
          ...consentBase,
          id: `agc_${crypto.randomUUID()}`,
          type: 'oauth_client',
        },
        grantAudit: {
          ...auditBase,
          id: transitionId,
          action: 'agent.grant.updated',
          metadata: {
            grant_id: nextGrant.grantId,
            client_id: clientId,
            management_mode: 'system_managed',
            scopes: approvedScopes,
            max_subjects_per_call: requestedAuthorizationDetails.maxSubjectsPerCall,
            previous_generation: authorizedGrant.generation,
            previous_catalog_version: resolved.grantTaskSetCatalogVersion ?? null,
            catalog_version: toolCatalog.version,
          },
        },
        consentAudit: {
          ...auditBase,
          id: `audit_${crypto.randomUUID()}`,
          action: 'agent.consent.granted',
          metadata: {
            grant_id: nextGrant.grantId,
            client_id: clientId,
            consent_version: nextConsentVersion,
            scopes: approvedScopes,
            max_subjects_per_call: requestedAuthorizationDetails.maxSubjectsPerCall,
          },
        },
      });
      authorizedGrant = nextGrant;
      consentPersisted = true;
    }
    if (!authorizedGrant)
      return oauthError(c, 'server_error', 'Agent Grant resolution failed', 500);
    const currentGrant = authorizedGrant;
    if (!approvedScopes.every((scope) => currentGrant.scopes.includes(scope))) {
      return oauthError(c, 'invalid_scope', 'Approved scopes exceed the active Agent Grant');
    }
    if (!consentPersisted) {
      const consentBase = {
        tenantId: resolved.tenantId,
        grantId: currentGrant.grantId,
        userId: resolved.actor.userId,
        clientId,
        consentVersion: currentGrant.consentVersion,
        scopes: approvedScopes,
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
          resourceId: currentGrant.grantId,
          severity: 'info',
          requestId: c.req.header('x-request-id'),
          actorType: 'admin_user',
          actorSub: `admin_user:${resolved.actor.userId}`,
          grantId: currentGrant.grantId,
          metadata: {
            grant_id: currentGrant.grantId,
            client_id: clientId,
            consent_version: currentGrant.consentVersion,
            scopes: approvedScopes,
          },
          createdAt: now,
        },
      });
    }
  }

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
      scope: approvedScopes.join(' '),
      codeChallenge: consumed.code_challenge,
      codeChallengeMethod: 'S256',
      state: consumed.state,
      authorizationDetails: consumed.authorization_details,
      authorizationServer: 'admin_agent',
      subjectType: 'admin_user',
      resource: resolved.canonicalResource,
      agentGrantId: authorizedGrant.grantId,
      agentGrantGeneration: authorizedGrant.generation,
      agentConsentVersion: authorizedGrant.consentVersion,
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
