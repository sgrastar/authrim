/**
 * The checks every step request makes before it acts (openRuntimeStepRequest), through a submit:
 * the runtime switch, the interaction and its state, its expiry, the signed contract and the step.
 * And the submit's claim on the interaction (another submit holds it, it ended meanwhile).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loginRuntimeInteractionSubmitHandler } from '../login-runtime-flow';
import { auditRows, mocks } from './helpers/mut-runtime2-mocks';
import {
  createContext,
  mockSubmitQueries,
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

type Signed = { contractHash: string; signature: string; expiresAt: number };

async function signedInteraction(): Promise<Signed> {
  const { data } = await startInteraction();
  const interaction = data.interaction as Record<string, unknown>;
  await resetAdapter();
  return {
    contractHash: String(data.contract_hash),
    signature: String(data.signature),
    expiresAt: Number(interaction.expires_at),
  };
}

function interactionRow(signed: Signed, row: Record<string, unknown> = {}) {
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
    context_json: JSON.stringify({ protocol: 'direct', screen_answers: [{ step_id: 's' }] }),
    contract_hash: signed.contractHash,
    signature: signed.signature,
    expires_at: signed.expiresAt,
    ...row,
  };
}

async function submit(
  signed: Signed | null,
  input: {
    body?: Record<string, unknown>;
    params?: Record<string, string>;
    env?: Record<string, unknown>;
  } = {}
) {
  const response = await loginRuntimeInteractionSubmitHandler(
    createContext({
      params: input.params ?? { interaction_id: 'interaction_1' },
      env: input.env,
      body: input.body ?? {
        step_id: 'auth:step',
        node_id: 'auth',
        selected_handle: 'passkey',
        contract_hash: signed?.contractHash,
        signature: signed?.signature,
      },
    })
  );
  return { response, data: await readJson(response) };
}

function failures() {
  return auditRows()
    .map((row) => row.overview)
    .filter((overview) => overview.action === 'flow.interaction.failed')
    .map((overview) => [overview.result, overview.reason_code]);
}

function claims() {
  return mocks.coreAdapter.execute.mock.calls.filter(([sql]) =>
    String(sql).includes('SET submit_claim_id = ?, submit_claim_expires_at = ?')
  );
}

describe('a step request to a runtime interaction', () => {
  beforeEach(async () => {
    await resetAdapter();
  });

  it('is refused while the runtime Flow is off', async () => {
    const { response, data } = await submit(null, { env: { ENABLE_LOGIN_RUNTIME_FLOW: 'false' } });
    expect(response.status).toBe(403);
    expect(data).toEqual({
      error: 'flow_runtime_disabled',
      error_description: 'LoginUI runtime Flow is disabled',
      error_code: 'AR_FLOW_DISABLED',
      category: 'configuration_error',
      action: 'contact_administrator',
    });
  });

  it('needs the interaction and the step', async () => {
    const noId = await submit(null, { params: {} });
    expect(noId.response.status).toBe(400);
    expect(noId.data).toEqual({
      error: 'invalid_request',
      error_description: 'Interaction ID is required',
      error_code: 'AR_FLOW_INVALID_REQUEST',
      category: 'recoverable',
      action: 'retry_step',
    });
    const noStep = await submit(null, { body: { node_id: 'auth' } });
    expect(noStep.data).toEqual({
      error: 'invalid_request',
      error_description: 'step_id is required',
      error_code: 'AR_FLOW_INVALID_STEP',
      category: 'recoverable',
      action: 'retry_step',
      interaction_id: 'interaction_1',
    });
    const c = createContext({ params: { interaction_id: 'interaction_1' } });
    (c.req.json as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new SyntaxError('bad'));
    const unreadable = await loginRuntimeInteractionSubmitHandler(c);
    expect(await readJson(unreadable)).toMatchObject({ error_code: 'AR_FLOW_INVALID_STEP' });
    expect(mocks.coreAdapter.queryOne).not.toHaveBeenCalled();
  });

  it('answers not found for an unknown interaction', async () => {
    mocks.coreAdapter.queryOne.mockResolvedValueOnce(null);
    const { response, data } = await submit(null, {
      body: { step_id: 'auth:step', contract_hash: 'h', signature: 's' },
    });
    expect(response.status).toBe(404);
    expect(data).toEqual({
      error: 'interaction_not_found',
      error_description: 'Flow interaction was not found',
      error_code: 'AR_FLOW_NOT_FOUND',
      category: 'restart_required',
      action: 'restart_interaction',
      interaction_id: 'interaction_1',
    });
  });

  it.each(['completed', 'failed', 'expired'])(
    'refuses an interaction that is %s',
    async (state) => {
      const signed = await signedInteraction();
      mocks.coreAdapter.queryOne.mockResolvedValueOnce(interactionRow(signed, { state }));
      const { response, data } = await submit(signed);
      expect(response.status).toBe(409);
      expect(data).toMatchObject({
        error: 'interaction_not_active',
        error_code: 'AR_FLOW_NOT_ACTIVE',
      });
      expect(claims()).toEqual([]);
    }
  );

  it('expires an interaction past its time, without its screen answers', async () => {
    const signed = await signedInteraction();
    const row = interactionRow(signed, { expires_at: Math.floor(Date.now() / 1000) - 1 });
    mocks.coreAdapter.queryOne.mockResolvedValueOnce(row);
    const { response, data } = await submit(signed);
    expect(response.status).toBe(409);
    expect(data).toMatchObject({
      error: 'interaction_expired',
      error_description: 'The login interaction has expired',
      error_code: 'AR_FLOW_EXPIRED',
      category: 'restart_required',
    });
    const expiry = mocks.coreAdapter.execute.mock.calls.find(([sql]) =>
      String(sql).includes("SET state = 'expired'")
    );
    expect(expiry?.[1]).toEqual([
      expect.any(Number),
      JSON.stringify({ protocol: 'direct' }),
      'tenant_test',
      'interaction_1',
      row.context_json,
    ]);
    expect(failures()).toEqual([['expired', 'AR_FLOW_EXPIRED']]);
  });

  it('does not expire an interaction still in its time', async () => {
    const signed = await signedInteraction();
    mocks.coreAdapter.queryOne.mockResolvedValueOnce(interactionRow(signed));
    await submit(signed, {
      body: {
        step_id: 'other:step',
        contract_hash: signed.contractHash,
        signature: signed.signature,
      },
    });
    expect(
      mocks.coreAdapter.execute.mock.calls.some(([sql]) => String(sql).includes("'expired'"))
    ).toBe(false);
  });

  it('cannot check the contract without the signing secret', async () => {
    const signed = await signedInteraction();
    mocks.coreAdapter.queryOne.mockResolvedValueOnce(interactionRow(signed));
    const { response, data } = await submit(signed, { env: { FLOW_RUNTIME_HMAC_SECRET: '' } });
    expect(response.status).toBe(500);
    expect(data).toEqual({
      error: 'flow_runtime_secret_missing',
      error_description: 'Flow runtime signing secret is not configured',
      error_code: 'AR_FLOW_SECRET_MISSING',
      category: 'configuration_error',
      action: 'contact_administrator',
      interaction_id: 'interaction_1',
    });
  });

  it('records a contract that was not signed for it as a security failure', async () => {
    const signed = await signedInteraction();
    mocks.coreAdapter.queryOne.mockResolvedValueOnce(interactionRow(signed));
    const { response, data } = await submit(signed, {
      body: { step_id: 'auth:step', contract_hash: signed.contractHash, signature: 'forged' },
    });
    expect(response.status).toBe(403);
    expect(data).toMatchObject({
      error: 'invalid_runtime_signature',
      error_code: 'AR_FLOW_SIGNATURE_MISMATCH',
    });
    expect(failures()).toEqual([['security_error', 'AR_FLOW_SIGNATURE_MISMATCH']]);
  });

  it.each([
    ['another step', { step_id: 'complete:step' }],
    ['another node', { step_id: 'auth:step', node_id: 'complete' }],
  ])('records a request for %s as a step mismatch', async (_label, named) => {
    const signed = await signedInteraction();
    mocks.coreAdapter.queryOne.mockResolvedValueOnce(interactionRow(signed));
    const { response, data } = await submit(signed, {
      body: { ...named, contract_hash: signed.contractHash, signature: signed.signature },
    });
    expect(response.status).toBe(409);
    expect(data).toEqual({
      error: 'step_mismatch',
      error_description: 'Submitted step does not match the active Flow step',
      error_code: 'AR_FLOW_STEP_MISMATCH',
      category: 'security_error',
      action: 'restart_interaction',
      interaction_id: 'interaction_1',
    });
    expect(failures()).toEqual([['security_error', 'AR_FLOW_STEP_MISMATCH']]);
    expect(claims()).toEqual([]);
  });
});

describe("a submit's claim on the interaction", () => {
  beforeEach(async () => {
    await resetAdapter();
  });

  async function claimedSubmit(signed: Signed) {
    mockSubmitQueries({
      contractHash: signed.contractHash,
      signature: signed.signature,
      expiresAt: signed.expiresAt,
      currentNodeId: 'auth',
      currentStepId: 'auth:step',
      stepState: 'waiting_input',
    });
    return submit(signed);
  }

  it('is taken over the interaction as it was read and verified', async () => {
    const signed = await signedInteraction();
    await claimedSubmit(signed);
    const [sql, params] = claims()[0] ?? [];
    expect(String(sql)).toContain("state IN ('created', 'active')");
    expect((params as unknown[]).slice(2)).toEqual([
      'tenant_test',
      'interaction_1',
      'auth:step',
      expect.stringContaining('"protocol":"oidc"'),
      signed.contractHash,
      signed.signature,
      expect.any(Number),
    ]);
  });

  it('answers step_conflict while another submit holds it', async () => {
    const signed = await signedInteraction();
    mocks.coreAdapter.queryOne.mockResolvedValueOnce(interactionRow(signed));
    mocks.coreAdapter.execute.mockResolvedValueOnce({ success: true, rowsAffected: 0 });
    mocks.coreAdapter.queryOne.mockResolvedValueOnce({ state: 'active' });
    const { response, data } = await submit(signed);
    expect(response.status).toBe(409);
    expect(data).toMatchObject({ error: 'step_conflict', error_code: 'AR_FLOW_STEP_CONFLICT' });
  });

  it('answers not active when the interaction ended meanwhile', async () => {
    const signed = await signedInteraction();
    mocks.coreAdapter.queryOne.mockResolvedValueOnce(interactionRow(signed));
    mocks.coreAdapter.execute.mockResolvedValueOnce({ success: true, rowsAffected: 0 });
    mocks.coreAdapter.queryOne.mockResolvedValueOnce({ state: 'completed' });
    const { response, data } = await submit(signed);
    expect(response.status).toBe(409);
    expect(data).toMatchObject({
      error: 'interaction_not_active',
      error_description: 'Flow interaction is no longer active',
      error_code: 'AR_FLOW_NOT_ACTIVE',
    });
  });

  it('answers step_conflict for a claim the database refused as concurrent', async () => {
    const signed = await signedInteraction();
    mocks.coreAdapter.queryOne.mockResolvedValueOnce(interactionRow(signed));
    mocks.coreAdapter.execute.mockRejectedValueOnce(
      Object.assign(new Error('c'), { code: '40001' })
    );
    const { data } = await submit(signed);
    expect(data).toMatchObject({ error_code: 'AR_FLOW_STEP_CONFLICT' });

    mocks.coreAdapter.queryOne.mockResolvedValueOnce(interactionRow(signed));
    mocks.coreAdapter.execute.mockRejectedValueOnce(new Error('disk'));
    await expect(submit(signed)).rejects.toThrow('disk');
  });
});
