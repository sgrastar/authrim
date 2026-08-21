import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  adapter: null as DatabaseAdapter | null,
  audit: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  getTenantIdFromContext: vi.fn(() => 'tenant-a'),
  resolveAccountDataContextFromHono: vi.fn(async () => ({})),
  createAccountAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.adapter })),
}));

vi.mock('../admin-tenant-access', () => ({
  getAdminAuth: vi.fn(() => ({ userId: 'admin-a', actorId: 'operator-a' })),
}));

vi.mock('../admin-shared', () => ({
  logSanitizedError: vi.fn(),
  scheduleAdminAuditLog: mocks.audit,
}));

import {
  adminAccountLegalHoldCreateHandler,
  adminAccountLegalHoldReleaseHandler,
  adminAccountSupportContextPutHandler,
} from '../admin-account-governance';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
type SqlValue = string | number | null | Uint8Array;

function sqliteAdapter(database: DatabaseSync): DatabaseAdapter {
  const values = (params: unknown[] = []): SqlValue[] =>
    params.map((value) => {
      if (
        typeof value === 'string' ||
        typeof value === 'number' ||
        value === null ||
        value instanceof Uint8Array
      ) {
        return value;
      }
      throw new Error('unsupported_test_sql_value');
    });
  const execute = async (sql: string, params: unknown[] = []) => {
    const result = database.prepare(sql).run(...values(params));
    return {
      success: true,
      rowsAffected: Number(result.changes),
      meta: { changes: result.changes },
    };
  };
  return {
    query: async <T>(sql: string, params: unknown[] = []) =>
      database.prepare(sql).all(...values(params)) as T[],
    queryOne: async <T>(sql: string, params: unknown[] = []) =>
      (database.prepare(sql).get(...values(params)) as T | undefined) ?? null,
    execute,
    batch: async (statements: Parameters<DatabaseAdapter['batch']>[0]) => {
      database.exec('BEGIN IMMEDIATE');
      try {
        const results = [];
        for (const statement of statements) {
          results.push(await execute(statement.sql, statement.params));
        }
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as DatabaseAdapter;
}

function context(input: {
  body: unknown;
  idempotencyKey?: string;
  holdId?: string;
  control?: { applyAccountLegalHoldProjection: ReturnType<typeof vi.fn> };
}) {
  return {
    req: {
      param: vi.fn((name: string) => (name === 'holdId' ? input.holdId : 'user-a')),
      header: vi.fn((name: string) =>
        name === 'Idempotency-Key' ? input.idempotencyKey : undefined
      ),
      json: vi.fn(async () => input.body),
    },
    env: input.control ? { CONTROL: input.control } : {},
    json: vi.fn((body: unknown, status = 200) => Response.json(body, { status })),
    executionCtx: { waitUntil: vi.fn() },
  } as never;
}

describe('Admin account governance handlers', () => {
  let database: DatabaseSync;

  beforeEach(() => {
    vi.clearAllMocks();
    database = new DatabaseSync(':memory:');
    database.exec('PRAGMA foreign_keys = ON');
    database.exec(
      readFileSync(resolve(REPO_ROOT, 'migrations/001_pre_1_0_core_baseline.sql'), 'utf8')
        .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '(unixepoch() * 1000)')
        .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', 'unixepoch()')
    );
    database.exec(
      `INSERT INTO identity_accounts (
         id, tenant_id, account_type, lifecycle_state, legacy_user_id, created_at, updated_at
       ) VALUES ('account-a', 'tenant-a', 'person', 'active', 'user-a', 100, 100)`
    );
    mocks.adapter = sqliteAdapter(database);
  });

  afterEach(() => database.close());

  it('creates and releases a hold idempotently without advancing projection gaps on retries', async () => {
    const createRequest = context({
      idempotencyKey: 'create-hold-request-1',
      body: { reason_code: 'litigation', case_reference: 'CASE-123' },
    });
    const created = await adminAccountLegalHoldCreateHandler(createRequest);
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { id: string; version: number; state: string };
    expect(createdBody).toMatchObject({ version: 1, state: 'active' });
    expect(
      database
        .prepare(
          `SELECT projection_state, projection_generation FROM account_legal_hold_states
            WHERE tenant_id = 'tenant-a' AND account_id = 'account-a'`
        )
        .get()
    ).toEqual({ projection_state: 'active', projection_generation: 2 });

    expect((await adminAccountLegalHoldCreateHandler(createRequest)).status).toBe(201);
    expect(
      database.prepare(`SELECT COUNT(*) AS count FROM legal_hold_projection_outbox`).get()
    ).toEqual({ count: 1 });
    expect(
      database.prepare(`SELECT projection_generation FROM account_legal_hold_states`).get()
    ).toEqual({ projection_generation: 2 });

    const releaseRequest = context({
      idempotencyKey: 'release-hold-request-1',
      holdId: createdBody.id,
      body: { expected_version: 1, reason_code: 'case_closed' },
    });
    const released = await adminAccountLegalHoldReleaseHandler(releaseRequest);
    expect(released.status).toBe(200);
    await expect(released.json()).resolves.toMatchObject({ version: 2, state: 'released' });
    expect((await adminAccountLegalHoldReleaseHandler(releaseRequest)).status).toBe(200);
    expect(
      database.prepare(`SELECT COUNT(*) AS count FROM legal_hold_projection_outbox`).get()
    ).toEqual({ count: 2 });
    expect(
      database
        .prepare(`SELECT projection_state, projection_generation FROM account_legal_hold_states`)
        .get()
    ).toEqual({ projection_state: 'inactive', projection_generation: 3 });
    expect(
      database
        .prepare(
          `SELECT event_type, hold_version, projection_generation
             FROM legal_hold_events ORDER BY projection_generation`
        )
        .all()
    ).toEqual([
      { event_type: 'created', hold_version: 1, projection_generation: 2 },
      { event_type: 'released', hold_version: 2, projection_generation: 3 },
    ]);
  });

  it('uses optimistic versions and does not copy support content into audit metadata', async () => {
    const first = await adminAccountSupportContextPutHandler(
      context({
        body: {
          expected_version: 0,
          context: {
            schema_version: 1,
            summary: 'Sensitive support summary',
            external_references: [{ system: 'zendesk', kind: 'ticket', reference: 'ZD-98765' }],
          },
        },
      })
    );
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({ version: 1 });
    const stale = await adminAccountSupportContextPutHandler(
      context({
        body: {
          expected_version: 0,
          context: { schema_version: 1, external_references: [] },
        },
      })
    );
    expect(stale.status).toBe(409);
    const auditPayload = JSON.stringify(mocks.audit.mock.calls);
    expect(auditPayload).not.toContain('Sensitive support summary');
    expect(auditPayload).not.toContain('ZD-98765');
    expect(auditPayload).toContain('external_reference_count');
  });

  it('projects a hold immediately when Control is available and completes the durable outbox row', async () => {
    const applyAccountLegalHoldProjection = vi.fn(async (input: unknown) => input);
    const response = await adminAccountLegalHoldCreateHandler(
      context({
        idempotencyKey: 'create-hold-projected-1',
        body: { reason_code: 'regulatory_review' },
        control: { applyAccountLegalHoldProjection },
      })
    );

    expect(response.status).toBe(201);
    expect(applyAccountLegalHoldProjection).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        accountId: 'account-a',
        projectionGeneration: 2,
        projectionState: 'active',
      })
    );
    expect(
      database
        .prepare(
          `SELECT status, attempt_count, completed_at IS NOT NULL AS completed
             FROM legal_hold_projection_outbox`
        )
        .get()
    ).toEqual({ status: 'succeeded', attempt_count: 0, completed: 1 });
  });
});
