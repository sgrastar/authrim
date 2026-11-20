/**
 * The hold a submit takes on its interaction before it records anything (claimRuntimeSubmit), and
 * how it lets go of it (releaseRuntimeSubmitClaim).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearLoginRuntimeFlowVersionCacheForTests,
  loginRuntimeInteractionStartHandler,
  loginRuntimeInteractionSubmitHandler,
} from '../login-runtime-flow';
import {
  createContext,
  mocks,
  mockStart,
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

let signed: { contract_hash: string; signature: string; expires_at: number };
const contextJson = JSON.stringify({ protocol: 'direct', target_type: 'tenant' });

beforeEach(async () => {
  resetHarness();
  clearLoginRuntimeFlowVersionCacheForTests();
  if (!signed) {
    mockStart();
    const data = await readJson(
      await loginRuntimeInteractionStartHandler(createContext({ body: { flow_kind: 'login' } }))
    );
    signed = {
      contract_hash: String(data.contract_hash),
      signature: String(data.signature),
      expires_at: (data.interaction as { expires_at: number }).expires_at,
    };
    resetHarness();
  }
});
afterEach(() => vi.restoreAllMocks());

function interactionRow() {
  return {
    id: 'interaction_1',
    flow_id: 'flow_login',
    flow_version_id: 'fv_1',
    user_id: null,
    client_id: null,
    saml_sp_id: null,
    state: 'active',
    current_node_id: 'auth',
    current_step_id: 'auth:step',
    context_json: contextJson,
    contract_hash: signed.contract_hash,
    signature: signed.signature,
    expires_at: signed.expires_at,
  };
}

async function submit() {
  const response = await loginRuntimeInteractionSubmitHandler(
    createContext({
      params: { interaction_id: 'interaction_1' },
      body: {
        step_id: 'auth:step',
        node_id: 'auth',
        selected_handle: 'passkey',
        contract_hash: signed.contract_hash,
        signature: signed.signature,
      },
    })
  );
  return { status: response.status, data: await readJson(response) };
}

const claimCall = () => mocks.coreAdapter.execute.mock.calls[0] as [string, unknown[]];

describe('the hold of a submit', () => {
  it('is taken over the interaction as the submit read it', async () => {
    const nowSeconds = signed.expires_at - 600;
    vi.spyOn(Date, 'now').mockReturnValue(nowSeconds * 1000);
    mocks.coreAdapter.queryOne.mockResolvedValueOnce(interactionRow()).mockResolvedValue(null);
    await submit();
    const [sql, params] = claimCall();
    expect(sql).toContain('SET submit_claim_id = ?, submit_claim_expires_at = ?');
    expect(sql).toContain('context_json IS ?');
    expect(params).toEqual([
      expect.any(String),
      nowSeconds + 60,
      'tenant_test',
      'interaction_1',
      'auth:step',
      contextJson,
      signed.contract_hash,
      signed.signature,
      nowSeconds,
    ]);
  });

  it('compares the context null-safely on PostgreSQL', async () => {
    mocks.coreAdapter.getType.mockReturnValue('postgres');
    mocks.coreAdapter.queryOne.mockResolvedValueOnce(interactionRow()).mockResolvedValue(null);
    await submit();
    expect(claimCall()[0]).toContain('context_json IS NOT DISTINCT FROM ?');
  });

  it('answers step_conflict when a concurrent claim refused this one, and records nothing', async () => {
    mocks.coreAdapter.queryOne.mockResolvedValueOnce(interactionRow());
    mocks.coreAdapter.execute.mockRejectedValueOnce(
      Object.assign(new Error('could not serialize'), { code: '40001' })
    );
    const { status, data } = await submit();
    expect(status).toBe(409);
    expect(data).toMatchObject({
      error: 'step_conflict',
      error_code: 'AR_FLOW_STEP_CONFLICT',
      category: 'recoverable',
      action: 'retry_step',
      interaction_id: 'interaction_1',
    });
    expect(mocks.coreAdapter.execute).toHaveBeenCalledTimes(1);
    expect(mocks.coreAdapter.batch).not.toHaveBeenCalled();
  });

  it('lets any other failure of the claim through', async () => {
    mocks.coreAdapter.queryOne.mockResolvedValueOnce(interactionRow());
    mocks.coreAdapter.execute.mockRejectedValueOnce(
      Object.assign(new Error('boom'), { code: 'XX' })
    );
    await expect(submit()).rejects.toThrow('boom');
    mocks.coreAdapter.queryOne.mockResolvedValueOnce(interactionRow());
    mocks.coreAdapter.execute.mockRejectedValueOnce('not an error');
    await expect(submit()).rejects.toBe('not an error');
  });

  it.each([
    ['active', 409, 'step_conflict'],
    ['created', 409, 'step_conflict'],
    ['completed', 409, 'interaction_not_active'],
  ])('tells, when another holds it, a %s interaction apart', async (state, status, error) => {
    mocks.coreAdapter.queryOne
      .mockResolvedValueOnce(interactionRow())
      .mockResolvedValueOnce({ state });
    mocks.coreAdapter.execute.mockResolvedValueOnce({ success: true, rowsAffected: 0 });
    const result = await submit();
    expect(result.status).toBe(status);
    expect(result.data.error).toBe(error);
    expect(mocks.coreAdapter.queryOne).toHaveBeenLastCalledWith(
      'SELECT state FROM flow_interactions WHERE tenant_id = ? AND id = ?',
      ['tenant_test', 'interaction_1']
    );
  });

  it('answers interaction_not_active when the interaction is gone', async () => {
    mocks.coreAdapter.queryOne.mockResolvedValueOnce(interactionRow()).mockResolvedValueOnce(null);
    mocks.coreAdapter.execute.mockResolvedValueOnce({ success: true });
    const { data } = await submit();
    expect(data).toMatchObject({
      error: 'interaction_not_active',
      error_code: 'AR_FLOW_NOT_ACTIVE',
    });
  });
});

describe('letting go of the hold', () => {
  it('is done for a submit that did not save its step', async () => {
    mocks.coreAdapter.queryOne.mockResolvedValueOnce(interactionRow()).mockResolvedValue(null);
    const { status } = await submit();
    expect(status).toBeGreaterThanOrEqual(400);
    const claimId = claimCall()[1][0];
    expect(mocks.coreAdapter.execute).toHaveBeenLastCalledWith(
      expect.stringContaining('SET submit_claim_id = NULL, submit_claim_expires_at = NULL'),
      ['tenant_test', 'interaction_1', claimId]
    );
  });

  it('keeps the answer when the release fails (the claim lapses on its own)', async () => {
    mocks.coreAdapter.queryOne.mockResolvedValueOnce(interactionRow()).mockResolvedValue(null);
    const before = await submit();
    mocks.coreAdapter.queryOne
      .mockReset()
      .mockResolvedValueOnce(interactionRow())
      .mockResolvedValue(null);
    mocks.coreAdapter.execute
      .mockReset()
      .mockResolvedValueOnce({ success: true, rowsAffected: 1 })
      .mockRejectedValueOnce(new TypeError('release failed'));
    const after = await submit();
    expect(after).toEqual(before);
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        action: 'flow_submit_claim_release',
        interaction_id: 'interaction_1',
        error: 'TypeError',
      })
    );
  });
});
