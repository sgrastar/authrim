import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EffectiveSettingsEnv } from '../effective-settings';

const { resolveEffectiveSettings } = vi.hoisted(() => ({ resolveEffectiveSettings: vi.fn() }));

vi.mock('../effective-settings', () => ({ resolveEffectiveSettings }));

import { resolveIDTokenSigningPolicy } from '../id-token-signing';

const env = {} as EffectiveSettingsEnv;

describe('ID token signing policy', () => {
  beforeEach(() => {
    resolveEffectiveSettings.mockReset();
  });

  it("reads the tenant's algorithm and whether apps may choose another", async () => {
    resolveEffectiveSettings.mockResolvedValue({
      'oauth.id_token_signing_alg': 'ES256',
      'oauth.id_token_signing_alg_client_override': false,
    });

    await expect(resolveIDTokenSigningPolicy(env, 't')).resolves.toEqual({
      algorithm: 'ES256',
      appsMayChoose: false,
    });
    expect(resolveEffectiveSettings).toHaveBeenCalledWith(env, 'oauth', { tenantId: 't' });
  });

  it('keeps RS256 for an unknown algorithm, and lets apps choose unless explicitly not', async () => {
    resolveEffectiveSettings.mockResolvedValue({
      'oauth.id_token_signing_alg': 'HS256',
      'oauth.id_token_signing_alg_client_override': 'false',
    });

    await expect(resolveIDTokenSigningPolicy(env, 't')).resolves.toEqual({
      algorithm: 'RS256',
      appsMayChoose: true,
    });
  });

  it('does not guess a policy when the settings cannot be read', async () => {
    resolveEffectiveSettings.mockRejectedValue(new Error('kv down'));

    await expect(resolveIDTokenSigningPolicy(env, 't')).rejects.toThrow('kv down');
  });
});
