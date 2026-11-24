/**
 * What recordFlowStatementConsents hands to the statement consent transitions: which statements,
 * to which versions, with what evidence, and which earlier answers it leaves standing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { recordFlowStatementConsents } from '../login-runtime-flow';
import { mocks } from './helpers/mut-runtime2-mocks';
import { createContext, resetAdapter } from './helpers/mut-runtime2-requests';

vi.mock('@authrim/ar-lib-core/services/log-iceberg-emitter', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-core/services/log-iceberg-emitter')>()),
  emitLogIcebergRow: (await import('./helpers/mut-runtime2-mocks')).mocks.emitLog,
}));
vi.mock('@authrim/ar-lib-core', async (original) =>
  (await import('./helpers/mut-runtime2-mocks')).mockLibCore(await original())
);
vi.mock('../direct-auth', async (original) =>
  (await import('./helpers/mut-runtime2-mocks')).mockDirectAuth(await original())
);
vi.mock('../registration-policy-gate', async (original) =>
  (await import('./helpers/mut-runtime2-mocks')).mockRegistrationPolicyGate(await original())
);

function item(statementId: string) {
  return {
    statement_id: statementId,
    slug: statementId,
    category: 'marketing',
    title: statementId,
    description: '',
    document_url: null,
    inline_content: null,
    version: '20260701',
    version_id: `${statementId}_v1`,
    is_required: false,
    content_mode: 'checkbox' as const,
    options: [],
    attribute_value_display: null,
    checkbox_mode: 'optional' as const,
    checkbox_default_checked: false,
    text_display: null,
    require_scroll: null,
    binding_type: null,
    binding_value: null,
    evidence_profile: null,
    language_fallback: null,
    display_order: 0,
  };
}

function policyOf(...statementIds: string[]) {
  return {
    id: 'auth:step',
    display_name: '',
    description: null,
    language: 'en',
    default_language: 'en',
    items: statementIds.map(item),
  };
}

const accepted = { decision: 'accepted' as const, selectedValue: null };
const rejected = { decision: 'rejected' as const, selectedValue: null };

function record(
  input: Omit<Partial<Parameters<typeof recordFlowStatementConsents>[0]>, 'interaction'> & {
    interaction?: Record<string, unknown>;
  }
) {
  return recordFlowStatementConsents({
    c: createContext({}) as never,
    db: mocks.coreAdapter as never,
    tenantId: 'default',
    policy: policyOf('statement_news'),
    userId: 'user_1',
    decisions: { statement_news: accepted },
    ...input,
    interaction: (input.interaction ?? {
      id: 'interaction_1',
      client_id: 'client_1',
      saml_sp_id: null,
    }) as never,
  });
}

describe('recording the answers to the statements of a step', () => {
  beforeEach(async () => {
    await resetAdapter();
    mocks.statementFake.seed({ id: 'statement_news' });
    mocks.statementFake.seed({ id: 'statement_terms' });
  });

  it('records nothing, and reads no account, for a step without statements', async () => {
    await record({ policy: policyOf() });
    expect(mocks.resolveAccountDataContextFromHono).not.toHaveBeenCalled();
    expect(mocks.processConsentItemDecisions).not.toHaveBeenCalled();
  });

  it('records each answer to the version shown, with the evidence of the request', async () => {
    await record({
      policy: policyOf('statement_news', 'statement_terms'),
      decisions: { statement_news: accepted, statement_terms: rejected },
      ipAddress: '',
      ipHash: 'hash_1',
      userAgent: 'agent/1',
    });
    expect(mocks.resolveAccountDataContextFromHono).toHaveBeenCalledWith(
      expect.anything(),
      'user_1'
    );
    // Answered now: the current records are not read.
    expect(mocks.readStatementConsentRecord).not.toHaveBeenCalled();
    expect(mocks.processConsentItemDecisions).toHaveBeenCalledTimes(1);
    const [stores, tenantId, userId, decisions, evidence, ipHash, targets, options] = mocks
      .processConsentItemDecisions.mock.calls[0] as unknown as unknown[];
    expect(stores).toEqual({ metadata: mocks.coreAdapter, account: mocks.coreAdapter });
    expect(tenantId).toBe('default');
    expect(userId).toBe('user_1');
    expect(decisions).toEqual({ statement_news: 'granted', statement_terms: 'denied' });
    // An empty address is no address.
    expect(evidence).toEqual({
      ip_address: undefined,
      user_agent: 'agent/1',
      client_id: 'client_1',
    });
    expect(ipHash).toBe('hash_1');
    expect(targets).toEqual({
      statement_news: { version_id: 'statement_news_v1', version: '20260701' },
      statement_terms: { version_id: 'statement_terms_v1', version: '20260701' },
    });
    expect(options).toEqual({ env: expect.any(Object) as unknown });
  });

  it('names the SAML app when there is no OIDC app, and none for neither', async () => {
    await record({
      interaction: { id: 'interaction_1', client_id: null, saml_sp_id: 'sp_1' },
      ipAddress: '203.0.113.7',
    });
    expect(mocks.processConsentItemDecisions.mock.calls[0]?.[4]).toEqual({
      ip_address: '203.0.113.7',
      user_agent: undefined,
      client_id: 'sp_1',
    });
    await record({ interaction: { id: 'interaction_1', client_id: null, saml_sp_id: null } });
    expect(mocks.processConsentItemDecisions.mock.calls[1]?.[4]).toMatchObject({
      client_id: undefined,
    });
  });

  it('records a statement without an answer as declined', async () => {
    await record({ decisions: {} });
    expect(mocks.processConsentItemDecisions.mock.calls[0]?.[3]).toEqual({
      statement_news: 'denied',
    });
  });

  it('passes when a held answer was given, and records it over one from that same moment', async () => {
    const givenAtMs = Date.now() - 60_000;
    mocks.statementFake.answer('user_1', 'statement_news', {
      status: 'denied',
      updated_at: givenAtMs,
    });
    await record({ givenAtMs });
    expect(mocks.processConsentItemDecisions).toHaveBeenCalledTimes(1);
    expect((mocks.processConsentItemDecisions.mock.calls[0] as unknown[] | undefined)?.[7]).toEqual(
      {
        env: expect.any(Object) as unknown,
        givenAtMs,
      }
    );
    expect(mocks.statementFake.record('user_1', 'statement_news')?.status).toBe('granted');
  });

  it('records a held refusal over an earlier refusal (only an agreement is left standing)', async () => {
    const givenAtMs = Date.now() - 60_000;
    mocks.statementFake.answer('user_1', 'statement_news', {
      status: 'withdrawn',
      updated_at: givenAtMs - 60_000,
    });
    await record({ givenAtMs, heldBeforeSignIn: true, decisions: { statement_news: rejected } });
    expect(mocks.processConsentItemDecisions.mock.calls[0]?.[3]).toEqual({
      statement_news: 'denied',
    });
  });

  it('records a held agreement over an earlier agreement', async () => {
    const givenAtMs = Date.now() - 60_000;
    mocks.statementFake.answer('user_1', 'statement_news', {
      status: 'granted',
      updated_at: givenAtMs - 60_000,
    });
    await record({ givenAtMs, heldBeforeSignIn: true });
    expect(mocks.processConsentItemDecisions.mock.calls[0]?.[3]).toEqual({
      statement_news: 'granted',
    });
  });

  it('records only the statements not answered again since', async () => {
    const givenAtMs = Date.now() - 60_000;
    mocks.statementFake.answer('user_1', 'statement_news', {
      status: 'denied',
      updated_at: givenAtMs + 1,
    });
    await record({
      policy: policyOf('statement_news', 'statement_terms'),
      decisions: { statement_news: accepted, statement_terms: accepted },
      givenAtMs,
    });
    expect(mocks.processConsentItemDecisions.mock.calls[0]?.[3]).toEqual({
      statement_terms: 'granted',
    });
    expect(mocks.readStatementConsentRecord).toHaveBeenCalledTimes(2);
  });
});
