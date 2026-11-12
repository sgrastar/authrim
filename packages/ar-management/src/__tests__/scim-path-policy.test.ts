/**
 * The SCIM switches (users, groups, bulk) are judged on the path the router dispatches on: an
 * escaped spelling (`/%55sers`) must not skip them.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

vi.mock('@authrim/ar-lib-scim', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-scim')>();
  return {
    ...actual,
    scimAuthMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
  };
});

vi.mock('../scim-settings', () => ({
  getScimInboundSettings: vi.fn(async () => ({
    enabled: true,
    usersEnabled: false,
    groupsEnabled: false,
    bulkEnabled: false,
    mappingSetId: 'm',
    bulkMaxOperations: 100,
    bulkMaxPayloadSize: 1_048_576,
  })),
}));

import scimApp from '../scim';

const env = { DEFAULT_TENANT_ID: 'default' } as unknown as Env;
const call = (method: string, path: string) => scimApp.request(path, { method }, env);

describe('the SCIM resource switches', () => {
  it.each([
    ['GET', '/Users', 'SCIM User provisioning is disabled'],
    ['GET', '/%55sers', 'SCIM User provisioning is disabled'],
    ['GET', '/Us%65rs/x', 'SCIM User provisioning is disabled'],
    ['GET', '/Groups', 'SCIM Group provisioning is disabled'],
    ['GET', '/%47roups', 'SCIM Group provisioning is disabled'],
    ['POST', '/Bulk', 'SCIM Bulk operations are disabled'],
    ['POST', '/%42ulk', 'SCIM Bulk operations are disabled'],
  ])('refuses %s %s while switched off', async (method, path, message) => {
    const res = await call(method, path);
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).toContain(message);
  });
});

describe('a malformed percent escape in a SCIM path', () => {
  it.each(['/Us%6%35rs', '/%', '/%zz', '/Users/%e0%a4%a', '/Gr%6%6fups'])(
    'is refused with 400, not repaired into a path the switches then judge: %s',
    async (path) => {
      const res = await call('GET', path);
      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).toContain('malformed');
    }
  );
});
