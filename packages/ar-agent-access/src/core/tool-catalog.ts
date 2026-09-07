import { canonicalizeJson } from './canonical-json';
import { computeAgentToolContractDigest } from './tool-contract';
import type { AgentToolDefinition, JsonObject, JsonValue } from './types';

export interface AgentToolCatalog {
  version: string;
  list(): readonly AgentToolDefinition[];
  get(toolName: string): AgentToolDefinition | undefined;
}

/** Phase 1 Admin read capabilities shared by the MCP catalog and Grant eligibility API. */
export const PHASE_ONE_ADMIN_READ_PERMISSIONS = Object.freeze({
  users: 'admin:users:read',
  clients: 'admin:clients:read',
  audit: 'admin:admin_audit:read',
  settings: 'admin:agent_settings:read',
  grants: 'admin:agent_grants:read',
} as const);

function freezeJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    const copy: JsonValue[] = value.map(freezeJson);
    Object.freeze(copy);
    return copy;
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) value[key] = freezeJson(value[key]);
    return Object.freeze(value);
  }
  return value;
}

function immutableSchema(schema: JsonObject): JsonObject {
  return freezeJson(JSON.parse(canonicalizeJson(schema)) as JsonObject) as JsonObject;
}

export function createAgentToolCatalog(
  version: string,
  tools: readonly AgentToolDefinition[]
): AgentToolCatalog {
  const byName = new Map<string, AgentToolDefinition>();
  for (const tool of tools) {
    if (byName.has(tool.name)) throw new TypeError(`Duplicate Agent tool name: ${tool.name}`);
    if (tool.schemaDigest !== computeAgentToolContractDigest(tool)) {
      throw new TypeError(`Agent tool contract digest mismatch: ${tool.id}`);
    }
    byName.set(
      tool.name,
      Object.freeze({
        ...tool,
        requiredPermissions: Object.freeze([...tool.requiredPermissions]),
        inputSchema: immutableSchema(tool.inputSchema),
        outputSchema: tool.outputSchema ? immutableSchema(tool.outputSchema) : undefined,
        annotations: tool.annotations ? Object.freeze({ ...tool.annotations }) : undefined,
        protocolMetadata: tool.protocolMetadata
          ? immutableSchema(tool.protocolMetadata)
          : undefined,
      })
    );
  }
  const snapshot = Object.freeze([...byName.values()]);
  return {
    version,
    list: () => snapshot,
    get: (toolName) => byName.get(toolName),
  };
}

/**
 * Public Mode A standard writes require both an explicit Tool declaration and conservative MCP
 * annotations. Annotations are only a catalog consistency check here; clients cannot influence
 * this decision.
 */
export function isPublicClientStandardOptInEligibleTool(tool: AgentToolDefinition): boolean {
  return (
    tool.publicClientStandardOptInEligible === true &&
    tool.riskLevel === 'standard' &&
    tool.annotations?.readOnlyHint === false &&
    tool.annotations.destructiveHint === false &&
    tool.annotations.idempotentHint === true &&
    tool.annotations.openWorldHint === false
  );
}
