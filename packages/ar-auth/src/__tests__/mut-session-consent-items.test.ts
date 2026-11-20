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

type Rec = Record<string, unknown>;
const argOf = (fn: { mock: { calls: unknown[][] } }, call: number, index: number) =>
  fn.mock.calls[call][index] as Rec;

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

function item(id: string, extra: Record<string, unknown> = {}) {
  return {
    statement_id: id,
    slug: id,
    category: 'terms_of_service',
    legal_basis: 'consent',
    title: id,
    description: id,
    version: '20260620',
    version_id: `ver-${id}`,
    is_required: false,
    enforcement: 'block',
    needs_version_upgrade: false,
    show_deletion_link: false,
    checkbox_mode: 'required',
    checkbox_default_checked: false,
    withdrawal_allowed: true,
    display_order: 1,
    ...extra,
  };
}

function versionsOf(items: Array<{ statement_id: string; version_id: string }>) {
  return Object.fromEntries(
    items.map((i) => [i.statement_id, { version_id: i.version_id, content_hash: null }])
  );
}

async function approveWith(
  items: ReturnType<typeof item>[],
  body: Record<string, unknown> = {},
  options = {}
) {
  m.consentItems.mockResolvedValue(items);
  return post({ approved: true, consent_item_versions: versionsOf(items), ...body }, options);
}

describe('consent item decisions', () => {
  it('grants a notice-only item by default and denies an unanswered checkbox', async () => {
    const items = [item('notice', { checkbox_mode: 'none' }), item('optional')];
    const res = await approveWith(items, { consent_item_decisions: { optional: 'maybe' } });
    expect(res.status).toBe(200);
    expect(m.processDecisions.mock.calls[0][3]).toEqual({ notice: 'granted', optional: 'denied' });
    const types = m.publishEvent.mock.calls.map(([, event]) => (event as { type: string }).type);
    expect(types).toEqual(expect.arrayContaining(['consent.item_granted', 'consent.item_denied']));
  });

  it('refuses an approval that leaves a blocking required item ungranted', async () => {
    const res = await approveWith([item('terms', { is_required: true })], {
      consent_item_decisions: { terms: 'denied' },
    });
    expect([res.status, res.json]).toEqual([
      400,
      { error: 'consent_required', error_description: 'Required consent items must be granted' },
    ]);
    expect(m.processDecisions).not.toHaveBeenCalled();
  });

  it('accepts a denied required item that only warns', async () => {
    const res = await approveWith([item('terms', { is_required: true, enforcement: 'warn' })], {
      consent_item_decisions: { terms: 'denied' },
    });
    expect(res.status).toBe(200);
  });

  it('records the client IP and its hash with the decisions', async () => {
    await approveWith(
      [item('optional')],
      {},
      { headers: { 'CF-Connecting-IP': '203.0.113.9', 'User-Agent': 'ua' } }
    );
    const request = argOf(m.processDecisions, 0, 4);
    const ipHash = argOf(m.processDecisions, 0, 5) as unknown;
    expect(request).toEqual({
      ip_address: '203.0.113.9',
      user_agent: 'ua',
      client_id: 'test-client',
    });
    expect(typeof ipHash).toBe('string');
  });

  it('records no IP when the request carries none', async () => {
    await approveWith([item('optional')]);
    const request = argOf(m.processDecisions, 0, 4);
    const ipHash = argOf(m.processDecisions, 0, 5) as unknown;
    expect(request.ip_address).toBeUndefined();
    expect(ipHash).toBeUndefined();
  });

  it.each(['document_changed', 'statement_consent_transition_rejected'])(
    'reissues the consumed challenge when recording fails with %s',
    async (message) => {
      m.processDecisions.mockRejectedValueOnce(new Error(message));
      const res = await approveWith(
        [item('optional')],
        {},
        {
          challengeStore: challengeWith(METADATA, { expiresAt: Date.now() + 60_000 }),
        }
      );
      expect(res.status).toBe(409);
      expect(res.json?.error_details).toEqual({
        consent_challenge_id: expect.any(String) as unknown,
      });
    }
  );

  it('answers 503 when the backend cannot write statement consents atomically', async () => {
    m.processDecisions.mockRejectedValueOnce(
      new Error('statement_consent_atomic_backend_unsupported')
    );
    const res = await approveWith([item('optional')]);
    expect([res.status, res.json]).toEqual([
      503,
      {
        error: 'temporarily_unavailable',
        error_description: 'Statement consent writes are unavailable on this database backend',
      },
    ]);
  });

  it('fails when a blocking item could not be recorded, but not for optional ones', async () => {
    m.processDecisions.mockRejectedValueOnce(new Error('d1'));
    const blocking = await approveWith([item('terms', { is_required: true })], {
      consent_item_decisions: { terms: 'granted' },
    });
    expect([blocking.status, blocking.json]).toEqual([
      500,
      { error: 'server_error', error_description: 'Failed to record required consent items' },
    ]);
    m.processDecisions.mockRejectedValueOnce(new Error('d1'));
    const optional = await approveWith([item('optional')]);
    expect(optional.status).toBe(200);
  });
});

describe('consent approval record', () => {
  function consentInsertArgs(db: ReturnType<typeof createConsentDB>) {
    const calls = (db._statement.bind as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    return calls.find(
      (args) => args.length > 15 && args[1] === 'user-123' && args[2] === 'test-client'
    );
  }

  it('sets the expiry from the default lifetime when expiration is on', async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ['Date'] });
    const db = createConsentDB();
    const res = await post(
      { approved: true },
      { db, env: { CONSENT_EXPIRATION_ENABLED: 'true', CONSENT_DEFAULT_EXPIRATION_DAYS: '30' } }
    );
    expect(res.status).toBe(200);
    const args = consentInsertArgs(db);
    expect(args?.[5]).toBe(1_800_000_000_000);
    expect(args?.[6]).toBe(1_800_000_000_000 + 30 * 24 * 60 * 60 * 1000);
  });

  it('sets no expiry when expiration is on without a lifetime', async () => {
    const db = createConsentDB();
    await post({ approved: true }, { db, env: { CONSENT_EXPIRATION_ENABLED: 'true' } });
    expect(consentInsertArgs(db)?.[6]).toBeNull();
  });

  it('answers server_error for an unexpected failure', async () => {
    m.answerRelease.mockRejectedValueOnce(new Error('boom'));
    const res = await post({ approved: true });
    expect([res.status, res.json]).toEqual([
      500,
      { error: 'server_error', error_description: 'Failed to process consent' },
    ]);
  });
});
