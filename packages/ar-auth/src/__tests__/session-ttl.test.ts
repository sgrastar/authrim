import { describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import { resolveSessionTtl } from '../session-ttl';

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
        'session.ttl.anonymous': 90 * 60 * 1000,
        'session.ttl.did': 45 * 60 * 1000,
      },
    });

    const ttl = await resolveSessionTtl(env, 'tenant-a', 'directory_password');
    const anonymousTtl = await resolveSessionTtl(env, 'tenant-a', 'anonymous');
    const didTtl = await resolveSessionTtl(env, 'tenant-a', 'did');

    expect(ttl.key).toBe('session.ttl.directory_password');
    expect(ttl.milliseconds).toBe(2 * 60 * 60 * 1000);
    expect(ttl.seconds).toBe(2 * 60 * 60);
    expect(anonymousTtl).toMatchObject({
      key: 'session.ttl.anonymous',
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
});
