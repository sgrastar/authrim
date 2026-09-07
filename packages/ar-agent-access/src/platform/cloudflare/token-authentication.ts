import {
  getPublicKeyByKid,
  hasAdminPermission,
  parseTokenHeader,
  requireDedicatedAdminDatabaseAdapter,
  resolveTenantFromRequest,
  validateDPoPProof,
  verifyToken,
  type Env,
} from '@authrim/ar-lib-core';
import {
  AdminAgentAccessRepository,
  evaluateAgentMcpFeatureFlag,
  normalizeSelfServiceAgentAuthorizationDetails,
  parseAgentAccessTokenClaims,
  type AgentGrantContract,
  type AgentScope,
  type AgentAccessTokenClaims,
} from '../../core';
import type {
  CloudflareAgentAccessAdmissionResult,
  CloudflareAgentAccessMcpAdmissionOptions,
} from './mcp-admission';

type AgentAccessCloudflareEnv = Env & { ENABLE_AGENT_MCP?: string };

export interface CloudflareAgentAccessTokenAuthenticationDependencies<
  TEnv extends AgentAccessCloudflareEnv,
> {
  now(): number;
  verifyJwt(input: {
    token: string;
    tenantId: string;
    issuer: string;
    audience: string;
    env: TEnv;
  }): Promise<unknown>;
  validateDpop(input: {
    proof: string;
    request: Request;
    token: string;
    tenantId: string;
    clientId: string;
    env: TEnv;
  }): Promise<{ valid: boolean; jkt?: string }>;
  createRepository(env: TEnv): {
    getGrant(tenantId: string, grantId: string): Promise<AgentGrantContract | null>;
    getActiveDelegatorPermissions(
      tenantId: string,
      delegatorId: string,
      now: number
    ): Promise<string[] | null>;
    hasCurrentConsent(
      tenantId: string,
      grantId: string,
      delegatorId: string,
      clientId: string,
      consentVersion: number
    ): Promise<boolean>;
  };
}

const AGENT_SCOPES = new Set<AgentScope>([
  'agent:read',
  'agent:user-data:read',
  'agent:write',
  'agent:execute',
  'agent:admin',
]);

function invalidToken(request: Request, description = 'Access token is invalid'): Response {
  const url = new URL(request.url);
  const scheme = request.headers.get('authorization')?.startsWith('DPoP ') ? 'DPoP' : 'Bearer';
  const metadata = `${url.origin}/.well-known/oauth-protected-resource/mcp`;
  return Response.json(
    { error: 'invalid_token', error_description: description },
    {
      status: 401,
      headers: {
        'cache-control': 'no-store',
        'www-authenticate': `${scheme} error="invalid_token", resource_metadata="${metadata}"`,
      },
    }
  );
}

function temporarilyUnavailable(): Response {
  return Response.json(
    {
      error: 'temporarily_unavailable',
      error_description: 'Agent access authorization state is unavailable',
    },
    { status: 503, headers: { 'cache-control': 'no-store' } }
  );
}

function authenticationFailure(
  response: Response,
  code: string,
  tenantId?: string
): CloudflareAgentAccessAdmissionResult {
  return { allowed: false, response, auditContext: { code, tenantId } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseAuthorization(request: Request): { scheme: 'bearer' | 'dpop'; token: string } | null {
  const match = request.headers.get('authorization')?.match(/^(Bearer|DPoP) ([^\s]+)$/u);
  if (!match?.[1] || !match[2]) return null;
  return { scheme: match[1].toLowerCase() as 'bearer' | 'dpop', token: match[2] };
}

export async function isCloudflareAgentAccessMcpEnabled(
  env: AgentAccessCloudflareEnv,
  tenantId: string
): Promise<boolean> {
  const settings = env.SETTINGS ?? env.AUTHRIM_CONFIG;
  if (!settings) {
    return evaluateAgentMcpFeatureFlag({
      configurationAvailable: true,
      environmentValue: env.ENABLE_AGENT_MCP,
    }).enabled;
  }
  try {
    const raw = await settings.get(`settings:tenant:${tenantId}:agent-access`);
    const parsed: unknown = raw ? JSON.parse(raw) : undefined;
    const tenantValue = isRecord(parsed) ? parsed['agent.mcp.enabled'] : parsed;
    return evaluateAgentMcpFeatureFlag({
      configurationAvailable: true,
      tenantValue,
      environmentValue: env.ENABLE_AGENT_MCP,
    }).enabled;
  } catch {
    return false;
  }
}

async function defaultVerifyJwt<TEnv extends AgentAccessCloudflareEnv>(input: {
  token: string;
  tenantId: string;
  issuer: string;
  audience: string;
  env: TEnv;
}): Promise<unknown> {
  const header = parseTokenHeader(input.token);
  if (header.alg !== 'RS256' || header.typ !== 'JWT' || !header.kid) {
    throw new Error('Unsupported Agent access token header');
  }
  const key = await getPublicKeyByKid(input.env, input.tenantId, header.kid);
  if (!key) throw new Error('Agent access verification key is unavailable');
  return verifyToken(input.token, key, input.issuer, { audience: input.audience });
}

async function defaultValidateDpop<TEnv extends AgentAccessCloudflareEnv>(input: {
  proof: string;
  request: Request;
  token: string;
  tenantId: string;
  clientId: string;
  env: TEnv;
}): Promise<{ valid: boolean; jkt?: string }> {
  return validateDPoPProof(
    input.proof,
    input.request.method,
    input.request.url,
    input.token,
    input.env,
    input.clientId,
    input.tenantId
  );
}

/**
 * Live MCP Resource Server authentication. Crypto/DO details remain in the Cloudflare adapter;
 * the returned props contain only verified platform-neutral authorization context.
 */
export function createCloudflareAgentAccessTokenAuthenticator<
  TEnv extends AgentAccessCloudflareEnv,
>(
  overrides: Partial<CloudflareAgentAccessTokenAuthenticationDependencies<TEnv>> = {}
): CloudflareAgentAccessMcpAdmissionOptions<TEnv>['authenticate'] {
  const dependencies: CloudflareAgentAccessTokenAuthenticationDependencies<TEnv> = {
    now: overrides.now ?? (() => Date.now()),
    verifyJwt: overrides.verifyJwt ?? defaultVerifyJwt,
    validateDpop: overrides.validateDpop ?? defaultValidateDpop,
    createRepository:
      overrides.createRepository ??
      ((env) =>
        new AdminAgentAccessRepository(
          requireDedicatedAdminDatabaseAdapter(env, 'agent-access-mcp-authentication')
        )),
  };

  return async (request, env): Promise<CloudflareAgentAccessAdmissionResult> => {
    const tenant = resolveTenantFromRequest(request, env);
    if (!tenant.success) {
      return authenticationFailure(invalidToken(request), 'AGENT_MCP_TENANT_RESOLUTION_FAILED');
    }
    if (!(await isCloudflareAgentAccessMcpEnabled(env, tenant.tenantId))) {
      return authenticationFailure(
        new Response(null, { status: 404 }),
        'AGENT_MCP_DISABLED',
        tenant.tenantId
      );
    }
    const authorization = parseAuthorization(request);
    if (!authorization) {
      return authenticationFailure(
        invalidToken(request),
        'AGENT_MCP_AUTHORIZATION_HEADER_INVALID',
        tenant.tenantId
      );
    }

    const origin = new URL(request.url).origin;
    const issuer = `${origin}/oauth/admin-agent`;
    const audience = `${origin}/mcp`;
    let claims: AgentAccessTokenClaims | null = null;
    try {
      claims = parseAgentAccessTokenClaims(
        await dependencies.verifyJwt({
          token: authorization.token,
          tenantId: tenant.tenantId,
          issuer,
          audience,
          env,
        })
      );
    } catch {
      // Keep verification details out of the public error.
    }
    if (!claims || claims.tenant_id !== tenant.tenantId) {
      return authenticationFailure(
        invalidToken(request),
        'AGENT_MCP_TOKEN_INVALID',
        tenant.tenantId
      );
    }
    if (
      !claims.sub.startsWith('admin_user:') ||
      claims.sub.length === 'admin_user:'.length ||
      (claims.actor_mode === 'mode_a'
        ? claims.act.sub !== `client:${claims.client_id}`
        : claims.act.sub !== `machine:${claims.act_principal_id}`)
    ) {
      return authenticationFailure(
        invalidToken(request),
        'AGENT_MCP_ACTOR_CLAIMS_INVALID',
        tenant.tenantId
      );
    }
    if (
      (claims.token_binding === 'bearer' &&
        (authorization.scheme !== 'bearer' || claims.cnf !== undefined)) ||
      (claims.token_binding === 'dpop' &&
        (authorization.scheme !== 'dpop' || typeof claims.cnf?.jkt !== 'string'))
    ) {
      return authenticationFailure(
        invalidToken(request),
        'AGENT_MCP_TOKEN_BINDING_INVALID',
        tenant.tenantId
      );
    }
    if (claims.token_binding === 'dpop') {
      const proof = request.headers.get('dpop');
      if (!proof) {
        return authenticationFailure(
          invalidToken(request),
          'AGENT_MCP_DPOP_PROOF_REQUIRED',
          tenant.tenantId
        );
      }
      let dpop: { valid: boolean; jkt?: string };
      try {
        dpop = await dependencies.validateDpop({
          proof,
          request,
          token: authorization.token,
          tenantId: tenant.tenantId,
          clientId: claims.client_id,
          env,
        });
      } catch {
        return authenticationFailure(
          temporarilyUnavailable(),
          'AGENT_MCP_DPOP_VALIDATION_UNAVAILABLE',
          tenant.tenantId
        );
      }
      if (!dpop.valid || dpop.jkt !== claims.cnf?.jkt) {
        return authenticationFailure(
          invalidToken(request),
          'AGENT_MCP_DPOP_PROOF_INVALID',
          tenant.tenantId
        );
      }
    }

    const delegatorId = claims.sub.slice('admin_user:'.length);
    let grant: AgentGrantContract | null;
    let permissions: string[] | null;
    let consent: boolean;
    try {
      const repository = dependencies.createRepository(env);
      [grant, permissions, consent] = await Promise.all([
        repository.getGrant(tenant.tenantId, claims.grant_id),
        repository.getActiveDelegatorPermissions(tenant.tenantId, delegatorId, dependencies.now()),
        repository.hasCurrentConsent(
          tenant.tenantId,
          claims.grant_id,
          delegatorId,
          claims.client_id,
          claims.consent_version
        ),
      ]);
    } catch {
      return authenticationFailure(
        temporarilyUnavailable(),
        'AGENT_MCP_AUTHORIZATION_STATE_UNAVAILABLE',
        tenant.tenantId
      );
    }
    const tokenScopes = claims.scope.split(/\s+/u).filter(Boolean);
    if (
      !grant ||
      grant.status !== 'active' ||
      grant.clientId !== claims.client_id ||
      grant.delegatorId !== delegatorId ||
      grant.generation !== claims.grant_generation ||
      grant.consentVersion !== claims.consent_version ||
      grant.expiresAt === undefined ||
      grant.expiresAt <= dependencies.now() ||
      !permissions ||
      grant.permissions.some((permission) => !hasAdminPermission(permissions, permission)) ||
      !consent ||
      tokenScopes.length === 0 ||
      tokenScopes.some(
        (scope) =>
          !AGENT_SCOPES.has(scope as AgentScope) || !grant.scopes.includes(scope as AgentScope)
      )
    ) {
      return authenticationFailure(
        invalidToken(request),
        'AGENT_MCP_GRANT_OR_CONSENT_INVALID',
        tenant.tenantId
      );
    }

    const tokenMaximum = claims.authorization_details
      ? normalizeSelfServiceAgentAuthorizationDetails(claims.authorization_details)
          .maxSubjectsPerCall
      : undefined;
    const grantMaximum = grant.resolvedScopeConstraints.maxPerCall;
    const effectiveMaximum =
      tokenMaximum === undefined
        ? grantMaximum
        : grantMaximum === undefined
          ? tokenMaximum
          : Math.min(grantMaximum, tokenMaximum);

    return {
      allowed: true,
      props: {
        context: {
          actor: {
            mode: claims.actor_mode,
            sub: claims.act.sub,
            assurance: claims.actor_assurance,
            tokenBinding: claims.token_binding,
            clientId: claims.client_id,
            ...(claims.actor_mode === 'mode_b'
              ? {
                  machinePrincipalId: claims.act_principal_id,
                  machineCredentialId: claims.act_credential_id,
                }
              : {}),
          },
          grant: {
            ...grant,
            scopes: tokenScopes as AgentScope[],
            resolvedScopeConstraints: {
              ...grant.resolvedScopeConstraints,
              ...(effectiveMaximum === undefined ? {} : { maxPerCall: effectiveMaximum }),
            },
          },
          resource: { tenantId: tenant.tenantId },
          issuerOrigin: origin,
          correlationId: request.headers.get('x-correlation-id') ?? `mcp_${crypto.randomUUID()}`,
        },
      },
    };
  };
}
