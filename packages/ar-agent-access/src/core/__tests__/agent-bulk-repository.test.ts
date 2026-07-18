import type { DatabaseAdapter } from '@authrim/ar-lib-core/db/adapter';
import { describe, expect, it, vi } from 'vitest';
import { AgentBulkRepository } from '../repositories/agent-bulk-repository';

const planRow = {
  id: 'bulk-1',
  version: 1,
  control_tenant_id: 'control',
  grant_id: 'grant-1',
  actor_sub: 'machine:principal-1',
  client_id: 'client-1',
  definition_json: JSON.stringify({ schemaVersion: 'authrim-agent-bulk-plan-v1' }),
  definition_digest: 'plan-digest',
  target_snapshot_json: '["tenant-a","tenant-b"]',
  target_snapshot_digest: 'targets',
  canary_tenant_ids_json: '["tenant-a"]',
  canary_digest: 'canaries',
  status: 'running',
  stage: 'validate',
  canary_size: 1,
  wave_size: 1,
  wave_failure_threshold_bps: 500,
  current_wave: 0,
  succeeded_count: 0,
  failed_count: 0,
  indeterminate_count: 0,
  pause_reason: null,
  expires_at: 10_000,
  payload_purge_at: 20_000,
  payload_purged_at: null,
  created_at: 1,
  updated_at: 1,
  delegator_id: 'admin-1',
  actor_mode: 'mode_b',
  actor_assurance: 'machine_key',
  token_binding: 'dpop',
  machine_principal_id: 'principal-1',
  machine_credential_id: 'credential-1',
  grant_generation: 2,
  consent_version: 3,
  approved_by: 'admin-1',
  approved_at: 1,
  approval_digest: 'approval',
};

function execution(overrides: Record<string, unknown>) {
  return {
    id: 'execution-a',
    bulk_plan_id: 'bulk-1',
    bulk_plan_version: 1,
    target_tenant_id: 'tenant-a',
    target_sequence: 0,
    is_canary: 1,
    wave_number: null,
    stage: 'apply',
    status: 'pending',
    plan_digest: 'plan-digest',
    child_capability_digest: null,
    precondition_snapshot_digest: 'snapshot-a',
    execution_attempt: 1,
    execution_fence: 1,
    execution_owner_id: null,
    execution_lease_expires_at: null,
    idempotency_key: 'key-a',
    result_json: null,
    result_digest: null,
    failure_kind: null,
    created_at: 1,
    started_at: null,
    completed_at: null,
    updated_at: 1,
    child_capability_expires_at: null,
    ...overrides,
  };
}

function repository(rows: unknown[]) {
  const adapter = {
    queryOne: vi.fn().mockResolvedValue(planRow),
    query: vi.fn().mockResolvedValue(rows),
  } as unknown as DatabaseAdapter;
  return new AgentBulkRepository(adapter);
}

describe('AgentBulkRepository rollout ordering', () => {
  it('validates every target before allowing canary apply', async () => {
    const repo = repository([
      execution({}),
      execution({
        id: 'execution-b',
        target_tenant_id: 'tenant-b',
        target_sequence: 1,
        is_canary: 0,
        wave_number: 1,
        stage: 'validate',
        precondition_snapshot_digest: null,
      }),
    ]);
    await expect(
      repo.listRunnableTenantExecutions({
        controlTenantId: 'control',
        bulkPlanId: 'bulk-1',
        bulkPlanVersion: 1,
      })
    ).resolves.toMatchObject([{ id: 'execution-b', stage: 'validate' }]);
  });

  it('runs canary apply and verify before the first wave', async () => {
    const repo = repository([
      execution({ stage: 'verify' }),
      execution({
        id: 'execution-b',
        target_tenant_id: 'tenant-b',
        target_sequence: 1,
        is_canary: 0,
        wave_number: 1,
        stage: 'apply',
      }),
    ]);
    await expect(
      repo.listRunnableTenantExecutions({
        controlTenantId: 'control',
        bulkPlanId: 'bulk-1',
        bulkPlanVersion: 1,
      })
    ).resolves.toMatchObject([{ id: 'execution-a', stage: 'verify' }]);
  });
});
