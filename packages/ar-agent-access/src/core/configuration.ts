import { hasAdminPermission } from '@authrim/ar-lib-core/types/admin-user';
import { canonicalizeJson, sha256Base64Url } from './canonical-json';
import type {
  AgentRiskLevel,
  AgentScope,
  AgentToolDefinition,
  JsonObject,
  JsonValue,
} from './types';
import type { AgentToolCatalog } from './tool-catalog';

const SAFE_ID = /^[A-Za-z0-9._~-]{1,128}$/u;
const SECRET_REF = /^asr_[A-Za-z0-9_-]{16,120}$/u;
const SECRET_KEY =
  /(?:secret|password|private[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|recovery[_-]?code)/iu;

export interface AgentTaskSetToolEntry {
  toolId: string;
  toolName: string;
  contractVersion: string;
  schemaDigest: string;
  permissions: readonly string[];
  requiredScope: AgentScope;
  riskLevel: AgentRiskLevel;
  requiresElevation: boolean;
}

export interface ResolvedAgentTaskSetVersion {
  catalogVersion: string;
  tools: readonly AgentTaskSetToolEntry[];
  permissions: readonly string[];
  digest: string;
}

export interface AgentScopePolicyDefinition {
  tenantIds: readonly string[];
  environmentIds: readonly string[];
  domains: readonly string[];
  resourceIds: readonly string[];
  selectors: readonly { catalogId: string; version: number; value: string }[];
  allowedFields: readonly string[];
  piiMode: 'masked' | 'explicit_unmasked';
  maxPerCall: number;
  maxPlanOperations: number;
  maxBulkTenants: number;
}

export interface AgentConfigurationPlanStepDefinition {
  id: string;
  operation: string;
  toolContractVersion: string;
  input: JsonObject;
  resourcePrecondition?: string;
}

export interface AgentConfigurationPlanDefinition {
  schemaVersion: 'authrim-agent-plan-v1';
  steps: readonly AgentConfigurationPlanStepDefinition[];
}

export interface ResolvedAgentConfigurationPlan {
  definition: AgentConfigurationPlanDefinition;
  digest: string;
  risks: readonly AgentRiskLevel[];
}

/** Platform-neutral validation contract used at the immutable Plan boundary. */
export interface AgentConfigurationSchemaValidator {
  validate(schema: JsonObject, input: JsonValue): { valid: boolean; errorMessage?: string };
}

/** Plan preconditions are carried separately and injected only at the owner-operation boundary. */
function planStepInputSchema(tool: AgentToolDefinition): JsonObject {
  const schema = tool.inputSchema;
  const sourceProperties =
    schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
      ? (schema.properties as JsonObject)
      : {};
  const properties = Object.fromEntries(
    Object.entries(sourceProperties).filter(([key]) => key !== 'resource_version')
  ) as JsonObject;
  const required = Array.isArray(schema.required)
    ? schema.required.filter(
        (key): key is string => typeof key === 'string' && key !== 'resource_version'
      )
    : [];
  const originalMin =
    typeof schema.minProperties === 'number' && Number.isSafeInteger(schema.minProperties)
      ? Math.max(0, schema.minProperties - 1)
      : 0;
  return {
    ...schema,
    properties,
    required,
    minProperties: Math.max(originalMin, required.length + 1),
  };
}

function uniqueSorted(values: readonly string[], field: string): string[] {
  if (values.some((value) => !SAFE_ID.test(value))) throw new TypeError(`${field} is invalid`);
  return [...new Set(values)].sort();
}

export async function resolveAgentTaskSetVersion(input: {
  toolIds: readonly string[];
  catalog: AgentToolCatalog;
  creatorPermissions: readonly string[];
}): Promise<ResolvedAgentTaskSetVersion> {
  if (input.toolIds.length === 0 || input.toolIds.length > 256) {
    throw new TypeError('Task Set must contain between 1 and 256 Tools');
  }
  const byId = new Map(input.catalog.list().map((tool) => [tool.id, tool]));
  const tools = uniqueSorted(input.toolIds, 'Tool ID').map((toolId) => {
    const tool = byId.get(toolId);
    if (!tool) throw new TypeError(`Unknown Tool ID: ${toolId}`);
    if (
      tool.requiredPermissions.some(
        (permission) => !hasAdminPermission([...input.creatorPermissions], permission)
      )
    ) {
      throw new TypeError(`Tool exceeds creator permissions: ${toolId}`);
    }
    return {
      toolId: tool.id,
      toolName: tool.name,
      contractVersion: tool.contractVersion,
      schemaDigest: tool.schemaDigest,
      permissions: [...tool.requiredPermissions].sort(),
      requiredScope: tool.requiredScope,
      riskLevel: tool.riskLevel,
      requiresElevation: tool.riskLevel === 'high',
    } satisfies AgentTaskSetToolEntry;
  });
  const permissions = [...new Set(tools.flatMap((tool) => tool.permissions))].sort();
  const snapshot = { catalogVersion: input.catalog.version, tools, permissions };
  return { ...snapshot, digest: await sha256Base64Url(canonicalizeJson(snapshot)) };
}

export async function normalizeAgentScopePolicy(
  value: AgentScopePolicyDefinition,
  tenantId: string
): Promise<{ definition: AgentScopePolicyDefinition; digest: string }> {
  if (
    !value ||
    (value.piiMode !== 'masked' && value.piiMode !== 'explicit_unmasked') ||
    !Number.isSafeInteger(value.maxPerCall) ||
    value.maxPerCall < 1 ||
    value.maxPerCall > 100 ||
    !Number.isSafeInteger(value.maxPlanOperations) ||
    value.maxPlanOperations < 1 ||
    value.maxPlanOperations > 100 ||
    !Number.isSafeInteger(value.maxBulkTenants) ||
    value.maxBulkTenants < 1 ||
    value.maxBulkTenants > 1000
  ) {
    throw new TypeError('Scope Policy quantitative limits are invalid');
  }
  const tenantIds = uniqueSorted(value.tenantIds, 'tenantIds');
  if (tenantIds.length === 0 || tenantIds.length > 1000 || !tenantIds.includes(tenantId)) {
    throw new TypeError('Scope Policy must include its owning tenant and at most 1000 targets');
  }
  const selectors = value.selectors.map((selector) => {
    if (
      !SAFE_ID.test(selector.catalogId) ||
      !Number.isSafeInteger(selector.version) ||
      selector.version < 1 ||
      !SAFE_ID.test(selector.value)
    ) {
      throw new TypeError('Scope Policy selector is invalid');
    }
    return { ...selector };
  });
  const definition: AgentScopePolicyDefinition = {
    tenantIds,
    environmentIds: uniqueSorted(value.environmentIds, 'environmentIds'),
    domains: uniqueSorted(value.domains, 'domains'),
    resourceIds: uniqueSorted(value.resourceIds, 'resourceIds'),
    selectors: selectors.sort((a, b) => canonicalizeJson(a).localeCompare(canonicalizeJson(b))),
    allowedFields: uniqueSorted(value.allowedFields, 'allowedFields'),
    piiMode: value.piiMode,
    maxPerCall: value.maxPerCall,
    maxPlanOperations: value.maxPlanOperations,
    maxBulkTenants: value.maxBulkTenants,
  };
  return {
    definition,
    digest: await sha256Base64Url(canonicalizeJson(definition as unknown as JsonValue)),
  };
}

export function assertScopePolicyNarrows(
  base: AgentScopePolicyDefinition,
  candidate: AgentScopePolicyDefinition
): void {
  const subset = (values: readonly string[], allowed: readonly string[]) =>
    values.every((value) => allowed.includes(value));
  if (
    !subset(candidate.tenantIds, base.tenantIds) ||
    !subset(candidate.environmentIds, base.environmentIds) ||
    !subset(candidate.domains, base.domains) ||
    !subset(candidate.resourceIds, base.resourceIds) ||
    !subset(candidate.allowedFields, base.allowedFields) ||
    candidate.selectors.some(
      (selector) =>
        !base.selectors.some((allowed) => canonicalizeJson(allowed) === canonicalizeJson(selector))
    ) ||
    (base.piiMode === 'masked' && candidate.piiMode !== 'masked') ||
    candidate.maxPerCall > base.maxPerCall ||
    candidate.maxPlanOperations > base.maxPlanOperations ||
    candidate.maxBulkTenants > base.maxBulkTenants
  ) {
    throw new TypeError('Scope Policy override may only narrow the named policy');
  }
}

export function assertNoRawSecrets(value: JsonValue, path = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoRawSecrets(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'secret_ref') {
      if (typeof child !== 'string' || !SECRET_REF.test(child)) {
        throw new TypeError(`Invalid opaque secret_ref at ${path}.${key}`);
      }
      continue;
    }
    if (SECRET_KEY.test(key) && child !== null && child !== undefined) {
      throw new TypeError(`Raw secret field is forbidden at ${path}.${key}`);
    }
    assertNoRawSecrets(child as JsonValue, `${path}.${key}`);
  }
}

export async function resolveAgentConfigurationPlan(input: {
  definition: AgentConfigurationPlanDefinition;
  catalog: AgentToolCatalog;
  maxOperations: number;
  schemaValidator: AgentConfigurationSchemaValidator;
}): Promise<ResolvedAgentConfigurationPlan> {
  const { definition } = input;
  if (
    definition.schemaVersion !== 'authrim-agent-plan-v1' ||
    definition.steps.length === 0 ||
    definition.steps.length > input.maxOperations
  ) {
    throw new TypeError('Configuration Plan size or schema version is invalid');
  }
  const seen = new Set<string>();
  const normalizedSteps = definition.steps.map((step) => {
    if (!SAFE_ID.test(step.id) || seen.has(step.id)) throw new TypeError('Plan step ID is invalid');
    seen.add(step.id);
    const tool = input.catalog.list().find((candidate) => candidate.id === step.operation);
    if (!tool || tool.contractVersion !== step.toolContractVersion) {
      throw new TypeError(`Plan operation contract is unavailable: ${step.operation}`);
    }
    if (tool.riskLevel !== 'low' && !step.resourcePrecondition) {
      throw new TypeError(
        `Plan write operation requires a resource precondition: ${step.operation}`
      );
    }
    assertNoRawSecrets(step.input);
    const inputValidation = input.schemaValidator.validate(planStepInputSchema(tool), step.input);
    if (!inputValidation.valid) {
      throw new TypeError(
        `Plan operation input is invalid: ${step.operation}${inputValidation.errorMessage ? ` (${inputValidation.errorMessage})` : ''}`
      );
    }
    if (
      step.resourcePrecondition !== undefined &&
      !/^[A-Za-z0-9._~:/"-]{1,256}$/u.test(step.resourcePrecondition)
    ) {
      throw new TypeError('Plan resource precondition is invalid');
    }
    return {
      id: step.id,
      operation: tool.id,
      toolContractVersion: tool.contractVersion,
      input: JSON.parse(canonicalizeJson(step.input)) as JsonObject,
      ...(step.resourcePrecondition ? { resourcePrecondition: step.resourcePrecondition } : {}),
    };
  });
  const normalized: AgentConfigurationPlanDefinition = {
    schemaVersion: 'authrim-agent-plan-v1',
    steps: normalizedSteps,
  };
  return {
    definition: normalized,
    digest: await sha256Base64Url(canonicalizeJson(normalized as unknown as JsonValue)),
    risks: normalizedSteps.map(
      (step) => input.catalog.list().find((tool) => tool.id === step.operation)!.riskLevel
    ),
  };
}

export function toolSnapshot(tool: AgentToolDefinition): JsonObject {
  return {
    tool_id: tool.id,
    name: tool.name,
    contract_version: tool.contractVersion,
    schema_digest: tool.schemaDigest,
    permissions: [...tool.requiredPermissions],
    risk_level: tool.riskLevel,
    requires_elevation: tool.riskLevel === 'high',
  };
}
