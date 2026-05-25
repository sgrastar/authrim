import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../types/env';
import {
  clearNativeSSOConfigCache,
  getNativeSSOConfig,
  isNativeSSOEnabled,
} from '../native-sso-config';

function createEnv(overrides: Record<string, unknown> = {}): Env {
  return overrides as Env;
}

describe('Native SSO config', () => {
  beforeEach(() => {
    clearNativeSSOConfigCache();
  });

  it('defaults same-client Native SSO on while keeping cross-client off', async () => {
    const config = await getNativeSSOConfig(createEnv());

    expect(config.enabled).toBe(true);
    expect(config.allowCrossClientNativeSSO).toBe(false);
    expect(config.deviceSecretRotationPolicy).toBe('disabled');
    expect(config.deviceSecretRotationOverlapSeconds).toBe(0);
    await expect(isNativeSSOEnabled(createEnv())).resolves.toBe(true);
  });

  it('allows operators to explicitly disable Native SSO', async () => {
    const env = createEnv({ NATIVE_SSO_ENABLED: 'false' });

    await expect(isNativeSSOEnabled(env)).resolves.toBe(false);
  });

  it('allows explicit device secret rotation policy with bounded overlap', async () => {
    const env = createEnv({
      NATIVE_SSO_DEVICE_SECRET_ROTATION_POLICY: 'explicit',
      NATIVE_SSO_DEVICE_SECRET_ROTATION_OVERLAP_SECONDS: '120',
    });

    const config = await getNativeSSOConfig(env);

    expect(config.deviceSecretRotationPolicy).toBe('explicit');
    expect(config.deviceSecretRotationOverlapSeconds).toBe(120);
  });

  it('falls back to disabled rotation policy for invalid values', async () => {
    const env = createEnv({
      NATIVE_SSO_DEVICE_SECRET_ROTATION_POLICY: 'automatic',
      NATIVE_SSO_DEVICE_SECRET_ROTATION_OVERLAP_SECONDS: '999999',
    });

    const config = await getNativeSSOConfig(env);

    expect(config.deviceSecretRotationPolicy).toBe('disabled');
    expect(config.deviceSecretRotationOverlapSeconds).toBe(86400);
  });
});
