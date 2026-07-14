import { describe, expect, it, vi } from 'vitest';
import type { DurableObjectNamespace, KVNamespace } from '@cloudflare/workers-types';
import {
  createPermissionChangeEvent,
  createPermissionChangeNotifier,
} from '../permission-change-notifier';

function event(overrides: Record<string, unknown> = {}) {
  return {
    event: 'grant' as const,
    tenant_id: 'tenant-a',
    subject_id: 'user-1',
    resource: 'document:1',
    relation: 'viewer',
    permission: 'read',
    timestamp: 100,
    ...overrides,
  };
}

describe('PermissionChangeNotifier', () => {
  it('invalidates tenant-scoped subject, role, resource, relation, and exact permission keys', async () => {
    const deleteKey = vi.fn().mockResolvedValue(undefined);
    const notifier = createPermissionChangeNotifier({
      cache: { delete: deleteKey } as unknown as KVNamespace,
    });

    await expect(notifier.publish(event())).resolves.toMatchObject({
      success: true,
      cacheInvalidated: true,
      auditLogged: false,
      websocketNotified: 0,
    });
    expect(deleteKey.mock.calls.map(([key]) => key)).toEqual(
      expect.arrayContaining([
        'check:tenant-a:subject:user-1',
        'rebac:tenant-a:roles:user-1',
        'check:tenant-a:resource:document:1',
        'rebac:tenant-a:relations:document:1',
        'check:tenant-a:user-1:read',
      ])
    );
  });

  it('fails closed before side effects when an event has no tenant', async () => {
    const deleteKey = vi.fn();
    const notifier = createPermissionChangeNotifier({
      cache: { delete: deleteKey } as unknown as KVNamespace,
    });

    await expect(notifier.publish(event({ tenant_id: '  ' }))).rejects.toThrow(
      'Permission change event requires tenantId'
    );
    expect(deleteKey).not.toHaveBeenCalled();
  });

  it('reports partial delivery failures without failing other invalidation channels', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 }));
    const notifier = createPermissionChangeNotifier({
      cache: { delete: vi.fn().mockResolvedValue(undefined) } as unknown as KVNamespace,
      permissionChangeHub: {
        idFromName: vi.fn().mockReturnValue({}),
        get: vi.fn().mockReturnValue({ fetch }),
      } as unknown as DurableObjectNamespace,
    });

    await expect(notifier.publish(event())).resolves.toMatchObject({
      success: true,
      cacheInvalidated: true,
      websocketNotified: 0,
    });
    expect(fetch).toHaveBeenCalledWith(
      'https://internal/broadcast',
      expect.objectContaining({
        method: 'POST',
      })
    );
  });

  it('creates normalized events and rejects tenantless helper input', () => {
    expect(
      createPermissionChangeEvent('revoke', ' tenant-a ', 'user-1', { permission: 'write' })
    ).toMatchObject({
      event: 'revoke',
      tenant_id: 'tenant-a',
      subject_id: 'user-1',
      permission: 'write',
    });
    expect(() => createPermissionChangeEvent('grant', '', 'user-1')).toThrow(
      'Permission change event requires tenantId'
    );
  });
});
