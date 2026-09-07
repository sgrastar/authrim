import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  adapter: {
    queryOne: vi.fn(),
  },
  findActiveInvitationByToken: vi.fn(),
  hasRemainingInvitationUses: vi.fn(),
  consumeInvitationUse: vi.fn(),
  applyInvitationAssignments: vi.fn(),
  findUserById: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async () => {
  const actual =
    await vi.importActual<typeof import('@authrim/ar-lib-core')>('@authrim/ar-lib-core');
  return {
    ...actual,
    resolveOptionalCoreAdapterFromHono: vi.fn(() => mocks.adapter),
    createPIIContextFromHono: vi.fn(() => ({ defaultPiiAdapter: {} })),
    CanonicalRuntimeUserStore: class {
      findById = mocks.findUserById;
    },
    getLogger: vi.fn(() => ({
      module: () => ({ warn: mocks.warn, error: mocks.error }),
    })),
  };
});

vi.mock('@authrim/ar-lib-core/services/invitation-auth-core', () => ({
  findActiveInvitationByToken: mocks.findActiveInvitationByToken,
  hasRemainingInvitationUses: mocks.hasRemainingInvitationUses,
  consumeInvitationUse: mocks.consumeInvitationUse,
  applyInvitationAssignments: mocks.applyInvitationAssignments,
}));

import { useInvitationHandler, validateInvitationHandler } from '../invitation-handlers';

const token = 'a'.repeat(32);
const invitation = {
  id: 'invitation-1',
  token,
  tenant_id: 'tenant-1',
  invited_email: 'Invited@Example.com',
  role_id: 'role-1',
  org_id: 'org-1',
  max_uses: 1,
  use_count: 0,
  expires_at: 2_000_000_000,
};

function createApp() {
  const app = new Hono();
  app.get('/validate', validateInvitationHandler);
  app.post('/use', useInvitationHandler);
  return app;
}

describe('public invitation handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findActiveInvitationByToken.mockResolvedValue(invitation);
    mocks.hasRemainingInvitationUses.mockReturnValue(true);
    mocks.adapter.queryOne.mockResolvedValue({ id: 'tenant-1', name: 'Tenant One' });
    mocks.findUserById.mockResolvedValue({
      id: 'user-1',
      email: 'invited@example.com',
    });
    mocks.consumeInvitationUse.mockResolvedValue(true);
    mocks.applyInvitationAssignments.mockResolvedValue({
      roleAssignment: { success: true },
      orgMembership: { success: true },
    });
  });

  describe('GET /validate', () => {
    it.each(['', 'too-short'])(
      'rejects a missing or undersized token without a database lookup',
      async (invalidToken) => {
        const suffix = invalidToken ? `?token=${invalidToken}` : '';
        const response = await createApp().request(`/validate${suffix}`, undefined, {});

        expect(response.status).toBe(400);
        expect(mocks.findActiveInvitationByToken).not.toHaveBeenCalled();
      }
    );

    it('returns tenant details for an active invitation', async () => {
      const response = await createApp().request(`/validate?token=${token}`, undefined, {});

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        valid: true,
        invitation_id: 'invitation-1',
        tenant_id: 'tenant-1',
        tenant_name: 'Tenant One',
        invited_email: 'Invited@Example.com',
        expires_at: 2_000_000_000,
      });
      expect(mocks.findActiveInvitationByToken).toHaveBeenCalledWith(
        mocks.adapter,
        token,
        expect.any(Number)
      );
    });

    it('does not disclose a missing invitation', async () => {
      mocks.findActiveInvitationByToken.mockResolvedValueOnce(null);

      const response = await createApp().request(`/validate?token=${token}`, undefined, {});

      expect(response.status).toBe(404);
      expect(mocks.adapter.queryOne).not.toHaveBeenCalled();
    });

    it('does not disclose an exhausted invitation', async () => {
      mocks.hasRemainingInvitationUses.mockReturnValueOnce(false);

      const response = await createApp().request(`/validate?token=${token}`, undefined, {});

      expect(response.status).toBe(404);
      expect(mocks.adapter.queryOne).not.toHaveBeenCalled();
    });

    it('hides an invitation whose tenant no longer exists', async () => {
      mocks.adapter.queryOne.mockResolvedValueOnce(null);

      const response = await createApp().request(`/validate?token=${token}`, undefined, {});

      expect(response.status).toBe(404);
      expect(mocks.warn).toHaveBeenCalledWith(
        'Invitation references non-existent tenant',
        expect.objectContaining({ tenant_id: 'tenant-1' })
      );
    });

    it('returns an internal error when the storage lookup fails', async () => {
      mocks.findActiveInvitationByToken.mockRejectedValueOnce(new Error('database unavailable'));

      const response = await createApp().request(`/validate?token=${token}`, undefined, {});

      expect(response.status).toBe(500);
      expect(mocks.error).toHaveBeenCalled();
    });
  });

  describe('POST /use', () => {
    it.each([{}, { token }, { user_id: 'user-1' }])(
      'requires both the token and user ID: %j',
      async (body) => {
        const response = await createApp().request(
          '/use',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
          {}
        );

        expect(response.status).toBe(400);
        expect(mocks.findActiveInvitationByToken).not.toHaveBeenCalled();
      }
    );

    it('rejects a user outside the invitation tenant before consuming it', async () => {
      mocks.findUserById.mockResolvedValueOnce(null);

      const response = await useInvitation();

      expect(response.status).toBe(404);
      expect(mocks.consumeInvitationUse).not.toHaveBeenCalled();
    });

    it.each([null, 'different@example.com'])(
      'rejects an email-restricted invitation when the canonical email is %s',
      async (email) => {
        mocks.findUserById.mockResolvedValueOnce({ id: 'user-1', email });

        const response = await useInvitation();

        expect(response.status).toBe(400);
        expect(mocks.consumeInvitationUse).not.toHaveBeenCalled();
      }
    );

    it('accepts an invited email case-insensitively and applies assignments', async () => {
      const response = await useInvitation();

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true });
      expect(mocks.consumeInvitationUse).toHaveBeenCalledWith(
        mocks.adapter,
        'invitation-1',
        'tenant-1',
        expect.any(Number)
      );
      expect(mocks.applyInvitationAssignments).toHaveBeenCalledWith(mocks.adapter, {
        userId: 'user-1',
        tenantId: 'tenant-1',
        roleId: 'role-1',
        orgId: 'org-1',
      });
    });

    it('rejects a concurrent final-use race without applying assignments', async () => {
      mocks.consumeInvitationUse.mockResolvedValueOnce(false);

      const response = await useInvitation();

      expect(response.status).toBe(404);
      expect(mocks.applyInvitationAssignments).not.toHaveBeenCalled();
    });

    it('keeps a consumed invitation successful when optional assignments fail', async () => {
      mocks.applyInvitationAssignments.mockResolvedValueOnce({
        roleAssignment: { success: false, error: 'role missing' },
        orgMembership: { success: false, error: 'org missing' },
      });

      const response = await useInvitation();

      expect(response.status).toBe(200);
      expect(mocks.warn).toHaveBeenCalledTimes(2);
    });

    it('returns an internal error for malformed JSON', async () => {
      const response = await createApp().request(
        '/use',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{',
        },
        {}
      );

      expect(response.status).toBe(500);
      expect(mocks.error).toHaveBeenCalled();
    });
  });
});

function useInvitation() {
  return createApp().request(
    '/use',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, user_id: 'user-1' }),
    },
    {}
  );
}
