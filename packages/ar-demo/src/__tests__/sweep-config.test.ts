import { beforeEach, describe, expect, it } from 'vitest';
import { loadSweepConfig } from '../sweep-config';
import type { Env } from '../types';
import { API, generateKey } from './helpers';

let env: Env;
beforeEach(async () => {
  env = {
    ADMIN_API_ORIGIN: API,
    SWEEP_ENABLED: 'true',
    SWEEP_MACHINE_CLIENT_ID: 'janitor-client',
    SWEEP_MACHINE_KEY_ID: 'janitor-key',
    SWEEP_MACHINE_PRIVATE_JWK: JSON.stringify((await generateKey()).privateJwk),
  } as Env;
});

describe('sweep configuration', () => {
  it.each([undefined, 'false'])('is disabled without credentials when enabled=%s', (enabled) => {
    expect(loadSweepConfig({ SWEEP_ENABLED: enabled } as Env)).toEqual({ ok: true, config: null });
  });

  it('needs only independent sweep credentials and defaults to a bounded dry run', () => {
    const result = loadSweepConfig(env);
    expect(result).toMatchObject({
      ok: true,
      config: { dryRun: true, minAgeMinutes: 30, maxDeletes: 5, maxPages: 10 },
    });
    if (!result.ok || !result.config) throw new Error('configuration');
    expect([...result.config.keepUserIds]).toEqual([]);
  });

  it('requires an explicit keep list before deletion, accepting an explicitly empty list', () => {
    env.SWEEP_DRY_RUN = 'false';
    expect(loadSweepConfig(env)).toEqual({ ok: false, problems: ['SWEEP_KEEP_USER_IDS'] });
    env.SWEEP_KEEP_USER_IDS = '';
    expect(loadSweepConfig(env)).toMatchObject({ ok: true, config: { dryRun: false } });
    env.SWEEP_KEEP_USER_IDS = ' user-1, user_2,user-1 ';
    const result = loadSweepConfig(env);
    if (!result.ok || !result.config) throw new Error('configuration');
    expect([...result.config.keepUserIds]).toEqual(['user-1', 'user_2']);
  });

  it.each([
    ['SWEEP_ENABLED', 'TRUE'],
    ['SWEEP_DRY_RUN', '0'],
    ['DEFAULT_TENANT_ID', 'other'],
    ['DEFAULT_TENANT_ID', ''],
    ['SWEEP_MIN_AGE_MINUTES', '0'],
    ['SWEEP_MIN_AGE_MINUTES', '1.5'],
    ['SWEEP_MIN_AGE_MINUTES', '10081'],
    ['SWEEP_MAX_DELETES_PER_RUN', '201'],
    ['SWEEP_MAX_DELETES_PER_RUN', '-1'],
    ['SWEEP_MAX_DELETES_PER_RUN', ''],
    ['SWEEP_MAX_PAGES', '11'],
    ['SWEEP_MAX_PAGES', 'NaN'],
    ['SWEEP_KEEP_USER_IDS', 'user-1,'],
    ['SWEEP_KEEP_USER_IDS', '../user'],
    ['SWEEP_KEEP_USER_IDS', 'user 1'],
    ['SWEEP_MACHINE_CLIENT_ID', ''],
    ['SWEEP_MACHINE_KEY_ID', ' key '],
    ['SWEEP_MACHINE_PRIVATE_JWK', '{"kty":"RSA","d":"secret-sentinel"}'],
    ['ADMIN_API_ORIGIN', 'https://user:pass@example.com'],
    ['ADMIN_API_ORIGIN', 'http://example.com'],
    ['ADMIN_API_ORIGIN', `${API}/path`],
  ] as const)('fails closed for invalid %s', (name, value) => {
    const result = loadSweepConfig({ ...env, [name]: value });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.problems).toContain(name);
    expect(JSON.stringify(result)).not.toContain('secret-sentinel');
  });

  it('refuses reuse of the portal principal', () => {
    env.MACHINE_CLIENT_ID = env.SWEEP_MACHINE_CLIENT_ID;
    expect(loadSweepConfig(env)).toEqual({ ok: false, problems: ['SWEEP_MACHINE_CLIENT_ID'] });
  });
});
