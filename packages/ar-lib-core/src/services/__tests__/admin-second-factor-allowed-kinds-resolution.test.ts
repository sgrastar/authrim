import { describe, expect, it, vi } from 'vitest';
import { readAdminStepUpPolicy } from '../admin-step-up-gate';
import { resolveAdminSecondFactorAllowedKinds } from '../admin-step-up';

const KEY = 'security.admin_second_factor_allowed_kinds';

function kv(values: Record<string, string>): KVNamespace {
  return { get: vi.fn(async (key: string) => values[key] ?? null) } as unknown as KVNamespace;
}

async function allowedFor(env: Record<string, unknown>, tenantId: string): Promise<string[]> {
  const policy = await readAdminStepUpPolicy(env as never, tenantId);
  return [...resolveAdminSecondFactorAllowedKinds(policy.allowedKinds)].sort();
}

describe('the allowed second-factor kinds, from the tenant, the platform and the environment', () => {
  it('allows hardware only until someone says otherwise', async () => {
    expect(await allowedFor({ SETTINGS: kv({}) }, 'acme')).toEqual(['hardware']);
  });

  it('applies the platform’s list to every tenant that sets none', async () => {
    const env = {
      SETTINGS: kv({
        'settings:platform:security': JSON.stringify({ [KEY]: ['hardware', 'totp'] }),
      }),
    };
    expect(await allowedFor(env, 'acme')).toEqual(['hardware', 'totp']);
    expect(await allowedFor(env, 'other')).toEqual(['hardware', 'totp']);
  });

  it('lets a tenant’s own list replace the platform’s, in either direction', async () => {
    const env = {
      SETTINGS: kv({
        'settings:platform:security': JSON.stringify({ [KEY]: ['hardware', 'totp'] }),
        'settings:tenant:strict:security': JSON.stringify({ [KEY]: ['hardware'] }),
      }),
    };
    expect(await allowedFor(env, 'strict')).toEqual(['hardware']);
    expect(await allowedFor(env, 'open')).toEqual(['hardware', 'totp']);

    const hardwarePlatform = {
      SETTINGS: kv({
        'settings:tenant:demo:security': JSON.stringify({ [KEY]: ['hardware', 'totp'] }),
      }),
    };
    expect(await allowedFor(hardwarePlatform, 'demo')).toEqual(['hardware', 'totp']);
    expect(await allowedFor(hardwarePlatform, 'other')).toEqual(['hardware']);
  });

  it('takes the deployment’s environment variable as the default for every tenant', async () => {
    const env = {
      SETTINGS: kv({}),
      ADMIN_SECOND_FACTOR_ALLOWED_KINDS: '["hardware","totp"]',
    };
    expect(await allowedFor(env, 'acme')).toEqual(['hardware', 'totp']);
  });

  it('puts the platform setting before the environment variable, and the tenant before both', async () => {
    const env = {
      SETTINGS: kv({
        'settings:platform:security': JSON.stringify({ [KEY]: ['hardware'] }),
        'settings:tenant:demo:security': JSON.stringify({ [KEY]: ['hardware', 'totp'] }),
      }),
      ADMIN_SECOND_FACTOR_ALLOWED_KINDS: '["hardware","totp"]',
    };
    expect(await allowedFor(env, 'acme')).toEqual(['hardware']);
    expect(await allowedFor(env, 'demo')).toEqual(['hardware', 'totp']);
  });

  it('never widens on an environment value it cannot use', async () => {
    for (const raw of ['totp', '["totp"]', '["hardware","sms"]', 'not json', '[]']) {
      const env = { SETTINGS: kv({}), ADMIN_SECOND_FACTOR_ALLOWED_KINDS: raw };
      expect(await allowedFor(env, 'acme'), raw).toEqual(['hardware']);
    }
  });
});
