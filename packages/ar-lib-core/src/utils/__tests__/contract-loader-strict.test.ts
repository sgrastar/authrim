import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types/env';
import { loadTenantProfile, loadTenantProfileStrict } from '../contract-loader';

function kv(get: (key: string) => Promise<string | null>) {
  return {
    get: vi.fn((key: string, type?: string) =>
      get(key).then((raw) => (type === 'json' && raw !== null ? JSON.parse(raw) : raw))
    ),
  } as unknown as KVNamespace;
}

const env = { ENVIRONMENT: 'test' } as unknown as Env;

describe('loadTenantProfileStrict', () => {
  it("reads the tenant's profile, or the default one without a contract", async () => {
    const stored = kv(async (key) =>
      key === 'test:contract:tenant:tenant-a' ? JSON.stringify({ profile: 'ai_ephemeral' }) : null
    );
    expect((await loadTenantProfileStrict(stored, env, 'tenant-a')).max_token_ttl_seconds).toBe(
      3600
    );
    expect((await loadTenantProfileStrict(stored, env, 'tenant-b')).max_token_ttl_seconds).toBe(
      86400
    );
  });

  it('throws where loadTenantProfile reads the default profile', async () => {
    const failing = kv(async () => {
      throw new Error('kv_unavailable');
    });
    expect((await loadTenantProfile(failing, env, 'tenant-a')).max_token_ttl_seconds).toBe(86400);
    await expect(loadTenantProfileStrict(failing, env, 'tenant-a')).rejects.toThrow(
      'kv_unavailable'
    );
    await expect(
      loadTenantProfileStrict(
        kv(async () => '{broken'),
        env,
        'tenant-a'
      )
    ).rejects.toThrow();
  });

  it('refuses a contract that is not an object or names an unknown profile', async () => {
    for (const stored of ['[]', '"human"', JSON.stringify({ profile: 'ai_ephemeral_typo' })]) {
      await expect(
        loadTenantProfileStrict(
          kv(async () => stored),
          env,
          'tenant-a'
        )
      ).rejects.toThrow();
    }
    // A contract without a profile is the default one.
    expect(
      (
        await loadTenantProfileStrict(
          kv(async () => '{}'),
          env,
          'tenant-a'
        )
      ).max_token_ttl_seconds
    ).toBe(86400);
  });
});
