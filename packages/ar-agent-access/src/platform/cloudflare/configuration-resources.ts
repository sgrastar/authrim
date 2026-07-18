import {
  AgentConfigurationRepository,
  listAgentTaskSetsWithBuiltins,
  type AgentToolCatalog,
  type JsonObject,
} from '../../core';
import type {
  AgentConfigurationResourceReaderPort,
  AgentConfigurationResourceSubject,
} from '../ports';

/** DatabaseAdapter-backed dynamic MCP Resource reader for the Cloudflare composition. */
export class CloudflareAgentConfigurationResourceReader implements AgentConfigurationResourceReaderPort {
  constructor(
    private readonly repository: AgentConfigurationRepository,
    private readonly catalog: AgentToolCatalog
  ) {}

  async readTenantSummary(subject: AgentConfigurationResourceSubject): Promise<JsonObject | null> {
    if (!(await this.repository.isActiveTenant(subject.tenantId))) return null;
    const [taskSets, scopePolicies, plans] = await Promise.all([
      listAgentTaskSetsWithBuiltins({
        repository: this.repository,
        catalog: this.catalog,
        tenantId: subject.tenantId,
      }),
      this.repository.listScopePolicies(subject.tenantId),
      this.repository.listPlans(subject.tenantId, 25),
    ]);
    return {
      schema_version: 'authrim-tenant-configuration-summary-v1',
      tenant_id: subject.tenantId,
      catalog_version: this.catalog.version,
      task_sets: taskSets.map((item) => ({
        id: item.id,
        name: item.name,
        version: item.currentVersion,
        digest: item.version.digest,
        status: item.status,
      })),
      scope_policies: scopePolicies.map((item) => ({
        id: item.id,
        name: item.name,
        version: item.currentVersion,
        digest: item.definitionDigest,
        status: item.status,
      })),
      recent_plans: plans
        .filter(
          (item) =>
            item.grantId === subject.grantId &&
            item.grantGeneration === subject.grantGeneration &&
            item.consentVersion === subject.consentVersion &&
            item.actorSub === subject.actorSub &&
            item.clientId === subject.clientId
        )
        .map((item) => ({
          id: item.id,
          version: item.version,
          digest: item.definitionDigest,
          status: item.status,
          stage: item.stage,
          updated_at: item.updatedAt,
        })),
    };
  }

  async readPlan(
    subject: AgentConfigurationResourceSubject,
    planId: string
  ): Promise<JsonObject | null> {
    if (!(await this.repository.isActiveTenant(subject.tenantId))) return null;
    const plan = await this.repository.getLatestPlan(subject.tenantId, planId);
    if (
      !plan ||
      plan.grantId !== subject.grantId ||
      plan.grantGeneration !== subject.grantGeneration ||
      plan.consentVersion !== subject.consentVersion ||
      plan.actorSub !== subject.actorSub ||
      plan.clientId !== subject.clientId
    ) {
      return null;
    }
    return {
      schema_version: 'authrim-agent-plan-resource-v1',
      id: plan.id,
      version: plan.version,
      digest: plan.definitionDigest,
      status: plan.status,
      stage: plan.stage,
      definition: (plan.definition as unknown as JsonObject | undefined) ?? null,
      diff: plan.diff ?? null,
      validation: plan.validation ?? null,
      result: plan.result ?? null,
      created_at: plan.createdAt,
      updated_at: plan.updatedAt,
      expires_at: plan.expiresAt,
    };
  }
}
