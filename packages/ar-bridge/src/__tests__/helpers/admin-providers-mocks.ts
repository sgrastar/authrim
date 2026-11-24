import { Hono } from 'hono';
import { vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  listAll: vi.fn(),
  getProvider: vi.fn(),
  createProvider: vi.fn(),
  updateProvider: vi.fn(),
  deleteProvider: vi.fn(),
  ensureRegistration: vi.fn(),
  createDiag: vi.fn(),
  logAuthDecision: vi.fn(),
  cleanup: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  getTenantIdFromContext: () => 'tenant-a',
  buildIssuerUrl: () => 'https://tenant-a.example.com',
  createDiagnosticLoggerFromContext: mocks.createDiag,
  getDiagnosticSessionId: () => 'diag-session',
  getLogger: () => ({
    module: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: mocks.error }),
  }),
}));
vi.mock('../../services/provider-store', () => ({
  listAllProviders: mocks.listAll,
  getProvider: mocks.getProvider,
  createProvider: mocks.createProvider,
  updateProvider: mocks.updateProvider,
  deleteProvider: mocks.deleteProvider,
}));
vi.mock('../../services/dynamic-registration', () => ({
  ensureDynamicClientRegistration: mocks.ensureRegistration,
}));
vi.mock('../../utils/crypto', () => ({
  encrypt: vi.fn(async (value: string) => `enc(${value})`),
  getEncryptionKey: vi.fn(() => 'key'),
}));

import {
  handleAdminCreateProvider,
  handleAdminDeleteProvider,
  handleAdminGetProvider,
  handleAdminListProviders,
  handleAdminRegisterProvider,
  handleAdminUpdateProvider,
} from '../../admin/providers';

export const ENV = {} as unknown as Env;

export function app(permissions: string[] | null = ['*']) {
  const instance = new Hono<{ Bindings: Env; Variables: { adminAuth?: unknown } }>();
  instance.use('*', async (c, next) => {
    if (permissions) c.set('adminAuth', { permissions });
    await next();
  });
  instance.get('/providers', handleAdminListProviders);
  instance.post('/providers', handleAdminCreateProvider);
  instance.get('/providers/:id', handleAdminGetProvider);
  instance.put('/providers/:id', handleAdminUpdateProvider);
  instance.delete('/providers/:id', handleAdminDeleteProvider);
  instance.post('/providers/:id/register', handleAdminRegisterProvider);
  return instance;
}

export const send = (
  method: string,
  path: string,
  body?: unknown,
  permissions: string[] | null = ['*'],
  env: Env = ENV
) =>
  Promise.resolve(
    app(permissions).request(
      `https://admin.example.com${path}`,
      {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      env
    )
  );

export { mocks };
