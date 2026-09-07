import {
  AgentBaselineRepository,
  AgentBulkRepository,
  canonicalizeJson,
  evaluateAgentBaselineConfiguration,
  resolveAgentBulkPlan,
  sha256Base64Url,
  type AdminAgentAuditWrite,
  type AgentBaselineAssignmentContext,
  type AgentBulkPlanRecord,
  type JsonObject,
} from '../../core';
import type {
  AgentClockPort,
  AgentConfigurationStateReaderPort,
  AgentSettingsPort,
} from '../ports';

const MANAGED_EVALUATION_INTERVAL_MS = 15 * 60_000;

export interface AgentBaselineRemediationResult {
  assignmentId: string;
  bulkPlanId?: string;
  outcome: 'started' | 'advanced' | 'blocked' | 'conflict';
  reason?: string;
}

export interface AgentBaselineEvaluationResult {
  assignmentId: string;
  outcome: 'evaluated' | 'queued' | 'unchanged' | 'blocked';
  driftStatus?: 'in_sync' | 'drifted' | 'unknown';
  reason?: string;
}

function audit(
  context: AgentBaselineAssignmentContext,
  action: string,
  resourceType: string,
  resourceId: string,
  now: number,
  metadata: JsonObject
): AdminAgentAuditWrite {
  return {
    id: `audit_${crypto.randomUUID()}`,
    tenantId: context.baseline.controlTenantId,
    adminUserId: context.baseline.createdBy,
    action,
    resourceType,
    resourceId,
    severity: 'info',
    actorType: 'system',
    actorSub: 'system:agent-baseline-remediator',
    metadata,
    createdAt: now,
  };
}

/** Crash-recoverable materializer for explicit standard-risk managed-baseline opt-in. */
export class CloudflareAgentBaselineRemediationCoordinator {
  constructor(
    private readonly baselines: AgentBaselineRepository,
    private readonly bulk: AgentBulkRepository,
    private readonly settings: AgentSettingsPort,
    private readonly clock: AgentClockPort,
    private readonly stateReader?: AgentConfigurationStateReaderPort
  ) {}

  async evaluateScheduled(limit = 25): Promise<AgentBaselineEvaluationResult[]> {
    if (!this.stateReader) return [];
    const now = this.clock.now();
    const candidates = await this.baselines.listManagedEvaluationCandidates({
      now,
      minimumIntervalMs: MANAGED_EVALUATION_INTERVAL_MS,
      limit,
    });
    const results: AgentBaselineEvaluationResult[] = [];
    for (const candidate of candidates) {
      try {
        const context = await this.baselines.getAssignmentContext(
          candidate.controlTenantId,
          candidate.assignmentId
        );
        if (
          !context ||
          context.baseline.status !== 'active' ||
          context.baseline.mode !== 'managed'
        ) {
          results.push({ assignmentId: candidate.assignmentId, outcome: 'unchanged' });
          continue;
        }
        const [current, exceptions] = await Promise.all([
          Promise.all(
            context.baseline.definition.configurationProfile.steps.map(async (step) => ({
              stepId: step.id,
              operation: step.operation,
              current: await this.stateReader!.readCurrent({
                tenantId: context.assignment.tenantId,
                step,
              }),
            }))
          ),
          this.baselines.listExceptions(candidate.controlTenantId, candidate.assignmentId, now),
        ]);
        const evaluation = await evaluateAgentBaselineConfiguration({
          definition: context.baseline.definition,
          current,
          exceptionFields: exceptions.flatMap((exception) => exception.fields),
        });
        const stored = await this.baselines.evaluateManagedAssignment({
          controlTenantId: candidate.controlTenantId,
          assignmentId: candidate.assignmentId,
          expectedLastEvaluatedAt: candidate.lastEvaluatedAt,
          status: evaluation.status,
          currentDigest: evaluation.currentDigest,
          evaluatedAt: now,
          audit: audit(
            context,
            'agent.baseline.drift_evaluated',
            'agent_baseline_assignment',
            candidate.assignmentId,
            now,
            {
              current_digest: evaluation.currentDigest,
              drift_status: evaluation.status,
              drift_fields: evaluation.driftFields,
              excepted_fields: evaluation.exceptedFields,
              evaluation_source: 'scheduler',
            }
          ),
        });
        if (!stored) {
          results.push({ assignmentId: candidate.assignmentId, outcome: 'unchanged' });
          continue;
        }
        if (
          evaluation.status !== 'drifted' ||
          context.baseline.enforcement !== 'standard_auto_remediation'
        ) {
          results.push({
            assignmentId: candidate.assignmentId,
            outcome: 'evaluated',
            driftStatus: evaluation.status,
          });
          continue;
        }
        const targetSettings = await this.settings.get(context.assignment.tenantId);
        if (!targetSettings.enabled || targetSettings.bulkCanaryProtected) {
          results.push({
            assignmentId: candidate.assignmentId,
            outcome: 'blocked',
            driftStatus: 'drifted',
            reason: targetSettings.enabled ? 'protected_tenant' : 'agent_access_disabled',
          });
          continue;
        }
        const bulkPlanId = `abp_baseline_${crypto.randomUUID()}`;
        const reserved = await this.baselines.reserveAutoRemediation({
          controlTenantId: candidate.controlTenantId,
          assignmentId: candidate.assignmentId,
          driftDigest: evaluation.currentDigest,
          bulkPlanId,
          bulkPlanVersion: 1,
          requestedAt: now,
          audit: audit(
            context,
            'agent.baseline.remediation_requested',
            'agent_baseline_assignment',
            candidate.assignmentId,
            now,
            {
              baseline_id: context.baseline.id,
              baseline_version: context.baseline.version,
              tenant_id: context.assignment.tenantId,
              drift_digest: evaluation.currentDigest,
              bulk_plan_id: bulkPlanId,
              request_source: 'scheduler',
            }
          ),
        });
        results.push({
          assignmentId: candidate.assignmentId,
          outcome: reserved ? 'queued' : 'unchanged',
          driftStatus: 'drifted',
        });
      } catch {
        results.push({
          assignmentId: candidate.assignmentId,
          outcome: 'blocked',
          reason: 'evaluation_unavailable',
        });
      }
    }
    return results;
  }

  async runScheduled(limit = 25): Promise<AgentBaselineRemediationResult[]> {
    const candidates = await this.baselines.listPendingAutoRemediations(limit);
    const results: AgentBaselineRemediationResult[] = [];
    for (const candidate of candidates) {
      try {
        results.push(await this.run(candidate.controlTenantId, candidate.assignmentId));
      } catch {
        results.push({
          assignmentId: candidate.assignmentId,
          outcome: 'blocked',
          reason: 'coordinator_unavailable',
        });
      }
    }
    return results;
  }

  async run(
    controlTenantId: string,
    assignmentId: string
  ): Promise<AgentBaselineRemediationResult> {
    const context = await this.baselines.getAssignmentContext(controlTenantId, assignmentId);
    if (!context) return { assignmentId, outcome: 'conflict' };
    const assignment = context.assignment;
    if (
      context.baseline.status !== 'active' ||
      context.baseline.mode !== 'managed' ||
      context.baseline.enforcement !== 'standard_auto_remediation' ||
      !assignment.remediationDriftDigest ||
      !assignment.remediationBulkPlanId ||
      assignment.remediationBulkPlanVersion !== 1
    ) {
      return { assignmentId, outcome: 'conflict' };
    }
    const targetSettings = await this.settings.get(assignment.tenantId);
    if (targetSettings.bulkCanaryProtected) {
      return { assignmentId, outcome: 'blocked', reason: 'protected_tenant' };
    }
    const source = await this.bulk.get(
      controlTenantId,
      assignment.sourceBulkPlanId,
      assignment.sourceBulkPlanVersion
    );
    if (!this.validSource(context, source)) {
      return { assignmentId, outcome: 'blocked', reason: 'source_binding_unavailable' };
    }
    const planId = assignment.remediationBulkPlanId;
    let plan = await this.bulk.get(controlTenantId, planId, 1);
    const now = this.clock.now();
    if (!plan) {
      const resolved = await resolveAgentBulkPlan({
        schemaVersion: 'authrim-agent-bulk-plan-v1',
        targetTenantIds: [assignment.tenantId],
        canaryTenantIds: [assignment.tenantId],
        plan: context.baseline.definition.configurationProfile,
        rollout: {
          canarySize: 1,
          waveSize: 1,
          waveFailureThresholdBasisPoints: 0,
        },
      });
      try {
        const expiresAt = now + 24 * 60 * 60_000;
        await this.bulk.create({
          id: planId,
          version: 1,
          controlTenantId,
          grantId: source!.grantId,
          actorSub: source!.actorSub,
          clientId: source!.clientId,
          delegatorId: source!.delegatorId,
          actorMode: source!.actorMode,
          actorAssurance: source!.actorAssurance,
          tokenBinding: source!.tokenBinding,
          machinePrincipalId: source!.machinePrincipalId,
          machineCredentialId: source!.machineCredentialId,
          grantGeneration: source!.grantGeneration,
          consentVersion: source!.consentVersion,
          resolved,
          expiresAt,
          payloadPurgeAt: expiresAt + 30 * 24 * 60 * 60_000,
          now,
          audit: audit(
            context,
            'agent.baseline.remediation_plan_created',
            'agent_bulk_plan',
            planId,
            now,
            {
              assignment_id: assignment.id,
              baseline_id: context.baseline.id,
              baseline_version: context.baseline.version,
              drift_digest: assignment.remediationDriftDigest,
              plan_digest: resolved.digest,
            }
          ),
        });
      } catch {
        plan = await this.bulk.get(controlTenantId, planId, 1);
        if (!plan) return { assignmentId, bulkPlanId: planId, outcome: 'conflict' };
      }
      plan = await this.bulk.get(controlTenantId, planId, 1);
    }
    if (!plan) return { assignmentId, bulkPlanId: planId, outcome: 'conflict' };
    if (plan.status === 'draft') {
      const changed = await this.bulk.transition({
        controlTenantId,
        id: plan.id,
        version: plan.version,
        from: 'draft',
        to: 'ready',
        stage: 'validate',
        now: this.clock.now(),
        audit: audit(
          context,
          'agent.baseline.remediation_plan_validated',
          'agent_bulk_plan',
          plan.id,
          this.clock.now(),
          {
            assignment_id: assignment.id,
            drift_digest: assignment.remediationDriftDigest,
          }
        ),
      });
      if (!changed) return { assignmentId, bulkPlanId: plan.id, outcome: 'conflict' };
      plan = (await this.bulk.get(controlTenantId, plan.id, plan.version))!;
    }
    if (plan.status !== 'ready') {
      return { assignmentId, bulkPlanId: plan.id, outcome: 'advanced' };
    }
    const approvalDigest = await sha256Base64Url(
      canonicalizeJson({
        purpose: 'authrim-agent-baseline-remediation-approval-v1',
        assignment_id: assignment.id,
        baseline_id: context.baseline.id,
        baseline_version: context.baseline.version,
        baseline_digest: context.baseline.definitionDigest,
        drift_digest: assignment.remediationDriftDigest,
        bulk_plan_id: plan.id,
        bulk_plan_version: plan.version,
        plan_digest: plan.definitionDigest,
        target_snapshot_digest: plan.targetSnapshotDigest,
        canary_digest: plan.canaryDigest,
      })
    );
    const started = await this.bulk.startApproved({
      controlTenantId,
      id: plan.id,
      version: plan.version,
      definitionDigest: plan.definitionDigest,
      targetSnapshotDigest: plan.targetSnapshotDigest,
      canaryDigest: plan.canaryDigest,
      approvedBy: context.baseline.createdBy,
      approvalDigest,
      now: this.clock.now(),
      audit: audit(
        context,
        'agent.baseline.remediation_started',
        'agent_bulk_plan',
        plan.id,
        this.clock.now(),
        {
          assignment_id: assignment.id,
          drift_digest: assignment.remediationDriftDigest,
          approval_digest: approvalDigest,
        }
      ),
    });
    return {
      assignmentId,
      bulkPlanId: plan.id,
      outcome: started ? 'started' : 'conflict',
    };
  }

  private validSource(
    context: AgentBaselineAssignmentContext,
    source: AgentBulkPlanRecord | null
  ): boolean {
    return Boolean(
      source?.status === 'completed' &&
      source.definition &&
      canonicalizeJson(source.definition.plan as unknown as JsonObject) ===
        canonicalizeJson(
          context.baseline.definition.configurationProfile as unknown as JsonObject
        ) &&
      source.actorMode === 'mode_b' &&
      source.actorAssurance === 'machine_key' &&
      source.tokenBinding === 'dpop' &&
      source.delegatorId &&
      source.machinePrincipalId &&
      source.machineCredentialId
    );
  }
}
