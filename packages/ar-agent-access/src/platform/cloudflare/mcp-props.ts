import type { AgentAccessMcpRequestContext } from '../../protocol/mcp';

export type CloudflareAgentAccessMcpProps = Record<string, unknown> & {
  context: AgentAccessMcpRequestContext;
  /** Verified MCP token retained only in memory for per-operation internal downscope. */
  sourceAccessToken?: string;
};

export type CloudflareAgentAccessStoredProps = Pick<CloudflareAgentAccessMcpProps, 'context'>;

/** McpAgent persists props by default, so bearer material must be stripped before storage. */
export function sanitizeCloudflareAgentAccessMcpPropsForStorage(
  props: CloudflareAgentAccessMcpProps
): CloudflareAgentAccessStoredProps {
  return { context: props.context };
}
