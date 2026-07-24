import type {
  AgentConfigurationRepository,
  AgentTaskSetRecord,
} from './repositories/agent-configuration-repository';
import { resolveAgentTaskSetVersion } from './configuration';
import type { AgentToolCatalog } from './tool-catalog';

export type BuiltinAgentTaskSetName =
  | 'read_only_inspector'
  | 'user_data_reader'
  | 'diagnostics_operator'
  | 'configuration_designer'
  | 'configuration_operator'
  | 'bulk_configuration_operator';

export interface BuiltinAgentTaskSetPreset {
  id: string;
  name: BuiltinAgentTaskSetName;
  description: string;
  version: 8;
  catalogVersion: 'admin-agent-access-v9';
  expectedDigest: string;
  toolIds: readonly string[];
}

const DISCOVERY_CONTROL_TOOLS = ['admin.session.discovery-profiles.select'] as const;

const GENERAL_READ_TOOLS = [
  ...DISCOVERY_CONTROL_TOOLS,
  'admin.read.runtime.diagnostics',
  'admin.read.clients.list',
  'admin.read.clients.get',
  'admin.read.audit.search',
  'admin.read.agent-settings.get',
  'admin.read.agent-grants.list',
  'admin.read.agent-access.explain',
  'admin.read.identity-providers.inspect',
  'admin.read.authorization.organizations',
  'admin.read.authorization.roles',
  'admin.read.authorization.policies',
  'admin.read.flows.inspect',
  'admin.read.consent.inspect',
  'admin.read.sessions.inspect',
  'admin.read.assurance.inspect',
  'admin.read.protocol-security.inspect',
  'admin.read.oauth.inspect',
  'admin.read.token-exchange.inspect',
  'admin.read.logout.inspect',
  'admin.read.webhooks.inspect',
  'admin.read.login-ui.inspect',
  'admin.read.conformance.inspect',
  'admin.read.flows.validate',
  'admin.read.authorization.simulate',
  'admin.read.tenant-policy.validate',
  'admin.read.clients.profile-validate',
] as const;

const USER_DATA_READ_TOOLS = [
  ...DISCOVERY_CONTROL_TOOLS,
  'admin.read.users.search',
  'admin.read.users.get',
] as const;

const CONFIGURATION_READ_TOOLS = [
  'admin.read.configuration.capabilities',
  'admin.read.configuration.plan.diff',
  'admin.read.configuration.plan.status',
  'admin.read.configuration.plan.verify',
] as const;

const CONFIGURATION_DESIGN_TOOLS = [
  'admin.write.configuration.plan.create',
  'admin.write.configuration.plan.validate',
] as const;

const CONFIGURATION_APPLY_TOOLS = [
  'admin.write.configuration.plan.apply',
  'admin.write.configuration.plan.cancel',
  'admin.write.clients.metadata',
  'admin.write.login-ui.update',
] as const;

const BULK_TOOLS = [
  'admin.write.bulk.plan.create',
  'admin.read.bulk.plan.get',
  'admin.write.bulk.plan.validate',
] as const;

function preset(
  name: BuiltinAgentTaskSetName,
  description: string,
  toolIds: readonly string[],
  expectedDigest: string
): BuiltinAgentTaskSetPreset {
  return Object.freeze({
    id: `builtin_agent_task_set_${name}`,
    name,
    description,
    version: 8 as const,
    catalogVersion: 'admin-agent-access-v9' as const,
    expectedDigest,
    toolIds: Object.freeze([...new Set(toolIds)]),
  });
}

export const BUILTIN_AGENT_TASK_SET_PRESETS: readonly BuiltinAgentTaskSetPreset[] = Object.freeze([
  preset(
    'read_only_inspector',
    'Inspect clients, identity configuration, authorization, protocol security, sessions, integrations, audit, and Agent Access configuration without user data.',
    GENERAL_READ_TOOLS,
    'u49bs50zVMDoRNR_D2zRJ9OWBb_HEReUTdViarG08Uc'
  ),
  preset(
    'user_data_reader',
    'Search and inspect masked tenant user data. Assign only when the MCP host and model data policy are approved.',
    USER_DATA_READ_TOOLS,
    'JET784ODvcv_ZBZO7Yfb59-NqSslyqqgEbfHiTCyoSo'
  ),
  preset(
    'diagnostics_operator',
    'Inspect tenant state and configuration Plan evidence for diagnosis and verification.',
    [...GENERAL_READ_TOOLS, ...CONFIGURATION_READ_TOOLS],
    'L5PMVYmQNcv1TvqUgMY7P75Pvs02tq4Kze1zHrZL4Zc'
  ),
  preset(
    'configuration_designer',
    'Inspect configuration and create, validate, review, and verify immutable Plans without apply.',
    [...GENERAL_READ_TOOLS, ...CONFIGURATION_READ_TOOLS, ...CONFIGURATION_DESIGN_TOOLS],
    'JQ_DD8EaPb2bV_KvOd0BM1wrQRH7Pe6RckXIf0321YQ'
  ),
  preset(
    'configuration_operator',
    'Design and apply reviewed single-tenant configuration Plans using allowlisted operations.',
    [
      ...GENERAL_READ_TOOLS,
      ...CONFIGURATION_READ_TOOLS,
      ...CONFIGURATION_DESIGN_TOOLS,
      ...CONFIGURATION_APPLY_TOOLS,
    ],
    'IKzJzvGZY056MZMpHd3RloaZH4joF49ANVoDHntY-P4'
  ),
  preset(
    'bulk_configuration_operator',
    'Design and validate immutable multi-tenant rollout Plans with explicit target snapshots.',
    [
      ...GENERAL_READ_TOOLS,
      ...CONFIGURATION_READ_TOOLS,
      ...CONFIGURATION_DESIGN_TOOLS,
      ...CONFIGURATION_APPLY_TOOLS,
      ...BULK_TOOLS,
    ],
    'SOMb-b3fNef_nyGvvt4FHn-z0XBTsaj9hZw42UNNC1U'
  ),
]);

function findPreset(id: string): BuiltinAgentTaskSetPreset | undefined {
  return BUILTIN_AGENT_TASK_SET_PRESETS.find((candidate) => candidate.id === id);
}

export async function resolveBuiltinAgentTaskSet(input: {
  tenantId: string;
  id: string;
  version: number;
  catalog: AgentToolCatalog;
}): Promise<AgentTaskSetRecord | null> {
  const definition = findPreset(input.id);
  if (!definition || input.version !== definition.version) return null;
  if (input.catalog.version !== definition.catalogVersion) {
    throw new TypeError(
      `Built-in Task Set ${definition.id} v${definition.version} requires catalog ${definition.catalogVersion}`
    );
  }
  const resolved = await resolveAgentTaskSetVersion({
    toolIds: definition.toolIds,
    catalog: input.catalog,
    creatorPermissions: ['admin:*'],
  });
  if (resolved.digest !== definition.expectedDigest) {
    throw new TypeError(
      `Built-in Task Set ${definition.id} v${definition.version} digest differs from its immutable snapshot`
    );
  }
  return {
    id: definition.id,
    tenantId: input.tenantId,
    name: definition.name,
    description: definition.description,
    kind: 'builtin',
    managementMode: 'managed',
    status: 'active',
    currentVersion: definition.version,
    version: resolved,
    createdAt: 0,
    updatedAt: 0,
  };
}

export async function listAgentTaskSetsWithBuiltins(input: {
  repository: AgentConfigurationRepository;
  catalog: AgentToolCatalog;
  tenantId: string;
}): Promise<AgentTaskSetRecord[]> {
  const builtins = await Promise.all(
    BUILTIN_AGENT_TASK_SET_PRESETS.map((definition) =>
      resolveBuiltinAgentTaskSet({
        tenantId: input.tenantId,
        id: definition.id,
        version: definition.version,
        catalog: input.catalog,
      })
    )
  );
  const stored = await input.repository.listTaskSets(input.tenantId);
  return [...builtins.filter((item): item is AgentTaskSetRecord => item !== null), ...stored];
}

export async function getAgentTaskSetWithBuiltins(input: {
  repository: AgentConfigurationRepository;
  catalog: AgentToolCatalog;
  tenantId: string;
  id: string;
  version?: number;
}): Promise<AgentTaskSetRecord | null> {
  const definition = findPreset(input.id);
  if (definition) {
    return resolveBuiltinAgentTaskSet({
      tenantId: input.tenantId,
      id: input.id,
      version: input.version ?? definition.version,
      catalog: input.catalog,
    });
  }
  return input.version === undefined
    ? input.repository.getTaskSet(input.tenantId, input.id)
    : input.repository.getTaskSetVersion(input.tenantId, input.id, input.version);
}
