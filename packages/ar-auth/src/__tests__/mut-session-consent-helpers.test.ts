import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getSessionRpc: vi.fn(),
  storeChallengeRpc: vi.fn(),
  getChallengeStoreByChallengeId: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  getSessionStoreBySessionId: vi.fn(() => ({ stub: { getSessionRpc: m.getSessionRpc } })),
  getChallengeStoreByChallengeId: m.getChallengeStoreByChallengeId,
}));
vi.mock('../authorize', () => ({
  redirectWithError: vi.fn(),
  answerFormPostAsData: vi.fn(),
  formPostAnsweredAsData: () => false,
}));

import {
  changedConsentDocument,
  consentPostHandler,
  consentRecordsUnavailable,
  statementSnapshotsMatch,
  validateConsentSessionBinding,
} from '../consent';
import { StatementConsentAccountReadError } from '@authrim/ar-lib-core';

const SESSION = 'g1:apac:3:session_user_123';
const DENIED = {
  error: 'access_denied',
  error_description: 'Consent approval requires the bound authenticated session',
};

function ctx(headers: Record<string, string> = {}) {
  return {
    req: {
      header: (name: string) => headers[name],
      json: vi.fn(async () => ({})),
    },
    env: {},
    get: (key: string) => (key === 'tenantId' ? 'default' : undefined),
    json: vi.fn((body: unknown, status?: number) => Response.json(body, { status: status ?? 200 })),
  } as never;
}

async function bodyOf(response: Response | null) {
  return response
    ? { status: response.status, body: await response.json<Record<string, unknown>>() }
    : null;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.getSessionRpc.mockResolvedValue({ userId: 'user-1', expiresAt: Date.now() + 60_000 });
  m.getChallengeStoreByChallengeId.mockResolvedValue({ storeChallengeRpc: m.storeChallengeRpc });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('validateConsentSessionBinding', () => {
  const challenge = (sessionId: unknown) => ({
    userId: 'user-1',
    metadata: { session_id: sessionId } as never,
  });
  const cookie = { Cookie: `theme=dark; authrim_session=${encodeURIComponent(SESSION)}` };

  it('accepts the bound live session of the same user', async () => {
    expect(await validateConsentSessionBinding(ctx(cookie), challenge(SESSION))).toBeNull();
    expect(m.getSessionRpc).toHaveBeenCalledWith(SESSION);
  });

  it('refuses a challenge without a session binding', async () => {
    for (const sessionId of [undefined, '', 42]) {
      expect(
        await bodyOf(await validateConsentSessionBinding(ctx(cookie), challenge(sessionId)))
      ).toEqual({
        status: 401,
        body: DENIED,
      });
    }
    expect(m.getSessionRpc).not.toHaveBeenCalled();
  });

  it('refuses a missing, different or undecodable session cookie', async () => {
    for (const headers of [
      {},
      { Cookie: 'authrim_session=g1%3Aapac%3A3%3Asession_other' },
      { Cookie: 'authrim_session=%E0%A4%A' },
      { Cookie: `xauthrim_session=${encodeURIComponent(SESSION)}` },
    ] as Array<Record<string, string>>) {
      expect(
        await bodyOf(await validateConsentSessionBinding(ctx(headers), challenge(SESSION)))
      ).toEqual({
        status: 401,
        body: DENIED,
      });
    }
    expect(m.getSessionRpc).not.toHaveBeenCalled();
  });

  it('refuses a binding that is not a sharded session id', async () => {
    const response = await validateConsentSessionBinding(
      ctx({ Cookie: 'authrim_session=plain' }),
      challenge('plain')
    );
    expect(await bodyOf(response)).toEqual({ status: 401, body: DENIED });
  });

  it('refuses a session that is gone, of another user, or expired', async () => {
    for (const session of [
      null,
      { userId: 'user-2', expiresAt: Date.now() + 60_000 },
      { userId: 'user-1' },
      { userId: 'user-1', expiresAt: Date.now() - 1 },
    ]) {
      m.getSessionRpc.mockResolvedValueOnce(session);
      expect(
        await bodyOf(await validateConsentSessionBinding(ctx(cookie), challenge(SESSION)))
      ).toEqual({
        status: 401,
        body: DENIED,
      });
    }
  });

  it('refuses a session expiring exactly now', async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    m.getSessionRpc.mockResolvedValueOnce({ userId: 'user-1', expiresAt: 1_800_000_000_000 });
    expect(await validateConsentSessionBinding(ctx(cookie), challenge(SESSION))).not.toBeNull();
  });
});

describe('statementSnapshotsMatch', () => {
  const item = (id: string, version: string, hash?: string | null) =>
    ({ statement_id: id, version_id: version, content_hash: hash }) as never;

  it('matches nothing shown with nothing asked', () => {
    expect(statementSnapshotsMatch([], undefined)).toBe(true);
    expect(statementSnapshotsMatch([], {})).toBe(true);
  });

  it('matches the versions and hashes shown', () => {
    expect(
      statementSnapshotsMatch([item('a', 'v1', 'h1'), item('b', 'v2')], {
        a: { version_id: 'v1', content_hash: 'h1' },
        b: { version_id: 'v2', content_hash: null },
      })
    ).toBe(true);
  });

  it.each([
    ['nothing shown', undefined],
    ['an array', []],
    ['a different count', {}],
    ['a different version', { a: { version_id: 'v0', content_hash: 'h1' } }],
    ['a different hash', { a: { version_id: 'v1', content_hash: 'h2' } }],
    ['no hash field', { a: { version_id: 'v1' } }],
    ['an array entry', { a: [] }],
    ['a null entry', { a: null }],
    ['another statement', { b: { version_id: 'v1', content_hash: 'h1' } }],
  ])('does not match %s', (_name, displayed) => {
    expect(statementSnapshotsMatch([item('a', 'v1', 'h1')], displayed as never)).toBe(false);
  });
});

describe('changedConsentDocument', () => {
  const pending = (expiresAt?: number) => ({
    userId: 'user-1',
    expiresAt,
    metadata: { session_id: SESSION, client_id: 'app' } as never,
  });
  const message = 'Consent documents changed. Review the updated consent screen before submitting.';

  it('asks for a refresh when the challenge was not consumed', async () => {
    expect(
      await bodyOf(await changedConsentDocument(ctx(), pending(Date.now() + 5000), false))
    ).toEqual({
      status: 409,
      body: {
        error: 'document_changed',
        error_description: message,
        error_details: { refresh_consent: true },
      },
    });
    expect(m.storeChallengeRpc).not.toHaveBeenCalled();
  });

  it('reissues a consumed challenge for the rest of its lifetime', async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const expiresAt = 1_800_000_000_000 + 2_500;
    const result = await bodyOf(await changedConsentDocument(ctx(), pending(expiresAt), true));
    const stored = (m.storeChallengeRpc.mock.calls[0] as [{ id: string }])[0];
    expect(stored).toEqual({
      id: stored.id,
      tenantId: 'default',
      type: 'consent',
      userId: 'user-1',
      challenge: stored.id,
      ttl: 3,
      notAfterMs: expiresAt,
      metadata: { session_id: SESSION, client_id: 'app' },
    });
    expect(result?.body.error_details).toEqual({ consent_challenge_id: stored.id });
  });

  it('asks to restart when the consumed challenge has expired or has no expiry', async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    for (const expiresAt of [1_800_000_000_000, undefined, 1_800_000_000_000.5 + 10]) {
      const result = await bodyOf(await changedConsentDocument(ctx(), pending(expiresAt), true));
      expect(result?.body.error_details).toEqual({ restart_required: true });
    }
    expect(m.storeChallengeRpc).not.toHaveBeenCalled();
  });
});

describe('consent responses', () => {
  it('describes unavailable consent records', async () => {
    const response = consentRecordsUnavailable(
      ctx(),
      new StatementConsentAccountReadError(new Error('x'))
    );
    expect(await bodyOf(response)).toEqual({
      status: 503,
      body: {
        error: 'temporarily_unavailable',
        error_description: 'Consent records are temporarily unavailable',
      },
    });
  });

  it('refuses a consent POST that is not JSON', async () => {
    for (const headers of [{}, { 'Content-Type': 'application/x-www-form-urlencoded' }] as Array<
      Record<string, string>
    >) {
      expect(await bodyOf(await consentPostHandler(ctx(headers)))).toEqual({
        status: 400,
        body: {
          error: 'invalid_request',
          error_description: 'Content-Type must be application/json',
        },
      });
    }
  });
});
