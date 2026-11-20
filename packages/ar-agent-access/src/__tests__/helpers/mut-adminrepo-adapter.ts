import type {
  DatabaseAdapter,
  ExecuteResult,
  HealthStatus,
  PreparedStatement,
  QueryOptions,
  TransactionContext,
} from '@authrim/ar-lib-core/db/adapter';
import type { AdminAgentAuditWrite } from '../../core/audit';
import { recordingAdminAgentAuditWriter } from '../../core/__tests__/helpers/admin-audit-writer';
import { AdminAgentAccessRepository } from '../../core/repositories';

export interface MutRecordedCall {
  kind: 'query' | 'queryOne' | 'execute';
  sql: string;
  params?: unknown[];
}

/** Recording adapter: queued results per method; batches are recorded as whole statement lists. */
export class MutRecordingAdapter implements DatabaseAdapter {
  readonly calls: MutRecordedCall[] = [];
  readonly batches: PreparedStatement[][] = [];
  queryResults: unknown[][] = [];
  queryOneResults: unknown[] = [];
  executeResults: ExecuteResult[] = [];
  /** Per-batch results; each entry gives rowsAffected per statement index (default 1). */
  batchRowsAffected: number[][] = [];

  async query<T>(sql: string, params?: unknown[], _options?: QueryOptions): Promise<T[]> {
    this.calls.push({ kind: 'query', sql, params });
    return (this.queryResults.shift() ?? []) as T[];
  }

  async queryOne<T>(sql: string, params?: unknown[], _options?: QueryOptions): Promise<T | null> {
    this.calls.push({ kind: 'queryOne', sql, params });
    return (this.queryOneResults.shift() ?? null) as T | null;
  }

  async execute(sql: string, params?: unknown[]): Promise<ExecuteResult> {
    this.calls.push({ kind: 'execute', sql, params });
    return this.executeResults.shift() ?? { rowsAffected: 1, success: true };
  }

  async transaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    return fn({
      query: (sql, params) => this.query(sql, params),
      queryOne: (sql, params) => this.queryOne(sql, params),
      execute: (sql, params) => this.execute(sql, params),
    });
  }

  async batch(statements: PreparedStatement[]): Promise<ExecuteResult[]> {
    this.batches.push(statements);
    const affected = this.batchRowsAffected.shift() ?? [];
    return statements.map((_, index) => ({ rowsAffected: affected[index] ?? 1, success: true }));
  }

  async isHealthy(): Promise<HealthStatus> {
    return { healthy: true, latencyMs: 0, type: 'recording' };
  }

  getType(): string {
    return 'recording';
  }

  async close(): Promise<void> {}
}

export function mutRepo(adapter: MutRecordingAdapter = new MutRecordingAdapter()) {
  return {
    adapter,
    repository: new AdminAgentAccessRepository(adapter, recordingAdminAgentAuditWriter),
  };
}

export function mutAudit(
  id: string,
  overrides: Partial<AdminAgentAuditWrite> = {}
): AdminAgentAuditWrite {
  return {
    id,
    tenantId: 'tenant-1',
    adminUserId: 'admin-1',
    action: 'agent.test',
    resourceType: 'admin_agent_grant',
    resourceId: 'grant-1',
    severity: 'info',
    actorType: 'admin_user',
    actorSub: 'admin_user:admin-1',
    metadata: {},
    createdAt: 100,
    ...overrides,
  };
}

export const mutTool = {
  toolId: 'admin.read.clients.list',
  toolName: 'list_clients',
  contractVersion: '1',
  schemaDigest: 'read-digest',
  permissions: ['admin:clients:read'],
  requiredScope: 'agent:read' as const,
  riskLevel: 'low' as const,
  requiresElevation: false,
};

/** A minimal stored admin_agent_grants row (AdminAgentGrantRecordRow shape). */
export function mutGrantRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'grant-1',
    tenant_id: 'tenant-1',
    client_id: 'client-1',
    machine_principal_id: null,
    grantor_id: 'admin-1',
    delegator_id: 'admin-2',
    permissions: '["admin:users:read"]',
    scopes: '["agent:read"]',
    authorization_details: null,
    resolved_scope_constraints: '{"tenantIds":["tenant-1"]}',
    consent_version: 2,
    generation: 3,
    status: 'active',
    delegation_mode: 'user_consent',
    expires_at: null,
    task_set_id: null,
    task_set_version: null,
    scope_policy_id: null,
    scope_policy_version: null,
    resolved_tools: null,
    access_snapshot_hash: null,
    purpose: null,
    management_mode: 'managed',
    last_used_at: null,
    created_at: 10,
    updated_at: 20,
    revoked_at: null,
    revoked_by: null,
    ...overrides,
  };
}
