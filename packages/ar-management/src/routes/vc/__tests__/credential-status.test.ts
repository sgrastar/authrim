import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  transition: vi.fn(),
  queryOne: vi.fn(async (_sql: string, _params: unknown[]): Promise<unknown> => null),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createAuthContextFromHono: () => ({
      coreAdapter: { marker: 'core', queryOne: mocks.queryOne },
    }),
    transitionCredentialStatus: mocks.transition,
  };
});

import {
  activateCredentialHandler,
  revokeCredentialHandler,
  suspendCredentialHandler,
} from '../credential-status';

function app() {
  const hono = new Hono<{ Bindings: Env; Variables: { tenantId: string } }>();
  hono.use('*', async (c, next) => {
    c.set('tenantId', 'tenant-a');
    await next();
  });
  hono.post('/credentials/:id/revoke', revokeCredentialHandler);
  hono.post('/credentials/:id/suspend', suspendCredentialHandler);
  hono.post('/credentials/:id/activate', activateCredentialHandler);
  return hono;
}

const call = (action: 'revoke' | 'suspend' | 'activate') =>
  app().request(`/credentials/cred-1/${action}`, { method: 'POST' });

describe('credential status transitions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it.each([
    ['revoke', ['pending', 'active', 'suspended'], 'revoked'],
    ['suspend', ['active'], 'suspended'],
    ['activate', ['suspended'], 'active'],
  ] as const)('%s asks for the right transition', async (action, from, to) => {
    mocks.transition.mockResolvedValue({ outcome: 'changed', previous: 'active' });

    const response = await call(action);

    expect(response.status).toBe(200);
    expect(mocks.transition).toHaveBeenCalledWith(
      expect.objectContaining({ marker: 'core' }),
      expect.objectContaining({ tenantId: 'tenant-a', credentialId: 'cred-1', from, to })
    );
    expect(await response.json()).toMatchObject({ id: 'cred-1', status: to });
  });

  it.each(['revoke', 'suspend', 'activate'] as const)(
    'refuses to %s an admin credential, which has its own routes',
    async (action) => {
      mocks.queryOne.mockResolvedValueOnce({
        credential_type: 'https://authrim.com/credentials/admin/v1',
      });

      const response = await call(action);

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: 'admin_credential_not_managed_here' });
      expect(mocks.queryOne.mock.calls[0][1]).toEqual(['tenant-a', 'cred-1']);
      expect(mocks.transition).not.toHaveBeenCalled();
    }
  );

  it('answers 200 with the current status when nothing changed (idempotent)', async () => {
    mocks.transition.mockResolvedValue({ outcome: 'unchanged' });
    const response = await call('revoke');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'revoked' });
  });

  it('answers 404 for an unknown credential', async () => {
    mocks.transition.mockResolvedValue({ outcome: 'not_found' });
    expect((await call('suspend')).status).toBe(404);
  });

  it('answers 409 when the credential is in a state that cannot move there', async () => {
    mocks.transition.mockResolvedValue({ outcome: 'not_allowed', current: 'revoked' });
    expect((await call('activate')).status).toBe(409);
  });

  it('answers 503 temporarily_unavailable on a concurrent change', async () => {
    mocks.transition.mockResolvedValue({ outcome: 'conflict' });
    const response = await call('revoke');
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('1');
    expect(await response.json()).toMatchObject({ error: 'temporarily_unavailable' });
  });

  it('answers 500 when the transition throws', async () => {
    mocks.transition.mockRejectedValue(new Error('boom'));
    expect((await call('revoke')).status).toBe(500);
  });
});
