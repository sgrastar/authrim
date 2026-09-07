import { McpAgent } from 'agents/mcp';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  createAgentAccessMcpSdkServer,
  createAgentAccessMcpServer,
  type AgentAccessMcpRequestContext,
  type AgentAccessMcpServerDependencies,
} from '../../protocol/mcp';
import {
  sanitizeCloudflareAgentAccessMcpPropsForStorage,
  type CloudflareAgentAccessMcpProps,
} from './mcp-props';
import type { CloudflareMcpAgentServeFactory } from './mcp-admission';
import type { AgentDiscoveryProfileStorePort } from '../ports';
import {
  AGENT_ACCESS_INTERNAL_CONTEXT_HEADER,
  decodeCloudflareAgentAccessRequestContext,
  getCloudflareAgentAccessCurrentRequest,
  runWithCloudflareAgentAccessRequest,
} from './mcp-request-context';
export {
  AGENT_ACCESS_MCP_SESSION_ABSOLUTE_MS,
  AGENT_ACCESS_MCP_SESSION_IDLE_MS,
} from './mcp-session-policy';
import {
  AGENT_ACCESS_MCP_SESSION_ABSOLUTE_MS,
  AGENT_ACCESS_MCP_SESSION_IDLE_MS,
} from './mcp-session-policy';

export type { CloudflareAgentAccessMcpProps, CloudflareAgentAccessStoredProps } from './mcp-props';
export { sanitizeCloudflareAgentAccessMcpPropsForStorage } from './mcp-props';

export interface CloudflareAgentAccessMcpState {
  initializedAt?: number;
  lastActivityAt?: number;
  contextBinding?: CloudflareAgentAccessSessionBinding;
  discoveryProfileIds?: string[];
  discoveryProfileUpdatedAt?: number;
}

export type CloudflareAgentAccessMcpSessionStatus =
  | 'active'
  | 'not_found'
  | 'expired'
  | 'context_mismatch'
  | 'unavailable';

export interface CloudflareAgentAccessSessionBinding {
  tenantId: string;
  grantId: string;
  grantGeneration: number;
  delegatorId: string;
  actorSub: string;
  actorMode: string;
  clientId: string;
  machinePrincipalId?: string;
  consentVersion: number;
}

export function toCloudflareAgentAccessSessionBinding(
  context: AgentAccessMcpRequestContext
): CloudflareAgentAccessSessionBinding {
  return {
    tenantId: context.grant.tenantId,
    grantId: context.grant.grantId,
    grantGeneration: context.grant.generation,
    delegatorId: context.grant.delegatorId,
    actorSub: context.actor.sub,
    actorMode: context.actor.mode,
    clientId: context.actor.clientId,
    machinePrincipalId: context.actor.machinePrincipalId,
    consentVersion: context.grant.consentVersion,
  };
}

function assertSessionBinding(
  expected: CloudflareAgentAccessSessionBinding | undefined,
  context: AgentAccessMcpRequestContext
): void {
  if (!expected) throw new Error('Agent Access MCP session is not initialized');
  const actual = toCloudflareAgentAccessSessionBinding(context);
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error('Agent Access MCP token context does not match the bound session');
  }
}

export function evaluateCloudflareAgentAccessMcpSession(input: {
  state: CloudflareAgentAccessMcpState;
  context: AgentAccessMcpRequestContext;
  now: number;
}): Exclude<CloudflareAgentAccessMcpSessionStatus, 'unavailable'> {
  const { contextBinding, initializedAt } = input.state;
  if (!contextBinding || initializedAt === undefined) return 'not_found';
  try {
    assertSessionBinding(contextBinding, input.context);
  } catch {
    return 'context_mismatch';
  }
  const lastActivityAt = input.state.lastActivityAt ?? initializedAt;
  if (
    !Number.isSafeInteger(input.now) ||
    input.now < initializedAt ||
    input.now < lastActivityAt ||
    input.now - initializedAt >= AGENT_ACCESS_MCP_SESSION_ABSOLUTE_MS ||
    input.now - lastActivityAt >= AGENT_ACCESS_MCP_SESSION_IDLE_MS
  ) {
    return 'expired';
  }
  return 'active';
}

export interface CloudflareAgentAccessMcpAgentOptions<Env extends Cloudflare.Env> {
  getEnvironmentName?(env: Env): string | undefined;
  createDependencies(
    env: Env,
    getCurrentRequest: typeof getCloudflareAgentAccessCurrentRequest,
    discoveryProfiles: AgentDiscoveryProfileStorePort
  ): AgentAccessMcpServerDependencies;
}

/** Creates one profile store for one McpAgent session without exposing Cloudflare state to core. */
export function createCloudflareAgentDiscoveryProfileStore(input: {
  getState(): CloudflareAgentAccessMcpState;
  setState(state: CloudflareAgentAccessMcpState): void;
}): AgentDiscoveryProfileStorePort {
  return {
    get: async () => {
      const state = input.getState();
      return state.discoveryProfileIds
        ? {
            profileIds: [...state.discoveryProfileIds],
            updatedAt: state.discoveryProfileUpdatedAt ?? 0,
          }
        : null;
    },
    put: async (selection) => {
      input.setState({
        ...input.getState(),
        discoveryProfileIds: [...selection.profileIds],
        discoveryProfileUpdatedAt: selection.updatedAt,
      });
    },
  };
}

/** Public constructor surface; Agents SDK private class members must not leak into declarations. */
export interface CloudflareAgentAccessMcpAgentInstance<Env extends Cloudflare.Env> extends McpAgent<
  Env,
  CloudflareAgentAccessMcpState,
  CloudflareAgentAccessMcpProps
> {
  server: Server;
  init(): Promise<void>;
  validateSessionContextRpc(
    context: AgentAccessMcpRequestContext,
    now: number
  ): Promise<Exclude<CloudflareAgentAccessMcpSessionStatus, 'unavailable'>>;
}

export interface CloudflareAgentAccessMcpAgentClass<
  Env extends Cloudflare.Env,
> extends CloudflareMcpAgentServeFactory<Env> {
  new (ctx: DurableObjectState, env: Env): CloudflareAgentAccessMcpAgentInstance<Env>;
}

interface CloudflareAgentAccessMcpSessionStub {
  setName(name: string, props?: CloudflareAgentAccessMcpProps): Promise<void>;
  getInitializeRequest(): Promise<unknown | undefined>;
  validateSessionContextRpc(
    context: AgentAccessMcpRequestContext,
    now: number
  ): Promise<Exclude<CloudflareAgentAccessMcpSessionStatus, 'unavailable'>>;
  _cf_scheduleDestroy(): Promise<void>;
}

/** Validates the exact named McpAgent DO before an existing session request is forwarded. */
export async function validateCloudflareAgentAccessMcpSession(input: {
  namespace: DurableObjectNamespace;
  sessionId: string;
  context: AgentAccessMcpRequestContext;
  now?: number;
}): Promise<CloudflareAgentAccessMcpSessionStatus> {
  try {
    const name = `streamable-http:${input.sessionId}`;
    const id = input.namespace.idFromName(name);
    const agent = input.namespace.get(id) as unknown as CloudflareAgentAccessMcpSessionStub;
    // This RPC is a read-only ownership check. Passing the caller's context as PartyServer props
    // would persist an unverified context before the binding comparison and let another valid
    // Grant corrupt the victim session on its next cold start.
    await agent.setName(name);
    if (!(await agent.getInitializeRequest())) {
      await agent._cf_scheduleDestroy().catch(() => undefined);
      return 'not_found';
    }
    const status = await agent.validateSessionContextRpc(input.context, input.now ?? Date.now());
    if (status === 'expired') {
      await agent._cf_scheduleDestroy().catch(() => undefined);
    }
    return status;
  } catch {
    return 'unavailable';
  }
}

/** Schedules destruction of one exact named McpAgent session without creating application state. */
export async function destroyCloudflareAgentAccessMcpSession(input: {
  namespace: DurableObjectNamespace;
  sessionId: string;
}): Promise<void> {
  const name = `streamable-http:${input.sessionId}`;
  const id = input.namespace.idFromName(name);
  const agent = input.namespace.get(id) as unknown as CloudflareAgentAccessMcpSessionStub;
  await agent.setName(name);
  await agent._cf_scheduleDestroy();
}

/**
 * Creates the Cloudflare runtime shell around the platform-neutral MCP application. Tool,
 * Resource, and Prompt definitions remain in protocol/mcp and are never declared in this class.
 */
export function createCloudflareAgentAccessMcpAgent<Env extends Cloudflare.Env>(
  options: CloudflareAgentAccessMcpAgentOptions<Env>
): CloudflareAgentAccessMcpAgentClass<Env> {
  class AgentAccessMcpAgent extends McpAgent<
    Env,
    CloudflareAgentAccessMcpState,
    CloudflareAgentAccessMcpProps
  > {
    initialState: CloudflareAgentAccessMcpState = {};

    server: Server = createAgentAccessMcpSdkServer(
      createAgentAccessMcpServer(
        options.createDependencies(
          this.env,
          getCloudflareAgentAccessCurrentRequest,
          createCloudflareAgentDiscoveryProfileStore({
            getState: () => this.state,
            setState: (state) => this.setState(state),
          })
        )
      ),
      () => {
        const context = getCloudflareAgentAccessCurrentRequest()?.context;
        if (!context) throw new Error('Agent Access MCP authentication context is unavailable');
        assertSessionBinding(this.state.contextBinding, context);
        return context;
      },
      { environmentName: options.getEnvironmentName?.(this.env) }
    );

    /**
     * Agents SDK persists props by default. Persist only the verified authorization context while
     * retaining the source token in memory for the current request's downscope exchange.
     */
    async updateProps(props?: CloudflareAgentAccessMcpProps): Promise<void> {
      await this.ctx.storage.put(
        'props',
        props ? sanitizeCloudflareAgentAccessMcpPropsForStorage(props) : {}
      );
      this.props = props;
    }

    async onConnect(
      connection: Parameters<
        McpAgent<Env, CloudflareAgentAccessMcpState, CloudflareAgentAccessMcpProps>['onConnect']
      >[0],
      connectionContext: Parameters<
        McpAgent<Env, CloudflareAgentAccessMcpState, CloudflareAgentAccessMcpProps>['onConnect']
      >[1]
    ): Promise<void> {
      const authorization = connectionContext.request.headers
        .get('authorization')
        ?.match(/^(?:Bearer|DPoP) ([^\s]+)$/u);
      const context = decodeCloudflareAgentAccessRequestContext(
        connectionContext.request.headers.get(AGENT_ACCESS_INTERNAL_CONTEXT_HEADER)
      );
      if (!authorization?.[1] || !context) {
        throw new Error('Agent Access request-local authorization context is unavailable');
      }
      const now = Date.now();
      const sessionStatus = evaluateCloudflareAgentAccessMcpSession({
        state: this.state,
        context,
        now,
      });
      if (sessionStatus !== 'active') {
        connection.close(1008, `Agent Access MCP session ${sessionStatus}`);
        throw new Error(`Agent Access MCP session ${sessionStatus}`);
      }
      this.setState({ ...this.state, lastActivityAt: now });
      return runWithCloudflareAgentAccessRequest(
        { context, sourceAccessToken: authorization[1] },
        () => super.onConnect(connection, connectionContext)
      );
    }

    async init(): Promise<void> {
      const context = this.props?.context;
      // A read-only validation RPC may address a non-existent named DO. Let that empty object
      // initialize so getInitializeRequest() can return not_found, but never accept a previously
      // bound session without its verified persisted context.
      if (!context) {
        if (this.state.contextBinding) {
          throw new Error('Agent Access MCP authentication context is unavailable');
        }
        return;
      }
      const binding = toCloudflareAgentAccessSessionBinding(context);
      if (this.state.contextBinding) {
        assertSessionBinding(this.state.contextBinding, context);
        return;
      }
      const now = Date.now();
      this.setState({ initializedAt: now, lastActivityAt: now, contextBinding: binding });
    }

    async validateSessionContextRpc(
      context: AgentAccessMcpRequestContext,
      now: number
    ): Promise<Exclude<CloudflareAgentAccessMcpSessionStatus, 'unavailable'>> {
      // Do not refresh activity before method/content negotiation succeeds. onConnect records
      // activity only after the request has passed admission and reached the real transport.
      return evaluateCloudflareAgentAccessMcpSession({ state: this.state, context, now });
    }
  }
  return AgentAccessMcpAgent as unknown as CloudflareAgentAccessMcpAgentClass<Env>;
}
