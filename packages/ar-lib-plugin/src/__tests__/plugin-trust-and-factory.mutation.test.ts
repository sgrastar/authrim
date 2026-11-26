import { afterEach, describe, expect, it, vi } from 'vitest';
import { THIRD_PARTY_DISCLAIMER, getPluginTrustLevel, type PluginSource } from '../core/types';
import { BuiltinPolicyInfra } from '../infra/policy/builtin';
import { createPolicyInfra } from '../infra/policy/factory';
import type { IStorageInfra, InfraEnv } from '../infra/types';

describe('getPluginTrustLevel', () => {
  it.each([
    [{ type: 'builtin' }, 'official'],
    [{ type: 'builtin', identifier: 'ar-lib-plugin/builtin/notifier/x' }, 'official'],
    [{ type: 'npm', identifier: '@authrim/plugin-x' }, 'official'],
    [{ type: 'npm', identifier: '@authrim/' }, 'official'],
    [{ type: 'npm', identifier: '@authrimx/plugin' }, 'community'],
    [{ type: 'npm', identifier: 'authrim-plugin-x' }, 'community'],
    [{ type: 'npm', identifier: 'x/@authrim/y' }, 'community'],
    [{ type: 'npm' }, 'community'],
    [{ type: 'local', identifier: '@authrim/plugin-x' }, 'community'],
    [{ type: 'unknown', identifier: '@authrim/plugin-x' }, 'community'],
    [{ type: 'unknown' }, 'community'],
  ] as Array<[PluginSource, string]>)('trusts %j as %s', (source, expected) => {
    expect(getPluginTrustLevel(source)).toBe(expected);
  });

  it('words the third-party disclaimer', () => {
    expect(THIRD_PARTY_DISCLAIMER).toBe(
      'This plugin is provided by a third party. Authrim does not guarantee its security, reliability, or compatibility. Use at your own risk.'
    );
  });
});

describe('createPolicyInfra', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const storage = { adapter: {} } as unknown as IStorageInfra;
  const env = (extra: Record<string, unknown> = {}) => extra as unknown as InfraEnv;

  it('creates an initialised built-in engine by default', async () => {
    const initialize = vi.spyOn(BuiltinPolicyInfra.prototype, 'initialize');
    const environment = env();
    const policy = await createPolicyInfra(environment, storage);
    expect(policy).toBeInstanceOf(BuiltinPolicyInfra);
    expect(initialize).toHaveBeenCalledWith(environment, storage);
    expect((await policy.healthCheck()).status).toBe('healthy');
    initialize.mockRestore();
  });

  it('accepts the built-in provider from the environment or the options', async () => {
    expect(await createPolicyInfra(env({ POLICY_PROVIDER: 'builtin' }), storage)).toBeInstanceOf(
      BuiltinPolicyInfra
    );
    expect(
      await createPolicyInfra(env({ POLICY_PROVIDER: 'opa' }), storage, { provider: 'builtin' })
    ).toBeInstanceOf(BuiltinPolicyInfra);
  });

  it.each(['openfga', 'opa'] as const)(
    'reports the %s provider as not implemented',
    async (provider) => {
      await expect(createPolicyInfra(env(), storage, { provider })).rejects.toThrow(
        `Policy provider '${provider}' is not yet implemented`
      );
      await expect(createPolicyInfra(env({ POLICY_PROVIDER: provider }), storage)).rejects.toThrow(
        `Policy provider '${provider}' is not yet implemented`
      );
    }
  );

  it('asks for manual instantiation of a custom provider', async () => {
    await expect(createPolicyInfra(env(), storage, { provider: 'custom' })).rejects.toThrow(
      'Custom policy provider requires manual instantiation'
    );
  });

  it('names an unknown provider', async () => {
    await expect(createPolicyInfra(env({ POLICY_PROVIDER: 'mystery' }), storage)).rejects.toThrow(
      'Unknown policy provider: mystery'
    );
  });
});
