/**
 * Admin device secret routes find secrets where Native SSO stores them: with their owner's account
 * data (an account database), not in the tenant metadata database. The tenant's core databases are
 * separate stores here, so a lookup in the wrong one is visible.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

interface StoredSecret {
  id: string;
  user_id: string;
  session_id: string;
  created_at: number;
  expires_at: number;
  use_count: number;
  is_active: number;
  revoked_at?: number;
  revoke_reason?: string;
}

interface Store {
  name: string;
  secrets: StoredSecret[];
}

const mocks = vi.hoisted(() => ({
  resolveAccountDataContext: vi.fn(),
  resolveTenantAssignedDatabaseSourcesFromRegistry: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  /** A repository over one store (the adapter it is constructed with). */
  class Repository {
    constructor(private readonly store: Store) {}
    findById = async (id: string) => this.store.secrets.find((secret) => secret.id === id) ?? null;
    findByUserId = async (userId: string) =>
      this.store.secrets.filter((secret) => secret.user_id === userId);
    revoke = async (id: string, reason?: string) => {
      const secret = this.store.secrets.find((row) => row.id === id && !row.revoked_at);
      if (!secret) return false;
      secret.revoked_at = Date.now();
      secret.revoke_reason = reason;
      return true;
    };
    revokeByUserId = async (userId: string, _tenantId: string, reason?: string) => {
      let count = 0;
      for (const secret of this.store.secrets) {
        if (secret.user_id === userId && !secret.revoked_at) {
          secret.revoked_at = Date.now();
          secret.revoke_reason = reason;
          count += 1;
        }
      }
      return count;
    };
    cleanupExpired = async () => {
      const before = this.store.secrets.length;
      this.store.secrets = this.store.secrets.filter((secret) => secret.expires_at > Date.now());
      return before - this.store.secrets.length;
    };
  }
  return {
    ...actual,
    DeviceSecretRepository: Repository,
    ensureDatabaseAdapter: (source: unknown) => source,
    resolveAccountDataContext: mocks.resolveAccountDataContext,
    resolveTenantAssignedDatabaseSourcesFromRegistry:
      mocks.resolveTenantAssignedDatabaseSourcesFromRegistry,
    createAuditLogFromContext: mocks.audit,
    getTenantIdFromContext: () => 'tenant-a',
  };
});

import {
  cleanupExpiredDeviceSecrets,
  getDeviceSecret,
  listUserDeviceSecrets,
  revokeAllUserDeviceSecrets,
  revokeDeviceSecret,
} from '../routes/device-secrets';

let metadataStore: Store;
let accountStore: Store;

function secret(overrides: Partial<StoredSecret> = {}): StoredSecret {
  return {
    id: 'ds-1',
    user_id: 'user-1',
    session_id: 'sid-1',
    created_at: Date.now() - 60_000,
    expires_at: Date.now() + 3_600_000,
    use_count: 0,
    is_active: 1,
    ...overrides,
  };
}

function app() {
  const hono = new Hono<{ Bindings: Env }>();
  hono.get('/users/:userId/device-secrets', listUserDeviceSecrets);
  hono.delete('/users/:userId/device-secrets', revokeAllUserDeviceSecrets);
  hono.post('/device-secrets/cleanup', cleanupExpiredDeviceSecrets);
  hono.get('/device-secrets/:id', getDeviceSecret);
  hono.delete('/device-secrets/:id', revokeDeviceSecret);
  return hono;
}

beforeEach(() => {
  vi.clearAllMocks();
  metadataStore = { name: 'metadata', secrets: [] };
  accountStore = { name: 'account', secrets: [secret()] };
  mocks.resolveAccountDataContext.mockImplementation(
    async (_env: unknown, input: { accountId: string }) => {
      if (input.accountId.replace(/^account:/u, '') !== 'user-1') {
        throw new Error('account_data_route_not_found');
      }
      return { coreDb: accountStore };
    }
  );
  mocks.resolveTenantAssignedDatabaseSourcesFromRegistry.mockResolvedValue([
    { source: metadataStore, bindingRef: 'DB' },
    { source: accountStore, bindingRef: 'DB_ACCOUNTS' },
  ]);
});

describe('admin device secret routes (account databases)', () => {
  it("lists a user's device secrets from its account database", async () => {
    const response = await app().request('/users/user-1/device-secrets', {}, {} as Env);
    const body = (await response.json()) as { items: Array<{ id: string }> };
    expect(response.status).toBe(200);
    expect(body.items.map((item) => item.id)).toEqual(['ds-1']);
  });

  it('gets a device secret by ID from the account database that holds it', async () => {
    const response = await app().request('/device-secrets/ds-1', {}, {} as Env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ id: 'ds-1', user_id: 'user-1' });
  });

  it('revokes a device secret by ID where it is stored', async () => {
    const response = await app().request('/device-secrets/ds-1', { method: 'DELETE' }, {} as Env);
    expect(response.status).toBe(200);
    expect(accountStore.secrets[0]?.revoked_at).toEqual(expect.any(Number));
  });

  it("revokes all of a suspended user's device secrets across the tenant databases", async () => {
    mocks.resolveAccountDataContext.mockRejectedValue(
      new Error('lookup_destination_revalidation_failed')
    );
    const response = await app().request(
      '/users/user-1/device-secrets',
      { method: 'DELETE' },
      {} as Env
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ revoked_count: 1 });
    expect(accountStore.secrets[0]?.revoked_at).toEqual(expect.any(Number));
  });

  it('cleans up expired device secrets in every tenant database', async () => {
    accountStore.secrets.push(secret({ id: 'ds-expired', expires_at: Date.now() - 1 }));
    const response = await app().request('/device-secrets/cleanup', { method: 'POST' }, {} as Env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ cleaned_count: 1 });
    expect(accountStore.secrets.map((row) => row.id)).toEqual(['ds-1']);
  });
});
