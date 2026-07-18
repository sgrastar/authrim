import { ADMIN_PERMISSIONS } from '@authrim/ar-lib-core/types/admin-user';
import type { AgentToolDefinition, JsonObject } from '../../core';

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

const PLAN_REF = objectSchema({ bulk_plan_id: ID, version: VERSION }, ['bulk_plan_id', 'version']);

const BULK_DEFINITION: JsonObject = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'targetTenantIds', 'canaryTenantIds', 'plan'],
  properties: {
    schemaVersion: { const: 'authrim-agent-bulk-plan-v1' },
    targetTenantIds: {
      type: 'array',
      minItems: 1,
      maxItems: 1000,
      uniqueItems: true,
      items: ID,
    },
    canaryTenantIds: {
      type: 'array',
      minItems: 1,
      maxItems: 5,
      uniqueItems: true,
      items: ID,
    },
    plan: {
      type: 'object',
      additionalProperties: false,
      required: ['schemaVersion', 'steps'],
      properties: {
        schemaVersion: { const: 'authrim-agent-plan-v1' },
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'operation', 'toolContractVersion', 'input', 'resourcePrecondition'],
            properties: {
              id: ID,
              operation: ID,
              toolContractVersion: { type: 'string', minLength: 1, maxLength: 32 },
              input: { type: 'object' },
              resourcePrecondition: { const: 'per-tenant-validation' },
            },
          },
        },
      },
    },
    rollout: {
      type: 'object',
      additionalProperties: false,
      properties: {
        canarySize: { type: 'integer', minimum: 1, maximum: 5 },
        waveSize: { type: 'integer', minimum: 1, maximum: 25 },
        waveFailureThresholdBasisPoints: { type: 'integer', minimum: 0, maximum: 500 },
      },
    },
  },
};

export const ADMIN_BULK_TOOL_DEFINITIONS: readonly AgentToolDefinition[] = [
  {
    id: 'admin.write.bulk.plan.create',
    name: 'create_bulk_plan',
    title: 'Create a cross-tenant Bulk Plan',
    description:
      'Create an immutable draft for an explicit tenant snapshot. A human must separately approve and start it in Authrim.',
    contractVersion: '1',
    requiredPermissions: [
      ADMIN_PERMISSIONS.BULK_PLANS_CREATE,
      ADMIN_PERMISSIONS.BULK_PLANS_APPLY,
      ADMIN_PERMISSIONS.CLIENTS_READ,
    ],
    requiredScope: 'agent:write',
    riskLevel: 'standard',
    schemaDigest: 'sha256:cd0395fb72b5e1e40a97664ea6dde503ba9d9ae97096aa10b2e7d3e2bf2444d0',
    inputSchema: objectSchema({ definition: BULK_DEFINITION }, ['definition']),
    outputSchema: objectSchema(
      {
        bulk_plan_id: ID,
        version: VERSION,
        digest: { type: 'string' },
        status: { const: 'draft' },
      },
      ['bulk_plan_id', 'version', 'digest', 'status']
    ),
    annotations: WRITE,
    taskSupport: 'forbidden',
    executionTarget: 'bulk_plan',
  },
  {
    id: 'admin.read.bulk.plan.get',
    name: 'get_bulk_plan',
    title: 'Get a cross-tenant Bulk Plan',
    description: 'Read one immutable Bulk Plan version and its tenant execution results.',
    contractVersion: '1',
    requiredPermissions: [ADMIN_PERMISSIONS.BULK_PLANS_READ],
    requiredScope: 'agent:read',
    riskLevel: 'low',
    schemaDigest: 'sha256:bb1735c0fef3ab0e819380104f0d86fa03f7580a16c2501819f70cbce2a050db',
    inputSchema: PLAN_REF,
    outputSchema: objectSchema(
      { bulk_plan: { type: 'object' }, tenant_executions: { type: 'array' } },
      ['bulk_plan', 'tenant_executions']
    ),
    annotations: READ,
    taskSupport: 'forbidden',
    executionTarget: 'bulk_plan',
  },
  {
    id: 'admin.write.bulk.plan.validate',
    name: 'validate_bulk_plan',
    title: 'Validate a cross-tenant Bulk Plan',
    description:
      'Recheck immutable targets, Grant, actor, and per-tenant permissions before human approval.',
    contractVersion: '1',
    requiredPermissions: [ADMIN_PERMISSIONS.BULK_PLANS_CREATE],
    requiredScope: 'agent:write',
    riskLevel: 'standard',
    schemaDigest: 'sha256:bb1735c0fef3ab0e819380104f0d86fa03f7580a16c2501819f70cbce2a050db',
    inputSchema: PLAN_REF,
    outputSchema: objectSchema({ bulk_plan_id: ID, version: VERSION, status: { const: 'ready' } }, [
      'bulk_plan_id',
      'version',
      'status',
    ]),
    annotations: WRITE,
    taskSupport: 'forbidden',
    executionTarget: 'bulk_plan',
  },
];
