import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types/env';
import { readTenantSessionSettingsStrict, resolveSessionTtl } from '../session-ttl';

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
