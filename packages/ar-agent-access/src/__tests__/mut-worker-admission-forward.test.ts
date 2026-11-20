import { describe, expect, it, vi } from 'vitest';
import { AGENT_ACCESS_SETTINGS_DEFAULTS } from '../core';
import { createCloudflareAgentAccessMcpWorker } from '../platform/cloudflare/mcp-admission';
import { admittedProps, mcpPost } from './helpers/mut-worker-admission-harness';

function worker(options: { binding?: string; agentHeaders?: Record<string, string> } = {}) {
  const serve = vi.fn((_path: string, _options: Record<string, unknown>) => ({
    fetch: vi.fn(
      async () =>
        new Response('agent', {
          status: 200,
          statusText: 'Agent OK',
          headers: { 'mcp-session-id': 'created', ...options.agentHeaders },
        })
    ),
  }));
  const handler = createCloudflareAgentAccessMcpWorker(
    { serve },
    {
      binding: options.binding,
      resolveAllowedOrigin: (request) => request.headers.get('origin'),
      authenticate: async () => ({ allowed: true, props: admittedProps }),
      controls: {
        getSettings: async () => ({ ...AGENT_ACCESS_SETTINGS_DEFAULTS, enabled: true }),
        getRateLimiter: () => ({
          consume: async () => ({ allowed: true, remaining: 1, resetAt: 0 }),
        }),
        getAdmissionAudit: () => ({ write: async () => undefined }),
        getPreAuthRateLimitPerMinute: () => 1200,
        getSessionRegistry: () => ({
          register: async () => 'registered' as const,
          touch: async () => true,
          delete: async () => undefined,
          listExpired: async () => [],
        }),
        destroySession: async () => undefined,
      },
    }
  );
  const fetch = (request: Request) =>
    handler.fetch!(request as never, {}, {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext);
  return { serve, fetch };
}

describe('createCloudflareAgentAccessMcpWorker forwarding', () => {
  it('serves the default AGENT_ACCESS_MCP binding without CORS for same-origin calls', async () => {
    const { serve, fetch } = worker();
    const response = await fetch(mcpPost());
    expect(serve).toHaveBeenCalledWith('/mcp', {
      binding: 'AGENT_ACCESS_MCP',
      transport: 'streamable-http',
      jurisdiction: undefined,
      corsOptions: undefined,
    });
    expect(response.headers.has('access-control-allow-origin')).toBe(false);
    expect(response.statusText).toBe('Agent OK');
  });

  it('honours a custom binding and adds CORS for an allowed origin', async () => {
    const { serve, fetch } = worker({ binding: 'CUSTOM', agentHeaders: { vary: 'Accept' } });
    const response = await fetch(mcpPost(undefined, { origin: 'https://app.example' }));
    expect(serve.mock.calls[0]?.[1]).toMatchObject({
      binding: 'CUSTOM',
      corsOptions: { origin: 'https://app.example' },
    });
    expect(response.status).toBe(200);
    expect(response.statusText).toBe('Agent OK');
    expect(response.headers.get('access-control-allow-origin')).toBe('https://app.example');
    expect(response.headers.get('vary')).toBe('Accept, Origin');
    await expect(response.text()).resolves.toBe('agent');
  });
});
