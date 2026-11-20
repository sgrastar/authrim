/**
 * The statements a step asks consent to, at its submit (persistRuntimeConsentStep and
 * recordRuntimeConsent): a step without them, consent before anyone signed in, another user's
 * session, an interaction another user took, and the evidence recorded with it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mocks } from './helpers/mut-runtime2-mocks';
import { txExecuteCalls } from './helpers/mut-runtime2-requests';
import {
  flowOf,
  sessionOf,
  signedInteraction,
  submit,
  type Signed,
} from './helpers/mut-runtime2-submit-rows';

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

const statements = [{ statement_id: 'statement_terms', required: true }];
const consentStep = (config: Record<string, unknown> = { statements }) => ({
  id: 'consent:step',
  source_node_id: 'consent',
  component: 'consent_policy',
  render: true,
  config,
});
const selector = (component: string) => ({
  id: 'auth:step',
  source_node_id: 'auth',
  component,
  render: true,
  config: { statements },
});
const complete = { id: 'complete:step', source_node_id: 'complete', component: 'completion' };
const agreed = { input: { consent_item_decisions: { statement_terms: 'granted' } } };

describe('the statements of a step, at its submit', () => {
  let signed: Signed;
  beforeEach(async () => {
    signed = await signedInteraction();
    mocks.statementFake.seed({ id: 'statement_terms' });
  });

  it('refuses a consent step that asks for no statement', async () => {
    const { response, data } = await submit(signed, {
      runtime: flowOf(consentStep({}), complete),
      current: 'consent',
      session: sessionOf(),
    });
    expect(response.status).toBe(409);
    expect(data).toEqual({
      error: 'invalid_consent_policy',
      error_description: 'No consent statements are configured for this Flow step',
      error_code: 'AR_FLOW_CONSENT_POLICY_MISSING',
      category: 'configuration_error',
      action: 'contact_administrator',
      interaction_id: 'interaction_1',
    });
  });

  it('records consent on a consent step only for someone signed in', async () => {
    const { response, data } = await submit(
      signed,
      { runtime: flowOf(consentStep(), complete), current: 'consent' },
      agreed
    );
    expect(response.status).toBe(401);
    expect(data).toEqual({
      error: 'authentication_required',
      error_description: 'Consent can only be recorded after authentication',
      error_code: 'AR_FLOW_CONSENT_AUTH_REQUIRED',
      category: 'reauthentication_required',
      action: 'reauthenticate',
      interaction_id: 'interaction_1',
    });
    expect(mocks.processConsentItemDecisions).not.toHaveBeenCalled();
  });

  it.each(['authentication_method_selector', 'registration_method_selector'])(
    'holds consent given on a %s before anyone signed in',
    async (component) => {
      const { response } = await submit(
        signed,
        { runtime: flowOf(selector(component), complete), current: 'auth' },
        { ...agreed, selected_handle: 'passkey' }
      );
      expect(response.status).toBe(200);
      expect(mocks.processConsentItemDecisions).not.toHaveBeenCalled();
    }
  );

  it("refuses another user's session on an interaction about someone", async () => {
    const { response, data } = await submit(
      signed,
      {
        runtime: flowOf(consentStep(), complete),
        current: 'consent',
        userId: 'user_2',
        session: sessionOf('user_1'),
      },
      agreed
    );
    expect(response.status).toBe(403);
    expect(data).toEqual({
      error: 'access_denied',
      error_description: 'The signed-in session does not belong to this interaction',
      error_code: 'AR_FLOW_SESSION_USER_MISMATCH',
      category: 'security_error',
      action: 'restart_interaction',
      interaction_id: 'interaction_1',
    });
    expect(mocks.processConsentItemDecisions).not.toHaveBeenCalled();
  });

  it('records nothing when another user took the interaction first', async () => {
    mocks.coreAdapter.execute.mockImplementation(async (sql: string) => ({
      success: true,
      rowsAffected: String(sql).includes('SET user_id = ?, updated_at = ?') ? 0 : 1,
    }));
    const { response, data } = await submit(
      signed,
      { runtime: flowOf(consentStep(), complete), current: 'consent', session: sessionOf() },
      agreed
    );
    expect(response.status).toBe(403);
    expect(data.error_code).toBe('AR_FLOW_SESSION_USER_MISMATCH');
    expect(mocks.processConsentItemDecisions).not.toHaveBeenCalled();
  });

  it('records the consent of the user signed in, with the hash of the address', async () => {
    const { response } = await submit(
      signed,
      { runtime: flowOf(consentStep(), complete), current: 'consent', session: sessionOf() },
      agreed
    );
    expect(response.status).toBe(200);
    const claim = mocks.coreAdapter.execute.mock.calls.find(([sql]) =>
      String(sql).includes('SET user_id = ?, updated_at = ?')
    );
    expect(claim?.[1]).toEqual(['user_1', expect.any(Number), 'tenant_test', 'interaction_1']);
    const call = mocks.processConsentItemDecisions.mock.calls[0] as unknown[];
    expect(call[2]).toBe('user_1');
    expect(call[3]).toEqual({ statement_terms: 'granted' });
    // No address given: none recorded, nor its hash.
    expect(call[4]).toMatchObject({ ip_address: undefined });
    expect(call[5]).toBeUndefined();
  });

  it('records a hash of the address the request came from', async () => {
    const { response } = await submit(
      signed,
      {
        runtime: flowOf(consentStep(), complete),
        current: 'consent',
        session: sessionOf(),
        headers: { 'X-Forwarded-For': '203.0.113.9', 'User-Agent': 'agent/2' },
      },
      agreed
    );
    expect(response.status).toBe(200);
    const call = mocks.processConsentItemDecisions.mock.calls[0] as unknown[];
    expect(call[4]).toMatchObject({ ip_address: '203.0.113.9', user_agent: 'agent/2' });
    expect(call[5]).toEqual(expect.any(String));
    expect(call[5]).not.toContain('203.0.113.9');
  });

  it('records, for each statement, only its latest answer held from before sign-in', async () => {
    mocks.statementFake.seed({ id: 'statement_news' });
    const optional = {
      ...selector('authentication_method_selector'),
      config: { statements: [{ statement_id: 'statement_news', required: false }] },
    };
    const runtime = flowOf(optional, complete);
    // Held at the method choice, before anyone signed in.
    await submit(
      signed,
      { runtime, current: 'auth' },
      {
        selected_handle: 'passkey',
        input: { consent_item_decisions: { statement_news: 'granted' } },
      }
    );
    const kept = txExecuteCalls
      .flatMap(([, params]) => params ?? [])
      .find((value) => typeof value === 'string' && value.includes('"held_consent"'));
    const held = (JSON.parse(String(kept)) as { held_consent: Record<string, unknown> })
      .held_consent;
    const row = (id: string, givenAtMs: number, decision: string) => ({
      id,
      step_id: 'auth:step',
      state_json: JSON.stringify({
        held_consent: {
          ...held,
          given_at_ms: givenAtMs,
          decisions: { statement_news: { decision, selectedValue: null } },
        },
      }),
    });
    mocks.processConsentItemDecisions.mockClear();

    const now = Date.now();
    mocks.coreAdapter.query.mockImplementation(async (sql: string) =>
      String(sql).includes('held_consent')
        ? // The earlier answer read first: the later one still stands.
          [row('row_early', now - 2000, 'rejected'), row('row_late', now - 1000, 'accepted')]
        : []
    );
    const { response } = await submit(signed, {
      runtime,
      current: 'complete',
      session: sessionOf(),
    });
    expect(response.status).toBe(200);
    expect(mocks.processConsentItemDecisions).toHaveBeenCalledTimes(1);
    const call = mocks.processConsentItemDecisions.mock.calls[0] as unknown[];
    expect(call[3]).toEqual({ statement_news: 'granted' });
    expect(call[7]).toMatchObject({ givenAtMs: now - 1000 });
  });
});
