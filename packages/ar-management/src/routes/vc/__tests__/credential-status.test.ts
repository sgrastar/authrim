import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  findByIdForTenant: vi.fn(),
  updateStatusIfCurrent: vi.fn(),
  suspend: vi.fn(),
  activate: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createAuthContextFromHono: () => ({ coreAdapter: {} }),
    IssuedCredentialRepository: class {
      findByIdForTenant = mocks.findByIdForTenant;
      updateStatusIfCurrent = mocks.updateStatusIfCurrent;
    },
    D1StatusListRepository: class {},
    StatusListManager: class {
      suspend = mocks.suspend;
      activate = mocks.activate;
    },
  };
});

import { activateCredentialHandler, suspendCredentialHandler } from '../credential-status';

function app() {
  const hono = new Hono<{ Bindings: Env; Variables: { tenantId: string } }>();
  hono.use('*', async (c, next) => {
    c.set('tenantId', 'tenant-a');
    await next();
  });
  hono.post('/credentials/:id/suspend', suspendCredentialHandler);
  hono.post('/credentials/:id/activate', activateCredentialHandler);
  return hono;
}

const credential = (status: string) => ({
  id: 'cred-1',
  status,
  status_list_id: 'list-1',
  status_list_index: 7,
});

describe('credential status transitions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('suspends only an active credential, before touching the status list', async () => {
    mocks.findByIdForTenant.mockResolvedValue(credential('active'));
    mocks.updateStatusIfCurrent.mockResolvedValue(true);

    const response = await app().request('/credentials/cred-1/suspend', { method: 'POST' });

    expect(response.status).toBe(200);
    expect(mocks.updateStatusIfCurrent).toHaveBeenCalledWith(
      'tenant-a',
      'cred-1',
      'active',
      'suspended'
    );
    expect(mocks.suspend).toHaveBeenCalledWith('tenant-a', 'list-1', 7);
  });

  it('refuses to suspend a credential revoked or still being issued meanwhile', async () => {
    mocks.findByIdForTenant.mockResolvedValue(credential('pending'));
    mocks.updateStatusIfCurrent.mockResolvedValue(false);

    const response = await app().request('/credentials/cred-1/suspend', { method: 'POST' });

    expect(response.status).toBe(409);
    expect(mocks.suspend).not.toHaveBeenCalled();
  });

  it('reactivates only a suspended credential', async () => {
    mocks.findByIdForTenant.mockResolvedValue(credential('suspended'));
    mocks.updateStatusIfCurrent.mockResolvedValue(true);

    const response = await app().request('/credentials/cred-1/activate', { method: 'POST' });

    expect(response.status).toBe(200);
    expect(mocks.updateStatusIfCurrent).toHaveBeenCalledWith(
      'tenant-a',
      'cred-1',
      'suspended',
      'active'
    );
    expect(mocks.activate).toHaveBeenCalledWith('tenant-a', 'list-1', 7);
  });

  it('never activates a pending credential, which only issuance may activate', async () => {
    mocks.findByIdForTenant.mockResolvedValue(credential('pending'));
    mocks.updateStatusIfCurrent.mockResolvedValue(false);

    const response = await app().request('/credentials/cred-1/activate', { method: 'POST' });

    expect(response.status).toBe(409);
    expect(mocks.activate).not.toHaveBeenCalled();
  });
});
