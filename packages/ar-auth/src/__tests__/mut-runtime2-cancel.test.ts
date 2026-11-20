/**
 * Cancelling a sign-in (interactions/<id>/cancel): the refusals it keeps as they are, those it
 * answers as a cancel not available, and the claim and write it is held under.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowRuntimeContract } from '@authrim/ar-lib-core';
import { loginRuntimeInteractionCancelHandler } from '../login-runtime-flow';
import { auditRows, mocks } from './helpers/mut-runtime2-mocks';
import {
  createContext,
  readJson,
  resetAdapter,
  startInteraction,
} from './helpers/mut-runtime2-requests';

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

const cancelRuntime: FlowRuntimeContract = {
  flow_kind: 'login',
  ui: {
    steps: [
      {
        id: 'auth:step',
        source_node_id: 'auth',
        component: 'authentication_method_selector',
        render: true,
        config: { on_cancel: 'error' },
      },
    ],
  },
};
const appRequest = {
  protocol: 'oidc',
  target_type: 'oidc_client',
  authorization_challenge_id: 'challenge_1',
  locale: 'en',
};
const loginChallenge = {
  tenantId: 'tenant_test',
  type: 'login',
  userId: 'anonymous',
  consumed: false,
  metadata: {
    client_id: 'rp-client',
    redirect_uri: 'https://rp.example.test/cb',
    state: 'xyz',
    response_type: 'code',
  },
};

type Started = { contract_hash: unknown; signature: unknown; expires_at: number };

async function started(): Promise<Started> {
  await resetAdapter();
  const { data } = await startInteraction({ flow_kind: 'login' }, cancelRuntime);
  await resetAdapter();
  return {
    contract_hash: data.contract_hash,
    signature: data.signature,
    expires_at: Number((data.interaction as Record<string, unknown>).expires_at),
  };
}

function storedRows(
  signed: Started,
  options: { state?: string; context?: Record<string, unknown>; version?: boolean } = {}
) {
  mocks.coreAdapter.queryOne.mockImplementation(async (sql: string) => {
    const text = String(sql);
    if (text.includes('SELECT state FROM flow_interactions')) return { state: 'completed' };
    if (text.includes('FROM flow_interactions')) {
      return {
        id: 'interaction_1',
        flow_id: 'flow_login',
        flow_version_id: 'fv_1',
        user_id: null,
        client_id: 'rp-client',
        saml_sp_id: null,
        state: options.state ?? 'active',
        current_node_id: 'auth',
        current_step_id: 'auth:step',
        context_json: JSON.stringify(options.context ?? appRequest),
        ...signed,
      };
    }
    if (text.includes('FROM flow_versions')) {
      return options.version === false
        ? null
        : {
            id: 'fv_1',
            flow_id: 'flow_login',
            schema_version: 'authrim.login_ui.contract.v1',
            runtime_snapshot_json: JSON.stringify(cancelRuntime),
            editor_snapshot_json: null,
            published_at: 1782770000,
          };
    }
    return undefined;
  });
  mocks.challengeStore.getChallengeRpc.mockResolvedValue(loginChallenge);
  mocks.challengeStore.consumeChallengeRpc.mockResolvedValue(loginChallenge);
}

async function cancel(signed: Started, body: Record<string, unknown> = {}) {
  const context = createContext({
    params: { interaction_id: 'interaction_1' },
    body: {
      step_id: 'auth:step',
      contract_hash: signed.contract_hash,
      signature: signed.signature,
      ...body,
    },
  }) as unknown as Record<string, unknown> & { req: Record<string, unknown> };
  context.get = (key: string) => (key === 'tenantId' ? 'tenant_test' : undefined);
  context.redirect = (url: string, status = 302) =>
    new Response(null, { status, headers: { Location: url } });
  context.req.raw = new Request('https://first.test.authrim.com/api/v1/login/interactions/x');
  const response = await loginRuntimeInteractionCancelHandler(context as never);
  return { response, data: await readJson(response) };
}

const notAvailable = {
  error: 'cancel_not_available',
  error_description: 'Cancelling is not available for this sign-in',
  error_code: 'AR_FLOW_CANCEL_NOT_AVAILABLE',
  category: 'recoverable',
  action: 'retry_step',
  interaction_id: 'interaction_1',
};
const releases = () =>
  mocks.coreAdapter.execute.mock.calls.filter(([sql]) =>
    String(sql).includes('SET submit_claim_id = NULL')
  );

describe('cancelling a sign-in', () => {
  let signed: Started;
  beforeEach(async () => {
    signed = await started();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps a step mismatch as it is', async () => {
    storedRows(signed);
    const { response, data } = await cancel(signed, { step_id: 'other:step' });
    expect(response.status).toBe(409);
    expect(data).toMatchObject({ error: 'step_mismatch', error_code: 'AR_FLOW_STEP_MISMATCH' });
  });

  it('answers an interaction that ended as a cancel not available, naming it', async () => {
    storedRows(signed, { state: 'completed' });
    const { response, data } = await cancel(signed);
    expect(response.status).toBe(409);
    expect(data).toEqual(notAvailable);
  });

  it('does not repeat the answer of a cancel once the interaction expired', async () => {
    storedRows(signed, {
      state: 'failed',
      context: { ...appRequest, cancel_answer: { redirect_url: 'https://rp.example.test/cb' } },
    });
    const realNow = Date.now.bind(Date);
    const late = (signed.expires_at + 10) * 1000 - realNow();
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + late);
    const { data } = await cancel(signed);
    expect(data).toEqual(notAvailable);
  });

  it('answers a configuration error when the published version is gone', async () => {
    storedRows(signed, { version: false });
    const { response, data } = await cancel(signed);
    expect(response.status).toBe(409);
    expect(data).toEqual({
      error: 'flow_version_unavailable',
      error_description: 'Published Flow version is unavailable',
      error_code: 'AR_FLOW_VERSION_UNAVAILABLE',
      category: 'configuration_error',
      action: 'contact_administrator',
      interaction_id: 'interaction_1',
    });
  });

  it('answers a cancel not available when the interaction ended before its claim', async () => {
    storedRows(signed);
    mocks.coreAdapter.execute.mockResolvedValueOnce({ success: true, rowsAffected: 0 });
    const { data } = await cancel(signed);
    expect(data).toEqual(notAvailable);
    expect(mocks.coreAdapter.batch).not.toHaveBeenCalled();
  });

  it('changes nothing while the authorization request cannot be read', async () => {
    storedRows(signed);
    mocks.challengeStore.getChallengeRpc.mockRejectedValue(new Error('store down'));
    const { response, data } = await cancel(signed);
    expect(response.status).toBe(503);
    expect(data).toEqual({
      error: 'temporarily_unavailable',
      error_description: 'The authorization request could not be checked',
    });
    expect(mocks.coreAdapter.batch).not.toHaveBeenCalled();
    expect(releases()).toHaveLength(1);
  });

  it('answers step_conflict for a write the database refused as concurrent', async () => {
    storedRows(signed);
    mocks.coreAdapter.batch.mockRejectedValueOnce(Object.assign(new Error('c'), { code: '40001' }));
    const { response, data } = await cancel(signed);
    expect(response.status).toBe(409);
    expect(data).toMatchObject({ error_code: 'AR_FLOW_STEP_CONFLICT' });
    expect(mocks.challengeStore.consumeChallengeRpc).not.toHaveBeenCalled();
    expect(releases()).toHaveLength(1);
  });

  it('answers step_conflict when the interaction moved before the write', async () => {
    storedRows(signed);
    mocks.coreAdapter.batch.mockResolvedValueOnce([{ success: true, rowsAffected: 0 }]);
    const { data } = await cancel(signed);
    expect(data).toMatchObject({ error_code: 'AR_FLOW_STEP_CONFLICT' });
    expect(mocks.challengeStore.consumeChallengeRpc).not.toHaveBeenCalled();
  });

  it('ends the interaction and its step under the claim, and records the cancel', async () => {
    storedRows(signed);
    const { response } = await cancel(signed);
    expect(response.status).toBe(200);
    const statements = mocks.coreAdapter.batch.mock.calls[0]?.[0] as Array<{
      sql: string;
      params: unknown[];
    }>;
    expect(statements[1]?.sql).toContain("SET state = 'failed', state_json = ?");
    expect(JSON.parse(String(statements[1]?.params[0]))).toEqual({
      cancelled_by_user: true,
      cancelled_at_ms: expect.any(Number) as unknown,
    });
    expect(releases()).toEqual([]);
    const failed = auditRows().find((row) => row.overview.action === 'flow.interaction.failed');
    expect(failed?.overview).toMatchObject({
      result: 'cancelled',
      reason_code: 'AR_FLOW_CANCELLED',
    });
    expect((failed?.row as Record<string, unknown>).node_id).toBe('auth');
  });
});
