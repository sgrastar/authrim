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

import * as passkey from '../passkey';
import {
  passkeyApp,
  passkeyEnv,
  pm,
  resetPasskeyHarness,
  send,
} from './helpers/mut-factor-passkey-harness';

const app = passkeyApp(passkey);
const INTERNAL = 'https://internal.example.net/login/options';
const env = (extra: Record<string, unknown> = {}, settings: Record<string, string | null> = {}) =>
  passkeyEnv(settings, { ISSUER_URL: 'https://issuer.example.net', ...extra });
const options = (headers: Record<string, string>, e = env(), url = INTERNAL) =>
  send(app, url, {}, e, headers);

describe('passkey login options: which origins may ask', () => {
  beforeEach(() => resetPasskeyHarness());

  it('refuses a request without an Origin', async () => {
    const res = await options({});
    expect(res.status).toBe(403);
    expect(res.body.error_code).toBe('AR050006');
    expect(pm.webauthn.generateAuthenticationOptions).not.toHaveBeenCalled();
  });

  it('refuses an origin that is neither configured, the request nor its host', async () => {
    const res = await options({ origin: 'https://evil.example', host: 'login.example.com' });
    expect(res.body.error_code).toBe('AR050006');
    expect(pm.challengeStore.storeChallengeRpc).not.toHaveBeenCalled();
  });

  it('allows the issuer origin when nothing else is configured', async () => {
    const res = await options({ origin: 'https://issuer.example.net' });
    expect(res.status).toBe(200);
  });

  it('allows an origin configured in the environment before the tenant setting', async () => {
    const res = await options(
      { origin: 'https://env.example.com' },
      env(
        { ALLOWED_ORIGINS: 'https://env.example.com' },
        {
          'settings:tenant:default:tenant': JSON.stringify({
            'tenant.allowed_origins': 'https://kv.example.com',
          }),
        }
      )
    );
    expect(res.status).toBe(200);
  });

  it('allows an origin from the tenant setting', async () => {
    const settings = {
      'settings:tenant:default:tenant': JSON.stringify({
        'tenant.allowed_origins': 'https://kv.example.com',
      }),
    };
    const allowed = await options({ origin: 'https://kv.example.com' }, env({}, settings));
    expect(allowed.status).toBe(200);
    const issuer = await options({ origin: 'https://issuer.example.net' }, env({}, settings));
    expect(issuer.status).toBe(403);
  });

  it('ignores a tenant setting that is not a string', async () => {
    const settings = {
      'settings:tenant:default:tenant': JSON.stringify({
        'tenant.allowed_origins': ['https://kv.example.com'],
      }),
    };
    const kv = await options({ origin: 'https://kv.example.com' }, env({}, settings));
    expect(kv.status).toBe(403);
    const issuer = await options({ origin: 'https://issuer.example.net' }, env({}, settings));
    expect(issuer.status).toBe(200);
  });

  it('allows the origin of the request itself', async () => {
    const res = await options({ origin: 'https://internal.example.net/' });
    expect(res.status).toBe(200);
  });

  it.each([
    ['an HTTPS origin of the Host', ' Login.Example.com ', 'https://login.example.com'],
    ['an HTTP origin of a localhost Host', 'localhost:8787', 'http://localhost:8787'],
    ['an HTTP origin of a loopback Host', '127.0.0.1:3000', 'http://127.0.0.1:3000'],
    ['an HTTPS origin of a localhost Host', 'localhost:8787', 'https://localhost:8787'],
  ])('allows %s', async (_label, host, origin) => {
    const res = await options({ origin, host });
    expect(res.status).toBe(200);
  });

  it.each([
    ['an HTTP origin of a public Host', 'login.example.com', 'http://login.example.com'],
    ['another port of the Host', 'login.example.com', 'https://login.example.com:8443'],
    [
      'an HTTP origin of a Host named like localhost',
      'localhost.example.com',
      'http://localhost.example.com',
    ],
  ])('refuses %s', async (_label, host, origin) => {
    const res = await options({ origin, host });
    expect(res.status).toBe(403);
  });
});

describe('passkey login options: the challenge', () => {
  beforeEach(() => resetPasskeyHarness());

  it('asks for a discoverable, user-verified credential and stores the challenge', async () => {
    const res = await options({ origin: 'https://issuer.example.net' });
    expect(pm.webauthn.generateAuthenticationOptions).toHaveBeenCalledWith({
      rpID: 'issuer.example.net',
      userVerification: 'required',
      allowCredentials: [],
    });
    expect(res.body.options).toEqual({
      challenge: 'generated-challenge',
      rpId: 'login.example.com',
      hints: ['hybrid', 'client-device', 'security-key'],
    });
    const challengeId = res.body.challengeId as string;
    expect(pm.challengeStore.storeChallengeRpc).toHaveBeenCalledWith({
      id: `passkey_auth:${challengeId}`,
      tenantId: 'default',
      type: 'passkey_authentication',
      userId: 'unknown',
      challenge: 'generated-challenge',
      ttl: 300,
    });
  });

  it('answers an internal error when the options cannot be made', async () => {
    pm.webauthn.generateAuthenticationOptions.mockRejectedValueOnce(new Error('boom'));
    const res = await options({ origin: 'https://issuer.example.net' });
    expect(res.status).toBe(500);
    expect(res.body.error_code).toBe('AR900001');
  });
});
