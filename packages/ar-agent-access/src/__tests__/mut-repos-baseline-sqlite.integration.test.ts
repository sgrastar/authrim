import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  DatabaseAdapter,
  ExecuteResult,
  HealthStatus,
  PreparedStatement,
  TransactionContext,
} from '@authrim/ar-lib-core/db/adapter';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AdminAgentAuditWrite } from '../core/audit';
import { recordingAdminAgentAuditWriter } from '../core/__tests__/helpers/admin-audit-writer';
import { AgentBaselineRepository } from '../core/repositories';

// Minimal copy of the SQLite CLI adapter from core/__tests__/repository-sqlite.integration.test.ts
// (it is not exported there): parameters are bound as literals and a batch runs in one
// BEGIN IMMEDIATE transaction that reports changes() per statement.
function findSqlite3(): string | null {
  try {
    return execFileSync('which', ['sqlite3'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`;
  return sqlLiteral(JSON.stringify(value));
}

function bindSql(sql: string, params: readonly unknown[] = []): string {
  let index = 0;
  const bound = sql.replaceAll('?', () => sqlLiteral(params[index++]));
  if (index !== params.length) throw new TypeError('SQLite parameter count mismatch');
  return bound;
}

class SqliteCliAdapter implements DatabaseAdapter {
  constructor(
    private readonly sqlite3Path: string,
    private readonly databasePath: string
  ) {}

  private run<T>(script: string): T[] {
    const execution = spawnSync(this.sqlite3Path, ['-json', '-bail', this.databasePath], {
      input: script,
      encoding: 'utf8',
    });
    if (execution.error) throw execution.error;
    if (execution.status !== 0 || execution.stderr.trim().length > 0) {
      throw new Error(execution.stderr.trim() || `sqlite3 exited with ${execution.status}`);
    }
    const output = execution.stdout.trim();
    return output ? (JSON.parse(output) as T[]) : [];
  }

  async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    return this.run<T>(`${bindSql(sql, params)};`);
  }

  async queryOne<T>(sql: string, params?: unknown[]): Promise<T | null> {
    return (await this.query<T>(sql, params))[0] ?? null;
  }

  async execute(sql: string, params?: unknown[]): Promise<ExecuteResult> {
    return (await this.batch([{ sql, params: params ?? [] }]))[0];
  }

  transaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async batch(statements: PreparedStatement[]): Promise<ExecuteResult[]> {
    const rows = this.run<{ rowsAffected: number }>(
      [
        'BEGIN IMMEDIATE;',
        'CREATE TEMP TABLE _batch_results (position INTEGER, rows_affected INTEGER);',
        ...statements.flatMap((statement, position) => [
          `${bindSql(statement.sql, statement.params)};`,
          `INSERT INTO _batch_results VALUES (${position}, changes());`,
        ]),
        'COMMIT;',
        'SELECT rows_affected AS rowsAffected FROM _batch_results ORDER BY position;',
      ].join('\n')
    );
    return rows.map((row) => ({ rowsAffected: row.rowsAffected, success: true }));
  }

  isHealthy = async (): Promise<HealthStatus> => ({ healthy: true, latencyMs: 0, type: 'sqlite' });
  getType = () => 'sqlite-cli';
  close = async () => undefined;
}

function adminBaselineMigrationSql(): string {
  const migration = '../../../../migrations/admin/d1/001_0_5_0_admin_baseline.sql';
  return readFileSync(new URL(migration, import.meta.url), 'utf8')
    .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '0')
    .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', '0');
}

const sqlite3Path = findSqlite3();
const describeWithSqlite = sqlite3Path ? describe : describe.skip;
const sqliteBinary = sqlite3Path ?? 'sqlite3';

function audit(id: string, createdAt: number): AdminAgentAuditWrite {
  return {
    id,
    tenantId: 'platform',
    adminUserId: 'admin-1',
    action: 'agent.baseline.drift_evaluated',
    resourceType: 'agent_baseline_assignment',
    resourceId: 'assignment-1',
    severity: 'info',
    actorType: 'system',
    actorSub: 'system:baseline-evaluator',
    metadata: {},
    createdAt,
  };
}

describeWithSqlite('AgentBaselineRepository SQLite evaluation receipts', () => {
  let temporaryDirectory: string;
  let adapter: SqliteCliAdapter;
  let baselines: AgentBaselineRepository;

  beforeEach(async () => {
    temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'authrim-agent-baseline-'));
    const databasePath = path.join(temporaryDirectory, 'test.db');
    execFileSync(sqliteBinary, ['-bail', databasePath], {
      encoding: 'utf8',
      input: adminBaselineMigrationSql(),
    });
    adapter = new SqliteCliAdapter(sqliteBinary, databasePath);
    baselines = new AgentBaselineRepository(adapter, recordingAdminAgentAuditWriter);
    await adapter.execute(
      `INSERT INTO agent_baselines (id, version, control_tenant_id, name, mode, enforcement,
         definition_json, definition_digest, status, created_by, created_at)
       VALUES ('baseline-1', 1, 'platform', 'Managed', 'managed', 'report_only', '{}',
         'definition-digest', 'active', 'admin-1', 1)`
    );
    await adapter.execute(
      `INSERT INTO agent_baseline_assignments (id, baseline_id, baseline_version, tenant_id,
         source_bulk_plan_id, source_bulk_plan_version, assigned_by, assigned_at, drift_status)
       VALUES ('assignment-1', 'baseline-1', 1, 'tenant-1', 'bulk-1', 1, 'admin-1', 2, 'unknown')`
    );
  }, 30_000);

  afterEach(() => {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  const receipts = async (auditId: string) =>
    (
      await adapter.queryOne<{ count: number }>(
        'SELECT COUNT(*) AS count FROM admin_audit_log WHERE id = ?',
        [auditId]
      )
    )?.count;

  const assignment = () =>
    adapter.queryOne<{
      last_evaluated_at: number | null;
      drift_digest: string | null;
      last_transition_id: string | null;
    }>(
      `SELECT last_evaluated_at, drift_digest, last_transition_id
       FROM agent_baseline_assignments WHERE id = 'assignment-1'`
    );

  const evaluateManaged = (
    auditId: string,
    evaluatedAt: number,
    expectedLastEvaluatedAt?: number,
    controlTenantId = 'platform'
  ) =>
    baselines.evaluateManagedAssignment({
      controlTenantId,
      assignmentId: 'assignment-1',
      expectedLastEvaluatedAt,
      status: 'drifted',
      currentDigest: `digest-${evaluatedAt}`,
      evaluatedAt,
      audit: audit(auditId, evaluatedAt),
    });

  it('writes one row and one receipt on the first managed evaluation', async () => {
    await expect(evaluateManaged('audit-first', 10)).resolves.toBe(true);
    await expect(assignment()).resolves.toEqual({
      last_evaluated_at: 10,
      drift_digest: 'digest-10',
      last_transition_id: 'audit-first',
    });
    await expect(receipts('audit-first')).resolves.toBe(1);
  });

  it('writes one row and one receipt when re-evaluating with the matching timestamp', async () => {
    await expect(evaluateManaged('audit-first', 10)).resolves.toBe(true);
    await expect(evaluateManaged('audit-second', 20, 10)).resolves.toBe(true);
    await expect(assignment()).resolves.toEqual({
      last_evaluated_at: 20,
      drift_digest: 'digest-20',
      last_transition_id: 'audit-second',
    });
    await expect(receipts('audit-second')).resolves.toBe(1);
    await expect(receipts('audit-first')).resolves.toBe(1);
  });

  it.each([
    ['a stale expected timestamp', 9, 'platform'],
    ['a missing expected timestamp on an evaluated row', undefined, 'platform'],
    ['another control tenant', 10, 'platform-2'],
  ])('writes neither the row nor a receipt for %s', async (_label, expected, tenant) => {
    await expect(evaluateManaged('audit-first', 10)).resolves.toBe(true);
    await expect(evaluateManaged('audit-lost', 20, expected, tenant)).resolves.toBe(false);
    await expect(assignment()).resolves.toEqual({
      last_evaluated_at: 10,
      drift_digest: 'digest-10',
      last_transition_id: 'audit-first',
    });
    await expect(receipts('audit-lost')).resolves.toBe(0);
  });

  it('writes no receipt for a first managed evaluation from another control tenant', async () => {
    await expect(evaluateManaged('audit-foreign', 10, undefined, 'platform-2')).resolves.toBe(
      false
    );
    await expect(assignment()).resolves.toEqual({
      last_evaluated_at: null,
      drift_digest: null,
      last_transition_id: null,
    });
    await expect(receipts('audit-foreign')).resolves.toBe(0);
  });

  it('writes no receipt for a foreign evaluateAssignment even when drift_digest already matches', async () => {
    const evaluate = (auditId: string, controlTenantId: string) =>
      baselines.evaluateAssignment({
        controlTenantId,
        assignmentId: 'assignment-1',
        status: 'drifted',
        currentDigest: 'same-digest',
        evaluatedAt: 30,
        audit: audit(auditId, 30),
      });
    await expect(evaluate('audit-owner', 'platform')).resolves.toBe('drifted');
    await expect(receipts('audit-owner')).resolves.toBe(1);
    await expect(evaluate('audit-foreign', 'platform-2')).resolves.toBeNull();
    await expect(assignment()).resolves.toEqual({
      last_evaluated_at: 30,
      drift_digest: 'same-digest',
      last_transition_id: 'audit-owner',
    });
    await expect(receipts('audit-foreign')).resolves.toBe(0);
  });
});
