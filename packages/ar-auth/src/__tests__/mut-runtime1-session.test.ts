/**
 * Which browser session stands for an interaction: the email-verified session of a sign-up
 * (getRecentVerifiedEmailSessionUserId), and the session a session check step continues with.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowRuntimeContract } from '@authrim/ar-lib-core';
import {
  clearLoginRuntimeFlowVersionCacheForTests,
  getRecentVerifiedEmailSessionUserId,
  loginRuntimeInteractionStartHandler,
} from '../login-runtime-flow';
import {
  challenge,
  createContext,
  mocks,
  assignmentRow,
  versionRow,
  readJson,
  resetHarness,
} from './helpers/mut-runtime1-harness';

vi.mock('@authrim/ar-lib-core', async (importOriginal) =>
  (await import('./helpers/mut-runtime1-harness')).libCoreMock(await importOriginal())
);
vi.mock('@authrim/ar-lib-core/services/log-iceberg-emitter', async (importOriginal) =>
  (await import('./helpers/mut-runtime1-harness')).icebergMock(await importOriginal())
);
vi.mock('../direct-auth', async (importOriginal) =>
  (await import('./helpers/mut-runtime1-harness')).directAuthMock(await importOriginal())
);

const NOW_MS = 1_800_000_000_000;
const NOW = NOW_MS / 1000;

beforeEach(() => {
  resetHarness();
  clearLoginRuntimeFlowVersionCacheForTests();
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
});
afterEach(() => vi.restoreAllMocks());

describe('the email-verified session of a sign-up', () => {
  const session = (data: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
    userId: 'user_1',
    expiresAt: NOW_MS + 60_000,
    createdAt: NOW_MS - 5_000,
    data: { amr: ['email_code'], runtime_interaction_id: 'fi_1', authTime: NOW - 5, ...data },
    ...extra,
  });
  const user = (extra: Record<string, unknown> = {}) => ({
    id: 'user_1',
    active: 1,
    email_verified: 1,
    email: 'ada@example.test',
    ...extra,
  });

  async function verifiedUser(
    headers: Record<string, string> = { Cookie: 'a=1; authrim_session=sess_1' }
  ) {
    return getRecentVerifiedEmailSessionUserId(
      createContext({ headers }),
      'tenant_1',
      NOW - 60,
      'fi_1'
    );
  }

  it('is the user of a session that proved the email in this interaction', async () => {
    mocks.sessionStore.getSessionRpc.mockResolvedValueOnce(session());
    mocks.runtimeUsers.findById.mockResolvedValueOnce(user());
    await expect(verifiedUser()).resolves.toBe('user_1');
    expect(mocks.sessionStore.getSessionRpc).toHaveBeenCalledWith('sess_1');
    expect(mocks.runtimeUsers.findById).toHaveBeenCalledWith('user_1', { includeInactive: true });
  });

  it('is read from a bearer session too, and with the email verification protocol', async () => {
    mocks.sessionStore.getSessionRpc.mockResolvedValueOnce(
      session({ amr: [7, 'email_verification_protocol'] })
    );
    mocks.runtimeUsers.findById.mockResolvedValueOnce(user());
    await expect(verifiedUser({ Authorization: 'Bearer sess_2' })).resolves.toBe('user_1');
    expect(mocks.sessionStore.getSessionRpc).toHaveBeenCalledWith('sess_2');
  });

  it.each([
    ['no session', {}],
    ['a session id that is not sharded', { Cookie: 'authrim_session=plain' }],
    ['a token that is not a bearer one', { Authorization: 'Basic sess_2' }],
  ])('is nobody with %s', async (_label, headers) => {
    await expect(verifiedUser(headers)).resolves.toBeNull();
    expect(mocks.sessionStore.getSessionRpc).not.toHaveBeenCalled();
  });

  it.each([
    ['an expired session', session({}, { expiresAt: NOW_MS })],
    ['a session without an email proof', session({ amr: ['pwd'] })],
    ['a session whose methods are not a list', session({ amr: 'email_code' })],
    ['a session of another interaction', session({ runtime_interaction_id: 'fi_2' })],
    ['a sign-in before the sign-up began', session({ authTime: NOW - 61 })],
    ['a sign-in dated in the future', session({ authTime: NOW + 61 })],
    [
      'a sign-in dated by an old session',
      session({ authTime: undefined }, { createdAt: NOW_MS - 120_000 }),
    ],
  ])('is nobody for %s', async (_label, stored) => {
    mocks.sessionStore.getSessionRpc.mockResolvedValueOnce(stored);
    mocks.runtimeUsers.findById.mockResolvedValue(user());
    await expect(verifiedUser()).resolves.toBeNull();
  });

  it('accepts a sign-in right at the edges of its window', async () => {
    for (const authTime of [NOW - 60, NOW + 60]) {
      mocks.sessionStore.getSessionRpc.mockResolvedValueOnce(session({ authTime }));
      mocks.runtimeUsers.findById.mockResolvedValueOnce(user());
      await expect(verifiedUser()).resolves.toBe('user_1');
    }
  });

  it.each([
    ['an inactive user', user({ active: 0 })],
    ['an unverified email', user({ email_verified: 0 })],
    ['no email', user({ email: null })],
    ['no user', null],
  ])('is nobody for %s', async (_label, found) => {
    mocks.sessionStore.getSessionRpc.mockResolvedValueOnce(session());
    mocks.runtimeUsers.findById.mockResolvedValueOnce(found);
    await expect(verifiedUser()).resolves.toBeNull();
  });

  it('is nobody for an inactive account, and fails on any other account error', async () => {
    mocks.sessionStore.getSessionRpc.mockResolvedValue(session());
    mocks.resolveAccountDataContextFromHono.mockRejectedValueOnce(
      new Error('lookup_destination_revalidation_failed', { cause: 'account_inactive' })
    );
    await expect(verifiedUser()).resolves.toBeNull();
    mocks.resolveAccountDataContextFromHono.mockRejectedValueOnce(
      new Error('lookup_destination_revalidation_failed', { cause: 'other' })
    );
    await expect(verifiedUser()).rejects.toThrow('lookup_destination_revalidation_failed');
    expect(mocks.runtimeUsers.findById).not.toHaveBeenCalled();
  });
});

describe('the session a session check continues with', () => {
  const steps = (flowKind: string): FlowRuntimeContract => ({
    flow_kind: flowKind as FlowRuntimeContract['flow_kind'],
    ui: {
      steps: [
        {
          id: 'session:step',
          source_node_id: 'session',
          component: 'session_check',
          render: false,
        },
        {
          id: 'signed-in:step',
          source_node_id: 'signed-in',
          component: 'consent_policy',
          render: true,
        },
        {
          id: 'sign-in:step',
          source_node_id: 'sign-in',
          component: 'consent_policy',
          render: true,
        },
      ],
    },
  });
  const editor = {
    nodes: [],
    edges: [
      { id: 'c', source: 'session', target: 'signed-in', source_handle: 'continue' },
      { id: 'a', source: 'session', target: 'sign-in', source_handle: 'authenticate' },
    ],
  };

  async function startWith(
    stored: Record<string, unknown> | null,
    options: { flowKind?: string; challengeId?: boolean } = {}
  ) {
    if (options.challengeId) {
      mocks.challengeStore.getChallengeRpc.mockResolvedValueOnce(challenge());
      mocks.coreAdapter.queryOne.mockResolvedValueOnce(null);
    }
    clearLoginRuntimeFlowVersionCacheForTests();
    mocks.idQueue.splice(0, mocks.idQueue.length, 'interaction_1', 'step_1', 'audit_1', 'audit_2');
    const flowKind = options.flowKind ?? 'login';
    mocks.coreAdapter.queryOne
      .mockResolvedValueOnce(assignmentRow({ flow_kind: flowKind }))
      .mockResolvedValueOnce(versionRow(steps(flowKind), editor));
    if (stored) {
      mocks.sessionStore.getSessionRpc.mockResolvedValueOnce({
        userId: 'user_1',
        expiresAt: NOW_MS + 60_000,
        createdAt: NOW_MS - 1_000,
        ...stored,
        data: { authTime: NOW, ...(stored.data as Record<string, unknown> | undefined) },
      });
    }
    const response = await loginRuntimeInteractionStartHandler(
      createContext({
        body: {
          flow_kind: options.flowKind ?? 'login',
          ...(options.challengeId
            ? { client_id: 'client_1', authorization_challenge_id: 'login_challenge_1' }
            : {}),
        },
        headers: { Cookie: 'authrim_session=sess_1' },
      })
    );
    const data = await readJson(response);
    return {
      status: response.status,
      data,
      at: (data.interaction as { current_step_id?: string } | undefined)?.current_step_id,
    };
  }

  it('continues with a session from before the sign-in began (single sign-on)', async () => {
    expect((await startWith({})).at).toBe('signed-in:step');
  });

  it('asks to sign in without a session, or with one of nobody', async () => {
    expect((await startWith(null)).at).toBe('sign-in:step');
    expect((await startWith({ userId: '' })).at).toBe('sign-in:step');
  });

  it('takes a session made since the start only when it was made in this interaction', async () => {
    const later = { createdAt: NOW_MS + 1_000 };
    expect(
      (await startWith({ ...later, data: { runtime_interaction_id: 'interaction_1' } })).at
    ).toBe('signed-in:step');
    expect((await startWith({ ...later, data: { runtime_interaction_id: 'other' } })).at).toBe(
      'sign-in:step'
    );
    // A route that does not record its interaction is taken while the Flow sets no profile.
    expect((await startWith({ ...later, data: { runtime_interaction_id: '' } })).at).toBe(
      'signed-in:step'
    );
  });

  it('takes for a registration only a session made since it began', async () => {
    expect((await startWith({}, { flowKind: 'registration' })).at).toBe('sign-in:step');
    expect(
      (
        await startWith(
          { createdAt: NOW_MS + 1_000, data: { runtime_interaction_id: 'interaction_1' } },
          { flowKind: 'registration' }
        )
      ).at
    ).toBe('signed-in:step');
  });

  describe('for an authorization request', () => {
    const withChallenge = { challengeId: true };

    it('ends the interaction when the request is gone', async () => {
      mocks.readAuthorizationChallengeFreshness.mockResolvedValue({ gone: true });
      const { status, data } = await startWith(null, withChallenge);
      expect(status).toBe(409);
      expect(data).toMatchObject({
        error: 'authorization_request_expired',
        error_code: 'AR_FLOW_TERMINAL',
      });
      expect(mocks.readAuthorizationChallengeFreshness).toHaveBeenCalledWith(
        expect.anything(),
        'tenant_test',
        'login_challenge_1'
      );
    });

    it('asks the browser again when the request cannot be read', async () => {
      mocks.readAuthorizationChallengeFreshness.mockRejectedValue(new Error('down'));
      const { status, data } = await startWith({}, withChallenge);
      expect(status).toBe(503);
      expect(data).toMatchObject({
        error: 'temporarily_unavailable',
        error_code: 'AR_FLOW_CHALLENGE_UNAVAILABLE',
      });
    });

    it('continues for the user the request was continued for, and no other', async () => {
      mocks.readAuthorizationChallengeFreshness.mockResolvedValue({ confirmedFor: 'user_1' });
      expect((await startWith({}, withChallenge)).at).toBe('signed-in:step');
      clearLoginRuntimeFlowVersionCacheForTests();
      mocks.readAuthorizationChallengeFreshness.mockResolvedValue({ confirmedFor: 'user_2' });
      expect((await startWith({}, withChallenge)).at).toBe('sign-in:step');
    });

    it('continues a re-authentication only for its subject, proven by a method', async () => {
      const reauth = { kind: 'reauth', subjectUserId: 'user_1' };
      mocks.readAuthorizationChallengeFreshness.mockResolvedValue(reauth);
      expect((await startWith({ data: { amr: ['pwd'] } }, withChallenge)).at).toBe('sign-in:step');
      clearLoginRuntimeFlowVersionCacheForTests();
      mocks.readAuthorizationChallengeFreshness.mockResolvedValue({
        ...reauth,
        subjectUserId: 'user_2',
      });
      expect(
        (await startWith({ data: { amr: ['otp'], reauth_method: 'email_otp' } }, withChallenge)).at
      ).toBe('sign-in:step');
    });
  });
});
