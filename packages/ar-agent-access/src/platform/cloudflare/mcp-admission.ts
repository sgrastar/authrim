import type { CloudflareAgentAccessMcpProps } from './mcp-props';
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

export interface CloudflareAgentAccessAdmissionSuccess {
  allowed: true;
  props: CloudflareAgentAccessMcpProps;
}

export interface CloudflareAgentAccessAdmissionFailure {
  allowed: false;
  response: Response;
}

export type CloudflareAgentAccessAdmissionResult =
  | CloudflareAgentAccessAdmissionSuccess
  | CloudflareAgentAccessAdmissionFailure;

export interface CloudflareAgentAccessMcpAdmissionOptions<Env> {
  /** Returns the exact allowed origin, or null when an Origin header is not allowed. */
  resolveAllowedOrigin(request: Request, env: Env): string | null | Promise<string | null>;
  /** Verifies feature flag, token, Grant, consent, actor, tenant, and resource live. */
  authenticate(
    request: Request,
    env: Env
  ): CloudflareAgentAccessAdmissionResult | Promise<CloudflareAgentAccessAdmissionResult>;
  forward(
    request: Request,
    env: Env,
    context: ExecutionContext,
    props: CloudflareAgentAccessMcpProps,
    allowedOrigin: string | undefined
  ): Promise<Response>;
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
      error: { code: -32600, message: 'Unsupported or missing MCP-Protocol-Version' },
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
      const sanitizedRequest = new Request(request, { headers: sanitizedHeaders });
      const origin = request.headers.get('origin') ?? undefined;
      const allowedOrigin = await options.resolveAllowedOrigin(sanitizedRequest, env);
      if (origin && allowedOrigin !== origin) return new Response(null, { status: 403 });

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
        return transportRequestError('Method is not supported by Streamable HTTP', 405);
      }
      if (
        request.method === 'POST' &&
        (!isJsonContentType(request) ||
          !accepts(request, 'application/json') ||
          !accepts(request, 'text/event-stream'))
      ) {
        return transportRequestError(
          'POST requires application/json and Accept for application/json and text/event-stream'
        );
      }
      if (request.method === 'GET' && !accepts(request, 'text/event-stream')) {
        return transportRequestError('GET requires Accept: text/event-stream');
      }

      const version = request.headers.get('mcp-protocol-version');
      // MCP 2025-11-25 requires clients to send this after initialization, but the server SHOULD
      // assume 2025-03-26 when it is absent. Pre-Streamable-HTTP revisions stay unsupported.
      if (version && !AGENT_ACCESS_MCP_COMPATIBLE_PROTOCOL_REVISIONS.includes(version)) {
        return protocolVersionError();
      }

      const admission = await options.authenticate(sanitizedRequest, env);
      if (!admission.allowed) return admission.response;
      return options.forward(
        sanitizedRequest,
        env,
        context,
        admission.props,
        allowedOrigin ?? undefined
      );
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
