/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- admin API response bodies and hono/vi fakes are untyped in these route tests */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const auditWrite = vi.hoisted(() => vi.fn(async () => 'audit_1'));
vi.mock('../admin-shared', async (original) => ({
  ...(await original<typeof import('../admin-shared')>()),
  writeAdminAuditLog: auditWrite,
}));

const stepUp = vi.hoisted(() => vi.fn(async (..._args: any[]): Promise<Response | null> => null));
vi.mock('../admin-step-up-gate', () => ({
  requireAdminStepUp: stepUp,
  refuseAdminFreshAuth: vi.fn(async () => null),
}));

const mockAdapter = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  batch: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  const statusByCode: Record<string, number> = {
    [actual.AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS]: 403,
    [actual.AR_ERROR_CODES.ADMIN_INVALID_REQUEST]: 400,
    [actual.AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND]: 404,
    [actual.AR_ERROR_CODES.ADMIN_CONFLICT]: 409,
    [actual.AR_ERROR_CODES.INTERNAL_ERROR]: 500,
  };
  return {
    ...actual,
    requireAdminDatabaseAdapter: vi.fn(() => mockAdapter),
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => mockAdapter),
    getTenantIdFromContext: vi.fn((c: { get: (key: string) => unknown }) => c.get('tenantId')),
    createErrorResponse: vi.fn(
      (
        c: { json: (body: unknown, status?: number) => Response },
        errorCode: string,
        options?: { extensions?: Record<string, unknown> }
      ) =>
        c.json({ error: errorCode, ...(options?.extensions ?? {}) }, statusByCode[errorCode] ?? 500)
    ),
  };
});

import { ADMIN_PERMISSIONS, AR_ERROR_CODES } from '@authrim/ar-lib-core';
import { deriveTenantKeyFromTenantId } from '@authrim/ar-lib-logging/contract';
import { createApp, installMessageJobStore, resetAdapter } from './logging-control-a-harness';
import { must } from './helpers/must';

const RUN = ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_RUN;
const ROOT_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
type Body = Record<string, any>;

let archive: { put: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
let queueSend: ReturnType<typeof vi.fn>;
let tenantKey: string;

async function apply(
  body: unknown = {},
  opts: { platform?: boolean; perms?: string[]; bucket?: boolean } = {}
) {
  const res = await createApp(opts.perms ?? [RUN], { platform: opts.platform ?? false }).request(
    '/api/admin/logging-policies/message-job-repair-findings/apply-safe',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    {
      DB_ADMIN: {},
      OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY,
      ...(opts.bucket === false ? {} : { AUDIT_ARCHIVE: archive }),
      LOGGING_MESSAGE_QUEUE: { send: queueSend },
      LOGGING_MESSAGE_BULK_QUEUE: { send: queueSend },
    }
  );
  return { status: res.status, body: await res.json<Body>() };
}

const findingRow = (extra: Record<string, unknown> = {}) => ({
  id: 'fnd_1',
  message_job_id: 'lmj_parent',
  finding_type: 'missing_export_part',
  severity: 'error',
  status: 'open',
  safe_action: 'rebuild_export_partition',
  dangerous_action: null,
  impact_json: JSON.stringify({ export_job_id: 'exp_1' }),
  detected_at: 1,
  updated_at: 2,
  resolved_at: null,
  applied_at: null,
  applied_by: null,
  tenant_key: null,
  job_kind: 'export_build',
  job_status: 'failed',
  ...extra,
});

const exportRow = (extra: Record<string, unknown> = {}) => ({
  id: 'exp_1',
  tenant_key: 'tk_export',
  log_type: 'audit',
  plane: 'archive',
  format: 'jsonl',
  status: 'failed',
  artifact_object_ref: null,
  manifest_object_ref: null,
  checksum_sha256: null,
  record_count: 0,
  byte_count: 0,
  requested_by: 'admin-1',
  error_class: 'part_missing',
  filter_json: null,
  created_at: 1,
  updated_at: 2,
  completed_at: null,
  expires_at: null,
  ...extra,
});

function world(rows: { finding?: unknown; findings?: unknown[]; exportJob?: unknown }) {
  return installMessageJobStore(mockAdapter, {
    one: [
      { match: /FROM logging_message_repair_findings f/, result: rows.finding ?? null },
      { match: /FROM logging_export_jobs/, result: rows.exportJob ?? null },
    ],
    many: [{ match: /FROM logging_message_repair_findings f/, result: rows.findings ?? [] }],
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  resetAdapter(mockAdapter);
  auditWrite.mockReset().mockResolvedValue('audit_1');
  archive = { put: vi.fn().mockResolvedValue({}), get: vi.fn() };
  queueSend = vi.fn().mockResolvedValue(undefined);
  tenantKey = await deriveTenantKeyFromTenantId('tenant-a');
});

describe('POST /message-job-repair-findings/apply-safe', () => {
  it('requires the repair run permission', async () => {
    const res = await apply({}, { perms: [] });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  });

  it('lists open missing_export_part findings by default, honouring the clamped limit', async () => {
    world({});
    const none = await apply({}, { platform: true });
    expect(none.body.result).toMatchObject({
      applied_count: 0,
      skipped_count: 0,
      applied: [],
      skipped: [],
    });
    const listing = must(
      mockAdapter.query.mock.calls.find(([s]) =>
        String(s).includes('logging_message_repair_findings')
      )
    );
    expect(listing[0]).toContain('f.status = ? AND f.finding_type = ?');
    expect(listing[1].slice(0, 2)).toEqual(['open', 'missing_export_part']);
    expect(listing[1].at(-2)).toBe(25);
    for (const [limit, expected] of [
      [500, 50],
      [7, 7],
      [0, 25],
      [1.5, 25],
    ] as const) {
      mockAdapter.query.mockClear();
      await apply({ limit }, { platform: true });
      expect(
        must(
          mockAdapter.query.mock.calls.find(([s]) =>
            String(s).includes('logging_message_repair_findings')
          )
        )[1].at(-2)
      ).toBe(expected);
    }
    expect(auditWrite).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'logging.message_job_repair.apply_safe',
        resourceType: 'logging_message_repair_finding',
        resourceId: 'bulk-safe-repair',
        severity: 'info',
        metadata: { requested_finding_id: null, applied_count: 0, skipped_count: 0 },
      })
    );
  });

  it('looks up a single finding by id and ignores unknown ones', async () => {
    world({});
    const res = await apply({ finding_id: ' fnd_9 ' }, { platform: true });
    expect(res.body.result.applied_count).toBe(0);
    expect(mockAdapter.queryOne.mock.calls[0][1]).toEqual(['fnd_9']);
    expect(auditWrite).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ resourceId: 'fnd_9' })
    );
  });

  it('refuses findings from another tenant', async () => {
    world({ finding: findingRow({ tenant_key: 'other' }) });
    const res = await apply({ finding_id: 'fnd_1' });
    expect(res.status).toBe(403);
    expect(res.body.details.permission.reason).toBe('tenant_key_scope_mismatch');
    expect(mockAdapter.execute).not.toHaveBeenCalled();
  });

  it.each([
    ['non-open finding', { status: 'ignored' }, 'not_safe_rebuild_candidate'],
    ['other type', { finding_type: 'stuck_claim' }, 'not_safe_rebuild_candidate'],
    ['other action', { safe_action: 'something_else' }, 'not_safe_rebuild_candidate'],
  ])('skips a %s', async (_n, extra, reason) => {
    world({ finding: findingRow({ tenant_key: tenantKey, ...extra }) });
    const res = await apply({ finding_id: 'fnd_1' });
    expect(res.status).toBe(200);
    expect(res.body.result.skipped).toEqual([
      {
        id: 'fnd_1',
        reason,
        status: (extra as Body).status ?? 'open',
        finding_type: (extra as Body).finding_type ?? 'missing_export_part',
      },
    ]);
    expect(res.body.result.applied_count).toBe(0);
  });

  it('skips findings without an export job id or whose export job is gone', async () => {
    for (const impact of [
      null,
      '{}',
      JSON.stringify({ export_job_id: '' }),
      JSON.stringify({ export_job_id: 5 }),
    ]) {
      world({ finding: findingRow({ tenant_key: tenantKey, impact_json: impact }) });
      const res = await apply({ finding_id: 'fnd_1' });
      expect(res.body.result.skipped).toEqual([{ id: 'fnd_1', reason: 'export_job_id_missing' }]);
    }
    world({ finding: findingRow({ tenant_key: tenantKey }) });
    const missing = await apply({ finding_id: 'fnd_1' });
    expect(missing.body.result.skipped).toEqual([
      { id: 'fnd_1', reason: 'export_job_not_found', export_job_id: 'exp_1' },
    ]);
  });

  it('rebuilds a standard catalog export as a default-lane plan job', async () => {
    const store = world({
      finding: findingRow({ tenant_key: tenantKey }),
      exportJob: exportRow({ expires_at: 5_000_000 }),
    });
    const res = await apply({ finding_id: 'fnd_1' });
    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ applied_count: 1, skipped_count: 0 });
    const applied = res.body.result.applied[0];
    expect(applied).toMatchObject({
      id: 'fnd_1',
      export_job_id: 'exp_1',
      queued: true,
      queue_binding: 'LOGGING_MESSAGE_QUEUE',
    });
    expect(applied.message_job_id).toMatch(/^lmj_/);
    expect(applied.payload_object_ref).toEqual(expect.any(String));
    const job = store.inserts[0];
    expect(job).toMatchObject({
      kind: 'export_build',
      lane: 'default',
      criticality: 'standard',
      priority: 10,
      tenant_key: 'tk_export',
      topology_type: 'unknown',
      scope_type: 'tenant',
      scope_id: 'tk_export',
      scope_key: 'tenant:tk_export',
      source_type: 'payload_object',
      source_id: 'exp_1',
      parent_job_id: 'lmj_parent',
      depth: 1,
      payload_type: 'export_build',
      max_attempts: 5,
      requested_by: 'admin-1',
      reason: 'repair:fnd_1:rebuild_export_partition',
      expires_at: 5_000_000,
    });
    expect(job.idempotency_key).toMatch(/^repair:fnd_1:exp_1:\d+$/);
    expect(JSON.parse(job.attempt_policy_json as string)).toEqual({
      maxAttempts: 5,
      leaseTimeoutMs: 600000,
    });
    expect(Number(job.dedupe_until) - Number(job.created_at)).toBe(24 * 60 * 60 * 1000);
    const message = queueSend.mock.calls[0][0];
    expect(message).toMatchObject({
      payload_type: 'export_build',
      export_job_id: 'exp_1',
      phase: 'plan',
      partition_strategy: 'time_bucket_shard',
      tenant_key: 'tk_export',
      lane: 'default',
      requested_by: 'admin-1',
      message_job_id: applied.message_job_id,
    });
    expect(message.snapshot_cutoff_at).toBe(message.created_at);
    const buildInsert = must(
      mockAdapter.execute.mock.calls.find(([s]) =>
        String(s).includes('INSERT INTO logging_message_export_builds')
      )
    );
    expect(buildInsert[1].slice(1, 9)).toEqual([
      applied.message_job_id,
      'exp_1',
      'plan',
      'time_bucket_shard',
      null,
      0,
      1,
      message.snapshot_cutoff_at,
    ]);
    expect(buildInsert[1][20]).toBe('not_required');
    expect(JSON.parse(buildInsert[1][21])).toEqual({ filters: {}, repair_finding_id: 'fnd_1' });
    const statusUpdate = must(
      mockAdapter.execute.mock.calls.find(([s]) => String(s).includes('UPDATE logging_export_jobs'))
    );
    expect(statusUpdate[1]).toEqual(['queued', expect.any(Number), 'exp_1']);
    const marked = must(
      mockAdapter.execute.mock.calls.find(([s]) =>
        String(s).includes('UPDATE logging_message_repair_findings')
      )
    );
    expect(marked[1].slice(0, 5)).toEqual([
      'safe_repaired',
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      'admin-1',
    ]);
    expect(auditWrite).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        severity: 'warn',
        resourceId: 'fnd_1',
        metadata: { requested_finding_id: 'fnd_1', applied_count: 1, skipped_count: 0 },
      })
    );
  });

  it('defaults the job expiry to a week when the export has none', async () => {
    const store = world({ finding: findingRow({ tenant_key: tenantKey }), exportJob: exportRow() });
    await apply({ finding_id: 'fnd_1' });
    const job = store.inserts[0];
    expect(Number(job.expires_at) - Number(job.created_at)).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it.each([
    [
      'include_payload object',
      { filter_json: { include_payload: true } },
      'bulk',
      0,
      'time_bucket_shard',
      'LOGGING_MESSAGE_BULK_QUEUE',
    ],
    [
      'record_index JSON string',
      { filter_json: JSON.stringify({ source: 'record_index' }) },
      'bulk',
      0,
      'query_page',
      'LOGGING_MESSAGE_BULK_QUEUE',
    ],
    [
      'sensitive_detail plane',
      { plane: 'sensitive_detail' },
      'default',
      100,
      'chunk_index',
      'LOGGING_MESSAGE_QUEUE',
    ],
    [
      'sensitive detail with record_index',
      {
        plane: 'sensitive_detail',
        filter_json: JSON.stringify({ source: 'record_index', include_payload: true }),
      },
      'bulk',
      100,
      'chunk_index',
      'LOGGING_MESSAGE_BULK_QUEUE',
    ],
  ])('plans %s', async (_n, extra, lane, priority, strategy, binding) => {
    const store = world({
      finding: findingRow({ tenant_key: tenantKey }),
      exportJob: exportRow(extra),
    });
    const res = await apply({ finding_id: 'fnd_1' });
    expect(res.status).toBe(200);
    expect(store.inserts[0]).toMatchObject({
      lane,
      priority,
      criticality: (extra as Body).plane === 'sensitive_detail' ? 'critical' : 'standard',
    });
    expect(queueSend.mock.calls[0][0]).toMatchObject({ lane, partition_strategy: strategy });
    expect(res.body.result.applied[0].queue_binding).toBe(binding);
  });

  it('ignores unusable filter_json values and uses the tenant key from the filters when present', async () => {
    for (const filter_json of ['not json', '[1,2]', '   ', '"str"']) {
      const store = world({
        finding: findingRow({ tenant_key: tenantKey }),
        exportJob: exportRow({ filter_json }),
      });
      const res = await apply({ finding_id: 'fnd_1' });
      expect(res.status).toBe(200);
      expect(store.inserts[0].lane).toBe('default');
      const buildInsert = must(
        mockAdapter.execute.mock.calls.find(([s]) =>
          String(s).includes('INSERT INTO logging_message_export_builds')
        )
      );
      expect(JSON.parse(buildInsert[1][21]).filters).toEqual({});
      mockAdapter.execute.mockClear();
    }
    const store = world({
      finding: findingRow({ tenant_key: tenantKey }),
      exportJob: exportRow({ filter_json: { tenant_key: 'tk_filter', note: 'x' } }),
    });
    await apply({ finding_id: 'fnd_1' });
    expect(store.inserts[0]).toMatchObject({ tenant_key: 'tk_filter', scope_id: 'tk_filter' });
    expect(must(queueSend.mock.calls.at(-1))[0].tenant_key).toBe('tk_filter');
  });

  it('uses platform scope for exports without a tenant key', async () => {
    const store = world({ finding: findingRow(), exportJob: exportRow({ tenant_key: null }) });
    const res = await apply({ finding_id: 'fnd_1' }, { platform: true });
    expect(res.status).toBe(200);
    expect(store.inserts[0]).toMatchObject({
      scope_type: 'platform',
      scope_id: null,
      scope_key: 'platform',
      topology_type: 'platform',
    });
  });

  it('fails with 500 when no payload bucket is configured or a write fails', async () => {
    world({ finding: findingRow({ tenant_key: tenantKey }), exportJob: exportRow() });
    expect((await apply({ finding_id: 'fnd_1' }, { bucket: false })).status).toBe(500);
    expect(mockAdapter.execute).not.toHaveBeenCalled();
    archive.put.mockRejectedValue(new Error('r2'));
    expect((await apply({ finding_id: 'fnd_1' })).status).toBe(500);
  });
});
