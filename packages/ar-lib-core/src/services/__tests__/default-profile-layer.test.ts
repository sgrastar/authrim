import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types/env';
import {
  DEFAULT_LAYER_KEYS,
  SESSION_DEFAULT_LAYER_KEYS,
  layerTenantDocument,
  parseLegacySwitch,
  type DefaultProfileLayer,
} from '../default-profile-layer';
import {
  layerTenantSettingsDocument,
  readDefaultProfileLayer,
  resolveEffectiveSettings,
  resolveEffectiveSettingsWithSources,
} from '../effective-settings';
import { isAuthenticationMethodUsageAvailable } from '../account-login-methods';
import { readTenantSessionSettings, readTenantSessionSettingsStrict } from '../session-ttl';
import { resolveGuestSettings } from '../guest-settings';
import { SESSION_PROFILE_SESSION_KEYS } from '../session-profile';
import { AUTHENTICATION_METHODS_SETTINGS_META } from '../../types/settings/authentication-methods';
import { SESSION_SETTINGS_META } from '../../types/settings/session';
import { OAUTH_SETTINGS_META } from '../../types/settings/oauth';

/** A KV holding the documents (a new one per test: the runtime caches per KV binding). */
function kv(values: Record<string, unknown>, failing: string[] = []): KVNamespace {
  return {
    get: vi.fn(async (key: string) => {
      if (failing.includes(key)) throw new Error('kv down');
      const value = values[key];
      if (value === undefined) return null;
      return typeof value === 'string' ? value : JSON.stringify(value);
    }),
  } as unknown as KVNamespace;
}

const METHODS = 'settings:tenant:acme:authentication-methods';
const PLATFORM_METHODS = 'settings:platform:authentication-methods';
const PROFILES = 'settings:platform:profiles';

describe('which settings a Default holds', () => {
  it('opens only them to the platform', () => {
    const layer = new Set<string>(DEFAULT_LAYER_KEYS['authentication-methods']);
    for (const [key, meta] of Object.entries(AUTHENTICATION_METHODS_SETTINGS_META)) {
      expect(meta.scopes, key).toEqual(layer.has(key) ? ['platform', 'tenant'] : ['tenant']);
    }
    for (const key of SESSION_DEFAULT_LAYER_KEYS) {
      expect(SESSION_SETTINGS_META[key].scopes).toEqual(['platform', 'tenant']);
    }
    expect(SESSION_SETTINGS_META['session.ttl.admin_passkey'].scopes).toEqual(['tenant']);
    // Of oauth, single sign-on only: the others stay per tenant (or app).
    for (const [key, meta] of Object.entries(OAUTH_SETTINGS_META)) {
      if (key === 'oauth.sso_enabled')
        expect(meta.scopes).toEqual(['platform', 'tenant', 'client']);
      else if (meta.scopes?.includes('client')) expect(meta.scopes, key).not.toContain('platform');
    }
  });

  it('are the settings a session profile holds', () => {
    expect([...SESSION_DEFAULT_LAYER_KEYS]).toEqual([...SESSION_PROFILE_SESSION_KEYS]);
  });

  it('leave out what names something of one tenant', () => {
    const keys = DEFAULT_LAYER_KEYS['authentication-methods'];
    expect(keys).not.toContain('authentication-methods.external_provider_usage');
    expect(keys.some((key) => key.includes('human_verification'))).toBe(false);
  });
});

describe('a raw document with the platform layer', () => {
  const layer = (
    platform: Record<string, unknown>,
    tenantSetAside: DefaultProfileLayer['tenantSetAside'] = null
  ): DefaultProfileLayer => ({
    category: 'authentication-methods',
    platformValues: platform,
    platformSources: Object.fromEntries(Object.keys(platform).map((key) => [key, 'platform'])),
    tenantSetAside,
  });

  it('keeps the tenant’s values and fills the rest from the platform', () => {
    const layered = layerTenantDocument(
      {
        'authentication-methods.passkey.login_enabled': true,
        'authentication-methods.external_provider_usage': '[]',
      },
      layer({
        'authentication-methods.passkey.login_enabled': false,
        'authentication-methods.email_otp.login_enabled': true,
      })
    );
    expect(layered['authentication-methods.passkey.login_enabled']).toBe(true);
    expect(layered['authentication-methods.email_otp.login_enabled']).toBe(true);
    expect(layered['authentication-methods.external_provider_usage']).toBe('[]');
  });

  it('sets the tenant’s values aside, its older switches too, when the platform does', () => {
    const layered = layerTenantDocument(
      {
        'authentication-methods.passkey.login_enabled': true,
        'authentication-methods.email_otp.enabled': true,
        'authentication-methods.human_verification.login_enabled': true,
      },
      layer({ 'authentication-methods.passkey.login_enabled': false }, 'locked')
    );
    expect(layered['authentication-methods.passkey.login_enabled']).toBe(false);
    expect(layered['authentication-methods.email_otp.enabled']).toBeUndefined();
    // Not a setting of the Default: the tenant's.
    expect(layered['authentication-methods.human_verification.login_enabled']).toBe(true);
  });

  it('lets a tenant’s older switch decide the uses it sets no switch for', () => {
    const layered = layerTenantDocument(
      { 'authentication-methods.email_otp.enabled': true },
      layer({ 'authentication-methods.email_otp.login_enabled': false })
    );
    expect(layered['authentication-methods.email_otp.login_enabled']).toBeUndefined();
    expect(layered['authentication-methods.email_otp.enabled']).toBe(true);
  });

  it('leaves what neither sets unset (the reader’s own default applies)', () => {
    const layered = layerTenantDocument({}, layer({}));
    expect(layered).toEqual({});
  });
});

describe('the runtime readers with the platform layer', () => {
  it('takes the platform’s Default methods where the tenant sets none', async () => {
    const env = {
      SETTINGS: kv({
        [PLATFORM_METHODS]: { 'authentication-methods.passkey.login_enabled': false },
      }),
    } as unknown as Env;
    expect(await isAuthenticationMethodUsageAvailable(env, 'acme', 'passkey', 'login')).toBe(false);
    expect(await isAuthenticationMethodUsageAvailable(env, 'acme', 'passkey', 'signup')).toBe(true);
  });

  it('keeps the tenant’s own value while the platform lets it apply', async () => {
    const env = {
      SETTINGS: kv({
        [METHODS]: { 'authentication-methods.passkey.login_enabled': true },
        [PLATFORM_METHODS]: { 'authentication-methods.passkey.login_enabled': false },
      }),
    } as unknown as Env;
    expect(await isAuthenticationMethodUsageAvailable(env, 'acme', 'passkey', 'login')).toBe(true);
  });

  it.each([
    ['locked', { 'profiles.method.default_locked': true }],
    ['changes not allowed', { 'profiles.method.tenant_change_allowed': false }],
  ])('sets the tenant’s value aside when %s', async (_, switches) => {
    const env = {
      SETTINGS: kv({
        [METHODS]: { 'authentication-methods.passkey.login_enabled': true },
        [PLATFORM_METHODS]: { 'authentication-methods.passkey.login_enabled': false },
        [PROFILES]: switches,
      }),
    } as unknown as Env;
    expect(await isAuthenticationMethodUsageAvailable(env, 'acme', 'passkey', 'login')).toBe(false);
    const resolved = await resolveEffectiveSettingsWithSources(env, 'authentication-methods', {
      tenantId: 'acme',
    });
    expect(resolved.values['authentication-methods.passkey.login_enabled']).toBe(false);
    expect(resolved.sources['authentication-methods.passkey.login_enabled']).toBe('platform');
  });

  it('falls back to the code default when locked and the platform sets nothing', async () => {
    const env = {
      SETTINGS: kv({
        [METHODS]: { 'authentication-methods.email_otp.login_enabled': true },
        [PROFILES]: { 'profiles.method.default_locked': true },
      }),
    } as unknown as Env;
    expect(await isAuthenticationMethodUsageAvailable(env, 'acme', 'email_otp', 'login')).toBe(
      false
    );
  });

  it('refuses a strict decision when the platform layer cannot be read', async () => {
    const env = {
      SETTINGS: kv({ [METHODS]: {}, [PROFILES]: 'not json' }),
    } as unknown as Env;
    await expect(
      isAuthenticationMethodUsageAvailable(env, 'acme', 'passkey', 'login', { strict: true })
    ).rejects.toThrow();
    await expect(readDefaultProfileLayer(env, 'authentication-methods')).rejects.toThrow();
  });

  it('layers the session rules for sign-in and for the admin view', async () => {
    const env = {
      SETTINGS: kv({
        'settings:tenant:acme:session': { 'session.default_ttl': 1000, 'session.max_ttl': 2000 },
        'settings:platform:session': {
          'session.default_ttl': 5000,
          'session.ttl.passkey': 7000,
          // Not a setting of the Default: the platform's value is not handed to the raw reader.
          'session.backchannel_enabled': false,
        },
        [PROFILES]: { 'profiles.session.tenant_change_allowed': false },
      }),
    } as unknown as Env;
    for (const read of [readTenantSessionSettings, readTenantSessionSettingsStrict]) {
      const settings = await read(env, 'acme');
      expect(settings['session.default_ttl']).toBe(5000);
      expect(settings['session.max_ttl']).toBeUndefined();
      expect(settings['session.ttl.passkey']).toBe(7000);
      expect(settings['session.backchannel_enabled']).toBeUndefined();
    }
  });

  it('turns single sign-on as the platform’s Default says, an app’s own value first', async () => {
    const env = {
      SETTINGS: kv({
        'settings:tenant:acme:oauth': { 'oauth.sso_enabled': true },
        'settings:client:acme:app:oauth': { 'oauth.sso_enabled': true },
        'settings:platform:oauth': { 'oauth.sso_enabled': false },
        [PROFILES]: { 'profiles.session.default_locked': true },
      }),
    } as unknown as Env;
    expect(
      (await resolveEffectiveSettings(env, 'oauth', { tenantId: 'acme' }))['oauth.sso_enabled']
    ).toBe(false);
    expect(
      (await resolveEffectiveSettings(env, 'oauth', { tenantId: 'acme', clientId: 'app' }))[
        'oauth.sso_enabled'
      ]
    ).toBe(true);
  });

  it('reads the guest switches with the platform layer', async () => {
    const env = {
      SETTINGS: kv({
        [PLATFORM_METHODS]: { 'authentication-methods.guest.login_enabled': true },
      }),
    } as unknown as Env;
    expect((await resolveGuestSettings(env, 'acme')).loginEnabled).toBe(true);
  });

  it('leaves the documents of other categories as they are', async () => {
    const env = { SETTINGS: kv({}) } as unknown as Env;
    const document = { 'login-ui.title': 'x' };
    expect(await layerTenantSettingsDocument(env, 'login-ui', document)).toBe(document);
  });

  it.each([[false], [' FALSE '], ['false'], ['__DISABLED__']])(
    'reads an older single switch %j the same way in every reader',
    async (legacy) => {
      const env = {
        SETTINGS: kv({
          [METHODS]: { 'authentication-methods.passkey.enabled': legacy },
          [PLATFORM_METHODS]: { 'authentication-methods.passkey.login_enabled': true },
        }),
      } as unknown as Env;
      expect(await isAuthenticationMethodUsageAvailable(env, 'acme', 'passkey', 'login')).toBe(
        false
      );
      const resolved = await resolveEffectiveSettingsWithSources(env, 'authentication-methods', {
        tenantId: 'acme',
      });
      expect(resolved.values['authentication-methods.passkey.login_enabled']).toBe(false);
      expect(resolved.sources['authentication-methods.passkey.login_enabled']).toBe('kv');
    }
  );
});

describe('an older single switch', () => {
  it('is read as sign-in reads it', () => {
    expect(parseLegacySwitch(' TRUE ')).toBe(true);
    expect(parseLegacySwitch('False')).toBe(false);
    expect(parseLegacySwitch('__DISABLED__')).toBe(false);
    expect(parseLegacySwitch('maybe')).toBeNull();
    expect(parseLegacySwitch(1)).toBeNull();
  });
});
