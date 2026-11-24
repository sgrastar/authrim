/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- admin API response bodies are untyped JSON in these route tests */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../admin-shared', async (original) => ({
  ...(await original<typeof import('../admin-shared')>()),
  writeAdminAuditLog: (await import('./logging-control-b-harness')).auditWrite,
}));
vi.mock('../admin-step-up-gate', async () => {
  const { stepUpFakes } = await import('./logging-control-b-harness');
  return {
    requireAdminStepUp: stepUpFakes.requireAdminStepUp,
    refuseAdminFreshAuth: stepUpFakes.refuseAdminFreshAuth,
  };
});
vi.mock('@authrim/ar-lib-logging/messaging', async (importOriginal) =>
  (await import('./logging-control-b-harness')).buildMessagingMock(
    await importOriginal<typeof import('@authrim/ar-lib-logging/messaging')>()
  )
);
vi.mock('../logging-message-payload-storage', async (importOriginal) =>
  (await import('./logging-control-b-harness')).buildPayloadStorageMock(
    await importOriginal<typeof import('../logging-message-payload-storage')>()
  )
);
vi.mock('@authrim/ar-lib-core', async (importOriginal) =>
  (await import('./logging-control-b-harness')).buildCoreMock(
    await importOriginal<typeof import('@authrim/ar-lib-core')>()
  )
);

import { ADMIN_PERMISSIONS } from '@authrim/ar-lib-core';
import { messagingFakes, resetFakes } from './logging-control-b-harness';
import { POLICIES, call, createApp, createPlatformApp } from './logging-control-b-app';
import {
  messageJob,
  repairFinding,
  serializedFinding,
  serializedMessageJob,
} from './logging-control-b-fixtures';

const NOW = Date.UTC(2026, 2, 5, 10, 20, 30, 123);

beforeEach(() => {
  resetFakes();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('GET /message-jobs', () => {
  const path = `${POLICIES}/message-jobs`;
  const READ = [ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ];

  it('requires delivery-events read and tenant scope', async () => {
    expect(
      (await call(createApp([ADMIN_PERMISSIONS.LOGGING_OVERVIEW_READ]), 'GET', path)).status
    ).toBe(403);
    expect((await call(createApp(READ), 'GET', `${path}?tenant_id=tenant-b`)).status).toBe(403);
  });

  it('reports each unsupported filter', async () => {
    const res = await call(
      createPlatformApp(READ),
      'GET',
      `${path}?kind=a&status=b&lane=c&source_type=d`
    );
    expect(res.status).toBe(400);
    expect(res.body.details.fields).toEqual([
      { path: 'kind', code: 'invalid_kind', message: 'Unsupported message job kind.' },
      { path: 'status', code: 'invalid_status', message: 'Unsupported message job status.' },
      { path: 'lane', code: 'invalid_lane', message: 'Unsupported delivery lane.' },
      {
        path: 'source_type',
        code: 'invalid_source_type',
        message: 'Unsupported message source type.',
      },
    ]);
    expect(messagingFakes.listJobs).not.toHaveBeenCalled();
  });

  it('passes every filter to the store and serializes the jobs', async () => {
    const job = messageJob({ claimToken: 'secret' });
    messagingFakes.listJobs.mockResolvedValue([job]);
    const res = await call(
      createPlatformApp(READ),
      'GET',
      `${path}?filter[tenant_key]=tk_a&filter[kind]=retry_delivery&filter[status]=queued&filter[lane]=bulk&filter[source_type]=dlq_item&filter[source_id]=src&filter[root_job_id]=root&filter[parent_job_id]=parent&time_start=10&time_end=20&limit=1&offset=4`
    );
    expect(res.status).toBe(200);
    expect(messagingFakes.listJobs).toHaveBeenCalledWith({
      tenantKey: 'tk_a',
      kind: 'retry_delivery',
      status: 'queued',
      lane: 'bulk',
      sourceType: 'dlq_item',
      sourceId: 'src',
      rootJobId: 'root',
      parentJobId: 'parent',
      createdAfter: 10,
      createdBefore: 20,
      limit: 1,
      offset: 4,
    });
    expect(res.body.items).toEqual([serializedMessageJob(job)]);
    expect(res.body.items[0].has_claim_token).toBe(true);
    expect(res.body.items[0]).not.toHaveProperty('claim_token');
    expect(res.body.total).toBe(1);
    expect(res.body.page).toEqual({ limit: 1, offset: 4, has_more: true });
  });

  it('uses defaults and the non-prefixed aliases, scoping tenant admins to their key', async () => {
    messagingFakes.listJobs.mockResolvedValue([]);
    const res = await call(
      createApp(READ),
      'GET',
      `${path}?kind=export_build&source_id=s&root_job_id=r&parent_job_id=p`
    );
    const args = messagingFakes.listJobs.mock.calls[0][0];
    expect(args).toMatchObject({
      kind: 'export_build',
      status: undefined,
      lane: undefined,
      sourceType: undefined,
      sourceId: 's',
      rootJobId: 'r',
      parentJobId: 'p',
      createdAfter: undefined,
      createdBefore: undefined,
      limit: 50,
      offset: 0,
    });
    expect(args.tenantKey).toMatch(/^t_/);
    expect(res.body.page).toEqual({ limit: 50, offset: 0, has_more: false });
    messagingFakes.listJobs.mockClear();
    await call(createPlatformApp(READ), 'GET', path);
    expect(messagingFakes.listJobs.mock.calls[0][0].tenantKey).toBeUndefined();
    messagingFakes.listJobs.mockRejectedValue(new Error('x'));
    expect((await call(createPlatformApp(READ), 'GET', path)).status).toBe(500);
  });
});

describe('GET /message-job-repair-findings', () => {
  const path = `${POLICIES}/message-job-repair-findings`;
  const READ = [ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ];

  it('requires delivery-events read and tenant scope', async () => {
    expect((await call(createApp([]), 'GET', path)).status).toBe(403);
    expect((await call(createApp(READ), 'GET', `${path}?tenant_key=other`)).status).toBe(403);
  });

  it('reports each unsupported filter', async () => {
    const res = await call(
      createPlatformApp(READ),
      'GET',
      `${path}?status=a&severity=b&finding_type=c`
    );
    expect(res.status).toBe(400);
    expect(res.body.details.fields).toEqual([
      { path: 'status', code: 'invalid_status', message: 'Unsupported repair finding status.' },
      {
        path: 'severity',
        code: 'invalid_severity',
        message: 'Unsupported repair finding severity.',
      },
      {
        path: 'finding_type',
        code: 'invalid_finding_type',
        message: 'Unsupported repair finding type.',
      },
    ]);
  });

  it('accepts every documented status, severity and finding type', async () => {
    messagingFakes.listRepairFindings.mockResolvedValue([]);
    const app = createPlatformApp(READ);
    for (const status of [
      'open',
      'safe_repaired',
      'dangerous_previewed',
      'dangerous_applied',
      'ignored',
    ]) {
      expect((await call(app, 'GET', `${path}?status=${status}`)).status).toBe(200);
    }
    for (const severity of ['info', 'warning', 'error', 'critical']) {
      expect((await call(app, 'GET', `${path}?severity=${severity}`)).status).toBe(200);
    }
    for (const type of [
      'stuck_claim',
      'expired_queued',
      'expired_retrying',
      'missing_payload_object',
      'missing_export_part',
      'orphan_staging_object',
      'event_job_mismatch',
      'blocked_configuration',
    ]) {
      expect((await call(app, 'GET', `${path}?finding_type=${type}`)).status).toBe(200);
    }
  });

  it('passes the filters and serializes findings', async () => {
    const finding = repairFinding();
    messagingFakes.listRepairFindings.mockResolvedValue([finding, finding]);
    const res = await call(
      createPlatformApp(READ),
      'GET',
      `${path}?filter[tenant_key]=tk_a&filter[status]=open&filter[severity]=error&filter[finding_type]=stuck_claim&filter[message_job_id]=lmj_9&limit=2&offset=6`
    );
    expect(messagingFakes.listRepairFindings).toHaveBeenCalledWith({
      tenantKey: 'tk_a',
      status: 'open',
      severity: 'error',
      findingType: 'stuck_claim',
      messageJobId: 'lmj_9',
      limit: 2,
      offset: 6,
    });
    expect(res.body.items).toEqual([serializedFinding(finding), serializedFinding(finding)]);
    expect(res.body.page).toEqual({ limit: 2, offset: 6, has_more: true });
    messagingFakes.listRepairFindings.mockClear();
    const defaults = await call(createPlatformApp(READ), 'GET', `${path}?message_job_id=m`);
    expect(messagingFakes.listRepairFindings.mock.calls[0][0]).toEqual({
      tenantKey: undefined,
      status: undefined,
      severity: undefined,
      findingType: undefined,
      messageJobId: 'm',
      limit: 50,
      offset: 0,
    });
    expect(defaults.body.page.has_more).toBe(false);
    messagingFakes.listRepairFindings.mockRejectedValue(new Error('x'));
    expect((await call(createPlatformApp(READ), 'GET', path)).status).toBe(500);
  });
});
