import type { Context } from 'hono';
import { evaluateAgentMcpFeatureFlag } from '@authrim/ar-agent-access/core';
import type { Env } from '@authrim/ar-lib-core';
import {
  ALLOWED_DPOP_ALGS,
  buildRequestIssuerUrl,
  getLogger,
  getTenantIdFromContext,
} from '@authrim/ar-lib-core';

type AgentDiscoveryEnv = Env & { ENABLE_AGENT_MCP?: string };

type FeatureDecision = 'enabled' | 'disabled' | 'error';

async function agentAccessFeatureDecision(
  c: Context<{ Bindings: Env }>,
  tenantId: string
): Promise<FeatureDecision> {
  const env = c.env as AgentDiscoveryEnv;
  const settings = env.SETTINGS ?? env.AUTHRIM_CONFIG;
  if (!settings) {
    const decision = evaluateAgentMcpFeatureFlag({
      configurationAvailable: true,
      environmentValue: env.ENABLE_AGENT_MCP,
    });
    return decision.enabled
      ? 'enabled'
      : decision.reason === 'invalid_configuration'
        ? 'error'
        : 'disabled';
  }
  try {
    const value = await settings.get(`settings:tenant:${tenantId}:agent-access`);
    const parsed: unknown = value ? JSON.parse(value) : undefined;
    const tenantValue =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)['agent.mcp.enabled']
        : parsed;
    const decision = evaluateAgentMcpFeatureFlag({
      configurationAvailable: true,
      tenantValue,
      environmentValue: env.ENABLE_AGENT_MCP,
    });
    return decision.enabled
      ? 'enabled'
      : decision.reason === 'invalid_configuration'
        ? 'error'
        : 'disabled';
  } catch (error) {
    getLogger(c)
      .module('AGENT-DISCOVERY')
      .error('Failed to resolve Agent access feature flag', { tenantId }, error as Error);
    const decision = evaluateAgentMcpFeatureFlag({ configurationAvailable: false });
    return decision.enabled ? 'enabled' : 'error';
  }
}

async function requireAgentAccess(
  c: Context<{ Bindings: Env }>
): Promise<{ tenantId: string; baseIssuer: string } | Response> {
  const tenantId = getTenantIdFromContext(c);
  const decision = await agentAccessFeatureDecision(c, tenantId);
  if (decision === 'error') {
    return c.json(
      {
        error: 'temporarily_unavailable',
        error_description: 'Agent access configuration unavailable',
      },
      503
    );
  }
  if (decision === 'disabled') {
    return c.json({ error: 'not_found', message: 'The requested resource was not found' }, 404);
  }
  return {
    tenantId,
    baseIssuer: buildRequestIssuerUrl(c.req.raw, c.env, tenantId).replace(/\/$/u, ''),
  };
}

function metadataHeaders(c: Context): void {
  c.header('Cache-Control', 'public, max-age=60');
  c.header('Vary', 'Accept-Encoding, Host');
}

/** RFC 9728 metadata for the path resource https://host/mcp. */
export async function agentProtectedResourceMetadataHandler(c: Context<{ Bindings: Env }>) {
  const access = await requireAgentAccess(c);
  if (access instanceof Response) return access;
  metadataHeaders(c);
  return c.json({
    resource: `${access.baseIssuer}/mcp`,
    authorization_servers: [`${access.baseIssuer}/oauth/admin-agent`],
    scopes_supported: ['agent:read', 'agent:user-data:read', 'agent:write'],
    bearer_methods_supported: ['header'],
    dpop_signing_alg_values_supported: ALLOWED_DPOP_ALGS,
    resource_documentation: 'https://authrim.com/docs/agent-access/mcp',
  });
}

/** RFC 8414 metadata for the dedicated Admin Agent authorization issuer. */
export async function adminAgentAuthorizationServerMetadataHandler(c: Context<{ Bindings: Env }>) {
  const access = await requireAgentAccess(c);
  if (access instanceof Response) return access;
  const issuer = `${access.baseIssuer}/oauth/admin-agent`;
  metadataHeaders(c);
  return c.json({
    issuer,
    authorization_endpoint: `${access.baseIssuer}/oauth/admin-agent/authorize`,
    token_endpoint: `${access.baseIssuer}/oauth/admin-agent/token`,
    pushed_authorization_request_endpoint: `${access.baseIssuer}/oauth/admin-agent/par`,
    jwks_uri: `${access.baseIssuer}/.well-known/jwks.json`,
    response_types_supported: ['code'],
    response_modes_supported: ['query', 'jwt'],
    grant_types_supported: [
      'authorization_code',
      'refresh_token',
      'urn:ietf:params:oauth:grant-type:token-exchange',
    ],
    subject_token_types_supported: ['urn:authrim:token-type:agent-delegation'],
    actor_token_types_supported: ['urn:ietf:params:oauth:token-type:access_token'],
    agent_delegation_endpoint: `${access.baseIssuer}/oauth/admin-agent/delegation`,
    token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'private_key_jwt'],
    token_endpoint_auth_signing_alg_values_supported: ['PS256', 'ES256', 'RS256'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['agent:read', 'agent:user-data:read', 'agent:write'],
    authorization_details_types_supported: ['authrim_admin_agent'],
    // PAR remains available and direct authorization requests are converted into a one-time PAR
    // record by ar-auth. MCP hosts such as Codex do not universally implement RFC 9126, so the
    // metadata must not advertise PAR as a client-side prerequisite.
    require_pushed_authorization_requests: false,
    authorization_response_iss_parameter_supported: true,
    dpop_signing_alg_values_supported: ALLOWED_DPOP_ALGS,
    client_id_metadata_document_supported: true,
    registration_endpoint: `${access.baseIssuer}/oauth/admin-agent/register`,
  });
}
