import { createAgentToolCatalog } from '../../core/tool-catalog';
import { sealAgentToolDefinition } from '../../core/tool-contract';
import type { AgentToolDefinition, AgentToolDefinitionSource } from '../../core/types';

export function makeCoreTool(
  overrides: Partial<AgentToolDefinitionSource> = {}
): AgentToolDefinition {
  return sealAgentToolDefinition({
    id: 'admin.write.clients.metadata',
    name: 'update_client_metadata',
    title: 'Update client metadata',
    description: 'Updates allowlisted display metadata.',
    contractVersion: '1',
    requiredPermissions: ['admin:clients:write'],
    requiredScope: 'agent:write',
    riskLevel: 'standard',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { client_id: { type: 'string' }, client_name: { type: 'string' } },
      required: ['client_id'],
    },
    ...overrides,
  });
}

export function makeCoreCatalog(tools: readonly AgentToolDefinition[], version = 'catalog-v1') {
  return createAgentToolCatalog(version, tools);
}
