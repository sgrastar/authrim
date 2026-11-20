import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SamlReleaseConsentChallengeMetadata } from '@authrim/ar-lib-core';

const m = vi.hoisted(() => ({
  decide: vi.fn(),
  record: vi.fn(),
  find: vi.fn(),
  items: vi.fn(),
  processItems: vi.fn(),
  user: vi.fn(),
  purpose: vi.fn(),
  changed: vi.fn(),
  hash: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  buildIssuerUrl: () => 'https://idp.example.com',
  getTenantIdFromContext: () => 'tenant-a',
  resolveAccountDataContextFromHono: vi.fn(async () => undefined),
  createAccountAuthContextFromHono: () => ({ coreAdapter: {} }),
  createPIIContextFromHono: () => ({ defaultPiiAdapter: {} }),
  getConsentUserInfo: m.user,
  getChallengeStoreByChallengeId: vi.fn(async () => ({ decideChallengeRpc: m.decide })),
  findSamlSpReleaseConsent: m.find,
  recordSamlSpReleaseDecision: m.record,
  processConsentItemDecisions: m.processItems,
  hashIpAddress: m.hash,
}));
vi.mock('../consent', () => ({
  loadConsentScreenItems: m.items,
  statementSnapshotsMatch: (items: unknown[], shown: unknown) =>
    items.length === 0 ? shown === undefined : shown !== undefined,
  changedConsentDocument: m.changed,
  consentRecordsUnavailable: (c: { json: (body: unknown, status: number) => Response }) =>
    c.json({ error: 'temporarily_unavailable' }, 503),
  statementConsentStores: () => ({ stores: true }),
}));
vi.mock('../consent-release', () => ({ loadReleasePurpose: m.purpose }));

import { samlConsentGet, samlConsentPost } from '../consent-saml';
import { StatementConsentAccountReadError } from '@authrim/ar-lib-core';

type Rec = Record<string, unknown>;
const argOf = (fn: { mock: { calls: unknown[][] } }, call: number, index: number) =>
  fn.mock.calls[call][index] as Rec;

const OPTIONAL = '["attribute","eduPersonAffiliation",null]';
const REQUIRED = '["attribute","mail",null]';
const RESUME = { redirect_url: 'https://idp.example.com/saml/idp/sso?saml_request_id=_r' };

function metadata(
  overrides: Partial<SamlReleaseConsentChallengeMetadata> = {}
): SamlReleaseConsentChallengeMetadata {
  return {
    protocol: 'saml',
    purpose: 'saml_release_consent',
    session_id: 'g1:apac:3:session-1',
    saml_request_id: '_r',
    saml_sp_entity_id: 'https://sp.example.edu/sp',
    idp_initiated: false,
    resume_path: '/saml/idp/sso?saml_request_id=_r',
    sp_name: 'Library',
    release: {
      items: [
        { key: REQUIRED, kind: 'attribute', label: 'Email', required: true },
        { key: OPTIONAL, kind: 'attribute', label: 'Affiliation', required: false },
      ],
      show_values: false,
      ask: 'once',
      purpose_statement_id: 'st-1',
      presentation_key: 'key-1',
      consent_generation: 2,
    },
    ...overrides,
  };
}

function context(headers: Record<string, string> = {}) {
  return {
    env: {},
    get: () => undefined,
    req: { header: (name: string) => headers[name] },
    json: (body: unknown, status = 200) => Response.json(body, { status }),
  } as never;
}

const challenge = (meta = metadata(), extra: Record<string, unknown> = {}) =>
  ({ userId: 'user-1', metadata: meta, ...extra }) as never;

async function read(response: Response) {
  return { status: response.status, body: await response.json<Record<string, unknown>>() };
}

const termsItem = (extra: Record<string, unknown> = {}) => ({
  statement_id: 'terms',
  version_id: 'v1',
  version: '1',
  content_hash: null,
  is_required: true,
  enforcement: 'block',
  checkbox_mode: 'required',
  withdrawal_allowed: true,
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  m.items.mockResolvedValue([]);
  m.find.mockResolvedValue(null);
  m.record.mockResolvedValue({ revision: 7 });
  m.decide.mockResolvedValue({ outcome: 'decided' });
  m.user.mockResolvedValue({ id: 'user-1' });
  m.purpose.mockResolvedValue(undefined);
  m.hash.mockResolvedValue('ip-hash');
  m.changed.mockImplementation(async (c: { json: (b: unknown, s: number) => Response }) =>
    c.json({ error: 'document_changed' }, 409)
  );
});

describe('samlConsentGet', () => {
  it('refuses a malformed challenge with the exact error', async () => {
    const response = await samlConsentGet(
      context(),
      'ch',
      challenge({ ...metadata(), resume_path: 'https://evil/' })
    );
    expect(await read(response)).toEqual({
      status: 400,
      body: { error: 'invalid_request', error_description: 'Invalid or expired challenge' },
    });
  });

  it('requires the user to exist', async () => {
    m.user.mockResolvedValueOnce(null);
    expect(await read(await samlConsentGet(context(), 'ch', challenge()))).toEqual({
      status: 401,
      body: { error: 'access_denied', error_description: 'Authentication required' },
    });
  });

  it('takes the language from ui_locales, else Accept-Language, else English', async () => {
    const languages: unknown[] = [];
    for (const [meta, headers] of [
      [metadata({ ui_locales: 'ja en' }), { 'Accept-Language': 'fr' }],
      [metadata(), { 'Accept-Language': 'fr-CA,en;q=0.5' }],
      [metadata(), {}],
    ] as const) {
      const { body } = await read(await samlConsentGet(context(headers), 'ch', challenge(meta)));
      languages.push(body.consent_language);
    }
    expect(languages).toEqual(['ja', 'fr', 'en']);
    expect(m.items.mock.calls[0][1]).toMatchObject({
      targetType: 'saml_sp',
      language: 'ja',
      defaultLanguage: 'en',
    });
    expect(m.purpose).toHaveBeenCalledWith(expect.anything(), 'tenant-a', 'st-1', 'ja', 'en');
  });

  it('answers 503 when the account records cannot be read, and fails on other errors', async () => {
    m.items.mockRejectedValueOnce(new StatementConsentAccountReadError(new Error('d1')));
    expect((await samlConsentGet(context(), 'ch', challenge())).status).toBe(503);
    m.items.mockRejectedValueOnce(new Error('other'));
    await expect(samlConsentGet(context(), 'ch', challenge())).rejects.toThrow('other');
  });

  it('shows no earlier approval after a refusal, and the purpose and logo when there are', async () => {
    m.find.mockResolvedValueOnce({ approved: [OPTIONAL], refused: true });
    m.purpose.mockResolvedValueOnce({ statement_id: 'st-1', version: '1', title: 'Why' });
    m.items.mockResolvedValueOnce([termsItem()]);
    const { body } = await read(
      await samlConsentGet(
        context(),
        'ch',
        challenge(metadata({ sp_logo_uri: 'https://sp/logo.png' }))
      )
    );
    const release = body.information_release as {
      items: Array<Record<string, unknown>>;
      purpose?: unknown;
    };
    expect(release.items[1]).toEqual({
      name: OPTIONAL,
      label: 'Affiliation',
      kind: 'attribute',
      required: false,
      previously_approved: false,
    });
    expect(release.purpose).toEqual({ statement_id: 'st-1', version: '1', title: 'Why' });
    expect(body.client).toEqual({
      client_id: 'https://sp.example.edu/sp',
      client_name: 'Library',
      logo_uri: 'https://sp/logo.png',
      is_trusted: false,
    });
    expect(body.consent_management_enabled).toBe(true);
    expect(m.find).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'tenant-a',
      userId: 'user-1',
      spEntityId: 'https://sp.example.edu/sp',
      consentGeneration: 2,
    });
  });

  it('shows no release, purpose or logo when there are none', async () => {
    const { body } = await read(
      await samlConsentGet(context(), 'ch', challenge(metadata({ release: undefined })))
    );
    expect(body).not.toHaveProperty('information_release');
    expect(body.client).not.toHaveProperty('logo_uri');
    expect(body.consent_management_enabled).toBe(false);
  });
});

describe('samlConsentPost', () => {
  const approve = (extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    samlConsentPost(context(headers), 'ch', challenge(), {
      approved: true,
      releasePresentationKey: 'key-1',
      ...extra,
    });

  it('sends an already decided challenge back to the SAML request', async () => {
    const response = await samlConsentPost(
      context(),
      'ch',
      challenge(metadata(), { decision: { approved: true } }),
      { approved: false }
    );
    expect(await read(response)).toEqual({ status: 200, body: RESUME });
  });

  it('claims a refusal with nothing approved or declined, and records every item declined', async () => {
    await samlConsentPost(context({ 'User-Agent': 'ua' }), 'ch', challenge(), { approved: false });
    expect(argOf(m.decide, 0, 0)).toEqual({
      id: 'ch',
      tenantId: 'tenant-a',
      type: 'consent',
      operationId: expect.any(String) as unknown,
      decision: {
        approved: false,
        approved_items: [],
        declined_items: [],
        decided_at: expect.any(Number) as unknown,
      },
    });
    expect(argOf(m.record, 0, 1)).toMatchObject({
      decision: {
        approved: [],
        declined: [REQUIRED, OPTIONAL],
        mode: 'once',
        basis: 'user',
        refused: true,
      },
      history: { userAgent: 'ua' },
    });
    expect(m.items).not.toHaveBeenCalled();
  });

  it('records no user agent when there is none', async () => {
    await approve();
    expect(argOf(m.record, 0, 1).history).toEqual({ userAgent: null });
  });

  it('asks to refresh, without consuming, when the documents or release changed', async () => {
    m.items.mockResolvedValueOnce([termsItem()]);
    expect((await approve()).status).toBe(409);
    expect((await approve({ releasePresentationKey: 'old' })).status).toBe(409);
    expect((m.changed.mock.calls as unknown[][]).map((call) => call[2])).toEqual([false, false]);
    expect(m.decide).not.toHaveBeenCalled();
  });

  it('describes a required document not agreed to, defaulting unanswered checkboxes to denied', async () => {
    m.items.mockResolvedValueOnce([termsItem()]);
    const response = await approve({
      consentItemVersions: { terms: {} },
      consentItemDecisions: { terms: 'maybe' },
    });
    expect(await read(response)).toEqual({
      status: 400,
      body: {
        error: 'consent_required',
        error_description: 'Required consent items must be granted',
      },
    });
  });

  it('grants notice-only and warning items, and records the decisions with the client IP', async () => {
    const items = [
      termsItem({ statement_id: 'notice', checkbox_mode: 'none' }),
      termsItem({ statement_id: 'warn', enforcement: 'warn' }),
      termsItem({ statement_id: 'optional', is_required: false, content_hash: 'h' }),
    ];
    m.items.mockResolvedValueOnce(items);
    const response = await approve(
      { consentItemVersions: {}, releaseSelected: [OPTIONAL] },
      { 'X-Forwarded-For': '203.0.113.4', 'User-Agent': 'ua' }
    );
    expect(await read(response)).toEqual({ status: 200, body: RESUME });
    expect(m.items.mock.calls[0][1]).toMatchObject({ language: 'en', defaultLanguage: 'en' });
    const [stores, tenant, user, decisions, request, ipHash, targets] = m.processItems.mock
      .calls[0] as [Rec, string, string, Rec, Rec, unknown, Record<string, Rec>];
    expect([stores, tenant, user]).toEqual([{ stores: true }, 'tenant-a', 'user-1']);
    expect(decisions).toEqual({ notice: 'granted', warn: 'denied', optional: 'denied' });
    expect(request).toEqual({
      ip_address: '203.0.113.4',
      user_agent: 'ua',
      client_id: 'https://sp.example.edu/sp',
    });
    expect(ipHash).toBe('ip-hash');
    expect(targets.optional).toEqual({
      version_id: 'v1',
      version: '1',
      content_hash: 'h',
      withdrawal_allowed: true,
    });
    expect(targets.notice.content_hash).toBeNull();
    expect(argOf(m.decide, 0, 0).decision).toMatchObject({
      approved_items: [REQUIRED, OPTIONAL],
      declined_items: [],
    });
  });

  it('records no IP when the request has none', async () => {
    m.items.mockResolvedValueOnce([termsItem({ is_required: false })]);
    await approve({ consentItemVersions: {} });
    const request = argOf(m.processItems, 0, 4);
    const ipHash = argOf(m.processItems, 0, 5) as unknown;
    expect(request.ip_address).toBeUndefined();
    expect(ipHash).toBeUndefined();
    expect(m.hash).not.toHaveBeenCalled();
  });

  it('refuses a challenge that is gone, and resumes after a conflict', async () => {
    m.decide.mockResolvedValueOnce({ outcome: 'gone' });
    expect((await read(await approve())).body).toEqual({
      error: 'invalid_request',
      error_description: 'Invalid or expired challenge',
    });
    m.decide.mockResolvedValueOnce({ outcome: 'conflict' });
    expect((await read(await approve())).body).toEqual(RESUME);
  });

  it.each(['document_changed', 'statement_consent_transition_rejected'])(
    'asks to refresh when recording the documents fails with %s',
    async (message) => {
      m.items.mockResolvedValueOnce([termsItem({ is_required: false })]);
      m.processItems.mockRejectedValueOnce(new Error(message));
      expect((await approve({ consentItemVersions: {} })).status).toBe(409);
      expect(m.changed.mock.calls[0][2]).toBe(false);
      expect(m.record).not.toHaveBeenCalled();
    }
  );

  it('answers 503 for unreadable records and 500 for other failures', async () => {
    m.items.mockRejectedValueOnce(new StatementConsentAccountReadError(new Error('d1')));
    expect((await approve()).status).toBe(503);
    m.items.mockResolvedValueOnce([termsItem({ is_required: false })]);
    m.processItems.mockRejectedValueOnce(new Error('d1'));
    expect(await read(await approve({ consentItemVersions: {} }))).toEqual({
      status: 500,
      body: { error: 'server_error', error_description: 'Failed to process consent' },
    });
  });

  it('describes a withdrawal that raced the answer', async () => {
    m.record.mockRejectedValueOnce(new Error('saml_sp_release_consent_changed'));
    expect(await read(await approve())).toEqual({
      status: 409,
      body: {
        error: 'consent_withdrawn',
        error_description:
          'Consent for this service changed while it was being answered. Start again.',
      },
    });
  });
});
