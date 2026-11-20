import { vi } from 'vitest';
import { AGENT_ACCESS_SETTINGS_DEFAULTS, type AgentGrantContract } from '../../core';
import type { CloudflareAgentAccessMcpProps } from '../../platform/cloudflare/mcp-props';
import {
  createCloudflareAgentAccessMcpAdmissionHandler,
  type CloudflareAgentAccessAdmissionResult,
  type CloudflareAgentAccessSessionValidationStatus,
} from '../../platform/cloudflare/mcp-admission';
import type {
  AgentMcpAdmissionAuditEvent,
  AgentMcpSessionRegistryPort,
} from '../../platform/ports';

export const NOW = 1_000_000;

const grant: AgentGrantContract = {
  grantId: 'grant-1',
  tenantId: 'tenant-1',
  clientId: 'client-1',
  grantorId: 'admin-1',
  delegatorId: 'admin-1',
  permissions: ['admin:users:read'],
  scopes: ['agent:read'],
  resolvedScopeConstraints: { tenantIds: ['tenant-1'] },
  consentVersion: 1,
  generation: 1,
  status: 'active',
  delegationMode: 'user_consent',
};

export const admittedProps: CloudflareAgentAccessMcpProps = {
  context: {
    actor: {
      mode: 'mode_a',
      sub: 'client:client-1',
      assurance: 'public_client_transaction',
      tokenBinding: 'bearer',
      clientId: 'client-1',
    },
    grant,
    resource: { tenantId: 'tenant-1' },
    issuerOrigin: 'https://auth.example',
    correlationId: 'correlation-1',
  },
};

export interface HarnessOptions {
  rateLimits?: Partial<Record<'preauth' | 'request' | 'initialize', boolean | 'throw'>>;
  preAuthLimit?: number;
  authenticate?: () => Promise<CloudflareAgentAccessAdmissionResult>;
  allowedOrigin?: string | null;
  originPolicyFails?: boolean;
  validateSession?: () => Promise<CloudflareAgentAccessSessionValidationStatus>;
  touch?: boolean | 'throw';
  register?: 'registered' | 'limit_exceeded' | 'conflict' | 'throw';
  deleteFails?: boolean;
  settingsFail?: boolean;
  forward?: (request: Request) => Response | Promise<Response>;
}

export function harness(options: HarnessOptions = {}) {
  const audit = vi.fn(async (_event: AgentMcpAdmissionAuditEvent): Promise<void> => undefined);
  const consume = vi.fn(async (input: { key: string; limit: number; windowSeconds: number }) => {
    const kind = input.key.split(':', 1)[0]?.replace('mcp-', '') as
      | 'preauth'
      | 'request'
      | 'initialize';
    const outcome = options.rateLimits?.[kind] ?? true;
    if (outcome === 'throw') throw new Error('limiter down');
    return { allowed: outcome, remaining: 1, resetAt: NOW + 60_000 };
  });
  const registry = {
    register: vi.fn<AgentMcpSessionRegistryPort['register']>(async () => {
      if (options.register === 'throw') throw new Error('registry down');
      return options.register ?? ('registered' as const);
    }),
    touch: vi.fn<AgentMcpSessionRegistryPort['touch']>(async () => {
      if (options.touch === 'throw') throw new Error('registry down');
      return options.touch ?? true;
    }),
    delete: vi.fn<AgentMcpSessionRegistryPort['delete']>(async () => {
      if (options.deleteFails) throw new Error('registry down');
    }),
    listExpired: vi.fn<AgentMcpSessionRegistryPort['listExpired']>(async () => []),
  };
  const destroySession = vi.fn(async (_sessionId: string, _env: unknown) => undefined);
  const forward = vi.fn(
    async (
      request: Request,
      _env: unknown,
      _context: unknown,
      _props: CloudflareAgentAccessMcpProps,
      _origin: string | undefined
    ) =>
      options.forward
        ? options.forward(request)
        : new Response('ok', { headers: { 'mcp-session-id': 'session-created' } })
  );
  const authenticate = vi.fn(
    async (_request: Request, _env: unknown): Promise<CloudflareAgentAccessAdmissionResult> =>
      options.authenticate ? options.authenticate() : { allowed: true, props: admittedProps }
  );
  const resolveAllowedOrigin = vi.fn(async (request: Request) => {
    if (options.originPolicyFails) throw new Error('origin policy down');
    if (options.allowedOrigin !== undefined) return options.allowedOrigin;
    return request.headers.get('origin');
  });
  const handler = createCloudflareAgentAccessMcpAdmissionHandler<unknown>({
    resolveAllowedOrigin,
    authenticate,
    validateSession: options.validateSession,
    forward,
    controls: {
      getSettings: vi.fn(async () => {
        if (options.settingsFail) throw new Error('settings down');
        return {
          ...AGENT_ACCESS_SETTINGS_DEFAULTS,
          enabled: true,
          requestRateLimitPerMinute: 11,
          sessionInitializationRateLimitPerMinute: 7,
          maxConcurrentSessions: 3,
        };
      }),
      getRateLimiter: () => ({ consume }),
      getAdmissionAudit: () => ({ write: audit }),
      getPreAuthRateLimitPerMinute: () => options.preAuthLimit ?? 1200,
      getSessionRegistry: () => registry,
      destroySession,
      now: () => NOW,
    },
  });
  const fetch = (request: Request) =>
    handler.fetch!(request as never, {}, {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext);
  const events = () => audit.mock.calls.map(([event]) => event);
  const lastEvent = (): AgentMcpAdmissionAuditEvent | undefined => events().at(-1);
  return {
    fetch,
    audit,
    events,
    lastEvent,
    consume,
    registry,
    destroySession,
    forward,
    authenticate,
    resolveAllowedOrigin,
  };
}

export function mcpPost(
  body: BodyInit | null = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
  headers: Record<string, string> = {}
): Request {
  return new Request('https://auth.example/mcp', {
    method: 'POST',
    headers: {
      authorization: 'Bearer token',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body,
    ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
  });
}

export function mcpCall(method: string, headers: Record<string, string> = {}): Request {
  return new Request('https://auth.example/mcp', {
    method,
    headers: { authorization: 'Bearer token', accept: 'text/event-stream', ...headers },
  });
}

export const toolsCall = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

export async function jsonRpcError(response: Response) {
  return response.json<{
    jsonrpc: string;
    id: null;
    error: { code: number; message: string };
  }>();
}

export async function sha256Prefix(prefix: string, value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return `${prefix}_${Array.from(new Uint8Array(digest).slice(0, 12))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
}
