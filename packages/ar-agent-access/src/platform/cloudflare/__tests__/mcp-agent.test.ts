import { describe, expect, it, vi } from 'vitest';

vi.mock('agents/mcp', () => ({ McpAgent: class {} }));
import type { CloudflareAgentAccessMcpProps } from '../mcp-props';
import { sanitizeCloudflareAgentAccessMcpPropsForStorage } from '../mcp-props';
import {
  AGENT_ACCESS_MCP_SESSION_ABSOLUTE_MS,
  AGENT_ACCESS_MCP_SESSION_IDLE_MS,
  createCloudflareAgentDiscoveryProfileStore,
  evaluateCloudflareAgentAccessMcpSession,
  toCloudflareAgentAccessSessionBinding,
  validateCloudflareAgentAccessMcpSession,
  type CloudflareAgentAccessMcpState,
} from '../mcp-agent';

const props: CloudflareAgentAccessMcpProps = {
  sourceAccessToken: 'raw-bearer-token',
  context: {
    actor: {
      mode: 'mode_a',
      sub: 'client:client-1',
      assurance: 'public_client_transaction',
      tokenBinding: 'bearer',
      clientId: 'client-1',
    },
    grant: {
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
    },
    resource: { tenantId: 'tenant-1' },
    issuerOrigin: 'https://tenant-1.authrim.example',
    correlationId: 'correlation-1',
  },
};

describe('Cloudflare McpAgent props persistence boundary', () => {
  it('removes the source token while retaining only verified context', () => {
    const stored = sanitizeCloudflareAgentAccessMcpPropsForStorage(props);
    expect(stored).toEqual({ context: props.context });
    expect(stored).not.toHaveProperty('sourceAccessToken');
    expect(JSON.stringify(stored)).not.toContain('raw-bearer-token');
  });

  it('persists Discovery Profiles within one session state without crossing sessions', async () => {
    let firstState: CloudflareAgentAccessMcpState = { initializedAt: 1 };
    let secondState: CloudflareAgentAccessMcpState = { initializedAt: 2 };
    const first = createCloudflareAgentDiscoveryProfileStore({
      getState: () => firstState,
      setState: (state) => {
        firstState = state;
      },
    });
    const second = createCloudflareAgentDiscoveryProfileStore({
      getState: () => secondState,
      setState: (state) => {
        secondState = state;
      },
    });

    await first.put({ profileIds: ['flows_consent'], updatedAt: 100 });

    await expect(first.get()).resolves.toEqual({
      profileIds: ['flows_consent'],
      updatedAt: 100,
    });
    await expect(second.get()).resolves.toBeNull();
    expect(firstState).toMatchObject({ initializedAt: 1 });
    expect(secondState).toEqual({ initializedAt: 2 });
  });

  it('enforces idle and absolute session deadlines at their exact boundaries', () => {
    const initializedAt = 1_000_000;
    const state = {
      initializedAt,
      lastActivityAt: initializedAt + 5_000,
      contextBinding: toCloudflareAgentAccessSessionBinding(props.context),
    };
    expect(
      evaluateCloudflareAgentAccessMcpSession({
        state,
        context: props.context,
        now: initializedAt + 5_000 + AGENT_ACCESS_MCP_SESSION_IDLE_MS - 1,
      })
    ).toBe('active');
    expect(
      evaluateCloudflareAgentAccessMcpSession({
        state,
        context: props.context,
        now: initializedAt + 5_000 + AGENT_ACCESS_MCP_SESSION_IDLE_MS,
      })
    ).toBe('expired');
    expect(
      evaluateCloudflareAgentAccessMcpSession({
        state: {
          ...state,
          lastActivityAt: initializedAt + AGENT_ACCESS_MCP_SESSION_ABSOLUTE_MS - 1,
        },
        context: props.context,
        now: initializedAt + AGENT_ACCESS_MCP_SESSION_ABSOLUTE_MS,
      })
    ).toBe('expired');
  });

  it('rejects a different Grant context and malformed or rolled-back clocks', () => {
    const initializedAt = 1_000_000;
    const state = {
      initializedAt,
      lastActivityAt: initializedAt,
      contextBinding: toCloudflareAgentAccessSessionBinding(props.context),
    };
    expect(
      evaluateCloudflareAgentAccessMcpSession({
        state,
        context: {
          ...props.context,
          grant: { ...props.context.grant, grantId: 'grant-other' },
        },
        now: initializedAt + 1,
      })
    ).toBe('context_mismatch');
    expect(
      evaluateCloudflareAgentAccessMcpSession({
        state,
        context: props.context,
        now: initializedAt - 1,
      })
    ).toBe('expired');
    expect(
      evaluateCloudflareAgentAccessMcpSession({
        state: {},
        context: props.context,
        now: initializedAt,
      })
    ).toBe('not_found');
  });

  it.each([
    { initialized: false, validation: 'active', expected: 'not_found', destroys: true },
    { initialized: true, validation: 'expired', expected: 'expired', destroys: true },
    {
      initialized: true,
      validation: 'context_mismatch',
      expected: 'context_mismatch',
      destroys: false,
    },
  ] as const)(
    'validates the named DO before forwarding: $expected',
    async ({ initialized, validation, expected, destroys }) => {
      const stub = {
        setName: vi.fn(async () => undefined),
        getInitializeRequest: vi.fn(async () =>
          initialized ? { method: 'initialize' } : undefined
        ),
        validateSessionContextRpc: vi.fn(async () => validation),
        _cf_scheduleDestroy: vi.fn(async () => undefined),
      };
      const namespace = {
        idFromName: vi.fn(() => ({ toString: () => 'do-id' })),
        get: vi.fn(() => stub),
      } as unknown as DurableObjectNamespace;

      await expect(
        validateCloudflareAgentAccessMcpSession({
          namespace,
          sessionId: 'session-1',
          context: props.context,
          now: 1_000_001,
        })
      ).resolves.toBe(expected);
      expect(namespace.idFromName).toHaveBeenCalledWith('streamable-http:session-1');
      expect(stub.setName).toHaveBeenCalledWith('streamable-http:session-1');
      expect(stub.setName.mock.calls[0]).toHaveLength(1);
      expect(stub._cf_scheduleDestroy).toHaveBeenCalledTimes(destroys ? 1 : 0);
      expect(stub.validateSessionContextRpc).toHaveBeenCalledTimes(initialized ? 1 : 0);
    }
  );
});
