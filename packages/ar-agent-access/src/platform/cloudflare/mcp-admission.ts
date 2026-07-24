import type { CloudflareAgentAccessMcpProps } from './mcp-props';
import type { AgentAccessSettings } from '../../core';
import type {
  AgentMcpAdmissionAuditPort,
  AgentMcpSessionRegistryPort,
  AgentRateLimiterPort,
} from '../ports';
import {
  AGENT_ACCESS_MCP_SESSION_ABSOLUTE_MS,
  AGENT_ACCESS_MCP_SESSION_IDLE_MS,
} from './mcp-session-policy';
import {
  AGENT_ACCESS_INTERNAL_CONTEXT_HEADER,
  encodeCloudflareAgentAccessRequestContext,
} from './mcp-request-context';

export const AGENT_ACCESS_MCP_PROTOCOL_REVISION = '2025-11-25' as const;
export const AGENT_ACCESS_MCP_COMPATIBLE_PROTOCOL_REVISIONS = Object.freeze([
  AGENT_ACCESS_MCP_PROTOCOL_REVISION,
  '2025-06-18',
  '2025-03-26',
]);
export const AGENT_ACCESS_MCP_MAX_REQUEST_BYTES = 1024 * 1024;
export const AGENT_ACCESS_MCP_DEFAULT_PREAUTH_RATE_LIMIT_PER_MINUTE = 1200;

export interface CloudflareAgentAccessAdmissionSuccess {
  allowed: true;
  props: CloudflareAgentAccessMcpProps;
}

export interface CloudflareAgentAccessAdmissionFailure {
  allowed: false;
  response: Response;
  auditContext?: {
    tenantId?: string;
    code: string;
  };
}

export type CloudflareAgentAccessAdmissionResult =
  | CloudflareAgentAccessAdmissionSuccess
  | CloudflareAgentAccessAdmissionFailure;

export type CloudflareAgentAccessSessionValidationStatus =
  | 'active'
  | 'not_found'
  | 'expired'
  | 'context_mismatch'
  | 'unavailable';

export interface CloudflareAgentAccessMcpAdmissionOptions<Env> {
  /** Returns the exact allowed origin, or null when an Origin header is not allowed. */
  resolveAllowedOrigin(request: Request, env: Env): string | null | Promise<string | null>;
  /** Verifies feature flag, token, Grant, consent, actor, tenant, and resource live. */
  authenticate(
    request: Request,
    env: Env
  ): CloudflareAgentAccessAdmissionResult | Promise<CloudflareAgentAccessAdmissionResult>;
  /** Revalidates an existing MCP session against the verified token context before forwarding. */
  validateSession?(
    sessionId: string,
    env: Env,
    props: CloudflareAgentAccessMcpProps
  ):
    | CloudflareAgentAccessSessionValidationStatus
    | Promise<CloudflareAgentAccessSessionValidationStatus>;
  controls: CloudflareAgentAccessMcpAdmissionControls<Env>;
  forward(
    request: Request,
    env: Env,
    context: ExecutionContext,
    props: CloudflareAgentAccessMcpProps,
    allowedOrigin: string | undefined
  ): Promise<Response>;
}

export interface CloudflareAgentAccessMcpAdmissionControls<Env> {
  getSettings(env: Env, props: CloudflareAgentAccessMcpProps): Promise<AgentAccessSettings>;
  getRateLimiter(env: Env): AgentRateLimiterPort;
  getAdmissionAudit(env: Env): AgentMcpAdmissionAuditPort;
  getPreAuthRateLimitPerMinute(env: Env): number;
  getSessionRegistry(env: Env): AgentMcpSessionRegistryPort;
  destroySession(sessionId: string, env: Env): Promise<void>;
  now?(): number;
}

export interface CloudflareMcpAgentServeFactory<Env> {
  serve(
    path: string,
    options?: {
      binding?: string;
      corsOptions?: { origin?: string };
      transport?: 'streamable-http';
      jurisdiction?: DurableObjectJurisdiction;
    }
  ): {
    fetch(
      request: Request,
      env: Env,
      context: ExecutionContext & { props?: CloudflareAgentAccessMcpProps }
    ): Promise<Response>;
  };
}

export interface CloudflareAgentAccessMcpWorkerOptions<Env> extends Omit<
  CloudflareAgentAccessMcpAdmissionOptions<Env>,
  'forward'
> {
  binding?: string;
  jurisdiction?: DurableObjectJurisdiction;
}

function protocolVersionError(): Response {
  return Response.json(
    {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Unsupported MCP-Protocol-Version' },
    },
    { status: 400 }
  );
}

function transportRequestError(message: string, status: 400 | 405 = 400): Response {
  return Response.json(
    {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message },
    },
    {
      status,
      headers: status === 405 ? { allow: 'GET, POST, DELETE, OPTIONS' } : undefined,
    }
  );
}

function sessionRequestError(
  status: Exclude<CloudflareAgentAccessSessionValidationStatus, 'active'>
): Response {
  const contextMismatch = status === 'context_mismatch';
  const unavailable = status === 'unavailable';
  return Response.json(
    {
      jsonrpc: '2.0',
      id: null,
      error: {
        code: contextMismatch ? -32003 : unavailable ? -32603 : -32001,
        message: contextMismatch
          ? 'MCP session authorization context does not match'
          : unavailable
            ? 'MCP session validation is unavailable'
            : 'MCP session not found or expired',
      },
    },
    {
      status: contextMismatch ? 403 : unavailable ? 503 : 404,
      headers: { 'cache-control': 'no-store' },
    }
  );
}

function admissionUnavailable(): Response {
  return Response.json(
    {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32603, message: 'MCP admission control is unavailable' },
    },
    { status: 503, headers: { 'cache-control': 'no-store' } }
  );
}

function rateLimitError(message: string): Response {
  return Response.json(
    {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32002, message },
    },
    {
      status: 429,
      headers: { 'cache-control': 'no-store', 'retry-after': '60' },
    }
  );
}

function validSessionId(value: string): boolean {
  return value.length >= 1 && value.length <= 128 && /^[\x21-\x7e]+$/u.test(value);
}

function accepts(request: Request, mediaType: string): boolean {
  const values = request.headers.get('accept');
  if (!values) return false;
  return values.split(',').some((raw) => {
    const [type, ...parameters] = raw.trim().toLowerCase().split(';');
    if (type !== mediaType) return false;
    return !parameters.some((parameter) => /^\s*q\s*=\s*0(?:\.0*)?\s*$/u.test(parameter));
  });
}

function isJsonContentType(request: Request): boolean {
  return (
    request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ===
    'application/json'
  );
}

interface BoundedJsonRpcRequest {
  request: Request;
  message: Record<string, unknown>;
}

async function readBoundedJsonRpcRequest(
  request: Request
): Promise<BoundedJsonRpcRequest | Response> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null) {
    const value = Number(declaredLength);
    if (!Number.isSafeInteger(value) || value < 0) {
      return transportRequestError('Content-Length is invalid');
    }
    if (value > AGENT_ACCESS_MCP_MAX_REQUEST_BYTES) {
      return transportRequestError('MCP request body exceeds the maximum size');
    }
  }
  if (!request.body) return transportRequestError('POST requires one JSON-RPC message');

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > AGENT_ACCESS_MCP_MAX_REQUEST_BYTES) {
        await reader.cancel('MCP request body exceeds the maximum size').catch(() => undefined);
        return transportRequestError('MCP request body exceeds the maximum size');
      }
      chunks.push(result.value);
    }
  } catch {
    return transportRequestError('MCP request body could not be read');
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    return transportRequestError('POST requires valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return transportRequestError('Exactly one JSON-RPC message is required per POST');
  }

  const headers = new Headers(request.headers);
  headers.delete('content-length');
  return {
    request: new Request(request.url, {
      method: request.method,
      headers,
      body,
      redirect: request.redirect,
    }),
    message: parsed as Record<string, unknown>,
  };
}

function admissionKey(props: CloudflareAgentAccessMcpProps): string {
  return `${props.context.grant.tenantId}:${props.context.grant.grantId}:${props.context.actor.clientId}`;
}

function correlationId(value: string | null): string {
  return value && /^[A-Za-z0-9._~-]{1,128}$/u.test(value) ? value : `mcp_${crypto.randomUUID()}`;
}

async function hashAdmissionIdentifier(prefix: string, value: string | null): Promise<string> {
  if (!value) return `${prefix}_unknown`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return `${prefix}_${Array.from(new Uint8Array(digest).slice(0, 12))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
}

function preAuthLimit(value: number): number {
  return Number.isSafeInteger(value) && value >= 60 && value <= 60_000
    ? value
    : AGENT_ACCESS_MCP_DEFAULT_PREAUTH_RATE_LIMIT_PER_MINUTE;
}

/**
 * Public HTTP admission gate around McpAgent.serve(). Authentication runs for POST/GET/DELETE;
 * OPTIONS is limited to a validated CORS preflight and never enters the Durable Object.
 */
export function createCloudflareAgentAccessMcpAdmissionHandler<Env>(
  options: CloudflareAgentAccessMcpAdmissionOptions<Env>
): ExportedHandler<Env> {
  return {
    async fetch(request, env, context) {
      const sanitizedHeaders = new Headers(request.headers);
      sanitizedHeaders.delete(AGENT_ACCESS_INTERNAL_CONTEXT_HEADER);
      const requestCorrelationId = correlationId(sanitizedHeaders.get('x-correlation-id'));
      sanitizedHeaders.set('x-correlation-id', requestCorrelationId);
      const sanitizedRequest = new Request(request, { headers: sanitizedHeaders });
      const requestUrl = new URL(request.url);
      const host = requestUrl.host.slice(0, 255);
      const clientIpHash = await hashAdmissionIdentifier(
        'ip',
        request.headers.get('cf-connecting-ip')
      );
      const sessionIdHeader = request.headers.get('mcp-session-id');
      const sessionIdHash = sessionIdHeader
        ? await hashAdmissionIdentifier('sid', sessionIdHeader)
        : undefined;
      const now = options.controls.now?.() ?? Date.now();
      const admissionAudit = options.controls.getAdmissionAudit(env);
      const writeAdmissionAudit = (
        eventType: string,
        outcome: 'success' | 'denied' | 'failed',
        httpStatus: number,
        details: Record<string, string | number | boolean | null>,
        tenantId?: string
      ) =>
        admissionAudit.write({
          eventType,
          occurredAt: now,
          correlationId: requestCorrelationId,
          outcome,
          httpStatus,
          method: request.method,
          host,
          tenantId,
          clientIpHash,
          sessionIdHash,
          details,
        });
      const reject = async (
        response: Response,
        eventType: string,
        code: string,
        tenantId?: string,
        outcome: 'denied' | 'failed' = 'denied'
      ): Promise<Response> => {
        await writeAdmissionAudit(eventType, outcome, response.status, { code }, tenantId);
        return response;
      };

      try {
        const limit = preAuthLimit(options.controls.getPreAuthRateLimitPerMinute(env));
        const preAuthRate = await options.controls.getRateLimiter(env).consume({
          key: `mcp-preauth:${host}:${clientIpHash}`,
          limit,
          windowSeconds: 60,
        });
        if (!preAuthRate.allowed) {
          return reject(
            rateLimitError('MCP pre-authentication rate limit exceeded'),
            'agent.mcp.admission.rate_limited',
            'AGENT_MCP_PREAUTH_RATE_LIMITED'
          );
        }
      } catch {
        return reject(
          admissionUnavailable(),
          'agent.mcp.admission.failed',
          'AGENT_MCP_PREAUTH_RATE_LIMIT_UNAVAILABLE',
          undefined,
          'failed'
        );
      }

      const origin = request.headers.get('origin') ?? undefined;
      let allowedOrigin: string | null;
      try {
        allowedOrigin = await options.resolveAllowedOrigin(sanitizedRequest, env);
      } catch {
        return reject(
          admissionUnavailable(),
          'agent.mcp.admission.failed',
          'AGENT_MCP_ORIGIN_POLICY_UNAVAILABLE',
          undefined,
          'failed'
        );
      }
      if (origin && allowedOrigin !== origin) {
        return reject(
          new Response(null, { status: 403 }),
          'agent.mcp.admission.origin_denied',
          'AGENT_MCP_ORIGIN_DENIED'
        );
      }

      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            ...(allowedOrigin ? { 'access-control-allow-origin': allowedOrigin } : {}),
            'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
            'access-control-allow-headers':
              'Authorization, DPoP, Content-Type, Accept, MCP-Protocol-Version, MCP-Session-Id, Last-Event-ID',
            'access-control-max-age': '86400',
            vary: 'Origin',
          },
        });
      }

      if (request.method !== 'POST' && request.method !== 'GET' && request.method !== 'DELETE') {
        return reject(
          transportRequestError('Method is not supported by Streamable HTTP', 405),
          'agent.mcp.admission.transport_denied',
          'AGENT_MCP_METHOD_UNSUPPORTED'
        );
      }
      let admission: CloudflareAgentAccessAdmissionResult;
      try {
        admission = await options.authenticate(sanitizedRequest, env);
      } catch {
        return reject(
          admissionUnavailable(),
          'agent.mcp.authentication.failed',
          'AGENT_MCP_AUTHENTICATION_UNAVAILABLE',
          undefined,
          'failed'
        );
      }
      if (!admission.allowed) {
        return reject(
          admission.response,
          'agent.mcp.authentication.denied',
          admission.auditContext?.code ?? 'AGENT_MCP_AUTHENTICATION_DENIED',
          admission.auditContext?.tenantId
        );
      }

      let settings: AgentAccessSettings;
      const key = admissionKey(admission.props);
      try {
        settings = await options.controls.getSettings(env, admission.props);
        const requestLimit = await options.controls.getRateLimiter(env).consume({
          key: `mcp-request:${key}`,
          limit: settings.requestRateLimitPerMinute,
          windowSeconds: 60,
        });
        if (!requestLimit.allowed) {
          return reject(
            rateLimitError('MCP request rate limit exceeded'),
            'agent.mcp.admission.rate_limited',
            'AGENT_MCP_REQUEST_RATE_LIMITED',
            admission.props.context.grant.tenantId
          );
        }
      } catch {
        return reject(
          admissionUnavailable(),
          'agent.mcp.admission.failed',
          'AGENT_MCP_ADMISSION_CONTROL_UNAVAILABLE',
          admission.props.context.grant.tenantId,
          'failed'
        );
      }
      await writeAdmissionAudit(
        'agent.mcp.authentication.succeeded',
        'success',
        200,
        {
          actor_assurance: admission.props.context.actor.assurance,
          token_binding: admission.props.context.actor.tokenBinding,
          grant_id: admission.props.context.grant.grantId,
        },
        admission.props.context.grant.tenantId
      );

      const sessionId = request.headers.get('mcp-session-id');
      if (sessionId !== null) {
        if (!validSessionId(sessionId)) {
          return reject(
            transportRequestError('MCP-Session-Id must contain 1-128 visible ASCII characters'),
            'agent.mcp.admission.session_denied',
            'AGENT_MCP_SESSION_ID_INVALID',
            admission.props.context.grant.tenantId
          );
        }
      }
      if (sessionId === null && (request.method === 'GET' || request.method === 'DELETE')) {
        return reject(
          transportRequestError(`${request.method} requires MCP-Session-Id`),
          'agent.mcp.admission.session_denied',
          'AGENT_MCP_SESSION_ID_REQUIRED',
          admission.props.context.grant.tenantId
        );
      }

      // Authenticate before validating the negotiated MCP transport. OAuth-capable clients probe
      // the protected endpoint before they have a token and may use generic Accept headers or a
      // previously supported protocol revision. Those unauthenticated probes must receive the
      // RFC 9728 challenge instead of a transport error so authorization discovery can start.
      if (
        request.method === 'POST' &&
        (!isJsonContentType(request) ||
          !accepts(request, 'application/json') ||
          !accepts(request, 'text/event-stream'))
      ) {
        return reject(
          transportRequestError(
            'POST requires application/json and Accept for application/json and text/event-stream'
          ),
          'agent.mcp.admission.transport_denied',
          'AGENT_MCP_MEDIA_TYPE_INVALID',
          admission.props.context.grant.tenantId
        );
      }
      if (request.method === 'GET' && !accepts(request, 'text/event-stream')) {
        return reject(
          transportRequestError('GET requires Accept: text/event-stream'),
          'agent.mcp.admission.transport_denied',
          'AGENT_MCP_ACCEPT_INVALID',
          admission.props.context.grant.tenantId
        );
      }

      const version = request.headers.get('mcp-protocol-version');
      // MCP 2025-11-25 requires clients to send this after initialization, but the server SHOULD
      // assume 2025-03-26 when it is absent. Pre-Streamable-HTTP revisions stay unsupported after
      // authentication; before authentication the OAuth challenge above takes precedence.
      if (version && !AGENT_ACCESS_MCP_COMPATIBLE_PROTOCOL_REVISIONS.includes(version)) {
        return reject(
          protocolVersionError(),
          'agent.mcp.admission.transport_denied',
          'AGENT_MCP_PROTOCOL_VERSION_UNSUPPORTED',
          admission.props.context.grant.tenantId
        );
      }

      let forwardedRequest = sanitizedRequest;
      let message: Record<string, unknown> | undefined;
      if (request.method === 'POST') {
        const bounded = await readBoundedJsonRpcRequest(sanitizedRequest);
        if (bounded instanceof Response) {
          return reject(
            bounded,
            'agent.mcp.admission.transport_denied',
            'AGENT_MCP_JSONRPC_INVALID',
            admission.props.context.grant.tenantId
          );
        }
        forwardedRequest = bounded.request;
        message = bounded.message;
      }

      const isInitialization =
        request.method === 'POST' && sessionId === null && message?.method === 'initialize';
      if (request.method === 'POST' && sessionId === null && !isInitialization) {
        return reject(
          transportRequestError('A sessionless POST must be an initialize request'),
          'agent.mcp.admission.session_denied',
          'AGENT_MCP_SESSION_INITIALIZE_REQUIRED',
          admission.props.context.grant.tenantId
        );
      }
      if (isInitialization) {
        try {
          const initializationLimit = await options.controls.getRateLimiter(env).consume({
            key: `mcp-initialize:${key}`,
            limit: settings.sessionInitializationRateLimitPerMinute,
            windowSeconds: 60,
          });
          if (!initializationLimit.allowed) {
            return reject(
              rateLimitError('MCP session initialization rate limit exceeded'),
              'agent.mcp.admission.rate_limited',
              'AGENT_MCP_INITIALIZATION_RATE_LIMITED',
              admission.props.context.grant.tenantId
            );
          }
        } catch {
          return reject(
            admissionUnavailable(),
            'agent.mcp.admission.failed',
            'AGENT_MCP_INITIALIZATION_RATE_LIMIT_UNAVAILABLE',
            admission.props.context.grant.tenantId,
            'failed'
          );
        }
      } else if (sessionId !== null) {
        try {
          const active = await options.controls.getSessionRegistry(env).touch({
            sessionId,
            tenantId: admission.props.context.grant.tenantId,
            grantId: admission.props.context.grant.grantId,
            clientId: admission.props.context.actor.clientId,
            now,
            idleExpiresAt: now + AGENT_ACCESS_MCP_SESSION_IDLE_MS,
          });
          if (!active) {
            return reject(
              sessionRequestError('expired'),
              'agent.mcp.admission.session_denied',
              'AGENT_MCP_SESSION_EXPIRED',
              admission.props.context.grant.tenantId
            );
          }
          if (options.validateSession) {
            let validation: CloudflareAgentAccessSessionValidationStatus;
            try {
              validation = await options.validateSession(sessionId, env, admission.props);
            } catch {
              validation = 'unavailable';
            }
            if (validation !== 'active') {
              return reject(
                sessionRequestError(validation),
                'agent.mcp.admission.session_denied',
                `AGENT_MCP_SESSION_${validation.toUpperCase()}`,
                admission.props.context.grant.tenantId,
                validation === 'unavailable' ? 'failed' : 'denied'
              );
            }
          }
        } catch {
          return reject(
            admissionUnavailable(),
            'agent.mcp.admission.failed',
            'AGENT_MCP_SESSION_REGISTRY_UNAVAILABLE',
            admission.props.context.grant.tenantId,
            'failed'
          );
        }
      }

      const response = await options.forward(
        forwardedRequest,
        env,
        context,
        admission.props,
        allowedOrigin ?? undefined
      );
      if (isInitialization && response.status >= 200 && response.status < 300) {
        const createdSessionId = response.headers.get('mcp-session-id');
        if (!createdSessionId || !validSessionId(createdSessionId)) {
          return reject(
            admissionUnavailable(),
            'agent.mcp.admission.failed',
            'AGENT_MCP_SESSION_RESPONSE_INVALID',
            admission.props.context.grant.tenantId,
            'failed'
          );
        }
        {
          try {
            const registration = await options.controls.getSessionRegistry(env).register({
              sessionId: createdSessionId,
              tenantId: admission.props.context.grant.tenantId,
              grantId: admission.props.context.grant.grantId,
              clientId: admission.props.context.actor.clientId,
              actorSub: admission.props.context.actor.sub,
              createdAt: now,
              idleExpiresAt: now + AGENT_ACCESS_MCP_SESSION_IDLE_MS,
              absoluteExpiresAt: now + AGENT_ACCESS_MCP_SESSION_ABSOLUTE_MS,
              maxConcurrentSessions: settings.maxConcurrentSessions,
            });
            if (registration === 'limit_exceeded') {
              await options.controls.destroySession(createdSessionId, env).catch(() => undefined);
              return reject(
                rateLimitError('Concurrent MCP session limit exceeded'),
                'agent.mcp.admission.rate_limited',
                'AGENT_MCP_CONCURRENT_SESSION_LIMITED',
                admission.props.context.grant.tenantId
              );
            }
            if (registration === 'conflict') {
              return reject(
                admissionUnavailable(),
                'agent.mcp.admission.failed',
                'AGENT_MCP_SESSION_REGISTRATION_CONFLICT',
                admission.props.context.grant.tenantId,
                'failed'
              );
            }
          } catch {
            await options.controls.destroySession(createdSessionId, env).catch(() => undefined);
            return reject(
              admissionUnavailable(),
              'agent.mcp.admission.failed',
              'AGENT_MCP_SESSION_REGISTRATION_UNAVAILABLE',
              admission.props.context.grant.tenantId,
              'failed'
            );
          }
        }
        await admissionAudit.write({
          eventType: 'agent.mcp.session.created',
          occurredAt: now,
          correlationId: requestCorrelationId,
          outcome: 'success',
          httpStatus: response.status,
          method: request.method,
          host,
          tenantId: admission.props.context.grant.tenantId,
          clientIpHash,
          sessionIdHash: await hashAdmissionIdentifier('sid', createdSessionId),
          details: { grant_id: admission.props.context.grant.grantId },
        });
      }
      if (request.method === 'DELETE' && sessionId !== null && response.status < 400) {
        try {
          await options.controls.getSessionRegistry(env).delete({
            sessionId,
            tenantId: admission.props.context.grant.tenantId,
            grantId: admission.props.context.grant.grantId,
            clientId: admission.props.context.actor.clientId,
          });
        } catch {
          return reject(
            admissionUnavailable(),
            'agent.mcp.admission.failed',
            'AGENT_MCP_SESSION_DELETE_UNAVAILABLE',
            admission.props.context.grant.tenantId,
            'failed'
          );
        }
        await writeAdmissionAudit(
          'agent.mcp.session.closed',
          'success',
          response.status,
          { grant_id: admission.props.context.grant.grantId },
          admission.props.context.grant.tenantId
        );
      }
      return response;
    },
  };
}

/** Composes the admission gate with the Agents SDK's stateful Streamable HTTP handler. */
export function createCloudflareAgentAccessMcpWorker<Env>(
  agent: CloudflareMcpAgentServeFactory<Env>,
  options: CloudflareAgentAccessMcpWorkerOptions<Env>
): ExportedHandler<Env> {
  return createCloudflareAgentAccessMcpAdmissionHandler({
    resolveAllowedOrigin: options.resolveAllowedOrigin,
    authenticate: options.authenticate,
    validateSession: options.validateSession,
    controls: options.controls,
    async forward(request, env, context, props, allowedOrigin) {
      const headers = new Headers(request.headers);
      headers.set(
        AGENT_ACCESS_INTERNAL_CONTEXT_HEADER,
        encodeCloudflareAgentAccessRequestContext(props.context)
      );
      const requestForAgent = new Request(request, { headers });
      const contextWithProps = context as ExecutionContext & {
        props?: CloudflareAgentAccessMcpProps;
      };
      contextWithProps.props = { context: props.context };
      const response = await agent
        .serve('/mcp', {
          binding: options.binding ?? 'AGENT_ACCESS_MCP',
          transport: 'streamable-http',
          jurisdiction: options.jurisdiction,
          corsOptions: allowedOrigin ? { origin: allowedOrigin } : undefined,
        })
        .fetch(requestForAgent, env, contextWithProps);
      if (!allowedOrigin) return response;
      const responseHeaders = new Headers(response.headers);
      responseHeaders.set('access-control-allow-origin', allowedOrigin);
      responseHeaders.append('vary', 'Origin');
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    },
  });
}
