/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- admin API response bodies are untyped JSON in these route tests */
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
vi.mock('@authrim/ar-lib-core', async (importOriginal) =>
  (await import('./logging-control-b-harness')).buildCoreMock(
    await importOriginal<typeof import('@authrim/ar-lib-core')>()
  )
);

import type { Env } from '@authrim/ar-lib-core';
import { ADMIN_PERMISSIONS } from '@authrim/ar-lib-core';
import { deriveTenantKeyFromTenantId } from '@authrim/ar-lib-logging/contract';
import {
  auditWrite,
  coreFakes,
  envFixture,
  mockAdapter,
  resetFakes,
  stepUpFakes,
} from './logging-control-b-harness';
import { POLICIES, call, createApp, createPlatformApp } from './logging-control-b-app';

const NOW = Date.UTC(2026, 2, 5, 10, 20, 30, 123);
const READ = [ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ];
const DELETE = [ADMIN_PERMISSIONS.LOGGING_DLQ_DELETE];
const PURGE = [ADMIN_PERMISSIONS.LOGGING_DLQ_PURGE];
const PAYLOAD = `${POLICIES}/dlq-items/dlq_1/payload`;
const DELETE_PATH = `${POLICIES}/dlq-items/dlq_1/delete`;
const PURGE_PATH = `${POLICIES}/dlq-items/dlq_1/purge`;
const REF = 'dlq/tenant_key=tk_a/item.json';

function dlqRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dlq_1',
    tenant_key: 'tk_a',
    payload_type: 'delivery_fanout',
    schema_version: 1,
    lane: 'default',
    destination_id: 'dest_1',
    payload_object_ref: REF,
    error_class: 'delivery_failed',
    attempt_count: 3,
    status: 'open',
    created_at: 1000,
    updated_at: 2000,
    ...overrides,
  };
}

function textObject(text: string, extra: Record<string, unknown> = {}) {
  return { text: async () => text, size: new TextEncoder().encode(text).byteLength, ...extra };
}

const withEnv = (extra: Record<string, unknown>) => ({ ...envFixture, ...extra }) as unknown as Env;

beforeEach(() => {
  resetFakes();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('GET /dlq-items/:id/payload', () => {
  it('requires delivery-events read, 404s unknown items and enforces tenancy', async () => {
    expect((await call(createApp([]), 'GET', PAYLOAD)).status).toBe(403);
    expect((await call(createPlatformApp(READ), 'GET', PAYLOAD)).status).toBe(404);
    expect(mockAdapter.queryOne.mock.calls[0][1]).toEqual(['dlq_1']);
    mockAdapter.queryOne.mockResolvedValue(dlqRow());
    const foreign = await call(createApp(READ), 'GET', PAYLOAD);
    expect(foreign.status).toBe(403);
  });

  it('needs the payload bucket and object', async () => {
    mockAdapter.queryOne.mockResolvedValue(dlqRow());
    const noBucket = await call(
      createPlatformApp(READ),
      'GET',
      PAYLOAD,
      undefined,
      {},
      withEnv({ AUDIT_ARCHIVE: undefined })
    );
    expect(noBucket.status).toBe(400);
    expect(noBucket.body.details.fields).toEqual([
      {
        path: 'payload_object_ref',
        code: 'bucket_unavailable',
        message: 'DLQ payload bucket is unavailable.',
      },
    ]);
    const missing = await call(createPlatformApp(READ), 'GET', PAYLOAD);
    expect(missing.status).toBe(404);
    expect(envFixture.AUDIT_ARCHIVE.get).toHaveBeenCalledWith(REF);
  });

  it('previews a redacted json payload with its metadata', async () => {
    mockAdapter.queryOne.mockResolvedValue(dlqRow());
    const payload = { payload_type: 'delivery_fanout', schema_version: 1, token: 'x'.repeat(10) };
    const text = JSON.stringify(payload);
    envFixture.AUDIT_ARCHIVE.get.mockResolvedValue(
      textObject(text, { httpMetadata: { contentType: 'application/json' } })
    );
    const res = await call(createPlatformApp(READ), 'GET', PAYLOAD);
    expect(res.status).toBe(200);
    expect(res.body.item).toMatchObject({
      id: 'dlq_1',
      tenant_key: 'tk_a',
      payload_type: 'delivery_fanout',
      schema_version: 1,
      lane: 'default',
      destination_id: 'dest_1',
      payload_object_ref: REF,
      error_class: 'delivery_failed',
      attempt_count: 3,
      status: 'open',
      created_at: 1000,
      updated_at: 2000,
    });
    const preview = res.body.item.payload;
    expect(preview).toMatchObject({
      content_type: 'application/json',
      byte_count: text.length,
      truncated: false,
    });
    expect(preview.parsed.json_parse).toEqual({ ok: true });
    expect(preview.parsed.redaction.applied).toBe(true);
    expect(JSON.parse(preview.text_preview)).toEqual(preview.parsed.redacted_json);
  });

  it('suppresses non-json payloads and falls back to default content metadata', async () => {
    mockAdapter.queryOne.mockResolvedValue(dlqRow());
    envFixture.AUDIT_ARCHIVE.get.mockResolvedValue({ text: async () => 'secret text' });
    const res = await call(createPlatformApp(READ), 'GET', PAYLOAD);
    expect(res.body.item.payload).toMatchObject({
      content_type: 'application/octet-stream',
      byte_count: 11,
      text_preview: '[non-json payload redacted]',
      truncated: false,
      parsed: {
        json_parse: { ok: false },
        redaction: { applied: true, raw_preview_suppressed: true, reason: 'payload_is_not_json' },
      },
    });
  });

  it('truncates the preview to preview_bytes (default 8 KiB, capped at 64 KiB)', async () => {
    mockAdapter.queryOne.mockResolvedValue(dlqRow());
    const big = JSON.stringify({ blob: 'a'.repeat(200) });
    envFixture.AUDIT_ARCHIVE.get.mockResolvedValue(textObject(big));
    const small = await call(createPlatformApp(READ), 'GET', `${PAYLOAD}?preview_bytes=20`);
    expect(small.body.item.payload.truncated).toBe(true);
    expect(small.body.item.payload.text_preview).toHaveLength(20);
    const exact = await call(createPlatformApp(READ), 'GET', `${PAYLOAD}?preview_bytes=65536`);
    expect(exact.body.item.payload.truncated).toBe(false);
    const clamped = await call(createPlatformApp(READ), 'GET', `${PAYLOAD}?preview_bytes=999999`);
    expect(clamped.body.item.payload.truncated).toBe(false);
    for (const value of ['0', '-4', 'abc']) {
      const res = await call(createPlatformApp(READ), 'GET', `${PAYLOAD}?preview_bytes=${value}`);
      expect(res.body.item.payload.truncated).toBe(false);
    }
    const dflt = await call(createPlatformApp(READ), 'GET', PAYLOAD);
    expect(dflt.body.item.payload.truncated).toBe(false);
  });

  it('answers 500 when the lookup fails', async () => {
    mockAdapter.queryOne.mockRejectedValue(new Error('x'));
    expect((await call(createPlatformApp(READ), 'GET', PAYLOAD)).status).toBe(500);
  });
});

describe('POST /dlq-items/:id/delete', () => {
  it('requires the dlq delete permission', async () => {
    expect((await call(createApp(READ), 'POST', DELETE_PATH)).status).toBe(403);
    expect(mockAdapter.queryOne).not.toHaveBeenCalled();
  });

  it('rejects unknown, closed and foreign items', async () => {
    expect((await call(createApp(DELETE), 'POST', DELETE_PATH)).status).toBe(404);
    mockAdapter.queryOne.mockResolvedValue(dlqRow({ status: 'deleted' }));
    const closed = await call(createApp(DELETE), 'POST', DELETE_PATH);
    expect(closed.status).toBe(400);
    expect(closed.body.details.fields).toEqual([
      { path: 'status', code: 'invalid_state', message: 'Only open DLQ items can be modified.' },
    ]);
    mockAdapter.queryOne.mockResolvedValue(dlqRow());
    expect((await call(createApp(DELETE), 'POST', DELETE_PATH)).status).toBe(403);
    expect(mockAdapter.execute).not.toHaveBeenCalled();
  });

  it('requires step-up, then marks the item deleted and audits it', async () => {
    mockAdapter.queryOne.mockResolvedValue(dlqRow());
    stepUpFakes.requireAdminStepUp.mockResolvedValueOnce(new Response('stepup', { status: 401 }));
    const refused = await call(createPlatformApp(DELETE), 'POST', DELETE_PATH);
    expect(refused.status).toBe(401);
    expect(mockAdapter.execute).not.toHaveBeenCalled();
    expect(stepUpFakes.requireAdminStepUp).toHaveBeenCalledWith(expect.anything(), {
      operation: 'audit.retention.shorten',
      targetTenantId: 'tenant-a',
      targetIds: ['dlq_1'],
      params: { kind: 'logging.dlq.delete', tenant_key: 'tk_a', next_status: 'deleted' },
    });
    const res = await call(createPlatformApp(DELETE), 'POST', DELETE_PATH);
    expect(res.status).toBe(200);
    expect(res.body.result).toEqual({ id: 'dlq_1', status: 'deleted', updated_at: NOW });
    expect(res.body.audit_id).toBe('audit-id-1');
    const [sql, params] = mockAdapter.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("SET status = 'deleted', updated_at = ?");
    expect(sql).toContain("WHERE id = ? AND status = 'open'");
    expect(params).toEqual([NOW, 'dlq_1']);
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'logging.dlq.delete',
        resourceType: 'logging_dlq_item',
        resourceId: 'dlq_1',
        result: 'success',
        severity: 'info',
        metadata: {
          dlq_item_id: 'dlq_1',
          tenant_key: 'tk_a',
          payload_type: 'delivery_fanout',
          lane: 'default',
          previous_status: 'open',
          next_status: 'deleted',
        },
      })
    );
    mockAdapter.execute.mockRejectedValue(new Error('x'));
    expect((await call(createPlatformApp(DELETE), 'POST', DELETE_PATH)).status).toBe(500);
  });

  it('lets a tenant admin delete its own tenant items', async () => {
    mockAdapter.queryOne.mockResolvedValue(
      dlqRow({ tenant_key: await deriveTenantKeyFromTenantId('tenant-a', undefined) })
    );
    expect((await call(createApp(DELETE), 'POST', DELETE_PATH)).status).toBe(200);
  });
});

describe('POST /dlq-items/:id/purge', () => {
  const confirm = { confirmation: 'PURGE DLQ dlq_1' };

  it('requires the purge permission and the exact confirmation', async () => {
    expect((await call(createApp(READ), 'POST', PURGE_PATH, confirm)).status).toBe(403);
    for (const confirmation of [undefined, '', 'PURGE DLQ other', 'purge dlq dlq_1', 7]) {
      const res = await call(createPlatformApp(PURGE), 'POST', PURGE_PATH, { confirmation });
      expect(res.status).toBe(400);
      expect(res.body.details.fields).toEqual([
        {
          path: 'confirmation',
          code: 'confirmation_mismatch',
          message: 'Confirmation must be: PURGE DLQ dlq_1',
        },
      ]);
    }
    expect(mockAdapter.queryOne).not.toHaveBeenCalled();
    mockAdapter.queryOne.mockResolvedValue(dlqRow());
    const trimmed = await call(createPlatformApp(PURGE), 'POST', PURGE_PATH, {
      confirmation: '  PURGE DLQ dlq_1  ',
    });
    expect(trimmed.status).toBe(200);
  });

  it('rejects unknown, closed and foreign items and a missing bucket', async () => {
    expect((await call(createPlatformApp(PURGE), 'POST', PURGE_PATH, confirm)).status).toBe(404);
    mockAdapter.queryOne.mockResolvedValue(dlqRow({ status: 'purged' }));
    const closed = await call(createPlatformApp(PURGE), 'POST', PURGE_PATH, confirm);
    expect(closed.body.details.fields[0].code).toBe('invalid_state');
    mockAdapter.queryOne.mockResolvedValue(dlqRow());
    expect((await call(createApp(PURGE), 'POST', PURGE_PATH, confirm)).status).toBe(403);
    const noBucket = await call(
      createPlatformApp(PURGE),
      'POST',
      PURGE_PATH,
      confirm,
      {},
      withEnv({ AUDIT_ARCHIVE: undefined })
    );
    expect(noBucket.body.details.fields).toEqual([
      {
        path: 'payload_object_ref',
        code: 'bucket_unavailable',
        message: 'DLQ payload bucket is unavailable.',
      },
    ]);
    expect(envFixture.AUDIT_ARCHIVE.delete).not.toHaveBeenCalled();
  });

  it('keeps the payload while a tenant backup snapshot is capturing', async () => {
    mockAdapter.queryOne.mockResolvedValue(dlqRow());
    coreFakes.hasBackupSnapshot.mockResolvedValue(true);
    const res = await call(createPlatformApp(PURGE), 'POST', PURGE_PATH, confirm);
    expect(res.status).toBe(400);
    expect(res.body.details.fields).toEqual([
      {
        path: 'payload_object_ref',
        code: 'backup_snapshot_active',
        message: 'DLQ payload is retained while a tenant backup snapshot is active.',
      },
    ]);
    expect(coreFakes.hasBackupSnapshot).toHaveBeenCalledWith(mockAdapter);
    expect(envFixture.AUDIT_ARCHIVE.delete).not.toHaveBeenCalled();
  });

  it('requires step-up before deleting the object, then marks the item purged', async () => {
    mockAdapter.queryOne.mockResolvedValue(dlqRow());
    stepUpFakes.requireAdminStepUp.mockResolvedValueOnce(new Response('stepup', { status: 401 }));
    expect((await call(createPlatformApp(PURGE), 'POST', PURGE_PATH, confirm)).status).toBe(401);
    expect(envFixture.AUDIT_ARCHIVE.delete).not.toHaveBeenCalled();
    expect(stepUpFakes.requireAdminStepUp).toHaveBeenCalledWith(expect.anything(), {
      operation: 'audit.retention.shorten',
      targetTenantId: 'tenant-a',
      targetIds: ['dlq_1'],
      params: {
        kind: 'logging.dlq.purge',
        tenant_key: 'tk_a',
        payload_object_ref: REF,
        next_status: 'purged',
      },
    });
    const res = await call(createPlatformApp(PURGE), 'POST', PURGE_PATH, confirm);
    expect(res.status).toBe(200);
    expect(res.body.result).toEqual({ id: 'dlq_1', status: 'purged', updated_at: NOW });
    expect(envFixture.AUDIT_ARCHIVE.delete).toHaveBeenCalledWith(REF);
    const [sql, params] = mockAdapter.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("SET status = 'purged', updated_at = ?");
    expect(params).toEqual([NOW, 'dlq_1']);
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'logging.dlq.purge',
        result: 'success',
        severity: 'warn',
        metadata: expect.objectContaining({
          next_status: 'purged',
          confirmation: 'PURGE DLQ dlq_1',
          previous_status: 'open',
        }),
      })
    );
  });

  it('audits a failed purge and answers 500', async () => {
    mockAdapter.queryOne.mockResolvedValue(dlqRow());
    envFixture.AUDIT_ARCHIVE.delete.mockRejectedValue(new Error('r2 down'));
    const res = await call(createPlatformApp(PURGE), 'POST', PURGE_PATH, confirm);
    expect(res.status).toBe(500);
    expect(mockAdapter.execute).not.toHaveBeenCalled();
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'logging.dlq.purge',
        result: 'failure',
        severity: 'warn',
        metadata: expect.objectContaining({ error_class: 'r2 down', dlq_item_id: 'dlq_1' }),
      })
    );
    auditWrite.mockClear();
    envFixture.AUDIT_ARCHIVE.delete.mockRejectedValue('weird');
    await call(createPlatformApp(PURGE), 'POST', PURGE_PATH, confirm);
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        metadata: expect.objectContaining({ error_class: 'unknown_error' }),
      })
    );
    auditWrite.mockClear();
    mockAdapter.queryOne.mockRejectedValue(new Error('db down'));
    const none = await call(createPlatformApp(PURGE), 'POST', PURGE_PATH, confirm);
    expect(none.status).toBe(500);
    expect(auditWrite).not.toHaveBeenCalled();
  });
});
