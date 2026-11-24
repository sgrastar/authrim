import { vi } from 'vitest';
import type { DatabaseAdapter } from '../../../db';
import type { GroupInputReader, InputVersion } from '../store';
import { compileGroups } from '../engine';
import { BUILTIN_GROUP_FIELDS, type Expression, type ServiceGroup } from '../model';

export const NOW = 1_700_000_000_000;
export const TENANT = 't1';
export const USER = 'u1';
export const PRIMARY = { consistencyClass: 'primary_required' };

export const attr = (field: string, value: string): Expression => ({
  op: 'attribute',
  field,
  compare: 'eq',
  value,
});
export const group = (
  id: string,
  condition: Expression | null,
  extra: Partial<ServiceGroup> = {}
): ServiceGroup => ({
  id,
  tenantId: TENANT,
  key: id.toLowerCase(),
  displayName: id,
  description: '',
  enabled: true,
  condition,
  ...extra,
});
export const groups = [group('A', attr('email_domain', 'example.com')), group('B', null)];
export const plan = compileGroups(TENANT, groups, BUILTIN_GROUP_FIELDS);

export interface Call {
  kind: 'queryOne' | 'execute' | 'batch';
  sql?: string;
  params?: unknown[];
  options?: unknown;
  statements?: unknown;
}

export interface FakeState {
  catalogRow: { revision: number | string; plan_json: string } | null;
  resultRow: Record<string, unknown> | null;
  writeToken: string | null;
  publicationState: string | null;
  claimRows: number;
  batchRows: number;
  calls: Call[];
  lastToken: string | null;
}

export function makeDb(over: Partial<FakeState> = {}) {
  const state: FakeState = {
    catalogRow: { revision: 3, plan_json: JSON.stringify(plan) },
    resultRow: null,
    writeToken: 'echo',
    publicationState: 'committed',
    claimRows: 1,
    batchRows: 1,
    calls: [],
    lastToken: null,
    ...over,
  };
  const db = {
    queryOne: vi.fn(async (sql: string, params?: unknown[], options?: unknown) => {
      state.calls.push({ kind: 'queryOne', sql, params, options });
      if (sql.startsWith('SELECT revision, plan_json')) return state.catalogRow;
      if (sql.startsWith('SELECT write_token')) {
        if (state.writeToken === 'echo') return { write_token: state.lastToken };
        return state.writeToken === null ? null : { write_token: state.writeToken };
      }
      if (sql.startsWith('SELECT * FROM service_group_results')) return state.resultRow;
      if (sql.startsWith('SELECT state FROM log_iceberg_core_publications')) {
        return state.publicationState === null ? null : { state: state.publicationState };
      }
      throw new Error(`unexpected queryOne: ${sql}`);
    }),
    execute: vi.fn(async (sql: string, params?: unknown[]) => {
      state.calls.push({ kind: 'execute', sql, params });
      if (sql.startsWith('UPDATE service_group_results SET lease_token')) {
        return { rowsAffected: state.claimRows };
      }
      return { rowsAffected: 1 };
    }),
    batch: vi.fn(async (statements: Array<{ params?: unknown[] }>) => {
      state.calls.push({ kind: 'batch', statements });
      const saveBatch = statements.length === 3 && Array.isArray(statements[1].params);
      if (saveBatch) state.lastToken = String(statements[1].params?.[3]);
      return statements.map(() => ({ rowsAffected: state.batchRows }));
    }),
  };
  return { db: db as unknown as DatabaseAdapter, raw: db, state };
}

export const publication = {
  env: { marker: 'env' } as never,
  source: { tenantId: TENANT, marker: 'src' } as never,
};

export function makeAudit(state = 'prepared') {
  return {
    publicationId: 'pub-1',
    state,
    dispatch: vi.fn(async () => undefined),
    wrapBusinessBatch: vi.fn((statements: BusinessStatement[], guard: BusinessGuard) => [
      ...statements,
      { guard },
    ]),
  };
}

export interface BusinessStatement {
  sql: string;
  params: unknown[];
}
export interface BusinessGuard {
  where: string;
  params: unknown[];
}
export interface AuditArg {
  eventAt: number;
  overview: { action: string; subject_id: string | null };
  row: {
    id: string;
    user_id: string;
    rule_version: number;
    generation: number;
    event_type: string;
    detail_json: string;
    created_at: number;
  };
}
/** Typed accessor for the request passed to the mocked core-log publication. */
export function auditArgOf(mock: { mock: { calls: unknown[][] } }, call = 0): AuditArg {
  return mock.mock.calls[call][2] as AuditArg;
}

export function makeReader(
  versions: InputVersion[] | ((i: number) => InputVersion),
  over: Partial<GroupInputReader> = {}
) {
  let i = 0;
  const version = vi.fn(async () => {
    const idx = i++;
    return typeof versions === 'function'
      ? versions(idx)
      : versions[Math.min(idx, versions.length - 1)];
  });
  const reader = {
    tenantId: TENANT,
    userId: USER,
    version,
    load: vi.fn(async () => ({ attributes: { email_domain: 'example.com' }, sources: {} })),
    ...over,
  };
  return { reader, version };
}

export const V: InputVersion = { core: 1, pii: 2, metadata: 3, epoch: 4 };
