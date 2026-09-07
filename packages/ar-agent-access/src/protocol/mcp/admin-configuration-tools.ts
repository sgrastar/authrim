import { ADMIN_PERMISSIONS } from '@authrim/ar-lib-core/types/admin-user';
import { sealAgentToolDefinitions, type AgentToolDefinition, type JsonObject } from '../../core';

const ID = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._~-]+$' };
const VERSION = { type: 'integer', minimum: 1, maximum: 2147483647 };
const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function objectSchema(properties: JsonObject, required: string[] = []): JsonObject {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

const PLAN_REF = objectSchema({ plan_id: ID, version: VERSION }, ['plan_id', 'version']);

/** High-level Copilot tools. Low-level owner operations remain separately typed catalog entries. */
export const ADMIN_CONFIGURATION_TOOL_DEFINITIONS: readonly AgentToolDefinition[] =
  sealAgentToolDefinitions([
    {
      id: 'admin.read.configuration.capabilities',
      name: 'get_auth_configuration_capabilities',
      title: 'Get authentication configuration capabilities',
      description:
        'List versioned Authrim configuration operations, Task Sets, Scope Policies, and constraints visible to this Grant.',
      contractVersion: '1',
      requiredPermissions: [ADMIN_PERMISSIONS.AUTH_CONFIG_PLANS_READ],
      requiredScope: 'agent:read',
      riskLevel: 'low',
      schemaDigest: 'sha256:71fc596a20f27da3dec80050e5d1f553eba34aea24c2853b853488a811e6b892',
      inputSchema: objectSchema({}),
      outputSchema: objectSchema(
        {
          catalog_version: { type: 'string' },
          tools: { type: 'array', items: { type: 'object' } },
          task_sets: { type: 'array', items: { type: 'object' } },
          scope_policies: { type: 'array', items: { type: 'object' } },
        },
        ['catalog_version', 'tools', 'task_sets', 'scope_policies']
      ),
      annotations: READ,
      taskSupport: 'forbidden',
      executionTarget: 'configuration_plan',
    },
    {
      id: 'admin.write.configuration.plan.create',
      name: 'create_auth_config_plan',
      title: 'Create authentication configuration plan',
      description:
        'Create an immutable version-bound Plan using only catalogued operations and opaque secret_ref handles.',
      contractVersion: '1',
      requiredPermissions: [ADMIN_PERMISSIONS.AUTH_CONFIG_PLANS_CREATE],
      requiredScope: 'agent:write',
      riskLevel: 'standard',
      schemaDigest: 'sha256:92055f763ab197ea017f9a677081d80e969390eea3709361c0b7a064c774095f',
      inputSchema: objectSchema(
        {
          definition: {
            type: 'object',
            additionalProperties: false,
            required: ['schemaVersion', 'goal', 'steps'],
            properties: {
              schemaVersion: { const: 'authrim-agent-plan-v1' },
              goal: { type: 'string', minLength: 1, maxLength: 500 },
              steps: {
                type: 'array',
                minItems: 1,
                maxItems: 100,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: [
                    'id',
                    'operation',
                    'toolContractVersion',
                    'input',
                    'resourcePrecondition',
                  ],
                  properties: {
                    id: ID,
                    operation: ID,
                    toolContractVersion: { type: 'string', minLength: 1, maxLength: 32 },
                    input: { type: 'object' },
                    resourcePrecondition: { type: 'string', minLength: 1, maxLength: 256 },
                  },
                },
              },
            },
          },
        },
        ['definition']
      ),
      outputSchema: objectSchema(
        { plan_id: ID, version: VERSION, digest: { type: 'string' }, status: { const: 'draft' } },
        ['plan_id', 'version', 'digest', 'status']
      ),
      annotations: WRITE,
      publicClientStandardOptInEligible: true,
      taskSupport: 'forbidden',
      executionTarget: 'configuration_plan',
    },
    ...([
      ['validate_auth_config_plan', 'admin.write.configuration.plan.validate', 'validate'],
      ['get_auth_config_plan_diff', 'admin.read.configuration.plan.diff', 'diff'],
      ['apply_auth_config_plan', 'admin.write.configuration.plan.apply', 'apply'],
      ['cancel_auth_config_plan', 'admin.write.configuration.plan.cancel', 'cancel'],
      ['get_auth_config_plan_status', 'admin.read.configuration.plan.status', 'status'],
      ['verify_auth_config_plan', 'admin.read.configuration.plan.verify', 'verify'],
    ].map(([name, id, action]) => ({
      id,
      name,
      title: `${action![0]!.toUpperCase()}${action!.slice(1)} authentication configuration Plan`,
      description: `${action} a version-bound immutable authentication configuration Plan.`,
      contractVersion: '1',
      requiredPermissions: [
        action === 'apply'
          ? ADMIN_PERMISSIONS.AUTH_CONFIG_PLANS_APPLY
          : action === 'cancel'
            ? ADMIN_PERMISSIONS.AUTH_CONFIG_PLANS_CANCEL
            : action === 'validate'
              ? ADMIN_PERMISSIONS.AUTH_CONFIG_PLANS_CREATE
              : ADMIN_PERMISSIONS.AUTH_CONFIG_PLANS_READ,
      ],
      requiredScope:
        action === 'apply' || action === 'validate' || action === 'cancel'
          ? 'agent:write'
          : 'agent:read',
      riskLevel: action === 'apply' || action === 'cancel' ? 'standard' : 'low',
      schemaDigest: 'sha256:1d40a19595c02a61e6ce1dc8e4283683288730441a14957c5d248cc4648cb991',
      inputSchema: PLAN_REF,
      outputSchema: objectSchema({ plan: { type: 'object' } }, ['plan']),
      annotations:
        action === 'apply' || action === 'validate' || action === 'cancel' ? WRITE : READ,
      publicClientStandardOptInEligible: action === 'apply' || action === 'cancel',
      taskSupport: 'forbidden',
      executionTarget: 'configuration_plan',
    })) as readonly AgentToolDefinition[]),
  ]);
