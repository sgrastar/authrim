import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const mocked = vi.hoisted(() => ({
  findActiveEmailTombstone: vi.fn(),
  createAuditLogFromContext: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async () => {
  const actual =
    await vi.importActual<typeof import('@authrim/ar-lib-core')>('@authrim/ar-lib-core');
  return {
    ...actual,
    findActiveEmailTombstone: mocked.findActiveEmailTombstone,
    createAuditLogFromContext: mocked.createAuditLogFromContext,
  };
});
vi.mock('../lookup-hmac-runtime', () => ({ loadLookupHmacRuntimeKeys: vi.fn() }));

import { checkTombstoneEmail } from '../routes/settings/tombstones';
import { findAdminRouteAccessRule } from '../admin-route-access';
import { ADMIN_PERMISSIONS } from '@authrim/ar-lib-core';

function context(body: unknown) {
  const store = new Map<string, unknown>([['tenantId', 'acme']]);
  return {
    req: {
      json: vi.fn(async () => {
        if (body instanceof Error) throw body;
        return body;
      }),
      query: vi.fn(),
      param: vi.fn(),
    },
    env: {} as Env,
    json: vi.fn((payload, status = 200) => new Response(JSON.stringify(payload), { status })),
    get: vi.fn((key: string) => store.get(key)),
    set: vi.fn((key: string, value: unknown) => store.set(key, value)),
  } as any;
}

describe('POST /api/admin/tombstones/email-check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.createAuditLogFromContext.mockResolvedValue(undefined);
  });

  it('answers whether the address was deleted, when, and until when, but not whose it was', async () => {
    const deletedAt = Date.UTC(2026, 9, 1);
    mocked.findActiveEmailTombstone.mockResolvedValue({
      deleted_at: deletedAt,
      retention_until: deletedAt + 90 * 86400000,
    });
    const c = context({ email: 'gone@example.com' });

    const response = await checkTombstoneEmail(c);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      deleted: true,
      deleted_at: '2026-10-01T00:00:00.000Z',
      retention_until: '2026-12-30T00:00:00.000Z',
    });
    expect(mocked.findActiveEmailTombstone).toHaveBeenCalledWith(
      c.env,
      { tenantId: 'acme', email: 'gone@example.com' },
      expect.objectContaining({ loadKeys: expect.any(Function) })
    );
    // Audited without the address.
    expect(mocked.createAuditLogFromContext).toHaveBeenCalledWith(
      c,
      'tombstone.email_checked',
      'tombstone',
      'email',
      { deleted: true }
    );
    expect(JSON.stringify(mocked.createAuditLogFromContext.mock.calls)).not.toContain(
      'gone@example.com'
    );
  });

  it('answers deleted: false for an address with no record within retention', async () => {
    mocked.findActiveEmailTombstone.mockResolvedValue(null);
    const response = await checkTombstoneEmail(context({ email: 'kept@example.com' }));
    expect(await response.json()).toEqual({ deleted: false });
  });

  it.each([[{}], [{ email: '' }], [{ email: 42 }], [new SyntaxError('bad json')]])(
    'requires an address in the body (%#)',
    async (body) => {
      const response = await checkTombstoneEmail(context(body));
      expect(response.status).toBe(400);
      expect(mocked.findActiveEmailTombstone).not.toHaveBeenCalled();
    }
  );

  it('answers a server error when the records cannot be searched', async () => {
    mocked.findActiveEmailTombstone.mockRejectedValue(new Error('missing_registry_row'));
    const response = await checkTombstoneEmail(context({ email: 'gone@example.com' }));
    expect(response.status).toBe(500);
  });

  it('needs users:read, not settings permissions', () => {
    expect(findAdminRouteAccessRule('POST', '/api/admin/tombstones/email-check')).toMatchObject({
      permissions: [ADMIN_PERMISSIONS.USERS_READ],
    });
    expect(findAdminRouteAccessRule('POST', '/api/admin/tombstones/cleanup')).toMatchObject({
      permissions: [ADMIN_PERMISSIONS.SETTINGS_WRITE],
    });
  });
});
