import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { LitePolicyStore } from '@authrim/ar-lib-core/durable-objects/LitePolicyStore';
import { DEFAULT_SCREENS } from '../admin-screens';
import { runLiteGuardedWrite, type LiteGuardedWrite } from '../lite-mode-guard';
import { liteIssuesOfScreen } from '../lite-mode-readiness';

class Storage {
  readonly data = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.data.get(key)) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.data.set(key, structuredClone(value));
  }
}

function policyEnv() {
  const store = new LitePolicyStore({ storage: new Storage() } as never, {} as never);
  const commit = vi.spyOn(store, 'commitRpc');
  const env = {
    LITE_POLICY_STORE: { idFromName: (name: string) => name, get: () => store },
  };
  return { store, env, commit };
}

async function switchTo(
  store: LitePolicyStore,
  liteMode: 'off' | 'always',
  required = { login: false, signup: false, reauth: false }
) {
  const lease = await store.acquireLeaseRpc('tenant-a');
  if (!lease.acquired) throw new Error('lease not acquired');
  await store.commitRpc({
    tenantId: 'tenant-a',
    token: lease.token,
    expectedGeneration: lease.generation,
    liteMode,
    humanVerificationRequired: required,
  });
}

function run(env: Record<string, unknown>, spec: LiteGuardedWrite): Promise<Response> {
  const app = new Hono();
  app.post('/', (c) => runLiteGuardedWrite(c, 'tenant-a', spec));
  return Promise.resolve(app.request('/', { method: 'POST' }, env));
}

const saved = () => Promise.resolve(Response.json({ saved: true }));

describe('runLiteGuardedWrite', () => {
  it('lets the change through without a policy store', async () => {
    const check = vi.fn(async () => [{ code: 'client_login_ui_url' as const }]);
    const response = await run({}, { check, write: saved });
    expect(response.status).toBe(200);
    expect(check).not.toHaveBeenCalled();
  });

  it('does not check a tenant that is not in lite mode', async () => {
    const { env } = policyEnv();
    const check = vi.fn(async () => [{ code: 'client_login_ui_url' as const }]);
    expect((await run(env, { check, write: saved })).status).toBe(200);
    expect(check).not.toHaveBeenCalled();
  });

  it('asks to retry while a switch holds the lease', async () => {
    const { env, store } = policyEnv();
    await store.acquireLeaseRpc('tenant-a');
    const write = vi.fn(saved);
    const response = await run(env, { check: async () => [], write });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'lite_mode_change_in_progress' });
    expect(response.headers.get('Retry-After')).toBeTruthy();
    expect(write).not.toHaveBeenCalled();
  });

  it('refuses a change that leaves a lite tenant with something unsupported', async () => {
    const { env, store } = policyEnv();
    await switchTo(store, 'always');
    const write = vi.fn(saved);
    const response = await run(env, {
      check: async () => [{ code: 'client_login_ui_url', subject: 'app-1' }],
      write,
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: 'lite_mode_unsupported',
      issues: [{ code: 'client_login_ui_url', subject: 'app-1' }],
    });
    expect(write).not.toHaveBeenCalled();
    // The lease is given back.
    expect((await store.getStatusRpc('tenant-a')).changeInProgress).toBe(false);
  });

  it('runs a supported change of a lite tenant under the lease', async () => {
    const { env, store } = policyEnv();
    await switchTo(store, 'always');
    const write = vi.fn(async () => {
      expect((await store.getStatusRpc('tenant-a')).changeInProgress).toBe(true);
      return Response.json({ saved: true });
    });
    expect((await run(env, { check: async () => [], write })).status).toBe(200);
    expect((await store.getStatusRpc('tenant-a')).changeInProgress).toBe(false);
  });

  it('publishes the stricter human verification set before the write and the new set after', async () => {
    const { env, store, commit } = policyEnv();
    await switchTo(store, 'always', { login: true, signup: false, reauth: false });
    commit.mockClear();
    const during: unknown[] = [];
    const response = await run(env, {
      check: async () => [],
      humanVerificationAfter: () => ({ login: false, signup: true, reauth: false }),
      write: async () => {
        during.push((await store.getSnapshotRpc('tenant-a')).humanVerificationRequired);
        return Response.json({ saved: true });
      },
    });
    expect(response.status).toBe(200);
    expect(during).toEqual([{ login: true, signup: true, reauth: false }]);
    expect((await store.getSnapshotRpc('tenant-a')).humanVerificationRequired).toEqual({
      login: false,
      signup: true,
      reauth: false,
    });
    expect(commit).toHaveBeenCalledTimes(2);
  });

  it('puts the old set back when the write fails', async () => {
    const { env, store } = policyEnv();
    await switchTo(store, 'always', { login: true, signup: false, reauth: false });
    const response = await run(env, {
      check: async () => [],
      humanVerificationAfter: () => ({ login: false, signup: false, reauth: false }),
      write: async () => Response.json({ error: 'conflict' }, { status: 409 }),
    });
    expect(response.status).toBe(409);
    expect((await store.getSnapshotRpc('tenant-a')).humanVerificationRequired).toEqual({
      login: true,
      signup: false,
      reauth: false,
    });
  });

  it('serialises a human verification change with a switch even when the tenant is off', async () => {
    const { env, store } = policyEnv();
    const write = vi.fn(async () => {
      expect((await store.getStatusRpc('tenant-a')).changeInProgress).toBe(true);
      return Response.json({ saved: true });
    });
    const check = vi.fn(async () => []);
    expect((await run(env, { check, write, serializeWithSwitch: true })).status).toBe(200);
    expect(check).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('answers 503 when the policy store cannot be read', async () => {
    const env = {
      LITE_POLICY_STORE: {
        idFromName: (name: string) => name,
        get: () => ({
          getStatusRpc: async () => {
            throw new Error('down');
          },
        }),
      },
    };
    const response = await run(env, { check: async () => [], write: saved });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'lite_policy_unavailable' });
  });
});

describe('system screens and the lite Login UI', () => {
  // The lite UI must render every system screen a tenant falls back to. A block added to a system
  // screen has to be added to the lite UI's lists (ar-lib-core lite-compatibility.ts) first.
  it('has every block of every system screen in the lite lists (directory password is off)', () => {
    const enabled = new Set(['passkey', 'mail_otp', 'totp', 'mail_otp_totp', 'external_idp']);
    for (const screen of DEFAULT_SCREENS) {
      expect(liteIssuesOfScreen(screen, enabled), screen.screen_key).toEqual([]);
    }
  });
});
