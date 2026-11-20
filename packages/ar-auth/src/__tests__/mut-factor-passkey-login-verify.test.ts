import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock(
  '@simplewebauthn/server',
  async () => (await import('./helpers/mut-factor-passkey-harness')).pm.webauthn
);
vi.mock('@authrim/ar-lib-core', async (importOriginal) =>
  (await import('./helpers/mut-factor-passkey-harness')).passkeyLibCoreMock(await importOriginal())
);
vi.mock('../account-provisioning', async (importOriginal) =>
  (await import('./helpers/mut-factor-passkey-harness')).passkeyProvisioningMock(
    await importOriginal()
  )
);
vi.mock('../lite-mode', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lite-mode')>()),
  readLiteMode: (await import('./helpers/mut-factor-passkey-harness')).pm.readLiteMode,
}));

import { isoBase64URL } from '@simplewebauthn/server/helpers';
import * as passkey from '../passkey';
import {
  passkeyApp,
  passkeyEnv,
  pm,
  resetPasskeyHarness,
  send,
} from './helpers/mut-factor-passkey-harness';
import { base64 } from './helpers/mut-factor-call-arg';

const app = passkeyApp(passkey);
const URL_VERIFY = 'https://login.example.com/login/verify';
const ORIGIN = { origin: 'https://login.example.com' };
const credentialId = 'Y3JlZC0x';
const storedPasskey = (extra: Record<string, unknown> = {}) => ({
  id: 'pk-1',
  user_id: 'user-1',
  credential_id: credentialId,
  public_key: base64('public-key'),
  counter: 7,
  ...extra,
});
const credential = (response: Record<string, unknown> = {}) => ({
  id: credentialId,
  rawId: credentialId,
  type: 'public-key',
  response: { clientDataJSON: 'x', authenticatorData: 'y', signature: 'z', ...response },
});
const verify = (
  body: unknown = { challengeId: 'ch-1', credential: credential() },
  headers: Record<string, string> = ORIGIN,
  env = passkeyEnv()
) => send(app, URL_VERIFY, body, env, headers);
const failureCodes = () =>
  pm.publishEvent.mock.calls
    .map((call) => (call[1] as { data: { errorCode?: string; clientId?: string } }).data)
    .filter((data) => data.errorCode)
    .map((data) => `${data.clientId}:${data.errorCode}`);

describe('passkey login verify: before the assertion is checked', () => {
  beforeEach(() => resetPasskeyHarness());

  it.each([[{ credential: credential() }], [{ challengeId: 'ch-1' }]])(
    'requires a challenge and a credential: %j',
    async (body) => {
      const res = await verify(body);
      expect(res.body.error_code).toBe('AR130001');
      expect(pm.challengeStore.consumeChallengeRpc).not.toHaveBeenCalled();
    }
  );

  it('answers a challenge that cannot be consumed as an expired session', async () => {
    pm.challengeStore.consumeChallengeRpc.mockRejectedValueOnce(new Error('gone'));
    const res = await verify();
    expect(res.body.error_code).toBe('AR000001');
    expect(pm.challengeStore.consumeChallengeRpc).toHaveBeenCalledWith({
      id: 'passkey_auth:ch-1',
      tenantId: 'default',
      type: 'passkey_authentication',
    });
  });

  it.each([[{}], [{ origin: 'https://evil.example' }]])('refuses origin %j', async (headers) => {
    const res = await verify(undefined, headers);
    expect(res.body.error_code).toBe('AR050006');
    expect(pm.passkeyRepo.findByCredentialId).not.toHaveBeenCalled();
  });

  it('answers a route lookup failure as a failed passkey', async () => {
    pm.resolvePasskeyRoute.mockRejectedValueOnce(new Error('route down'));
    const res = await verify();
    expect(res.body.error_code).toBe('AR000005');
    expect(pm.resolvePasskeyRoute).toHaveBeenCalledWith(expect.anything(), {
      credentialId,
      rpId: 'login.example.com',
    });
  });

  it('reports an unknown credential without naming a user', async () => {
    const res = await verify();
    expect(res.body.error_code).toBe('AR000005');
    expect(failureCodes()).toEqual(['passkey-auth:credential_not_found']);
    expect(pm.webauthn.verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  it('finds a credential stored in legacy base64 and rewrites it', async () => {
    pm.passkeyRepo.findByCredentialId
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(storedPasskey({ credential_id: 'Y3JlZC0x' }));
    const res = await verify();
    expect(res.status).toBe(200);
    expect(pm.passkeyRepo.findByCredentialId).toHaveBeenNthCalledWith(
      2,
      isoBase64URL.toBase64(credentialId)
    );
    expect(pm.coreAdapter.execute).toHaveBeenCalledWith(
      'UPDATE passkeys SET credential_id = ? WHERE id = ? AND tenant_id = ?',
      [credentialId, 'pk-1', 'default']
    );
  });

  it.each([
    ['a user handle of another user', { userHandle: isoBase64URL.fromUTF8String('user-2') }],
    ['an empty user handle', { userHandle: '' }],
  ])('refuses %s', async (_label, response) => {
    pm.passkeyRepo.findByCredentialId.mockResolvedValueOnce(storedPasskey());
    const res = await verify({ challengeId: 'ch-1', credential: credential(response) });
    expect(res.body.error_code).toBe('AR000005');
    expect(pm.webauthn.verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  it('accepts the user handle of the credential owner', async () => {
    pm.passkeyRepo.findByCredentialId.mockResolvedValueOnce(storedPasskey());
    const res = await verify({
      challengeId: 'ch-1',
      credential: credential({ userHandle: isoBase64URL.fromUTF8String('user-1') }),
    });
    expect(res.status).toBe(200);
  });

  it('binds a routed credential to the account of its route and its user handle', async () => {
    pm.usesRoutedAccountStorage.mockReturnValue(true);
    pm.resolvePasskeyRoute.mockResolvedValue({ legacyUserId: 'user-1' });
    pm.passkeyRepo.findByCredentialId.mockResolvedValue(storedPasskey());
    const noHandle = await verify();
    expect(noHandle.body.error_code).toBe('AR000005');
    const other = await verify({
      challengeId: 'ch-1',
      credential: credential({ userHandle: isoBase64URL.fromUTF8String('user-1') }),
    });
    expect(other.status).toBe(200);
    expect(pm.createAccountAuthContext).toHaveBeenCalled();
    pm.resolvePasskeyRoute.mockResolvedValue({ legacyUserId: 'user-9' });
    const moved = await verify({
      challengeId: 'ch-1',
      credential: credential({ userHandle: isoBase64URL.fromUTF8String('user-1') }),
    });
    expect(moved.body.error_code).toBe('AR000005');
  });

  it('fails when the stored credential id is empty', async () => {
    pm.passkeyRepo.findByCredentialId.mockResolvedValueOnce(storedPasskey({ credential_id: '' }));
    const res = await verify();
    expect(res.status).toBe(500);
    expect(pm.webauthn.verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  it('verifies against the stored key, the consumed challenge and the origin', async () => {
    pm.passkeyRepo.findByCredentialId.mockResolvedValueOnce(storedPasskey());
    await verify();
    expect(pm.webauthn.verifyAuthenticationResponse).toHaveBeenCalledWith({
      response: credential(),
      expectedChallenge: 'expected-challenge',
      expectedOrigin: 'https://login.example.com',
      expectedRPID: 'login.example.com',
      credential: {
        id: credentialId,
        publicKey: new TextEncoder().encode('public-key'),
        counter: 7,
      },
      requireUserVerification: true,
    });
  });

  it('reports a verification that throws and one that fails', async () => {
    pm.passkeyRepo.findByCredentialId.mockResolvedValue(storedPasskey());
    pm.webauthn.verifyAuthenticationResponse.mockRejectedValueOnce(new Error('bad sig'));
    const thrown = await verify();
    expect(thrown.body.error_code).toBe('AR000005');
    pm.webauthn.verifyAuthenticationResponse.mockResolvedValueOnce({
      verified: false,
      authenticationInfo: { newCounter: 8 },
    });
    const failed = await verify();
    expect(failed.body.error_code).toBe('AR000005');
    expect(failureCodes()).toEqual([
      'passkey-auth:verification_exception',
      'passkey-auth:verification_failed',
    ]);
    expect(pm.advanceState).not.toHaveBeenCalled();
    expect(pm.sessionStore.createSessionRpc).not.toHaveBeenCalled();
  });
});
