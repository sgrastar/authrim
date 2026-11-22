import { describe, expect, it } from 'vitest';
import type { Env } from '../../types/env';
import {
  getAdminSecretEncryptionKey,
  openAdminTotpSecret,
  sealAdminTotpSecret,
} from '../admin-totp-secret';

const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const OTHER_KEY = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
const env = { ADMIN_CREDENTIAL_ENCRYPTION_KEY: KEY } as unknown as Env;

describe('admin TOTP secret sealing', () => {
  it('seals a secret for an admin and opens it again for that admin only', async () => {
    const sealed = await sealAdminTotpSecret(env, 'admin-1', 'JBSWY3DPEHPK3PXP');
    expect(sealed).not.toBeNull();
    expect(sealed!.encrypted).not.toContain('JBSWY3DPEHPK3PXP');
    expect(sealed!.keyVersion).toBe(1);

    await expect(openAdminTotpSecret(env, 'admin-1', sealed!.encrypted)).resolves.toBe(
      'JBSWY3DPEHPK3PXP'
    );
    // A row copied to another admin's account does not open.
    await expect(openAdminTotpSecret(env, 'admin-2', sealed!.encrypted)).resolves.toBeNull();
  });

  it('never opens plaintext, garbage, or a secret sealed with another key', async () => {
    const sealed = await sealAdminTotpSecret(env, 'admin-1', 'JBSWY3DPEHPK3PXP');
    await expect(openAdminTotpSecret(env, 'admin-1', 'JBSWY3DPEHPK3PXP')).resolves.toBeNull();
    await expect(openAdminTotpSecret(env, 'admin-1', 'enc:v1:broken')).resolves.toBeNull();
    const otherKeyEnv = { ADMIN_CREDENTIAL_ENCRYPTION_KEY: OTHER_KEY } as unknown as Env;
    await expect(
      openAdminTotpSecret(otherKeyEnv, 'admin-1', sealed!.encrypted)
    ).resolves.toBeNull();
  });

  it('seals and opens nothing without a key, and falls back through the key names', async () => {
    const none = {} as Env;
    expect(getAdminSecretEncryptionKey(none)).toBeNull();
    await expect(sealAdminTotpSecret(none, 'admin-1', 'JBSWY3DPEHPK3PXP')).resolves.toBeNull();
    await expect(openAdminTotpSecret(none, 'admin-1', 'x')).resolves.toBeNull();

    expect(
      getAdminSecretEncryptionKey({
        PII_ENCRYPTION_KEY: KEY,
        PII_ENCRYPTION_KEY_VERSION: '3',
      } as unknown as Env)
    ).toEqual({ key: KEY, version: 3 });
    expect(
      getAdminSecretEncryptionKey({
        ADMIN_CREDENTIAL_ENCRYPTION_KEY: KEY,
        PII_ENCRYPTION_KEY: OTHER_KEY,
      } as unknown as Env)?.key
    ).toBe(KEY);
  });
});
