import type { DatabaseAdapter, PreparedStatement } from '@authrim/ar-lib-core/db/adapter';
import { vi } from 'vitest';
import type { AdminAgentAuditWrite, AdminAgentAuditWriter } from '../../core/audit';

/** In-memory DatabaseAdapter double that records every SQL statement and its bindings. */
export function fakeAdapter() {
  const query = vi.fn<(sql: string, params?: unknown[]) => Promise<unknown[]>>(() =>
    Promise.resolve([])
  );
  const queryOne = vi.fn<(sql: string, params?: unknown[]) => Promise<unknown>>(() =>
    Promise.resolve(null)
  );
  const execute = vi.fn<
    (sql: string, params?: unknown[]) => Promise<{ rowsAffected: number; success: boolean }>
  >(() => Promise.resolve({ rowsAffected: 0, success: true }));
  const batch = vi.fn<
    (statements: PreparedStatement[]) => Promise<{ rowsAffected: number; success: boolean }[]>
  >(() => Promise.resolve([{ rowsAffected: 1, success: true }]));
  const adapter = { query, queryOne, execute, batch } as unknown as DatabaseAdapter;
  return { adapter, query, queryOne, execute, batch };
}

export const AUDIT_STATEMENT: PreparedStatement = { sql: '-- audit statement', params: [] };

/** Audit writer double: records the guard each repository method passes. */
export function fakeAuditWriter() {
  return vi.fn<AdminAgentAuditWriter>(() => Promise.resolve([AUDIT_STATEMENT]));
}

export function auditWrite(overrides: Partial<AdminAgentAuditWrite> = {}): AdminAgentAuditWrite {
  return {
    id: 'audit-1',
    tenantId: 'tenant-1',
    action: 'agent.test',
    resourceType: 'agent_test',
    resourceId: 'resource-1',
    severity: 'info',
    actorType: 'agent',
    actorSub: 'agent:sub',
    metadata: {},
    createdAt: 1_000,
    ...overrides,
  };
}

/** Collapses whitespace so SQL fragments can be asserted independent of indentation. */
export function flat(sql: string | undefined): string {
  return (sql ?? '').replace(/\s+/g, ' ').trim();
}

export function batchStatements(batch: ReturnType<typeof fakeAdapter>['batch'], call = 0) {
  return batch.mock.calls[call]?.[0] ?? [];
}
