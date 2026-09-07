import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env, Session } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  isShardedSessionId: vi.fn(),
  getSession: vi.fn(),
  getSessionStoreBySessionId: vi.fn(),
  findById: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async () => {
  const actual =
    await vi.importActual<typeof import('@authrim/ar-lib-core')>('@authrim/ar-lib-core');
  return {
    ...actual,
    isShardedSessionId: mocks.isShardedSessionId,
    getSessionStoreBySessionId: mocks.getSessionStoreBySessionId,
    createAuthContextFromHono: () => ({ coreAdapter: {} }),
    createPIIContextFromHono: () => ({ defaultPiiAdapter: {} }),
    CanonicalRuntimeUserStore: class {
      findById = mocks.findById;
    },
  };
});

import {
  cibaLoginHintMatchesAuthenticatedUser,
  cibaRequestMatchesAuthenticatedUser,
  getAuthenticatedAsyncUser,
  type AuthenticatedAsyncUser,
} from '../authenticated-session';

const activeSession = {
  userId: 'user-1',
  expiresAt: Date.now() + 60_000,
} as Session;

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.get('/', async (c) => c.json(await getAuthenticatedAsyncUser(c, 'tenant-a')));
  return app;
}

describe('authenticated async session security', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isShardedSessionId.mockImplementation((value: string) => value.startsWith('s1_'));
    mocks.getSession.mockResolvedValue(activeSession);
    mocks.getSessionStoreBySessionId.mockReturnValue({
      stub: { getSessionRpc: mocks.getSession },
    });
    mocks.findById.mockResolvedValue({ id: 'user-1', active: 1, email: 'User@Example.com' });
  });

  it.each([
    ['no credential', {}, null],
    ['non-Bearer authorization', { Authorization: 'Basic abc' }, null],
    ['unsharded credential', { Authorization: 'Bearer legacy-session' }, null],
  ])('rejects %s', async (_label, headers, expected) => {
    const response = await createApp().request('http://localhost/', { headers }, {} as Env);
    expect(await response.json()).toBe(expected);
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it.each([
    ['cookie', { Cookie: 'authrim_session=s1_cookie' }, 's1_cookie'],
    ['session header', { 'X-Session-Id': 's1_header' }, 's1_header'],
    ['bearer header', { Authorization: 'Bearer s1_bearer' }, 's1_bearer'],
  ])('authenticates a valid %s credential', async (_label, headers, sessionId) => {
    const response = await createApp().request('http://localhost/', { headers }, {} as Env);
    expect(await response.json()).toEqual({
      userId: 'user-1',
      sub: 'user-1',
      email: 'User@Example.com',
    });
    expect(mocks.getSessionStoreBySessionId).toHaveBeenCalledWith(
      expect.anything(),
      sessionId,
      'tenant-a'
    );
    expect(mocks.findById).toHaveBeenCalledWith('user-1', { includeInactive: true });
  });

  it('does not fall back to a weaker header when a cookie is present', async () => {
    mocks.isShardedSessionId.mockImplementation((value: string) => value === 's1_header');
    const response = await createApp().request(
      'http://localhost/',
      {
        headers: {
          Cookie: 'authrim_session=invalid-cookie',
          'X-Session-Id': 's1_header',
        },
      },
      {} as Env
    );
    expect(await response.json()).toBeNull();
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it.each([
    ['missing session', null],
    ['expired session', { ...activeSession, expiresAt: Date.now() - 1 }],
  ])('rejects a %s', async (_label, session) => {
    mocks.getSession.mockResolvedValue(session);
    const response = await createApp().request(
      'http://localhost/',
      { headers: { 'X-Session-Id': 's1_session' } },
      {} as Env
    );
    expect(await response.json()).toBeNull();
    expect(mocks.findById).not.toHaveBeenCalled();
  });

  it.each([
    ['missing user', null],
    ['inactive user', { id: 'user-1', active: 0, email: 'user@example.com' }],
  ])('rejects a session for a %s', async (_label, user) => {
    mocks.findById.mockResolvedValue(user);
    const response = await createApp().request(
      'http://localhost/',
      { headers: { 'X-Session-Id': 's1_session' } },
      {} as Env
    );
    expect(await response.json()).toBeNull();
  });

  it('fails closed when session or user storage throws', async () => {
    mocks.getSession.mockRejectedValue(new Error('storage unavailable'));
    const response = await createApp().request(
      'http://localhost/',
      { headers: { 'X-Session-Id': 's1_session' } },
      {} as Env
    );
    expect(await response.json()).toBeNull();
  });

  it('normalizes an absent email to null', async () => {
    mocks.findById.mockResolvedValue({ id: 'user-1', active: 1 });
    const response = await createApp().request(
      'http://localhost/',
      { headers: { 'X-Session-Id': 's1_session' } },
      {} as Env
    );
    await expect(response.json()).resolves.toMatchObject({ email: null });
  });
});

describe('CIBA request ownership matching', () => {
  const user: AuthenticatedAsyncUser = {
    userId: 'user-1',
    sub: 'subject-1',
    email: 'User@Example.com',
  };

  it.each([
    [undefined, true],
    ['', true],
    ['sub:SUBJECT-1', true],
    ['user@example.com', true],
    ['subject-1', true],
    ['USER-1', true],
    ['sub:other', false],
    ['other@example.com', false],
    ['other-user', false],
  ])('matches login hint %s only to the authenticated identity', (hint, expected) => {
    expect(cibaLoginHintMatchesAuthenticatedUser(hint, user)).toBe(expected);
  });

  it('requires both a resolved subject and login hint to belong to the session', () => {
    expect(
      cibaRequestMatchesAuthenticatedUser(
        { resolved_subject_id: 'user-1', login_hint: 'user@example.com' },
        user
      )
    ).toBe(true);
    expect(
      cibaRequestMatchesAuthenticatedUser(
        { resolved_subject_id: 'victim', login_hint: 'user@example.com' },
        user
      )
    ).toBe(false);
  });
});
