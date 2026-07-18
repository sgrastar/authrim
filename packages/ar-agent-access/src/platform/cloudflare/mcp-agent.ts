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
import {
  AGENT_ACCESS_INTERNAL_CONTEXT_HEADER,
  decodeCloudflareAgentAccessRequestContext,
  getCloudflareAgentAccessCurrentRequest,
  runWithCloudflareAgentAccessRequest,
} from './mcp-request-context';

export type { CloudflareAgentAccessMcpProps, CloudflareAgentAccessStoredProps } from './mcp-props';
export { sanitizeCloudflareAgentAccessMcpPropsForStorage } from './mcp-props';

export interface CloudflareAgentAccessMcpState {
  initializedAt?: number;
  contextBinding?: CloudflareAgentAccessSessionBinding;
}

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

export interface CloudflareAgentAccessMcpAgentOptions<Env extends Cloudflare.Env> {
  createDependencies(
    env: Env,
    getCurrentRequest: typeof getCloudflareAgentAccessCurrentRequest
  ): AgentAccessMcpServerDependencies;
}

/** Public constructor surface; Agents SDK private class members must not leak into declarations. */
export interface CloudflareAgentAccessMcpAgentInstance<Env extends Cloudflare.Env> extends McpAgent<
  Env,
  CloudflareAgentAccessMcpState,
  CloudflareAgentAccessMcpProps
> {
  server: Server;
  init(): Promise<void>;
}

export interface CloudflareAgentAccessMcpAgentClass<
  Env extends Cloudflare.Env,
> extends CloudflareMcpAgentServeFactory<Env> {
  new (ctx: DurableObjectState, env: Env): CloudflareAgentAccessMcpAgentInstance<Env>;
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
        options.createDependencies(this.env, getCloudflareAgentAccessCurrentRequest)
      ),
      () => {
        const context = getCloudflareAgentAccessCurrentRequest()?.context;
        if (!context) throw new Error('Agent Access MCP authentication context is unavailable');
        assertSessionBinding(this.state.contextBinding, context);
        return context;
      }
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
      assertSessionBinding(this.state.contextBinding, context);
      return runWithCloudflareAgentAccessRequest(
        { context, sourceAccessToken: authorization[1] },
        () => super.onConnect(connection, connectionContext)
      );
    }

    async init(): Promise<void> {
      const context = this.props?.context;
      if (!context) throw new Error('Agent Access MCP authentication context is unavailable');
      const binding = toCloudflareAgentAccessSessionBinding(context);
      if (this.state.contextBinding) {
        assertSessionBinding(this.state.contextBinding, context);
        return;
      }
      this.setState({ initializedAt: Date.now(), contextBinding: binding });
    }
  }
  return AgentAccessMcpAgent as unknown as CloudflareAgentAccessMcpAgentClass<Env>;
}
