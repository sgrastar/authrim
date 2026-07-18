import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  adminClientCreateHandler,
  adminClientUpdateHandler,
  adminUserSuspendHandler,
} from '../../admin';
import { agentElevatedExecutionMiddleware } from '../../agent-elevated-execution';
import { loadAgentSafeClientSnapshot } from './agent-read-operations';

export const agentWriteOperationsRouter = new Hono<{ Bindings: Env }>();

export const AGENT_EXPECTED_CLIENT_UPDATED_AT = 'agentExpectedClientUpdatedAt';

const CLIENT_METADATA_FIELDS = new Set(['client_name', 'description', 'logo_uri', 'client_uri']);
const CLIENT_PROTOCOL_SECURITY_FIELDS = new Set([
  'redirect_uris',
  'allowed_redirect_origins',
  'require_pkce',
]);
const PUBLIC_CLIENT_FIELDS = new Set([
  'client_name',
  'application_type',
  'redirect_uris',
  'allowed_redirect_origins',
  'scope',
  'grant_types',
  'response_types',
  'token_endpoint_auth_method',
  'require_pkce',
  'client_credentials_allowed',
  'token_exchange_allowed',
  'is_trusted',
  'skip_consent',
]);
const PUBLIC_CLIENT_RESPONSE_FIELDS = [
  'client_id',
  'client_name',
  'application_type',
  'redirect_uris',
  'allowed_redirect_origins',
  'scope',
  'grant_types',
  'response_types',
  'token_endpoint_auth_method',
  'require_pkce',
  'created_at',
  'updated_at',
] as const;

async function requireClientMetadataProjection(
  c: Parameters<typeof adminClientUpdateHandler>[0],
  next: () => Promise<void>
) {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'AGENT_CLIENT_METADATA_INVALID' }, 400);
  }
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).length === 0 ||
    Object.keys(body).some((key) => !CLIENT_METADATA_FIELDS.has(key))
  ) {
    return c.json({ error: 'AGENT_CLIENT_METADATA_FIELD_NOT_ALLOWED' }, 400);
  }
  const expected = c.req.header('if-match');
  if (!expected || !/^[A-Za-z0-9_-]{16,128}$/u.test(expected)) {
    return c.json({ error: 'AGENT_CLIENT_METADATA_PRECONDITION_REQUIRED' }, 428);
  }
  const snapshot = await loadAgentSafeClientSnapshot(c as never);
  if (snapshot.status === 404) return c.json({ error: 'AGENT_CLIENT_NOT_FOUND' }, 404);
  if (snapshot.status !== 200) return c.json({ error: 'AGENT_CLIENT_READ_FAILED' }, 502);
  if (snapshot.resourceVersion !== expected) {
    return c.json(
      {
        error: 'AGENT_CLIENT_METADATA_PRECONDITION_FAILED',
        current_resource_version: snapshot.resourceVersion,
      },
      412
    );
  }
  c.set(AGENT_EXPECTED_CLIENT_UPDATED_AT as never, snapshot.updatedAt as never);
  await next();
}

async function requireClientProtocolSecurityProjection(
  c: Parameters<typeof adminClientUpdateHandler>[0],
  next: () => Promise<void>
) {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'AGENT_CLIENT_PROTOCOL_SECURITY_INVALID' }, 400);
  }
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).length === 0 ||
    Object.keys(body).some((key) => !CLIENT_PROTOCOL_SECURITY_FIELDS.has(key))
  ) {
    return c.json({ error: 'AGENT_CLIENT_PROTOCOL_SECURITY_FIELD_NOT_ALLOWED' }, 400);
  }
  const expected = c.req.header('if-match');
  if (!expected || !/^[A-Za-z0-9._~-]{1,128}$/u.test(expected)) {
    return c.json({ error: 'AGENT_CLIENT_PROTOCOL_SECURITY_PRECONDITION_REQUIRED' }, 428);
  }
  const snapshot = await loadAgentSafeClientSnapshot(c as never);
  if (snapshot.status === 404) return c.json({ error: 'AGENT_CLIENT_NOT_FOUND' }, 404);
  if (snapshot.status !== 200) return c.json({ error: 'AGENT_CLIENT_READ_FAILED' }, 502);
  if (snapshot.resourceVersion !== expected) {
    return c.json(
      {
        error: 'AGENT_CLIENT_PROTOCOL_SECURITY_PRECONDITION_FAILED',
        current_resource_version: snapshot.resourceVersion,
      },
      412
    );
  }
  c.set(AGENT_EXPECTED_CLIENT_UPDATED_AT as never, snapshot.updatedAt as never);
  await next();
}

async function requirePublicClientProjection(
  c: Parameters<typeof adminClientCreateHandler>[0],
  next: () => Promise<void>
) {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'AGENT_PUBLIC_CLIENT_INVALID' }, 400);
  }
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => !PUBLIC_CLIENT_FIELDS.has(key))
  ) {
    return c.json({ error: 'AGENT_PUBLIC_CLIENT_FIELD_NOT_ALLOWED' }, 400);
  }
  const value = body as Record<string, unknown>;
  if (
    !['spa', 'native'].includes(value.application_type as string) ||
    value.token_endpoint_auth_method !== 'none' ||
    value.require_pkce !== true ||
    JSON.stringify(value.grant_types) !== JSON.stringify(['authorization_code']) ||
    JSON.stringify(value.response_types) !== JSON.stringify(['code']) ||
    value.client_credentials_allowed !== false ||
    value.token_exchange_allowed !== false ||
    value.is_trusted !== false ||
    value.skip_consent !== false
  ) {
    return c.json({ error: 'AGENT_PUBLIC_CLIENT_SECURITY_PROFILE_REQUIRED' }, 400);
  }
  await next();
}

async function stripCreatedClientSecret(
  c: Parameters<typeof adminClientCreateHandler>[0],
  next: () => Promise<void>
) {
  await next();
  const response = c.res.clone();
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return;
  const value = (await response.json()) as Record<string, unknown>;
  const client = value.client;
  if (client && typeof client === 'object' && !Array.isArray(client)) {
    const clientRecord = client as Record<string, unknown>;
    const safeClient = Object.fromEntries(
      PUBLIC_CLIENT_RESPONSE_FIELDS.flatMap((field) =>
        clientRecord[field] === undefined ? [] : [[field, clientRecord[field]]]
      )
    );
    const headers = new Headers(response.headers);
    // The rewritten representation is shorter than the owner handler response. Retaining the
    // original length would truncate or stall strict HTTP clients.
    headers.delete('content-length');
    c.header('content-length', undefined);
    c.res = new Response(JSON.stringify({ ...value, client: safeClient }), {
      status: response.status,
      headers,
    });
  }
}

// Standard-risk, idempotent projection. The fixed route and allowlisted Tool schema prevent an
// Agent from selecting credential, redirect, grant, trust, or protocol-security fields.
agentWriteOperationsRouter.put(
  '/clients/:id/metadata',
  requireClientMetadataProjection,
  adminClientUpdateHandler
);

agentWriteOperationsRouter.post(
  '/clients/public',
  agentElevatedExecutionMiddleware('admin.write.clients.public-create', ({ body }) => {
    const {
      grant_types: _grantTypes,
      response_types: _responseTypes,
      token_endpoint_auth_method: _authMethod,
      require_pkce: _pkce,
      client_credentials_allowed: _clientCredentials,
      token_exchange_allowed: _tokenExchange,
      is_trusted: _trusted,
      skip_consent: _skipConsent,
      ...toolInput
    } = body;
    return toolInput;
  }),
  requirePublicClientProjection,
  stripCreatedClientSecret,
  adminClientCreateHandler
);

// Owner-package wrapper: Agent input cannot choose method/path, and the existing handler remains
// the mutation source of truth for tenant status, revocation semantics, and audit side effects.
agentWriteOperationsRouter.post(
  '/users/:id/suspend',
  agentElevatedExecutionMiddleware('admin.write.users.suspend'),
  adminUserSuspendHandler
);

agentWriteOperationsRouter.put(
  '/clients/:id/protocol-security',
  agentElevatedExecutionMiddleware(
    'admin.write.clients.protocol-security',
    ({ body, resourceId, request }) => {
      const resourceVersion = request.headers.get('if-match');
      if (!resourceId || !resourceVersion) throw new TypeError('Missing client precondition');
      return { ...body, client_id: resourceId, resource_version: resourceVersion };
    }
  ),
  requireClientProtocolSecurityProjection,
  adminClientUpdateHandler
);
