import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  redirectWithError: vi.fn(),
  resolveAccountData: vi.fn(),
  validateActingAs: vi.fn(),
  publishEvent: vi.fn(),
  consentItems: vi.fn(),
  processDecisions: vi.fn(),
  answerRelease: vi.fn(),
}));

vi.mock('../authorize', () => ({
  redirectWithError: m.redirectWithError,
  answerFormPostAsData: vi.fn(),
  formPostAnsweredAsData: (c: { req: { header: (name: string) => string | undefined } }) =>
    c.req.header('x-authrim-relay') === 'structured',
}));
vi.mock('../consent-release', () => ({
  answerInformationRelease: m.answerRelease,
  loadInformationReleaseScreen: vi.fn(),
}));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  publishEvent: m.publishEvent,
  getConsentItemsForScreen: m.consentItems,
  ssoConsentStatementsForTarget: vi.fn(async () => []),
  resolveStatementRequirements: vi.fn(async () => []),
  processConsentItemDecisions: m.processDecisions,
  resolveClientTrustPolicy: vi.fn(async () => null),
  resolveAccountDataContextFromHono: m.resolveAccountData,
  validateActingAsRelationship: m.validateActingAs,
}));

import { consentPostHandler } from '../consent';
import {
  createConsentChallengeStore,
  createConsentContext,
  createConsentDB,
} from './helpers/mut-session-consent-context';

const METADATA = {
  response_type: 'code',
  client_id: 'test-client',
  redirect_uri: 'https://rp.example.com/cb',
  scope: 'openid profile',
  state: 'st-1',
};

function challengeWith(
  metadata: Record<string, unknown> = METADATA,
  extra: Record<string, unknown> = {}
) {
  return createConsentChallengeStore({
    id: 'ch-1',
    type: 'consent',
    userId: 'user-123',
    metadata,
    ...extra,
  });
}

async function post(
  body: Record<string, unknown>,
  options: Partial<Parameters<typeof createConsentContext>[0]> = {}
) {
  const challengeStore = options.challengeStore ?? challengeWith();
  const c = createConsentContext({
    challengeStore,
    ...options,
    body: { challenge_id: 'ch-1', ...body },
  });
  const response = await consentPostHandler(c as never);
  const text = await response.clone().text();
  let json: Record<string, unknown> | undefined;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = undefined;
  }
  return { c, response, status: response.status, json, challengeStore };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.publishEvent.mockResolvedValue(undefined);
  m.consentItems.mockResolvedValue([]);
  m.processDecisions.mockResolvedValue(undefined);
  m.answerRelease.mockResolvedValue({ ok: true, approval: [], decision: null });
  m.validateActingAs.mockResolvedValue({ valid: false });
  m.resolveAccountData.mockImplementation(
    async (c: { get: (key: string) => unknown }, userId: string) => ({
      ...(c.get('accountDataContext') as object),
      accountId: userId,
      legacyUserId: userId,
    })
  );
});

afterEach(() => {
  vi.useRealTimers();
});

const INVALID_CHALLENGE = {
  error: 'invalid_request',
  error_description: 'Invalid or expired challenge',
};

describe('consent POST challenge handling', () => {
  it('refuses an approval whose challenge names no client, without consuming it', async () => {
    const challengeStore = challengeWith({ ...METADATA, client_id: '' });
    const res = await post({ approved: true }, { challengeStore });
    expect([res.status, res.json]).toEqual([400, INVALID_CHALLENGE]);
    expect(challengeStore._stub.consumeChallengeRpc).not.toHaveBeenCalled();
  });

  it('answers 503 when the consent withdrawal generation cannot be read', async () => {
    m.resolveAccountData.mockRejectedValueOnce(new Error('route down'));
    const res = await post({ approved: true });
    expect([res.status, res.json]).toEqual([
      503,
      {
        error: 'temporarily_unavailable',
        error_description: 'Consent state is temporarily unavailable',
      },
    ]);
    expect(res.challengeStore._stub.consumeChallengeRpc).not.toHaveBeenCalled();
  });

  it('asks to refresh, without consuming, when the release shown has changed', async () => {
    m.answerRelease.mockResolvedValueOnce({ ok: false, reason: 'changed' });
    const res = await post(
      { approved: true },
      { challengeStore: challengeWith(METADATA, { expiresAt: Date.now() + 60_000 }) }
    );
    expect(res.status).toBe(409);
    expect(res.json?.error_details).toEqual({ refresh_consent: true });
    expect(res.challengeStore._stub.consumeChallengeRpc).not.toHaveBeenCalled();
  });

  it('refuses a challenge that can no longer be consumed', async () => {
    const challengeStore = challengeWith();
    challengeStore._stub.consumeChallengeRpc.mockRejectedValueOnce(new Error('gone'));
    const res = await post({ approved: false }, { challengeStore });
    expect([res.status, res.json]).toEqual([400, INVALID_CHALLENGE]);
  });
});

describe('consent POST denial', () => {
  it('returns the redirect URI with access_denied and state, and announces the denial', async () => {
    const res = await post({ approved: false });
    const url = new URL(res.json?.redirect_url as string);
    expect(url.origin + url.pathname).toBe('https://rp.example.com/cb');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      error: 'access_denied',
      error_description: 'User denied the consent request',
      state: 'st-1',
    });
    expect(m.publishEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: 'consent.denied',
        data: { userId: 'user-123', clientId: 'test-client', scopes: ['openid', 'profile'] },
      })
    );
  });

  it('sends a denial to the cancel_uri, without state when there is none', async () => {
    const res = await post(
      { approved: false },
      {
        challengeStore: challengeWith({
          ...METADATA,
          state: undefined,
          cancel_uri: 'https://rp.example.com/cancel',
        }),
      }
    );
    const url = new URL(res.json?.redirect_url as string);
    expect(url.pathname).toBe('/cancel');
    expect(url.searchParams.has('state')).toBe(false);
  });

  it('answers a form_post denial as a redirect URL unless the relay asks for data', async () => {
    const challengeStore = challengeWith({ ...METADATA, response_mode: 'form_post' });
    const res = await post({ approved: false }, { challengeStore });
    expect(res.json?.redirect_url).toContain('error=access_denied');
    expect(m.redirectWithError).not.toHaveBeenCalled();
  });

  it('does not answer a query-mode denial as data even for the relay', async () => {
    const res = await post({ approved: false }, { headers: { 'X-Authrim-Relay': 'structured' } });
    expect(res.json?.redirect_url).toContain('error=access_denied');
    expect(m.redirectWithError).not.toHaveBeenCalled();
  });

  it('treats a *.jwt response mode as JARM and needs the client id', async () => {
    const challengeStore = challengeWith({
      ...METADATA,
      response_mode: 'query.jwt',
      client_id: undefined,
    });
    const res = await post({ approved: false }, { challengeStore });
    expect([res.status, res.json]).toEqual([
      500,
      {
        error: 'server_error',
        error_description: 'Unable to create JWT-secured authorization error response',
      },
    ]);
  });

  it('describes unavailable JARM settings', async () => {
    const challengeStore = challengeWith({ ...METADATA, response_mode: 'jwt' });
    const SETTINGS = { get: vi.fn().mockRejectedValue(new Error('kv down')) };
    const res = await post({ approved: false }, { challengeStore, env: { SETTINGS } });
    expect([res.status, res.json]).toEqual([
      503,
      {
        error: 'temporarily_unavailable',
        error_description: 'Security profile settings are temporarily unavailable',
      },
    ]);
  });

  it('returns the JARM response itself when it has no Location', async () => {
    const page = new Response('<form>', { status: 200 });
    m.redirectWithError.mockResolvedValueOnce(page);
    const challengeStore = challengeWith({ ...METADATA, response_mode: 'form_post.jwt' });
    const res = await post({ approved: false }, { challengeStore });
    expect(res.response).toBe(page);
    expect(m.redirectWithError).toHaveBeenCalledWith(
      expect.anything(),
      'https://rp.example.com/cb',
      'access_denied',
      'User denied the consent request',
      'st-1',
      expect.objectContaining({
        responseMode: 'form_post.jwt',
        clientId: 'test-client',
        isUserCancellation: true,
      })
    );
  });
});

describe('consent POST acting-as', () => {
  const forbidden = {
    error: 'access_denied',
    error_description: 'Acting-as consent is not permitted',
  };

  it('refuses acting-as when the feature is off', async () => {
    const res = await post({ approved: true, acting_as_user_id: 'user-9' });
    expect([res.status, res.json]).toEqual([403, forbidden]);
  });

  it('refuses acting-as without a valid relationship', async () => {
    const res = await post(
      { approved: true },
      {
        challengeStore: challengeWith({ ...METADATA, acting_as: 'user-9' }),
        env: { ENABLE_RBAC_CONSENT_ACTING_AS: 'true' },
      }
    );
    expect([res.status, res.json]).toEqual([403, forbidden]);
    expect(m.validateActingAs).toHaveBeenCalledWith(
      expect.anything(),
      'user-123',
      'user-9',
      'default'
    );
  });
});

describe('consent POST granular scopes', () => {
  const env = { CONSENT_GRANULAR_SCOPES: 'true' };

  it('describes a selection without openid', async () => {
    const res = await post({ approved: true, selected_scopes: ['profile'] }, { env });
    expect([res.status, res.json]).toEqual([
      400,
      {
        error: 'invalid_request',
        error_description: 'The openid scope is required and cannot be deselected',
      },
    ]);
  });

  it('refuses a selection with nothing that was requested', async () => {
    const res = await post(
      { approved: true, selected_scopes: ['openid'] },
      { env, challengeStore: challengeWith({ ...METADATA, scope: 'profile' }) }
    );
    expect([res.status, res.json]).toEqual([
      400,
      { error: 'invalid_request', error_description: 'At least one valid scope must be selected' },
    ]);
  });

  it('keeps every requested scope for an empty selection', async () => {
    const res = await post({ approved: true, selected_scopes: [] }, { env });
    expect(res.status).toBe(200);
    expect(m.answerRelease).toHaveBeenLastCalledWith(
      expect.objectContaining({ effectiveScopes: ['openid', 'profile'] })
    );
  });

  it('continues to the issuer default when ISSUER_URL is unset', async () => {
    const res = await post(
      { approved: true },
      { env: { ISSUER_URL: undefined }, db: createConsentDB() }
    );
    expect(res.json?.redirect_url).toMatch(/^https:\/\/authrim\.local\/authorize\?/);
  });
});
