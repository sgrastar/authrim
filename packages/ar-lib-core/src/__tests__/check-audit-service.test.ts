import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LogIcebergRowWrite } from '../services/log-iceberg-emitter';
import type { LogIcebergRuntimeEnv } from '../services/log-iceberg-runtime';
import type { ExecutionContext } from '@cloudflare/workers-types';
import {
  CheckAuditService,
  DEFAULT_CHECK_AUDIT_CONFIG,
  createCheckAuditService,
  generateAuditId,
  type PermissionCheckAuditEntry,
} from '../services/check-audit-service';
const { emit, errorLog } = vi.hoisted(() => ({
  emit: vi.fn<(env: LogIcebergRuntimeEnv, input: LogIcebergRowWrite) => Promise<void>>(),
  errorLog: vi.fn(),
}));
vi.mock('../services/log-iceberg-emitter', () => ({ emitLogIcebergRow: emit }));
vi.mock('../utils/logger', () => ({
  createLogger: () => ({ module: () => ({ error: errorLog }) }),
}));
const env: LogIcebergRuntimeEnv = { AUTHRIM_LOG_ARCHIVE_MODE: 'scheduled' };
const entry = (patch: Partial<PermissionCheckAuditEntry> = {}): PermissionCheckAuditEntry => ({
  id: 'audit-1',
  tenantId: 'tenant-a',
  subjectId: 'subject-a',
  permission: 'documents:read',
  allowed: false,
  resolvedVia: ['direct'],
  finalDecision: 'deny',
  ...patch,
});
function context(waitUntil: (promise: Promise<unknown>) => void): ExecutionContext {
  return { waitUntil, passThroughOnException: () => {}, props: {} };
}
function written(): LogIcebergRowWrite {
  const value = emit.mock.calls.at(-1)?.[1];
  if (!value) throw new Error('Missing emitted audit');
  return value;
}
describe('permission-check audit through the explicit storage writer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-27T00:00:00.000Z'));
    emit.mockReset().mockResolvedValue(undefined);
    errorLog.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  it('retains deny-all, one-percent allow sampling and 90-day defaults', () => {
    expect(DEFAULT_CHECK_AUDIT_CONFIG).toEqual({
      mode: 'waitUntil',
      logDeny: 'always',
      logAllow: 'sample',
      sampleRate: 0.01,
      retentionDays: 90,
    });
    const service = new CheckAuditService(env);
    expect(service.shouldLog(false)).toBe(true);
    vi.spyOn(Math, 'random').mockReturnValue(0.009);
    expect(service.shouldLog(true)).toBe(true);
    vi.mocked(Math.random).mockReturnValue(0.01);
    expect(service.shouldLog(true)).toBe(false);
    service.updateConfig({ logAllow: 'always' });
    expect(service.shouldLog(true)).toBe(true);
    service.updateConfig({ logAllow: 'never' });
    expect(service.shouldLog(true)).toBe(false);
    expect(service.shouldLog(false)).toBe(true);
  });
  it('does not produce a record when an allowed decision is excluded', async () => {
    const waitUntil = vi.fn();
    await new CheckAuditService(env, { logAllow: 'never' }).log(
      entry({ allowed: true, finalDecision: 'allow' }),
      context(waitUntil)
    );
    expect(emit).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });
  it.each(['sync', 'queue'] as const)(
    'submits one frozen record with explicit timestamps and expiry in %s mode',
    async (mode) => {
      const input = entry({
        permissionParsed: {
          type: 'type_level',
          resource: 'documents',
          action: 'read',
          original: 'documents:read',
        },
        reason: 'No matching role',
        apiKeyId: 'key-a',
        clientId: 'client-a',
        requestId: 'request-a',
      });
      await createCheckAuditService(env, { mode }).log(input);
      expect(emit).toHaveBeenCalledTimes(1);
      const output = written();
      expect(output).toMatchObject({
        tenantId: 'tenant-a',
        sourceDataset: 'core.permission_check_audit',
        eventAt: Date.now(),
        expiresAt: Date.now() + 90 * 86400000,
        overview: { result: 'deny', subject_id: 'subject-a', request_id: 'request-a' },
      });
      expect(output.row).toEqual({
        id: 'audit-1',
        tenant_id: 'tenant-a',
        subject_id: 'subject-a',
        permission: 'documents:read',
        permission_json: JSON.stringify(input.permissionParsed),
        allowed: 0,
        resolved_via_json: '["direct"]',
        final_decision: 'deny',
        reason: 'No matching role',
        api_key_id: 'key-a',
        client_id: 'client-a',
        checked_at: Date.now() / 1000,
      });
    }
  );
  it('uses configured retention and awaits the common durable writer', async () => {
    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => (release = resolve));
    emit.mockImplementation(async () => blocked);
    let finished = false;
    const running = new CheckAuditService(env, { mode: 'queue', retentionDays: 7 })
      .log(entry())
      .then(() => (finished = true));
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(written().expiresAt).toBe(Date.now() + 7 * 86400000);
    release();
    await running;
    expect(finished).toBe(true);
  });
  it('handles a rejected waitUntil write without rejecting authorization', async () => {
    emit.mockRejectedValueOnce(new Error('transport failed'));
    const pending: Promise<unknown>[] = [];
    await expect(
      new CheckAuditService(env).log(
        entry(),
        context((promise) => pending.push(promise))
      )
    ).resolves.toBeUndefined();
    expect(pending).toHaveLength(1);
    await expect(pending[0]).resolves.toBeUndefined();
    expect(errorLog).toHaveBeenCalledTimes(1);
  });
  it('captures content and expiry before returning a waitUntil operation', async () => {
    const input = entry();
    let saved: LogIcebergRowWrite | undefined;
    emit.mockImplementation(async (_env, record) => {
      await Promise.resolve();
      saved = record;
    });
    const pending: Promise<unknown>[] = [];
    await new CheckAuditService(env).log(
      input,
      context((promise) => pending.push(promise))
    );
    input.resolvedVia.push('role');
    input.subjectId = 'changed';
    vi.setSystemTime(Date.now() + 86400000);
    await Promise.all(pending);
    expect(saved?.row.subject_id).toBe('subject-a');
    expect(saved?.row.resolved_via_json).toBe('["direct"]');
    expect(saved?.expiresAt).toBe(Date.parse('2026-10-27T00:00:00.000Z') + 90 * 86400000);
  });
  it.each(['sync', 'queue', 'waitUntil'] as const)(
    'keeps %s transport failures from changing authorization',
    async (mode) => {
      emit.mockRejectedValueOnce(new Error('transport failed'));
      await expect(new CheckAuditService(env, { mode }).log(entry())).resolves.toBeUndefined();
      expect(errorLog).toHaveBeenCalledTimes(1);
    }
  );
  it('handles preparation and execution-context failures without altering a decision', async () => {
    const broken = entry();
    Object.defineProperty(broken, 'subjectId', {
      get() {
        throw new Error('cannot prepare');
      },
      enumerable: true,
    });
    await expect(new CheckAuditService(env).log(broken)).resolves.toBeUndefined();
    expect(emit).not.toHaveBeenCalled();
    await expect(
      new CheckAuditService(env).log(
        entry(),
        context(() => {
          throw new Error('context failed');
        })
      )
    ).resolves.toBeUndefined();
    expect(errorLog).toHaveBeenCalledTimes(2);
  });
  it('does not emit a record with invalid retention', async () => {
    for (const retentionDays of [0, -1, 1.5, 3651])
      await expect(
        new CheckAuditService(env, { mode: 'sync', retentionDays }).log(entry())
      ).resolves.toBeUndefined();
    expect(emit).not.toHaveBeenCalled();
  });
  it('returns independent configuration objects', () => {
    const service = new CheckAuditService(env);
    const copy = service.getConfig();
    copy.sampleRate = 1;
    expect(service.getConfig().sampleRate).toBe(0.01);
  });
  it('generates independent event IDs in the supported format', () => {
    const ids = Array.from({ length: 1000 }, () => generateAuditId());
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^aud_[a-z0-9]+$/.test(id) && id.length < 64)).toBe(true);
  });
});
