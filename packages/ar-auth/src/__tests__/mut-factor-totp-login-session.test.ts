import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@authrim/ar-lib-core', async (importOriginal) =>
  (await import('./helpers/mut-factor-totp-harness')).libCoreMock(await importOriginal())
);
vi.mock('../registration-policy-gate', async (importOriginal) =>
  (await import('./helpers/mut-factor-totp-harness')).registrationGateMock(await importOriginal())
);
vi.mock('../flow-session-profile', async (importOriginal) =>
  (await import('./helpers/mut-factor-totp-harness')).flowSessionMock(await importOriginal())
);
vi.mock('../sign-in-attempt-recording', async (importOriginal) =>
  (await import('./helpers/mut-factor-totp-harness')).attemptRecordingMock(await importOriginal())
);
vi.mock('../account-provisioning', async (importOriginal) =>
  (await import('./helpers/mut-factor-totp-harness')).accountProvisioningMock(
    await importOriginal()
  )
);
vi.mock('../invitation-redemption', async (importOriginal) =>
  (await import('./helpers/mut-factor-totp-harness')).invitationMock(await importOriginal())
);
vi.mock('../direct-auth', async () => ({
  consumeAuthorizationChallengeContinuation: (await import('./helpers/mut-factor-totp-harness')).m
    .consumeContinuation,
}));
vi.mock('../human-verification', async () => ({
  verifyHumanVerificationForAction: (await import('./helpers/mut-factor-totp-harness')).m
    .verifyHumanVerification,
}));
vi.mock('../lite-mode', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lite-mode')>()),
  readLiteMode: (await import('./helpers/mut-factor-totp-harness')).m.readLiteMode,
}));
vi.mock('../registration-field-utils', async (importOriginal) => {
  const { m } = await import('./helpers/mut-factor-totp-harness');
  return {
    ...(await importOriginal<typeof import('../registration-field-utils')>()),
    validateRegistrationFieldSubmissionFromEnv: m.validateFields,
    persistRegistrationFieldValuesFromEnv: m.persistFields,
    buildCanonicalProfileRuntimeUserFields: m.buildProfileFields,
  };
});

import { InteractionChallengeMismatchError } from '@authrim/ar-lib-core';
import * as totp from '../totp';
import {
  ENABLED,
  createEnv,
  createTotpApp,
  m,
  overrides,
  postJson,
  resetHarness,
} from './helpers/mut-factor-totp-harness';
import { credentialRow, currentCode, encryptedSecret } from './helpers/mut-factor-totp-fixtures';

const app = createTotpApp(totp);
const verify = (body: unknown, env = createEnv()) => postJson(app, '/verify', body, env);
const sessionMetadata = () =>
  m.sessionStore.createSessionRpc.mock.calls[0]?.[3] as Record<string, unknown>;

async function arrange(metadata: Record<string, unknown> = {}) {
  const { code } = await currentCode();
  m.challengeStore.consumeChallengeRpc.mockResolvedValueOnce({ userId: 'user-001', metadata });
  m.totpRepo.findActiveByUserId.mockResolvedValueOnce([credentialRow(await encryptedSecret())]);
  return code;
}

async function withFlowSession(change: Record<string, unknown>) {
  const actual =
    await vi.importActual<typeof import('../flow-session-profile')>('../flow-session-profile');
  overrides.sessionForChallenge = (async (
    ...args: Parameters<typeof actual.sessionForChallenge>
  ) => ({
    ...(await actual.sessionForChallenge(...args)),
    ...change,
  })) as never;
}

describe('TOTP login verify: the session it makes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-23T00:00:00Z'));
    resetHarness();
  });
  afterEach(() => vi.useRealTimers());

  it('answers the session, the user and the tenant redirect', async () => {
    const code = await arrange();
    const res = await verify({ challenge_id: 'c', code });
    const now = Date.now();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      sessionId: 'g1:apac:3:session_new',
      session: {
        userId: 'user-001',
        createdAt: now,
        authTime: Math.floor(now / 1000),
        acr: 'urn:authrim:aal:2',
        amr: ['otp', 'totp'],
      },
      user: { id: 'user-001', email: 'person@example.com', name: 'Person' },
      redirect_url: '/',
    });
    const session = res.body.session as { expiresAt: number; createdAt: number };
    expect(session.expiresAt - session.createdAt).toBe((res.body.expires_in as number) * 1000);
    expect(res.body).not.toHaveProperty('authorization');
    expect(sessionMetadata()).not.toHaveProperty('runtime_interaction_id');
    expect(m.publishEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        data: {
          userId: 'user-001',
          method: 'totp',
          clientId: 'totp-auth',
          sessionId: 'g1:apac:3:session_new',
        },
      })
    );
    expect(m.createAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: 'user-001',
        action: 'user.login',
        resource: 'session',
        userAgent: 'unknown',
        metadata: JSON.stringify({ method: 'totp', credential_id: 'totp-001' }),
      })
    );
    const cookies = res.headers.get('Set-Cookie') ?? '';
    expect(cookies).toContain(
      `authrim_session=${encodeURIComponent('g1:apac:3:session_new')}; Max-Age=${String(res.body.expires_in)}; Path=/; HttpOnly; Secure`
    );
  });

  it('uses the trimmed tenant default ACR', async () => {
    const code = await arrange();
    const res = await verify(
      { challenge_id: 'c', code },
      createEnv({ ...ENABLED, 'authentication-methods.totp.default_acr': ' urn:x ' })
    );
    expect(sessionMetadata().acr).toBe('urn:x');
    expect((res.body.session as { acr: string }).acr).toBe('urn:x');
  });

  it('keeps the Flow interaction on the session', async () => {
    await withFlowSession({ interactionId: 'int-3' });
    const code = await arrange();
    await verify({ challenge_id: 'c', code });
    expect(sessionMetadata().runtime_interaction_id).toBe('int-3');
  });

  it('refuses when the Flow does not take TOTP', async () => {
    await withFlowSession({ allowed: false });
    const code = await arrange();
    const res = await verify({ challenge_id: 'c', code });
    expect(res.status).toBe(403);
    expect(res.body.error_code).toBe('AR050006');
    expect(res.body).toMatchObject({ authentication_method: 'totp', usage: 'login' });
    expect(m.sessionStore.createSessionRpc).not.toHaveBeenCalled();
  });

  it('answers an interaction started for another request as a mismatch', async () => {
    overrides.sessionForChallenge = async () => {
      throw new InteractionChallengeMismatchError();
    };
    const code = await arrange();
    const res = await verify({ challenge_id: 'c', code });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('authorization_challenge_mismatch');
  });

  it('answers 503 when the session settings cannot be read', async () => {
    overrides.sessionForChallenge = async () => {
      throw new Error('settings down');
    };
    const code = await arrange();
    const res = await verify({ challenge_id: 'c', code });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: 'temporarily_unavailable',
      error_description: 'Session settings are unavailable.',
    });
  });

  it('passes the presented authorization challenge to the Flow session', async () => {
    const seen: unknown[] = [];
    overrides.sessionForChallenge = async (...args: unknown[]) => {
      seen.push(args[5]);
      throw new Error('stop');
    };
    const code = await arrange();
    await verify({ challenge_id: 'c', code });
    const again = await arrange();
    await verify({ challenge_id: 'c', code: again, authorization_challenge_id: 'ac-1' });
    expect(seen).toEqual([null, 'ac-1']);
  });

  it('continues the authorization challenge it was presented with', async () => {
    const code = await arrange({ authorization_challenge_id: 'ac-1' });
    const res = await verify({ challenge_id: 'c', code, authorization_challenge_id: 'ac-1' });
    expect(m.consumeContinuation).toHaveBeenCalledWith(
      expect.anything(),
      'default',
      'ac-1',
      'user-001',
      Math.floor(Date.now() / 1000),
      'http://localhost',
      'totp',
      Date.now()
    );
    expect(res.body).toMatchObject({
      authorization: { challenge_id: 'ac-1', type: 'login' },
      redirect_url: 'https://rp.example.com/callback?code=abc',
    });
    expect(m.resolvePostLoginRedirectUrl).not.toHaveBeenCalled();
  });

  it('returns a continuation error before making a session', async () => {
    const code = await arrange();
    m.consumeContinuation.mockResolvedValueOnce({ error: new Response('x', { status: 410 }) });
    const res = await verify({ challenge_id: 'c', code, authorization_challenge_id: 'ac-1' });
    expect(res.status).toBe(410);
    expect(m.sessionStore.createSessionRpc).not.toHaveBeenCalled();
  });

  it('defers the continuation only for true', async () => {
    const code = await arrange();
    const res = await verify({
      challenge_id: 'c',
      code,
      authorization_challenge_id: 'ac-1',
      defer_authorization_continuation: true,
    });
    expect(m.consumeContinuation).not.toHaveBeenCalled();
    expect(res.body).not.toHaveProperty('authorization');
    const again = await arrange();
    await verify({
      challenge_id: 'c',
      code: again,
      authorization_challenge_id: 'ac-1',
      defer_authorization_continuation: 1,
    });
    expect(m.consumeContinuation).toHaveBeenCalledTimes(1);
  });

  it('still answers when mirroring the state, the event or the audit fails', async () => {
    const code = await arrange();
    m.totpRepo.markUsed.mockRejectedValueOnce(new Error('down'));
    m.publishEvent.mockRejectedValue(new Error('down'));
    m.createAuditLog.mockRejectedValueOnce(new Error('down'));
    const res = await verify({ challenge_id: 'c', code });
    expect(res.status).toBe(200);
    expect(res.waitUntil).toHaveBeenCalledTimes(2);
    await expect(
      Promise.all(res.waitUntil.mock.calls.map((call) => call[0] as unknown))
    ).resolves.toEqual([undefined, undefined]);
  });

  it('answers a write fence on the session as retryable', async () => {
    const code = await arrange();
    m.sessionStore.createSessionRpc.mockRejectedValueOnce(
      new Error('tenant_placement_migration_write_fenced')
    );
    const res = await verify({ challenge_id: 'c', code });
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('1');
    const again = await arrange();
    m.sessionStore.createSessionRpc.mockRejectedValueOnce(new Error('boom'));
    const failed = await verify({ challenge_id: 'c', code: again });
    expect(failed.body.error_code).toBe('AR900001');
  });
});
