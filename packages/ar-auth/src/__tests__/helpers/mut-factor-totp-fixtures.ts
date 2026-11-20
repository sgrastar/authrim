/** Sign-up and sign-in fixtures for the mut-factor-totp-* tests (real TOTP codes). */
import {
  encryptValue,
  generateTotpCode,
  getTotpTimeStep,
  type TotpProfile,
} from '@authrim/ar-lib-core';
import { ENCRYPTION_KEY, SECRET, m } from './mut-factor-totp-harness';

export const PROFILE: TotpProfile = { algorithm: 'SHA1', digits: 6, period: 30, window: 1 };

export async function currentCode(secret = SECRET, offsetSteps = 0) {
  const timeStep = getTotpTimeStep(Date.now(), PROFILE.period) + offsetSteps;
  return { code: await generateTotpCode(secret, PROFILE, timeStep), timeStep };
}

export async function encryptedSecret(secret = SECRET) {
  return (await encryptValue(secret, ENCRYPTION_KEY, 'AES-256-GCM', 1)).encrypted;
}

export function credentialRow(secretEncrypted: string, extra: Record<string, unknown> = {}) {
  return {
    id: 'totp-001',
    tenant_id: 'default',
    user_id: 'user-001',
    secret_encrypted: secretEncrypted,
    secret_key_version: 1,
    label: 'Authenticator app',
    ...PROFILE,
    status: 'active',
    last_used_time_step: null,
    created_at: 1,
    activated_at: 1,
    last_used_at: null,
    ...extra,
  };
}

/** A stored sign-up challenge `signup-challenge` for user-signup-001, plus the repo answers. */
export async function arrangeSignup(metadata: Record<string, unknown> = {}, extra = {}) {
  const secretEncrypted = await encryptedSecret();
  const pending = credentialRow(secretEncrypted, {
    id: 'cred-signup',
    user_id: 'user-signup-001',
    status: 'pending',
    activated_at: null,
  });
  m.challengeStore.getChallengeRpc.mockResolvedValue({
    userId: 'user-signup-001',
    challenge: 'signup-challenge',
    metadata: {
      credential_id: 'cred-signup',
      email: 'new@example.com',
      name: 'New User',
      label: 'Authenticator app',
      secret_encrypted: secretEncrypted,
      secret_key_version: 1,
      ...PROFILE,
      custom_fields: {},
      ...metadata,
    },
    ...extra,
  });
  m.runtimeUsers.findById.mockResolvedValueOnce(null).mockResolvedValue({
    id: 'user-signup-001',
    email: 'new@example.com',
    name: 'New User',
    active: 1,
  });
  m.totpRepo.create.mockImplementation(async (row: Record<string, unknown>) => ({
    ...pending,
    ...row,
  }));
  m.totpRepo.activate.mockImplementation(async (id: string, userId: string, step: number) => ({
    ...pending,
    id,
    user_id: userId,
    status: 'active',
    last_used_time_step: step,
  }));
  return { pending, ...(await currentCode()) };
}
