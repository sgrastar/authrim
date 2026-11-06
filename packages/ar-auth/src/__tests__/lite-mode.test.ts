import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LitePolicyStore } from '@authrim/ar-lib-core/durable-objects/LitePolicyStore';

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return { ...actual, getTenantIdFromContext: () => 'tenant-a' };
});

import { litePowChallengeHandler, liteTenantBudget, refuseForLiteTenant } from '../lite-mode';

class Storage {
  readonly data = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.data.get(key)) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.data.set(key, structuredClone(value));
  }
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/u, '');
}

let policy: LitePolicyStore;
let counts: Map<string, number>;
let env: Record<string, unknown>;

async function goLite() {
  const lease = await policy.acquireLeaseRpc('tenant-a');
  if (!lease.acquired) throw new Error('lease');
  await policy.commitRpc({
    tenantId: 'tenant-a',
    token: lease.token,
    expectedGeneration: lease.generation,
    liteMode: 'always',
    humanVerificationRequired: { login: true, signup: true, reauth: false },
  });
}

beforeEach(() => {
  policy = new LitePolicyStore({ storage: new Storage() } as never, {} as never);
  counts = new Map();
  env = {
    LITE_POLICY_STORE: { idFromName: (n: string) => n, get: () => policy },
    RATE_LIMITER: {
      idFromName: (n: string) => n,
      get: () => ({
        incrementRpc: async (key: string, config: { maxRequests: number }) => {
          const current = (counts.get(key) ?? 0) + 1;
          counts.set(key, current);
          return {
            allowed: current <= config.maxRequests,
            current,
            limit: config.maxRequests,
            resetAt: Math.floor(Date.now() / 1000) + 60,
          };
        },
      }),
    },
    SETTINGS: {
      get: async (key: string) =>
        key === 'settings:tenant:tenant-a:authentication-methods'
          ? JSON.stringify({
              'authentication-methods.human_verification.pow_issue_per_ip_per_minute': 2,
            })
          : null,
    },
    HUMAN_VERIFICATION_POW_HMAC_KEYRING: JSON.stringify({
      current: 1,
      keys: { '1': base64Url(new Uint8Array(32).fill(3)) },
    }),
  };
});

function app() {
  const hono = new Hono();
  hono.get('/pow', (c) => litePowChallengeHandler(c as never));
  hono.post('/legacy', refuseForLiteTenant(), (c) => c.json({ ok: true }));
  hono.post(
    '/budgeted',
    liteTenantBudget('test', { perIpPerMinute: 1, perTenantPerMinute: 100 }),
    (c) => c.json({ ok: true })
  );
  return hono;
}

const request = (path: string, init: RequestInit = {}) =>
  app().request(path, { ...init, headers: { 'CF-Connecting-IP': '203.0.113.9' } }, env);

describe('the proof-of-work challenge route', () => {
  it('is not found for a tenant that is not in lite mode', async () => {
    expect((await request('/pow?action=login')).status).toBe(404);
  });

  it('issues a challenge bound to the policy revision, without caching', async () => {
    await goLite();
    const response = await request('/pow?action=login');
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = await response.json<{
      challenge: { salt: string; maxnumber: number; algorithm: string };
      policy_revision: string;
    }>();
    expect(body.challenge.algorithm).toBe('SHA-256');
    expect(body.challenge.maxnumber).toBe(25_000);
    expect(body.challenge.salt).toContain(`&rev=${body.policy_revision}&`);
    expect(body.challenge.salt).toContain('action=login');
  });

  it('refuses an unknown action, and answers 503 without a keyring', async () => {
    await goLite();
    expect((await request('/pow?action=admin')).status).toBe(400);
    delete env.HUMAN_VERIFICATION_POW_HMAC_KEYRING;
    expect((await request('/pow?action=login')).status).toBe(503);
  });

  it('limits issues per IP, atomically', async () => {
    await goLite();
    expect((await request('/pow?action=login')).status).toBe(200);
    expect((await request('/pow?action=login')).status).toBe(200);
    const third = await request('/pow?action=login');
    expect(third.status).toBe(429);
    expect(third.headers.get('Retry-After')).toBeTruthy();
  });

  it('refuses rather than count on KV when the atomic limiter is unavailable', async () => {
    await goLite();
    delete env.RATE_LIMITER;
    expect((await request('/pow?action=login')).status).toBe(503);
  });
});

describe('endpoints closed for lite tenants', () => {
  it('lets a tenant that is not in lite mode through', async () => {
    expect((await request('/legacy', { method: 'POST' })).status).toBe(200);
  });

  it('refuses a lite tenant', async () => {
    await goLite();
    const response = await request('/legacy', { method: 'POST' });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'lite_mode_endpoint_unavailable' });
  });

  it('asks the marker instance when the policy instance is down', async () => {
    let everLite = true;
    env.LITE_POLICY_STORE = {
      idFromName: (n: string) => n,
      get: (id: string) =>
        id.startsWith('lite-policy-marker:')
          ? { isEverLiteRpc: async () => everLite }
          : {
              getSnapshotRpc: async () => {
                throw new Error('down');
              },
            },
    };
    expect((await request('/legacy', { method: 'POST' })).status).toBe(403);
    everLite = false;
    expect((await request('/legacy', { method: 'POST' })).status).toBe(200);
  });

  it('refuses when neither the policy nor the marker can be read', async () => {
    env.LITE_POLICY_STORE = {
      idFromName: (n: string) => n,
      get: () => ({
        getSnapshotRpc: async () => {
          throw new Error('down');
        },
        isEverLiteRpc: async () => {
          throw new Error('down');
        },
      }),
    };
    expect((await request('/legacy', { method: 'POST' })).status).toBe(403);
  });
});

describe('the lite budget on shared endpoints', () => {
  it('counts only a lite tenant', async () => {
    expect((await request('/budgeted', { method: 'POST' })).status).toBe(200);
    expect((await request('/budgeted', { method: 'POST' })).status).toBe(200);
    await goLite();
    expect((await request('/budgeted', { method: 'POST' })).status).toBe(200);
    expect((await request('/budgeted', { method: 'POST' })).status).toBe(429);
  });
});
