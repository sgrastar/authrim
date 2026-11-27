/**
 * Mutation-driven test: the per-isolate custom-domain cache is bounded at 1000 entries.
 * Kept in its own file so the module-level cache starts empty.
 */
import { describe, it, expect } from 'vitest';
import app from '../index';
import { createMockEnv, createMockFetcher, createMockKV } from './helpers/router-env';

describe('custom domain cache bound', () => {
  it('forgets every entry when the 1001st domain arrives', async () => {
    const resolve = { resolveTenantForHost: async (_h: string) => ({ tenantId: 'bound-t' }) };
    const calls: string[] = [];
    const tenantHost = {
      resolveTenantForHost: async (h: string) => {
        calls.push(h);
        return resolve.resolveTenantForHost(h);
      },
    };
    const env = {
      ...createMockEnv(),
      BASE_DOMAIN: 'example.com',
      SETTINGS: createMockKV(),
      ENABLE_LOGIN_UI_PROXY: 'true',
      AR_LOGIN_UI_URL: 'https://ui.example.workers.dev',
      LOGIN_UI_WORKER: createMockFetcher('LOGIN_UI_WORKER'),
      TENANT_HOST: tenantHost,
    };
    const ask = (n: number) => app.fetch(new Request(`https://d${n}.bound.test/account`), env);

    for (let n = 0; n < 1000; n++) await ask(n);
    expect(calls).toHaveLength(1000);

    // Still cached while at the limit.
    await ask(0);
    expect(calls).toHaveLength(1000);

    // One more domain: the cache is cleared, so the first domain is asked again.
    await ask(1000);
    expect(calls).toHaveLength(1001);
    await ask(0);
    expect(calls).toHaveLength(1002);
    // ...and the new entry was kept after the clear.
    await ask(1000);
    expect(calls).toHaveLength(1002);
  });
});
