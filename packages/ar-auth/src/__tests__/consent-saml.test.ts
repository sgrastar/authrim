/**
 * The consent screen for a SAML SP (consent-saml.ts): it shows what the SAML IdP put on the
 * challenge and decides the challenge with the answer (never uses it up), writing the decision
 * (a refusal too) under the generation it was asked under.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SamlReleaseConsentChallengeMetadata } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  decide: vi.fn<(request: Record<string, unknown>) => Promise<unknown>>(),
  record: vi.fn<(db: unknown, input: Record<string, unknown>) => Promise<unknown>>(),
  find: vi.fn(),
  items: vi.fn(),
  processItems: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    buildIssuerUrl: () => 'https://idp.example.com',
    getTenantIdFromContext: () => 'tenant-a',
    resolveAccountDataContextFromHono: vi.fn(async () => undefined),
    createAccountAuthContextFromHono: () => ({ coreAdapter: {} }),
    createPIIContextFromHono: () => ({ defaultPiiAdapter: {} }),
    getConsentUserInfo: vi.fn(async () => ({ id: 'user-1', email: 'u@example.edu' })),
    getChallengeStoreByChallengeId: vi.fn(async () => ({ decideChallengeRpc: mocks.decide })),
    findSamlSpReleaseConsent: mocks.find,
    recordSamlSpReleaseDecision: mocks.record,
    processConsentItemDecisions: mocks.processItems,
  };
});

vi.mock('../consent', () => ({
  loadConsentScreenItems: mocks.items,
  statementSnapshotsMatch: (items: unknown[], shown: unknown) =>
    items.length === 0 ? shown === undefined : shown !== undefined,
  changedConsentDocument: (c: { json: (body: unknown, status: number) => Response }) =>
    c.json({ error: 'document_changed' }, 409),
  consentRecordsUnavailable: (c: { json: (body: unknown, status: number) => Response }) =>
    c.json({ error: 'temporarily_unavailable' }, 503),
  statementConsentStores: () => ({}),
}));

vi.mock('../consent-release', () => ({ loadReleasePurpose: vi.fn(async () => undefined) }));

import { samlConsentGet, samlConsentPost } from '../consent-saml';

const NAMEID = '["nameid","urn:oasis:names:tc:SAML:2.0:nameid-format:persistent"]';
const MAIL = '["attribute","mail",null]';
const AFFILIATION = '["attribute","eduPersonAffiliation",null]';

function metadata(
  overrides: Partial<SamlReleaseConsentChallengeMetadata> = {}
): SamlReleaseConsentChallengeMetadata {
  return {
    protocol: 'saml',
    purpose: 'saml_release_consent',
    session_id: 'g1:apac:3:session-1',
    saml_request_id: '_request-1',
    saml_sp_entity_id: 'https://sp.example.edu/sp',
    idp_initiated: false,
    resume_path: '/saml/idp/sso?saml_request_id=_request-1',
    sp_name: 'Library',
    release: {
      items: [
        { key: NAMEID, kind: 'nameid', label: 'persistent', required: true, deferred: true },
        { key: MAIL, kind: 'attribute', label: 'Email', required: true, values: ['u@example.edu'] },
        {
          key: AFFILIATION,
          kind: 'attribute',
          label: 'Affiliation',
          required: false,
          values: ['member', 'student'],
        },
      ],
      show_values: true,
      ask: 'once',
      purpose_statement_id: null,
      presentation_key: 'key-1',
      consent_generation: 0,
    },
    ...overrides,
  };
}

function context() {
  return {
    env: {},
    get: () => undefined,
    set: () => undefined,
    req: { header: () => undefined },
    json: (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  } as never;
}

const challenge = (meta = metadata(), extra: Record<string, unknown> = {}) =>
  ({ userId: 'user-1', metadata: meta, ...extra }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.items.mockResolvedValue([]);
  mocks.find.mockResolvedValue(null);
  mocks.record.mockResolvedValue({ revision: 7 });
  mocks.decide.mockResolvedValue({ outcome: 'decided' });
});

describe('the SAML consent screen', () => {
  it('shows the SP and its items from the challenge, with no scopes or organisations', async () => {
    mocks.find.mockResolvedValue({ approved: [AFFILIATION], refused: false });
    const response = await samlConsentGet(context(), 'challenge-1', challenge());
    const body: {
      information_release: { items: unknown[]; presentation_key: string };
    } = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      protocol: 'saml',
      client: { client_id: 'https://sp.example.edu/sp', client_name: 'Library' },
      scopes: [],
      organizations: [],
    });
    expect(body.information_release.items).toEqual([
      { name: NAMEID, label: 'persistent', kind: 'nameid', required: true, deferred: true },
      { name: MAIL, label: 'Email', kind: 'attribute', required: true, value: 'u@example.edu' },
      {
        name: AFFILIATION,
        label: 'Affiliation',
        kind: 'attribute',
        required: false,
        previously_approved: true,
        value: ['member', 'student'],
      },
    ]);
    expect(body.information_release.presentation_key).toBe('key-1');
  });

  it('refuses a challenge that is not a well-formed SAML one', async () => {
    const response = await samlConsentGet(
      context(),
      'challenge-1',
      challenge({ ...metadata(), resume_path: 'https://evil.example/' })
    );
    expect(response.status).toBe(400);
  });

  it('decides an approval: the required items and the optional ones chosen', async () => {
    const response = await samlConsentPost(context(), 'challenge-1', challenge(), {
      approved: true,
      releaseSelected: [],
      releasePresentationKey: 'key-1',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      redirect_url: 'https://idp.example.com/saml/idp/sso?saml_request_id=_request-1',
    });
    expect(mocks.record.mock.calls[0][1]).toMatchObject({
      consentGeneration: 0,
      decision: { approved: [NAMEID, MAIL], declined: [AFFILIATION], refused: false },
    });
    expect(mocks.decide.mock.calls.at(-1)?.[0]).toMatchObject({
      id: 'challenge-1',
      type: 'consent',
      decision: { approved: true, approved_items: [NAMEID, MAIL], decision_revision: 7 },
    });
  });

  it('keeps a refusal: an earlier approval no longer answers the next request', async () => {
    await samlConsentPost(context(), 'challenge-1', challenge(), { approved: false });
    expect(mocks.record.mock.calls[0][1]).toMatchObject({
      decision: { approved: [], refused: true },
    });
    expect(mocks.decide.mock.calls.at(-1)?.[0]).toMatchObject({
      decision: { approved: false, decision_revision: 7 },
    });
  });

  it('writes nothing for an answer that lost the challenge to another one', async () => {
    mocks.decide.mockResolvedValue({ outcome: 'conflict' });
    const response = await samlConsentPost(context(), 'challenge-1', challenge(), {
      approved: true,
      releasePresentationKey: 'key-1',
    });
    expect(response.status).toBe(200);
    expect(mocks.decide).toHaveBeenCalledTimes(1);
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.processItems).not.toHaveBeenCalled();
  });

  it('claims the challenge before writing, then completes the claim with the revision', async () => {
    const order: string[] = [];
    mocks.decide.mockImplementation(async (request: { replaceOwn?: boolean }) => {
      order.push(request.replaceOwn ? 'complete' : 'claim');
      return { outcome: 'decided' };
    });
    mocks.record.mockImplementation(async () => {
      order.push('record');
      return { revision: 3 };
    });
    await samlConsentPost(context(), 'challenge-1', challenge(), {
      approved: true,
      releasePresentationKey: 'key-1',
    });
    expect(order).toEqual(['claim', 'record', 'complete']);
    expect(mocks.decide.mock.calls[0][0].decision).not.toHaveProperty('decision_revision');
    expect(mocks.decide.mock.calls[1][0]).toMatchObject({
      replaceOwn: true,
      decision: { decision_revision: 3 },
    });
  });

  it('takes the answer only for what was shown', async () => {
    const response = await samlConsentPost(context(), 'challenge-1', challenge(), {
      approved: true,
      releasePresentationKey: 'another-key',
    });
    expect(response.status).toBe(409);
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.decide).not.toHaveBeenCalled();
  });

  it('asks to start again when a withdrawal moved the generation on meanwhile', async () => {
    mocks.record.mockRejectedValue(new Error('saml_sp_release_consent_changed'));
    const response = await samlConsentPost(context(), 'challenge-1', challenge(), {
      approved: true,
      releasePresentationKey: 'key-1',
    });
    expect(response.status).toBe(409);
    // Claimed, never completed: the SAML request takes no approval from it.
    expect(mocks.decide).toHaveBeenCalledTimes(1);
  });

  it('sends the person back without writing again when the challenge is already decided', async () => {
    const response = await samlConsentPost(
      context(),
      'challenge-1',
      challenge(metadata(), { decision: { approved: true } }),
      { approved: false }
    );
    expect(response.status).toBe(200);
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.decide).not.toHaveBeenCalled();
  });

  it('refuses an approval with a required document not agreed to', async () => {
    mocks.items.mockResolvedValue([
      {
        statement_id: 'terms',
        version_id: 'v1',
        version: '1',
        content_hash: null,
        is_required: true,
        enforcement: 'block',
        checkbox_mode: 'required',
      },
    ]);
    const response = await samlConsentPost(context(), 'challenge-1', challenge(), {
      approved: true,
      releasePresentationKey: 'key-1',
      consentItemVersions: { terms: { version_id: 'v1', content_hash: null } },
      consentItemDecisions: { terms: 'denied' },
    });
    expect(response.status).toBe(400);
    expect(mocks.record).not.toHaveBeenCalled();
  });
});
