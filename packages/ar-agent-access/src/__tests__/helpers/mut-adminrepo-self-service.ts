import { canonicalizeJson, sha256Base64Url } from '../../core/canonical-json';
import type {
  CreateSelfServiceAgentAuthorizationInput,
  ReplaceSelfServiceAgentAuthorizationInput,
} from '../../core/repositories/admin-agent-access-repository';
import { selfServiceRevocationOutboxId } from '../../core/self-service';
import type { JsonValue } from '../../core/types';
import { mutAudit, mutTool } from './mut-adminrepo-adapter';

export const mutPolicy = {
  tenantIds: ['tenant-1'],
  environmentIds: [],
  domains: [],
  resourceIds: [],
  selectors: [],
  allowedFields: [],
  piiMode: 'masked' as const,
  maxPerCall: 50,
  maxPlanOperations: 25,
  maxBulkTenants: 1,
};

const json = (value: unknown) => canonicalizeJson(value as JsonValue);

/** Builds a fully consistent self-service authorization (digests computed for real). */
export async function mutSelfServiceInput(
  options: { generation?: number; consentVersion?: number } = {}
): Promise<CreateSelfServiceAgentAuthorizationInput> {
  const generation = options.generation ?? 1;
  const consentVersion = options.consentVersion ?? 1;
  const resolved = {
    catalogVersion: 'catalog-v1',
    tools: [mutTool],
    permissions: ['admin:clients:read'],
  };
  const taskDigest = await sha256Base64Url(json(resolved));
  const policyDigest = await sha256Base64Url(json(mutPolicy));
  const accessSnapshotHash = await sha256Base64Url(
    json({
      purpose: 'authrim-agent-self-service-snapshot-v1',
      tenant_id: 'tenant-1',
      admin_user_id: 'admin-1',
      client_id: 'client-1',
      grant_id: 'grant-1',
      expires_at: 700,
      scopes: ['agent:read'],
      task_set: { id: 'task-1', version: 1, digest: taskDigest },
      scope_policy: { id: 'policy-1', version: 1, digest: policyDigest },
      tools: [mutTool],
    })
  );
  const consentBase = {
    tenantId: 'tenant-1',
    grantId: 'grant-1',
    userId: 'admin-1',
    clientId: 'client-1',
    consentVersion,
    scopes: ['agent:read' as const],
    grantedAt: 100,
  };
  return {
    grant: {
      grantId: 'grant-1',
      tenantId: 'tenant-1',
      clientId: 'client-1',
      grantorId: 'admin-1',
      delegatorId: 'admin-1',
      permissions: ['admin:clients:read'],
      scopes: ['agent:read'],
      authorizationDetails: [{ type: 'authrim_admin_agent', max_subjects_per_call: 50 }],
      resolvedScopeConstraints: {
        tenantIds: ['tenant-1'],
        piiMode: 'masked',
        maxPerCall: 50,
        maxPerPlan: 25,
        maxPerBulkPlan: 1,
      },
      consentVersion,
      generation,
      status: 'active',
      delegationMode: 'user_consent',
      taskSetId: 'task-1',
      taskSetVersion: 1,
      scopePolicyId: 'policy-1',
      scopePolicyVersion: 1,
      resolvedTools: [mutTool],
      accessSnapshotHash,
      purpose: 'interactive_self_service',
      managementMode: 'system_managed',
      expiresAt: 700,
      createdAt: 100,
    },
    taskSet: {
      id: 'task-1',
      version: 1,
      digest: taskDigest,
      resolved: { ...resolved, digest: taskDigest },
    },
    scopePolicy: {
      id: 'policy-1',
      version: 1,
      digest: policyDigest,
      definition: mutPolicy,
      selectorCatalogVersion: 'selectors-v1',
    },
    delegationConsent: { ...consentBase, id: 'consent-d', type: 'delegation' },
    oauthClientConsent: { ...consentBase, id: 'consent-o', type: 'oauth_client' },
    audit: mutAudit('audit-create', { action: 'agent.grant.created' }),
    consentAudit: mutAudit('audit-consent', { action: 'agent.consent.granted' }),
  };
}

export async function mutReplaceInput(): Promise<ReplaceSelfServiceAgentAuthorizationInput> {
  const base = await mutSelfServiceInput({ generation: 2, consentVersion: 2 });
  return {
    grant: base.grant,
    taskSet: base.taskSet,
    scopePolicy: base.scopePolicy,
    delegationConsent: base.delegationConsent,
    oauthClientConsent: base.oauthClientConsent,
    expectedGeneration: 1,
    transitionId: 'transition-1',
    outboxId: selfServiceRevocationOutboxId('transition-1'),
    grantAudit: mutAudit('audit-grant'),
    consentAudit: mutAudit('audit-consent'),
  };
}

/** The admin_agent_grants replay row that exactly matches a replace input (idempotent retry). */
export function mutReplayRow(input: ReplaceSelfServiceAgentAuthorizationInput) {
  const g = input.grant;
  return {
    machine_principal_id: g.machinePrincipalId ?? null,
    grantor_id: g.grantorId,
    permissions: JSON.stringify(g.permissions),
    scopes: JSON.stringify(g.scopes),
    authorization_details: g.authorizationDetails ? JSON.stringify(g.authorizationDetails) : null,
    resolved_scope_constraints: JSON.stringify(g.resolvedScopeConstraints),
    purpose: g.purpose ?? null,
    management_mode: g.managementMode ?? 'managed',
    task_set_id: g.taskSetId ?? null,
    task_set_version: g.taskSetVersion ?? null,
    scope_policy_id: g.scopePolicyId ?? null,
    scope_policy_version: g.scopePolicyVersion ?? null,
    resolved_tools: g.resolvedTools ? JSON.stringify(g.resolvedTools) : null,
    access_snapshot_hash: g.accessSnapshotHash ?? null,
    generation: g.generation,
    consent_version: g.consentVersion,
    status: g.status,
    delegation_mode: g.delegationMode,
    expires_at: g.expiresAt ?? null,
    updated_at: g.createdAt,
    last_mutation_id: input.transitionId,
  };
}
