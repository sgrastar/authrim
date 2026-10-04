import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types/env';
import {
  readTenantSessionSettingsStrict,
  resolveSessionExtensionPolicy,
  resolveSessionTtl,
} from '../session-ttl';

function createEnv(input: {
  settings?: Record<string, unknown>;
  env?: Record<string, unknown>;
}): Env {
  return {
    ...input.env,
    SETTINGS: {
      get: vi.fn(async (key: string) => {
        if (key !== 'settings:tenant:tenant-a:session') return null;
        return input.settings === undefined ? null : JSON.stringify(input.settings);
      }),
    },
  } as unknown as Env;
}

describe('resolveSessionTtl', () => {
  it('uses method-specific tenant settings in milliseconds', async () => {
    const env = createEnv({
      settings: {
        'session.ttl.directory_password': 2 * 60 * 60 * 1000,
        'session.ttl.guest': 90 * 60 * 1000,
        'session.ttl.did': 45 * 60 * 1000,
      },
    });

    const ttl = await resolveSessionTtl(env, 'tenant-a', 'directory_password');
    const anonymousTtl = await resolveSessionTtl(env, 'tenant-a', 'guest');
    const didTtl = await resolveSessionTtl(env, 'tenant-a', 'did');

    expect(ttl.key).toBe('session.ttl.directory_password');
    expect(ttl.milliseconds).toBe(2 * 60 * 60 * 1000);
    expect(ttl.seconds).toBe(2 * 60 * 60);
    expect(anonymousTtl).toMatchObject({
      key: 'session.ttl.guest',
      milliseconds: 90 * 60 * 1000,
      seconds: 90 * 60,
    });
    expect(didTtl).toMatchObject({
      key: 'session.ttl.did',
      milliseconds: 45 * 60 * 1000,
      seconds: 45 * 60,
    });
  });

  it('falls back to the matching environment variable', async () => {
    const env = createEnv({
      env: {
        SESSION_TTL_EMAIL_CODE_MS: String(3 * 60 * 60 * 1000),
      },
    });

    const ttl = await resolveSessionTtl(env, 'tenant-a', 'email_code');

    expect(ttl.milliseconds).toBe(3 * 60 * 60 * 1000);
    expect(ttl.seconds).toBe(3 * 60 * 60);
  });

  it('falls back to defaults when settings are missing or invalid', async () => {
    const env = createEnv({
      settings: {
        'session.ttl.passkey': 'not-a-number',
      },
    });

    const ttl = await resolveSessionTtl(env, 'tenant-a', 'passkey');

    expect(ttl.milliseconds).toBe(7 * 24 * 60 * 60 * 1000);
    expect(ttl.seconds).toBe(7 * 24 * 60 * 60);
  });

  it('clamps tenant values to the supported bounds', async () => {
    const lowEnv = createEnv({
      settings: {
        'session.ttl.direct_auth': 1,
      },
    });
    const highEnv = createEnv({
      settings: {
        'session.ttl.admin_passkey': 365 * 24 * 60 * 60 * 1000,
      },
    });

    await expect(resolveSessionTtl(lowEnv, 'tenant-a', 'direct_auth')).resolves.toMatchObject({
      milliseconds: 60 * 1000,
      seconds: 60,
    });
    await expect(resolveSessionTtl(highEnv, 'tenant-a', 'admin_passkey')).resolves.toMatchObject({
      milliseconds: 30 * 24 * 60 * 60 * 1000,
      seconds: 30 * 24 * 60 * 60,
    });
  });

  it('reads unreadable settings as none for sign-in, and throws for an admin view', async () => {
    const failing = {
      SETTINGS: {
        get: vi.fn(async () => {
          throw new Error('kv_unavailable');
        }),
      },
    } as unknown as Env;
    expect((await resolveSessionTtl(failing, 'tenant-a', 'passkey')).key).toBe(
      'session.ttl.passkey'
    );
    await expect(readTenantSessionSettingsStrict(failing, 'tenant-a')).rejects.toThrow(
      'kv_unavailable'
    );

    const array = createEnv({ settings: [] as unknown as Record<string, unknown> });
    await expect(readTenantSessionSettingsStrict(array, 'tenant-a')).rejects.toThrow(
      'session_settings_invalid'
    );
    expect(await readTenantSessionSettingsStrict(createEnv({}), 'tenant-a')).toEqual({});
    // A stored empty string is unreadable data, not no settings.
    const empty = {
      SETTINGS: { get: vi.fn(async () => '') },
    } as unknown as Env;
    await expect(readTenantSessionSettingsStrict(empty, 'tenant-a')).rejects.toThrow();
    expect(
      await readTenantSessionSettingsStrict(
        createEnv({ settings: { 'session.ttl.passkey': 1000 } }),
        'tenant-a'
      )
    ).toEqual({ 'session.ttl.passkey': 1000 });
  });
});

describe('session.default_ttl and session.max_ttl', () => {
  it('gives sign-ins without their own setting session.default_ttl', async () => {
    expect((await resolveSessionTtl(createEnv({}), 'tenant-a', 'default')).seconds).toBe(86400);
    const env = createEnv({ settings: { 'session.default_ttl': 2 * 60 * 60 * 1000 } });
    const ttl = await resolveSessionTtl(env, 'tenant-a', 'default');
    expect(ttl).toMatchObject({ key: 'session.default_ttl', seconds: 2 * 60 * 60 });
  });

  it('cuts every lifetime to session.max_ttl', async () => {
    const env = createEnv({
      settings: {
        'session.max_ttl': 2 * 86400000,
        'session.ttl.passkey': 7 * 86400000,
      },
    });
    expect((await resolveSessionTtl(env, 'tenant-a', 'passkey')).seconds).toBe(2 * 86400);
    // The default for registration (30 days) as well.
    expect((await resolveSessionTtl(env, 'tenant-a', 'passkey_registration')).seconds).toBe(
      2 * 86400
    );
    // A shorter lifetime stays as set.
    expect((await resolveSessionTtl(env, 'tenant-a', 'email_code')).seconds).toBe(86400);
  });

  it('keeps the defaults within the default session.max_ttl (30 days)', async () => {
    expect(
      (await resolveSessionTtl(createEnv({}), 'tenant-a', 'passkey_registration')).seconds
    ).toBe(30 * 86400);
  });

  it('reads the extension policy: on and 30 days by default, else as the tenant sets it', async () => {
    expect(await resolveSessionExtensionPolicy(createEnv({}), 'tenant-a')).toEqual({
      enabled: true,
      maxLifetimeMs: 30 * 86400000,
    });
    expect(
      await resolveSessionExtensionPolicy(
        createEnv({ settings: { 'session.refresh_default': false, 'session.max_ttl': 86400000 } }),
        'tenant-a'
      )
    ).toEqual({ enabled: false, maxLifetimeMs: 86400000 });
    // The variable reads as the Settings API reads it: on only as `true` or `1`.
    for (const [value, enabled] of [
      ['false', false],
      ['FALSE', false],
      ['0', false],
      ['TRUE', true],
      ['1', true],
    ] as const) {
      expect(
        await resolveSessionExtensionPolicy(
          createEnv({ env: { SESSION_REFRESH_DEFAULT: value } }),
          'tenant-a'
        )
      ).toMatchObject({ enabled });
    }
    // A tenant value wins over the variable.
    expect(
      await resolveSessionExtensionPolicy(
        createEnv({
          settings: { 'session.refresh_default': true },
          env: { SESSION_REFRESH_DEFAULT: 'false' },
        }),
        'tenant-a'
      )
    ).toMatchObject({ enabled: true });
  });
});
