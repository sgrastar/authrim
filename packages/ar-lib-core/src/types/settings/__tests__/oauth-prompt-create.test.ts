/**
 * `oauth.prompt_create_enabled` (prompt=create, Initiating User Registration): off unless the
 * tenant turns it on. Only the boolean `true` saved for the tenant, or the exact string `true` in
 * OAUTH_PROMPT_CREATE_ENABLED, turns it on, through the real settings reader. (A saved value that
 * is not a boolean is refused when it is saved; the authorization endpoint and discovery act only on
 * `true`, see their tests.)
 */
import { describe, expect, it } from 'vitest';
import { resolveEffectiveSettings } from '../../../services/effective-settings';
import { OAUTH_DEFAULTS, OAUTH_SETTINGS_META } from '../oauth';
import { TENANT_SETTINGS_META } from '../tenant';

const KEY = 'oauth.prompt_create_enabled';

async function promptCreate(env: Record<string, string | undefined>, stored?: unknown) {
  const documents: Record<string, string> =
    stored !== undefined ? { 'settings:tenant:t1:oauth': JSON.stringify({ [KEY]: stored }) } : {};
  const kv = { get: async (key: string) => documents[key] ?? null } as unknown as KVNamespace;
  const values = await resolveEffectiveSettings({ SETTINGS: kv, ...env } as never, 'oauth', {
    tenantId: 't1',
  });
  return values[KEY];
}

describe('oauth.prompt_create_enabled', () => {
  it('is a tenant boolean that is off by default', () => {
    const meta = OAUTH_SETTINGS_META[KEY];
    expect(meta.type).toBe('boolean');
    expect(meta.default).toBe(false);
    expect(meta.scopes).toEqual(['tenant']);
    expect(meta.envKey).toBe('OAUTH_PROMPT_CREATE_ENABLED');
    expect(meta.envBoolean).toBe('exactly-true');
    expect(OAUTH_DEFAULTS[KEY]).toBe(false);
  });

  it('is off with nothing set', async () => {
    expect(await promptCreate({})).toBe(false);
  });

  it('turns on from the environment only for the exact string true', async () => {
    expect(await promptCreate({ OAUTH_PROMPT_CREATE_ENABLED: 'true' })).toBe(true);
    for (const value of ['TRUE', 'True', '1', 'yes', 'on', ' true', 'true ', 'false', '']) {
      expect(await promptCreate({ OAUTH_PROMPT_CREATE_ENABLED: value }), value).toBe(false);
    }
  });

  it('lets a value saved for the tenant win over the environment', async () => {
    expect(await promptCreate({ OAUTH_PROMPT_CREATE_ENABLED: 'true' }, false)).toBe(false);
    expect(await promptCreate({ OAUTH_PROMPT_CREATE_ENABLED: 'false' }, true)).toBe(true);
    expect(await promptCreate({}, true)).toBe(true);
  });
});

describe('tenant.ui_register_path', () => {
  it('is applied: no longer marked as in development', () => {
    const meta = TENANT_SETTINGS_META['tenant.ui_register_path'];
    expect(meta.status).toBeUndefined();
    expect(meta.default).toBe('/signup');
  });
});
