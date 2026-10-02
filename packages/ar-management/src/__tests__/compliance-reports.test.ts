import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  core: null as unknown,
  admin: { tag: 'admin' },
  audit: vi.fn(),
  materialize: vi.fn(),
  load: vi.fn(),
  tombstone: vi.fn(),
  status: vi.fn(),
  hotSupport: vi.fn(),
  stores: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getTenantIdFromContext: vi.fn(() => 'tenant-a'),
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.core })),
    getTenantMetadataContextFromHono: vi.fn(() => ({ route: {} })),
    requireAdminDatabaseAdapter: vi.fn(() => mocks.admin),
    createAuditLogFromContext: mocks.audit,
    loadCatalogObjectRepresentation: mocks.load,
    tombstoneObjectCatalogEntryForTenant: mocks.tombstone,
    resolveTenantRuntimeProfilesFromEnv: vi.fn(async () => ({ auditProfile: { id: 'p' } })),
    resolveTenantAssignedDatabaseSourcesFromRegistry: mocks.stores,
    ensureDatabaseAdapter: vi.fn((source: unknown) => source),
    getLogger: vi.fn(() => ({
      module: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
    })),
    createErrorResponse: vi.fn((c, code) =>
      c.json(
        { error: code },
        code === actual.AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND
          ? 404
          : code === actual.AR_ERROR_CODES.INTERNAL_ERROR
            ? 500
            : 400
      )
    ),
  };
});
vi.mock('../object-artifact-materialization', () => ({
  materializeEncryptedObjectArtifact: mocks.materialize,
}));
vi.mock('../admin-compliance', () => ({ readComplianceStatus: mocks.status }));
vi.mock('../audit-hot-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../audit-hot-query')>()),
  getAuditHotQuerySupportForProfile: mocks.hotSupport,
}));

import {
  createComplianceReport,
  downloadComplianceReport,
  getComplianceReport,
  listComplianceReports,
} from '../compliance/report-routes';
import { MAX_REPORT_ROWS } from '../compliance/reports';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SCHEMA = [
  readFileSync(resolve(REPO_ROOT, 'migrations/core/d1/001_0_4_0_core_baseline.sql'), 'utf8')
    .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '(unixepoch() * 1000)')
    .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', 'unixepoch()'),
  ...[
    '002_guest_account_lifecycle',
    '003_account_registration_state',
    '014_access_review_apply',
    '015_compliance_report_artifacts',
  ].map((name) => readFileSync(resolve(REPO_ROOT, `migrations/core/d1/${name}.sql`), 'utf8')),
];

type SqlValue = string | number | null;
const values = (params: unknown[] = []) =>
  params.map((value): SqlValue => (value === undefined ? null : (value as SqlValue)));

function sqliteStore() {
  const db = new DatabaseSync(':memory:');
  for (const sql of SCHEMA) db.exec(sql);
  db.exec('PRAGMA foreign_keys = OFF');
  return {
    db,
    async query(sql: string, params?: unknown[]) {
      return db.prepare(sql).all(...values(params));
    },
    async queryOne(sql: string, params?: unknown[]) {
      return db.prepare(sql).get(...values(params)) ?? null;
    },
    async execute(sql: string, params?: unknown[]) {
      return {
        success: true,
        rowsAffected: Number(db.prepare(sql).run(...values(params)).changes),
      };
    },
  };
}

type Store = ReturnType<typeof sqliteStore>;

function context(
  options: {
    body?: unknown;
    params?: Record<string, string>;
    query?: Record<string, string>;
    env?: Record<string, unknown>;
  } = {}
) {
  return {
    get: vi.fn((key: string) => (key === 'adminAuth' ? { userId: 'admin-1' } : undefined)),
    req: {
      param: vi.fn((name: string) => options.params?.[name]),
      query: vi.fn((name: string) => options.query?.[name]),
      json: vi.fn().mockResolvedValue(options.body ?? {}),
    },
    env: options.env ?? {
      DB_ADMIN: {},
      EXPORT_ARTIFACTS: {},
      OBJECT_ENCRYPTION_ROOT_KEY: 'a'.repeat(64),
    },
    json: vi.fn((value: unknown, status = 200) => Response.json(value, { status })),
  } as never;
}

async function json(response: Response) {
  return (await response.json()) as Record<string, any>;
}

function review(store: Store, id: string, items: number) {
  store.db
    .prepare(
      `INSERT INTO access_reviews (id, tenant_id, name, scope, status, created_at)
       VALUES (?, 'tenant-a', 'Q3', 'role', 'completed', '2026-09-01T00:00:00.000Z')`
    )
    .run(id);
  const insert = store.db.prepare(
    `INSERT INTO access_review_items (id, review_id, tenant_id, user_id, permission_type,
       permission_value, decision, decided_by, decided_at, justification, created_at,
       apply_status)
     VALUES (?, ?, 'tenant-a', ?, 'role', 'role-admin', 'revoked', 'admin-1',
       '2026-09-02T00:00:00.000Z', ?, '2026-09-01T00:00:00.000Z', 'applied')`
  );
  store.db.exec('BEGIN');
  for (let index = 0; index < items; index += 1) {
    insert.run(`item-${String(index).padStart(5, '0')}`, id, `user-${index}`, '=cmd|calc');
  }
  store.db.exec('COMMIT');
}

describe('compliance reports', () => {
  let core: Store;

  beforeEach(() => {
    vi.clearAllMocks();
    core = sqliteStore();
    mocks.core = core;
    mocks.audit.mockResolvedValue(undefined);
    mocks.materialize.mockImplementation(async () => ({
      catalogId: 'catalog-1',
      primaryObjectKey: 'key',
    }));
    mocks.tombstone.mockResolvedValue(undefined);
  });

  async function stored(content: string) {
    // What the artifact store hands back: the content materialize was given.
    mocks.load.mockResolvedValueOnce({ content, contentType: 'text/csv' });
  }

  it("generates an access review's report, stored encrypted and audited", async () => {
    review(core, 'rev-1', 2);
    const response = await createComplianceReport(
      context({ body: { type: 'access_review', parameters: { review_id: 'rev-1' } } })
    );
    expect(response.status).toBe(201);
    const report = await json(response);
    expect(report).toMatchObject({
      type: 'access_review',
      status: 'completed',
      format: 'csv',
      row_count: 2,
      requested_by: 'admin-1',
      downloadable: true,
    });
    expect(Date.parse(report.expires_at) - Date.parse(report.created_at)).toBe(30 * 86400000);
    const [adapter, , options] = mocks.materialize.mock.calls[0]!;
    // Catalogued in the admin database, where the artifact cleanup deletes from.
    expect(adapter).toBe(mocks.admin);
    expect(options).toMatchObject({
      tenantId: 'tenant-a',
      objectClass: 'admin_job_result',
      representation: 'csv_projection',
      contentType: 'text/csv',
    });
    const content = options.content as string;
    expect(content.split('\n')[0]).toBe(
      'item_id,user_id,permission_type,permission_value,decision,decided_by,decided_at,justification,apply_status,applied_at,apply_error'
    );
    // A cell a spreadsheet would run as a formula is made inert.
    expect(content).toContain("'=cmd|calc");
    expect(report.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      'compliance_report.created',
      'compliance_report',
      report.report_id,
      { type: 'access_review', format: 'csv', row_count: 2 }
    );

    // Downloaded as generated, its hash checked, the download audited.
    await stored(content);
    const download = await downloadComplianceReport(context({ params: { id: report.report_id } }));
    expect(download.status).toBe(200);
    expect(download.headers.get('Content-Disposition')).toContain('attachment;');
    expect(download.headers.get('Cache-Control')).toBe('no-store');
    expect(await download.text()).toBe(content);
    expect(mocks.load).toHaveBeenCalledWith(mocks.admin, expect.anything(), {
      tenantId: 'tenant-a',
      objectCatalogId: 'catalog-1',
      representation: 'csv_projection',
      expectedClass: 'admin_job_result',
      expectedBucketBinding: 'EXPORT_ARTIFACTS',
      allowPlaintextFallback: false,
    });
    expect(mocks.audit).toHaveBeenLastCalledWith(
      expect.anything(),
      'compliance_report.downloaded',
      'compliance_report',
      report.report_id,
      expect.objectContaining({ sha256: report.sha256 })
    );

    // Content that is not the one generated is not handed out.
    await stored(`${content}\nforged`);
    expect(
      (await downloadComplianceReport(context({ params: { id: report.report_id } }))).status
    ).toBe(500);
  });

  it('records a report with more rows than one holds as failed, not cut short', async () => {
    review(core, 'rev-big', MAX_REPORT_ROWS + 1);
    const response = await createComplianceReport(
      context({ body: { type: 'access_review', parameters: { review_id: 'rev-big' } } })
    );
    expect(response.status).toBe(422);
    const body = await json(response);
    expect(body.report).toMatchObject({
      status: 'failed',
      error: 'too_large',
      downloadable: false,
    });
    expect(mocks.materialize).not.toHaveBeenCalled();
  });

  it('refuses what it cannot make, and says when storage is missing', async () => {
    for (const body of [
      { type: 'access_review' },
      { type: 'audit_log', parameters: { from: '2026-01-01T00:00:00Z' } },
      {
        type: 'audit_log',
        parameters: { from: '2025-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' },
      },
      { type: 'unknown' },
      { type: 'mfa_coverage', parameters: { extra: 1 } },
    ]) {
      expect((await createComplianceReport(context({ body }))).status).toBe(400);
    }
    expect(
      (
        await createComplianceReport(
          context({ body: { type: 'access_review', parameters: { review_id: 'missing' } } })
        )
      ).status
    ).toBe(404);
    expect(
      (await createComplianceReport(context({ body: { type: 'compliance_status' }, env: {} })))
        .status
    ).toBe(503);
  });

  it('keeps the compliance status of that moment as JSON', async () => {
    mocks.status.mockResolvedValue({ overall_status: 'warning', checks: [] });
    const response = await createComplianceReport(context({ body: { type: 'compliance_status' } }));
    expect(response.status).toBe(201);
    const [, , options] = mocks.materialize.mock.calls[0]!;
    expect(options).toMatchObject({
      representation: 'canonical_json',
      contentType: 'application/json',
    });
    expect(JSON.parse(options.content)).toEqual({ overall_status: 'warning', checks: [] });
  });

  it('lists audit log entries of the period, oldest first', async () => {
    const events = sqliteStore();
    const insert = events.db.prepare(
      `INSERT INTO event_log (id, tenant_id, event_type, event_category, result, created_at)
       VALUES (?, ?, 'login.success', 'auth', 'success', ?)`
    );
    insert.run('e-before', 'tenant-a', Date.parse('2026-08-31T23:59:59Z'));
    insert.run('e-2', 'tenant-a', Date.parse('2026-09-02T00:00:00Z'));
    insert.run('e-1', 'tenant-a', Date.parse('2026-09-01T00:00:00Z'));
    insert.run('e-other', 'tenant-b', Date.parse('2026-09-01T00:00:00Z'));
    insert.run('e-end', 'tenant-a', Date.parse('2026-09-03T00:00:00Z'));
    mocks.hotSupport.mockReturnValue({
      supported: true,
      context: {
        adapter: events,
        mode: 'unified',
        dialect: 'sqlite',
        createdAtUnit: 'milliseconds',
      },
    });
    const response = await createComplianceReport(
      context({
        body: {
          type: 'audit_log',
          parameters: { from: '2026-09-01T00:00:00Z', to: '2026-09-03T00:00:00Z' },
        },
      })
    );
    expect(response.status).toBe(201);
    const lines = (mocks.materialize.mock.calls[0]![2].content as string).split('\n');
    expect(lines[0]).toBe(
      'id,occurred_at,action,event_category,result,severity,actor,client_id,error_code'
    );
    expect(lines.slice(1).map((line) => line.split(',')[0])).toEqual(['e-1', 'e-2']);

    mocks.hotSupport.mockReturnValue({ supported: false, status: 'not_supported' });
    expect(
      (
        await createComplianceReport(
          context({
            body: {
              type: 'audit_log',
              parameters: { from: '2026-09-01T00:00:00Z', to: '2026-09-03T00:00:00Z' },
            },
          })
        )
      ).status
    ).toBe(409);
  });

  it("lists who has MFA by identifier, from the tenant's stores once each", async () => {
    const users = sqliteStore();
    users.db.exec(`INSERT INTO identity_accounts (id, tenant_id, account_type, lifecycle_state,
        legacy_user_id, created_at, updated_at)
      VALUES ('account:u-1', 'tenant-a', 'user', 'active', 'u-1', 0, 0),
             ('account:u-2', 'tenant-a', 'user', 'active', 'u-2', 0, 0),
             ('account:u-3', 'tenant-a', 'user', 'deleting', 'u-3', 0, 0)`);
    users.db.exec(`INSERT INTO passkeys (id, tenant_id, user_id, credential_id, public_key, counter,
        created_at) VALUES ('pk-1', 'tenant-a', 'u-1', 'cred-1', 'key', 0, 0)`);
    mocks.stores.mockResolvedValue([
      { source: users, bindingRef: 'DB' },
      { source: users, bindingRef: 'DB' },
    ]);
    const admin = { query: vi.fn(async () => [{ id: 'admin-1', has_passkey: 1 }]) };
    mocks.admin = admin as never;
    const response = await createComplianceReport(context({ body: { type: 'mfa_coverage' } }));
    expect(response.status).toBe(201);
    expect((mocks.materialize.mock.calls[0]![2].content as string).split('\n')).toEqual([
      'kind,id,registration_state,passkey,totp',
      'admin,admin-1,,yes,',
      'user,u-1,registered,yes,no',
      'user,u-2,registered,no,no',
    ]);
    mocks.admin = { tag: 'admin' };
  });

  it('pages reports newest first and shows those past their download period as expired', async () => {
    const insert = core.db.prepare(
      `INSERT INTO compliance_reports (id, tenant_id, type, name, status, created_at, expires_at,
         object_catalog_id, format)
       VALUES (?, 'tenant-a', 'mfa_coverage', ?, 'completed', ?, ?, 'catalog', 'csv')`
    );
    insert.run('r-1', 'old', '2026-01-01T00:00:00.000Z', '2026-01-31T00:00:00.000Z');
    insert.run('r-2', 'new', '2026-09-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z');
    insert.run('r-3', 'newer', '2026-09-02T00:00:00.000Z', '2099-01-01T00:00:00.000Z');
    const first = await json(await listComplianceReports(context({ query: { limit: '2' } })));
    expect(first.data.map((report: { report_id: string }) => report.report_id)).toEqual([
      'r-3',
      'r-2',
    ]);
    const next = await json(
      await listComplianceReports(
        context({ query: { limit: '2', cursor: first.pagination.next_cursor } })
      )
    );
    expect(next.data).toMatchObject([{ report_id: 'r-1', status: 'expired', downloadable: false }]);
    expect((await downloadComplianceReport(context({ params: { id: 'r-1' } }))).status).toBe(404);
    expect((await getComplianceReport(context({ params: { id: 'missing' } }))).status).toBe(404);
    for (const query of [{ cursor: 'bad' }, { status: 'pending' }, { type: 'soc2' }] as Array<
      Record<string, string>
    >) {
      expect((await listComplianceReports(context({ query }))).status).toBe(400);
    }
  });

  it('keeps a report not downloadable, and removes its file, when its generation cannot be audited', async () => {
    mocks.status.mockResolvedValue({ overall_status: 'compliant' });
    mocks.audit.mockRejectedValueOnce(new Error('audit_unavailable'));
    const response = await createComplianceReport(context({ body: { type: 'compliance_status' } }));
    expect(response.status).toBe(503);
    const [row] = core.db.prepare('SELECT * FROM compliance_reports').all();
    expect(row).toMatchObject({
      status: 'failed',
      error_message: 'storage_failed',
      object_catalog_id: null,
      object_key_base: null,
    });
    expect(mocks.tombstone).toHaveBeenCalledWith(
      mocks.admin,
      'tenant-a',
      'catalog-1',
      expect.any(Number)
    );
  });

  it('deletes what was stored when the file is stored but not catalogued, or leaves it for the retention task', async () => {
    mocks.status.mockResolvedValue({ overall_status: 'compliant' });
    mocks.materialize.mockRejectedValueOnce(new Error('catalog_insert_failed'));
    const bucket = {
      list: vi.fn(async () => ({ objects: [{ key: 'k.json' }], truncated: false })),
      delete: vi.fn(async () => undefined),
    };
    const env = {
      DB_ADMIN: {},
      EXPORT_ARTIFACTS: bucket,
      OBJECT_ENCRYPTION_ROOT_KEY: 'a'.repeat(64),
    };
    expect(
      (await createComplianceReport(context({ body: { type: 'compliance_status' }, env }))).status
    ).toBe(503);
    const id = (core.db.prepare('SELECT id FROM compliance_reports').get() as { id: string }).id;
    expect(bucket.list).toHaveBeenCalledWith({
      prefix: `compliance-reports/tenant-a/${id}.`,
      cursor: undefined,
    });
    expect(bucket.delete).toHaveBeenCalledWith(['k.json']);

    // Deleting fails too: the report keeps where its file is, due now, for the retention task.
    mocks.materialize.mockRejectedValueOnce(new Error('catalog_insert_failed'));
    bucket.delete.mockRejectedValueOnce(new Error('r2_unavailable'));
    await createComplianceReport(context({ body: { type: 'compliance_status' }, env }));
    const left = core.db
      .prepare('SELECT * FROM compliance_reports WHERE object_key_base IS NOT NULL')
      .all() as Array<{ status: string; expires_at: string }>;
    expect(left).toHaveLength(1);
    expect(left[0]!.status).toBe('failed');
    expect(Date.parse(left[0]!.expires_at)).toBeLessThanOrEqual(Date.now());
  });

  it('fails a report whose completion cannot be recorded, removing its file', async () => {
    mocks.status.mockResolvedValue({ overall_status: 'compliant' });
    const execute = core.execute.bind(core);
    core.execute = async (sql: string, params?: unknown[]) => {
      if (sql.includes("SET status = 'completed'")) throw new Error('d1_unavailable');
      return execute(sql, params);
    };
    const response = await createComplianceReport(context({ body: { type: 'compliance_status' } }));
    expect(response.status).toBe(503);
    expect(
      core.db.prepare('SELECT status, object_catalog_id FROM compliance_reports').get()
    ).toMatchObject({ status: 'failed', object_catalog_id: null });
    expect(mocks.tombstone).toHaveBeenCalled();
    // Its generation was audited, so its failure is too.
    expect(mocks.audit).toHaveBeenLastCalledWith(
      expect.anything(),
      'compliance_report.failed',
      'compliance_report',
      expect.any(String),
      { type: 'compliance_status', error: 'storage_failed' }
    );
  });

  it('audits a failure recorded though its answer was lost, leaving the file to the retention task', async () => {
    mocks.status.mockResolvedValue({ overall_status: 'compliant' });
    const execute = core.execute.bind(core);
    core.execute = async (sql: string, params?: unknown[]) => {
      if (sql.includes("SET status = 'completed'")) throw new Error('d1_unavailable');
      const result = await execute(sql, params);
      if (sql.includes("SET status = 'failed'")) throw new Error('d1_timeout');
      return result;
    };
    const response = await createComplianceReport(context({ body: { type: 'compliance_status' } }));
    expect(response.status).toBe(503);
    const row = core.db
      .prepare('SELECT status, object_catalog_id, expires_at FROM compliance_reports')
      .get() as { status: string; object_catalog_id: string | null; expires_at: string };
    expect(row).toMatchObject({ status: 'failed', object_catalog_id: 'catalog-1' });
    expect(Date.parse(row.expires_at)).toBeLessThanOrEqual(Date.now());
    expect(mocks.tombstone).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenLastCalledWith(
      expect.anything(),
      'compliance_report.failed',
      'compliance_report',
      expect.any(String),
      { type: 'compliance_status', error: 'storage_failed' }
    );
  });

  it('keeps a report whose completion was recorded though its answer was lost', async () => {
    mocks.status.mockResolvedValue({ overall_status: 'compliant' });
    const execute = core.execute.bind(core);
    core.execute = async (sql: string, params?: unknown[]) => {
      const result = await execute(sql, params);
      if (sql.includes("SET status = 'completed'")) throw new Error('d1_timeout');
      return result;
    };
    const response = await createComplianceReport(context({ body: { type: 'compliance_status' } }));
    expect(response.status).toBe(201);
    expect(core.db.prepare('SELECT status FROM compliance_reports').get()).toMatchObject({
      status: 'completed',
    });
    expect(mocks.tombstone).not.toHaveBeenCalled();
  });

  it('keeps the file when completion cannot be confirmed either way', async () => {
    mocks.status.mockResolvedValue({ overall_status: 'compliant' });
    const execute = core.execute.bind(core);
    core.execute = async (sql: string, params?: unknown[]) => {
      const result = await execute(sql, params);
      if (sql.includes("SET status = 'completed'")) throw new Error('d1_timeout');
      return result;
    };
    // Reading it back fails once too: its state is unknown, so nothing is removed.
    const queryOne = core.queryOne.bind(core);
    let failedRead = false;
    core.queryOne = async (sql: string, params?: unknown[]) => {
      if (!failedRead && sql.startsWith('SELECT status, object_catalog_id')) {
        failedRead = true;
        throw new Error('d1_timeout');
      }
      return queryOne(sql, params);
    };
    const response = await createComplianceReport(context({ body: { type: 'compliance_status' } }));
    expect(response.status).toBe(201);
    expect(core.db.prepare('SELECT status FROM compliance_reports').get()).toMatchObject({
      status: 'completed',
    });
    expect(mocks.tombstone).not.toHaveBeenCalled();
  });

  it('filters by the status each report is shown with', async () => {
    const insert = core.db.prepare(
      `INSERT INTO compliance_reports (id, tenant_id, type, name, status, created_at, expires_at,
         object_catalog_id, format)
       VALUES (?, 'tenant-a', 'mfa_coverage', ?, 'completed', ?, ?, 'catalog', 'csv')`
    );
    // Past its download period, not marked by the retention task yet.
    insert.run('r-due', 'due', '2026-01-01T00:00:00.000Z', '2026-01-31T00:00:00.000Z');
    insert.run('r-ok', 'ok', '2026-09-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z');
    const ids = async (status: string) =>
      (await json(await listComplianceReports(context({ query: { status } })))).data.map(
        (report: { report_id: string }) => report.report_id
      );
    expect(await ids('expired')).toEqual(['r-due']);
    expect(await ids('completed')).toEqual(['r-ok']);
  });

  it('writes CSV a spreadsheet reads as text, rows intact', async () => {
    const { toCsv } = await import('../admin-job-executor');
    expect(
      toCsv([{ a: '-1+SUM(1)', b: 'ok\r=1+1', c: -5, d: '@cmd', e: 'plain' }]).split('\n')[1]
    ).toBe(`'-1+SUM(1),"ok\r=1+1",-5,'@cmd,plain`);
  });
});
