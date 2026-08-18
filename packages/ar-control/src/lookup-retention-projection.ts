import type { D1Database, D1DatabaseSession } from '@cloudflare/workers-types';
import type {
  ControlAccountLegalHoldProjectionRequest,
  ControlAccountLegalHoldProjectionView,
  ControlLookupRetentionPolicyProjectionRequest,
  ControlLookupRetentionPolicyProjectionView,
  ControlLookupRetentionProjectionStatus,
} from '@authrim/ar-lib-core/control-plane';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;

interface PolicyRow {
  tenant_id: string;
  policy_generation: number | string;
  retention_days: number | string;
  source_operation_id: string;
  source_updated_at: number | string;
  projected_at: number | string;
}

interface HoldRow {
  tenant_id: string;
  account_id: string;
  hold_id: string;
  projection_generation: number | string;
  hold_version: number | string;
  projection_state: 'active' | 'inactive';
  source_operation_id: string;
  source_updated_at: number | string;
  projected_at: number | string;
}

function primary(database: D1Database): D1DatabaseSession {
  if (typeof database.withSession !== 'function') throw new Error('d1_sessions_api_required');
  return database.withSession('first-primary');
}

function safeId(value: unknown, code: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error(code);
  return value;
}

function positiveInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(code);
  return value as number;
}

function storedInteger(value: number | string, code: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(code);
  return parsed;
}

function policyView(row: PolicyRow): ControlLookupRetentionPolicyProjectionView {
  return {
    tenantId: safeId(row.tenant_id, 'control_lookup_retention_projection_invalid'),
    policyGeneration: storedInteger(
      row.policy_generation,
      'control_lookup_retention_projection_invalid'
    ),
    retentionDays: storedInteger(row.retention_days, 'control_lookup_retention_projection_invalid'),
    sourceOperationId: safeId(
      row.source_operation_id,
      'control_lookup_retention_projection_invalid'
    ),
    sourceUpdatedAt: storedInteger(
      row.source_updated_at,
      'control_lookup_retention_projection_invalid'
    ),
    projectedAt: storedInteger(row.projected_at, 'control_lookup_retention_projection_invalid'),
  };
}

function holdView(row: HoldRow): ControlAccountLegalHoldProjectionView {
  if (!['active', 'inactive'].includes(row.projection_state)) {
    throw new Error('control_account_legal_hold_projection_invalid');
  }
  return {
    tenantId: safeId(row.tenant_id, 'control_account_legal_hold_projection_invalid'),
    accountId: safeId(row.account_id, 'control_account_legal_hold_projection_invalid'),
    holdId: safeId(row.hold_id, 'control_account_legal_hold_projection_invalid'),
    projectionGeneration: storedInteger(
      row.projection_generation,
      'control_account_legal_hold_projection_invalid'
    ),
    holdVersion: storedInteger(row.hold_version, 'control_account_legal_hold_projection_invalid'),
    projectionState: row.projection_state,
    sourceOperationId: safeId(
      row.source_operation_id,
      'control_account_legal_hold_projection_invalid'
    ),
    sourceUpdatedAt: storedInteger(
      row.source_updated_at,
      'control_account_legal_hold_projection_invalid'
    ),
    projectedAt: storedInteger(row.projected_at, 'control_account_legal_hold_projection_invalid'),
  };
}

export class LookupRetentionProjectionService {
  constructor(
    private readonly database: D1Database,
    private readonly now: () => number
  ) {}

  async applyPolicy(
    environmentId: string,
    input: ControlLookupRetentionPolicyProjectionRequest
  ): Promise<ControlLookupRetentionPolicyProjectionView> {
    const environment = safeId(environmentId, 'control_lookup_retention_projection_invalid');
    const tenantId = safeId(input.tenantId, 'control_lookup_retention_projection_invalid');
    const sourceOperationId = safeId(
      input.sourceOperationId,
      'control_lookup_retention_projection_invalid'
    );
    const policyGeneration = positiveInteger(
      input.policyGeneration,
      'control_lookup_retention_projection_invalid'
    );
    if (
      !Number.isSafeInteger(input.retentionDays) ||
      input.retentionDays < 30 ||
      input.retentionDays > 3650
    ) {
      throw new Error('control_lookup_retention_projection_invalid');
    }
    const sourceUpdatedAt = positiveInteger(
      input.sourceUpdatedAt,
      'control_lookup_retention_projection_invalid'
    );
    const projectedAt = positiveInteger(this.now(), 'control_lookup_retention_projection_invalid');
    if (projectedAt < sourceUpdatedAt) {
      throw new Error('control_lookup_retention_projection_clock_invalid');
    }
    const result = await primary(this.database)
      .prepare(
        `INSERT INTO control_lookup_retention_policy_projections (
           environment_id, tenant_id, policy_generation, retention_days,
           source_operation_id, source_updated_at, projected_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (environment_id, tenant_id) DO UPDATE SET
           policy_generation = excluded.policy_generation,
           retention_days = excluded.retention_days,
           source_operation_id = excluded.source_operation_id,
           source_updated_at = excluded.source_updated_at,
           projected_at = excluded.projected_at
         WHERE excluded.policy_generation >
               control_lookup_retention_policy_projections.policy_generation`
      )
      .bind(
        environment,
        tenantId,
        policyGeneration,
        input.retentionDays,
        sourceOperationId,
        sourceUpdatedAt,
        projectedAt
      )
      .run();
    const row = await this.policy(environment, tenantId);
    if (!row) throw new Error('control_lookup_retention_projection_not_reflected');
    const view = policyView(row);
    if (
      (result.meta.changes ?? 0) !== 1 &&
      (view.policyGeneration !== policyGeneration ||
        view.retentionDays !== input.retentionDays ||
        view.sourceOperationId !== sourceOperationId ||
        view.sourceUpdatedAt !== sourceUpdatedAt)
    ) {
      throw new Error('control_lookup_retention_projection_stale');
    }
    return view;
  }

  async applyLegalHold(
    environmentId: string,
    input: ControlAccountLegalHoldProjectionRequest
  ): Promise<ControlAccountLegalHoldProjectionView> {
    const environment = safeId(environmentId, 'control_account_legal_hold_projection_invalid');
    const tenantId = safeId(input.tenantId, 'control_account_legal_hold_projection_invalid');
    const accountId = safeId(input.accountId, 'control_account_legal_hold_projection_invalid');
    const holdId = safeId(input.holdId, 'control_account_legal_hold_projection_invalid');
    const sourceOperationId = safeId(
      input.sourceOperationId,
      'control_account_legal_hold_projection_invalid'
    );
    const projectionGeneration = positiveInteger(
      input.projectionGeneration,
      'control_account_legal_hold_projection_invalid'
    );
    const holdVersion = positiveInteger(
      input.holdVersion,
      'control_account_legal_hold_projection_invalid'
    );
    if (!['active', 'inactive'].includes(input.projectionState)) {
      throw new Error('control_account_legal_hold_projection_invalid');
    }
    const sourceUpdatedAt = positiveInteger(
      input.sourceUpdatedAt,
      'control_account_legal_hold_projection_invalid'
    );
    const projectedAt = positiveInteger(
      this.now(),
      'control_account_legal_hold_projection_invalid'
    );
    if (projectedAt < sourceUpdatedAt) {
      throw new Error('control_account_legal_hold_projection_clock_invalid');
    }
    const result = await primary(this.database)
      .prepare(
        `INSERT INTO control_account_legal_hold_projections (
           environment_id, tenant_id, account_id, hold_id, projection_generation,
           hold_version, projection_state, source_operation_id, source_updated_at, projected_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (environment_id, tenant_id, account_id) DO UPDATE SET
           hold_id = excluded.hold_id,
           projection_generation = excluded.projection_generation,
           hold_version = excluded.hold_version,
           projection_state = excluded.projection_state,
           source_operation_id = excluded.source_operation_id,
           source_updated_at = excluded.source_updated_at,
           projected_at = excluded.projected_at
         WHERE excluded.projection_generation >
               control_account_legal_hold_projections.projection_generation`
      )
      .bind(
        environment,
        tenantId,
        accountId,
        holdId,
        projectionGeneration,
        holdVersion,
        input.projectionState,
        sourceOperationId,
        sourceUpdatedAt,
        projectedAt
      )
      .run();
    const row = await this.legalHold(environment, tenantId, accountId);
    if (!row) throw new Error('control_account_legal_hold_projection_not_reflected');
    const view = holdView(row);
    if (
      (result.meta.changes ?? 0) !== 1 &&
      (view.projectionGeneration !== projectionGeneration ||
        view.holdId !== holdId ||
        view.holdVersion !== holdVersion ||
        view.projectionState !== input.projectionState ||
        view.sourceOperationId !== sourceOperationId ||
        view.sourceUpdatedAt !== sourceUpdatedAt)
    ) {
      throw new Error('control_account_legal_hold_projection_stale');
    }
    return view;
  }

  async status(
    environmentId: string,
    tenantId: string,
    accountId: string
  ): Promise<ControlLookupRetentionProjectionStatus> {
    const environment = safeId(environmentId, 'control_lookup_retention_projection_invalid');
    const tenant = safeId(tenantId, 'control_lookup_retention_projection_invalid');
    const account = safeId(accountId, 'control_account_legal_hold_projection_invalid');
    const [policy, legalHold] = await Promise.all([
      this.policy(environment, tenant),
      this.legalHold(environment, tenant, account),
    ]);
    return {
      policy: policy ? policyView(policy) : null,
      legalHold: legalHold ? holdView(legalHold) : null,
    };
  }

  private policy(environmentId: string, tenantId: string): Promise<PolicyRow | null> {
    return primary(this.database)
      .prepare(
        `SELECT tenant_id, policy_generation, retention_days, source_operation_id,
                source_updated_at, projected_at
           FROM control_lookup_retention_policy_projections
          WHERE environment_id = ? AND tenant_id = ?`
      )
      .bind(environmentId, tenantId)
      .first<PolicyRow>();
  }

  private legalHold(
    environmentId: string,
    tenantId: string,
    accountId: string
  ): Promise<HoldRow | null> {
    return primary(this.database)
      .prepare(
        `SELECT tenant_id, account_id, hold_id, projection_generation, hold_version,
                projection_state, source_operation_id, source_updated_at, projected_at
           FROM control_account_legal_hold_projections
          WHERE environment_id = ? AND tenant_id = ? AND account_id = ?`
      )
      .bind(environmentId, tenantId, accountId)
      .first<HoldRow>();
  }
}
