import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types/env';
import { createAuditLog } from '../audit-log';

const entry = {
  id: 'event-1',
  tenantId: 'tenant-a',
  userId: 'user-a',
  action: 'user.login',
  resource: 'session',
  resourceId: 'opaque',
  ipAddress: '',
  userAgent: '',
  metadata: '{}',
  severity: 'info' as const,
  createdAt: 1_800_000_000_000,
};

describe('deployment-owned audit delivery', () => {
  it('delivers the complete event without requiring Cloudflare bindings', async () => {
    const append = vi.fn(async () => {});
    await createAuditLog({ AUDIT_RUNTIME_PORTS: { append } } as Env, entry);
    expect(append).toHaveBeenCalledExactlyOnceWith(entry);
  });
  it('propagates delivery failure without exposing provider details', async () => {
    const append = vi.fn(async () => {
      throw new Error('private database hostname');
    });
    await expect(createAuditLog({ AUDIT_RUNTIME_PORTS: { append } } as Env, entry)).rejects.toThrow(
      'audit_log_runtime_write_failed'
    );
  });
  it('rejects an invalid event before delivery', async () => {
    const append = vi.fn(async () => {});
    await expect(
      createAuditLog({ AUDIT_RUNTIME_PORTS: { append } } as Env, { ...entry, id: '../bad' })
    ).rejects.toThrow('audit_log_id_invalid');
    expect(append).not.toHaveBeenCalled();
  });
});
