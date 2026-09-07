import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types/env';
import { derivePluginInstallationId } from '../plugin-installation-id';
import { verifyHumanVerificationWithRunner } from '../human-verification-runner';

function kv(values: Record<string, string>): KVNamespace {
  return {
    get: vi.fn(async (key: string) => values[key] ?? null),
  } as unknown as KVNamespace;
}

describe('verifyHumanVerificationWithRunner', () => {
  let runHumanVerification: ReturnType<typeof vi.fn>;
  let env: Env;

  beforeEach(() => {
    runHumanVerification = vi.fn(async () => ({
      decision: 'allow' as const,
      reasonCode: 'verification_succeeded',
    }));
    env = {
      AUTHRIM_ENVIRONMENT_NAME: 'test',
      SETTINGS: kv({
        'settings:tenant:tenant-a:authentication-methods': JSON.stringify({
          'authentication-methods.human_verification.provider':
            'human-verification-cloudflare-turnstile',
          'authentication-methods.human_verification.login_enabled': true,
        }),
        'plugins:enabled:human-verification-cloudflare-turnstile:tenant:tenant-a': 'true',
      }),
      PLUGIN_RUNNER: { runHumanVerification } as unknown as Env['PLUGIN_RUNNER'],
    } as Env;
  });

  it('uses the deterministic tenant installation and returns the Runner decision', async () => {
    await expect(
      verifyHumanVerificationWithRunner(env, {
        tenantId: 'tenant-a',
        action: 'login',
        responseToken: ' browser-token ',
        remoteIp: '203.0.113.7',
      })
    ).resolves.toEqual({ required: true, verified: true });
    expect(runHumanVerification).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      pluginInstallationId: await derivePluginInstallationId({
        environmentId: 'test',
        tenantId: 'tenant-a',
        pluginId: 'human-verification-cloudflare-turnstile',
        purpose: 'human-verification',
      }),
      requestId: expect.any(String),
      action: 'login',
      responseToken: 'browser-token',
      remoteIp: '203.0.113.7',
    });
  });

  it('does not call Runner for a disabled action', async () => {
    await expect(
      verifyHumanVerificationWithRunner(env, {
        tenantId: 'tenant-a',
        action: 'signup',
        responseToken: 'browser-token',
      })
    ).resolves.toEqual({ required: false, verified: true });
    expect(runHumanVerification).not.toHaveBeenCalled();
  });

  it.each(['missing_token', 'disabled_provider', 'missing_runner', 'denied'])(
    'returns a safe denial for %s',
    async (failure) => {
      if (failure === 'disabled_provider') {
        env.SETTINGS = kv({
          'settings:tenant:tenant-a:authentication-methods': JSON.stringify({
            'authentication-methods.human_verification.login_enabled': true,
          }),
          'plugins:enabled:human-verification-cloudflare-turnstile:tenant:tenant-a': 'false',
        });
      } else if (failure === 'missing_runner') {
        env.PLUGIN_RUNNER = undefined;
      } else if (failure === 'denied') {
        runHumanVerification.mockResolvedValueOnce({
          decision: 'deny',
          reasonCode: 'verification_failed',
        });
      }
      await expect(
        verifyHumanVerificationWithRunner(env, {
          tenantId: 'tenant-a',
          action: 'login',
          responseToken: failure === 'missing_token' ? '' : 'browser-token',
        })
      ).resolves.toEqual({ required: true, verified: false });
    }
  );

  it('throws on malformed settings so every caller can fail closed', async () => {
    env.SETTINGS = kv({ 'settings:tenant:tenant-a:authentication-methods': '{invalid' });
    await expect(
      verifyHumanVerificationWithRunner(env, {
        tenantId: 'tenant-a',
        action: 'login',
        responseToken: 'browser-token',
      })
    ).rejects.toThrow();
  });
});
