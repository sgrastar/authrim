import { ADMIN_PERMISSIONS } from '@authrim/ar-lib-core/types/admin-user';
import {
  BUILTIN_AGENT_DISCOVERY_PROFILES,
  sealAgentToolDefinitions,
  type AgentToolDefinition,
} from '../../core';

const PROFILE_IDS = BUILTIN_AGENT_DISCOVERY_PROFILES.map((profile) => profile.id);
const READ = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export const ADMIN_DISCOVERY_TOOL_DEFINITIONS: readonly AgentToolDefinition[] =
  sealAgentToolDefinitions([
    {
      id: 'admin.session.discovery-profiles.select',
      name: 'set_active_tool_profiles',
      title: 'Set active tool profiles',
      description:
        'Select session-local Tool discovery profiles from capabilities already authorized by this Grant. This never adds authority.',
      contractVersion: '1',
      requiredPermissions: [ADMIN_PERMISSIONS.AGENT_USE],
      requiredScope: 'agent:read',
      riskLevel: 'low',
      schemaDigest: 'sha256:4ffee557eec1d1378e12e259f7edf55fcb8b7a2746f22cb8cbdbb5d6b5a1d303',
      inputSchema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        additionalProperties: false,
        properties: {
          profile_ids: {
            type: 'array',
            minItems: 1,
            maxItems: PROFILE_IDS.length,
            uniqueItems: true,
            items: { type: 'string', enum: PROFILE_IDS },
            not: {
              allOf: [{ contains: { const: 'all_granted' } }, { minItems: 2 }],
            },
          },
        },
        required: ['profile_ids'],
      },
      outputSchema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        additionalProperties: false,
        properties: {
          selected_profile_ids: { type: 'array', items: { type: 'string' } },
          visible_tool_count: { type: 'integer', minimum: 1 },
          available_profiles: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                description: { type: 'string' },
                granted_tool_count: { type: 'integer', minimum: 1 },
              },
              required: ['id', 'title', 'description', 'granted_tool_count'],
            },
          },
        },
        required: ['selected_profile_ids', 'visible_tool_count', 'available_profiles'],
      },
      annotations: READ,
      taskSupport: 'forbidden',
      executionTarget: 'session_control',
    },
  ]);
