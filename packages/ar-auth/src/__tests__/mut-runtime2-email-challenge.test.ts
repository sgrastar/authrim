/**
 * The email-verification challenge of a runtime interaction (the EVP nonce a mail-OTP step
 * asks for): when one is made, what it is bound to, and each refusal before it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowRuntimeContract } from '@authrim/ar-lib-core';
import { loginRuntimeEmailVerificationChallengeHandler } from '../login-runtime-flow';
import { mocks } from './helpers/mut-runtime2-mocks';
import {
  createContext,
  readJson,
  resetAdapter,
  runtime,
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

const emailRuntime: FlowRuntimeContract = {
  flow_kind: 'login',
  ui: {
    steps: [
      {
        id: 'auth:step',
        source_node_id: 'auth',
        component: 'authentication_method_selector',
        render: true,
      },
      {
        id: 'email-verify:step',
        source_node_id: 'email-verify',
        component: 'email_verification',
        render: false,
      },
      { id: 'complete:step', source_node_id: 'complete', component: 'completion', render: true },
    ],
  },
};
const emailEditor = {
  nodes: [
    { id: 'auth', type: 'authentication' },
    { id: 'email-verify', type: 'email_verification' },
    { id: 'complete', type: 'complete' },
  ],
  edges: [
    { id: 'e1', source: 'auth', target: 'email-verify', source_handle: 'mail_otp' },
    { id: 'e2', source: 'email-verify', target: 'complete', source_handle: 'verified' },
  ],
};

type Signed = { contractHash: string; signature: string; expiresAt: number };

async function signedInteraction(): Promise<Signed> {
  const { data } = await startInteraction({ flow_kind: 'login' }, emailRuntime, emailEditor);
  const interaction = data.interaction as Record<string, unknown>;
  await resetAdapter();
  return {
    contractHash: String(data.contract_hash),
    signature: String(data.signature),
    expiresAt: Number(interaction.expires_at),
  };
}

function mockInteraction(
  signed: Signed,
  row: Record<string, unknown> = {},
  version: Record<string, unknown> | null = {}
) {
  mocks.coreAdapter.queryOne.mockResolvedValueOnce({
    id: 'interaction_1',
    flow_id: 'flow_login',
    flow_version_id: 'fv_1',
    user_id: null,
    client_id: null,
    saml_sp_id: null,
    state: 'active',
    current_node_id: 'auth',
    current_step_id: 'auth:step',
    context_json: JSON.stringify({ protocol: 'oidc', target_type: 'tenant', locale: 'en' }),
    contract_hash: signed.contractHash,
    signature: signed.signature,
    expires_at: signed.expiresAt,
    ...row,
  });
  mocks.coreAdapter.queryOne.mockResolvedValueOnce(
    version === null
      ? null
      : {
          id: 'fv_1',
          flow_id: 'flow_login',
          schema_version: 'authrim.login_ui.contract.v1',
          runtime_snapshot_json: JSON.stringify(emailRuntime),
          editor_snapshot_json: JSON.stringify(emailEditor),
          published_at: 1782770000,
          ...version,
        }
  );
}

async function ask(
  signed: Signed | null,
  input: {
    body?: Record<string, unknown>;
    params?: Record<string, string>;
    env?: Record<string, unknown>;
  } = {}
) {
  const c = createContext({
    params: input.params ?? { interaction_id: 'interaction_1' },
    env: input.env,
    url: 'https://api.example.com/api/v1/login/interactions/interaction_1/email-verification/challenge',
    body: input.body ?? {
      step_id: 'auth:step',
      contract_hash: signed?.contractHash,
      signature: signed?.signature,
    },
  });
  const response = await loginRuntimeEmailVerificationChallengeHandler(c);
  return { response, data: await readJson(response), c };
}

describe('the email-verification challenge of a runtime interaction', () => {
  beforeEach(async () => {
    await resetAdapter();
  });

  it('is refused while the runtime Flow is off, before reading anything', async () => {
    const { response, data } = await ask(null, { env: { ENABLE_LOGIN_RUNTIME_FLOW: 'false' } });
    expect(response.status).toBe(403);
    expect(data).toMatchObject({ error: 'flow_runtime_disabled', error_code: 'AR_FLOW_DISABLED' });
    expect(mocks.coreAdapter.queryOne).not.toHaveBeenCalled();
  });

  it('needs the interaction and the step it is asked for', async () => {
    const noId = await ask(null, { params: {} });
    expect(noId.response.status).toBe(400);
    expect(noId.data).toMatchObject({
      error: 'invalid_request',
      error_code: 'AR_FLOW_INVALID_REQUEST',
    });

    const noStep = await ask(null, { body: { contract_hash: 'h', signature: 's' } });
    expect(noStep.response.status).toBe(400);
    expect(noStep.data).toMatchObject({
      error: 'invalid_request',
      error_code: 'AR_FLOW_INVALID_STEP',
      interaction_id: 'interaction_1',
    });
    expect(mocks.coreAdapter.queryOne).not.toHaveBeenCalled();
  });

  it('reads an unreadable body as one without a step', async () => {
    const c = createContext({ params: { interaction_id: 'interaction_1' } });
    (c.req.json as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new SyntaxError('bad json'));
    const response = await loginRuntimeEmailVerificationChallengeHandler(c);
    expect(response.status).toBe(400);
    expect(await readJson(response)).toMatchObject({ error_code: 'AR_FLOW_INVALID_STEP' });
  });

  it.each([
    ['missing', null],
    ['completed', { state: 'completed' }],
    ['failed', { state: 'failed' }],
    ['expired', { expires_at: 1 }],
  ])('answers not found for an interaction that is %s', async (_label, row) => {
    const signed = await signedInteraction();
    if (row === null) mocks.coreAdapter.queryOne.mockResolvedValueOnce(null);
    else mockInteraction(signed, row);
    const { response, data } = await ask(signed);
    expect(response.status).toBe(404);
    expect(data).toMatchObject({
      error: 'interaction_not_found',
      error_code: 'AR_FLOW_NOT_FOUND',
      interaction_id: 'interaction_1',
    });
    expect(mocks.challengeStore.storeChallengeRpc).not.toHaveBeenCalled();
  });

  it('refuses a step that is not the current one', async () => {
    const signed = await signedInteraction();
    mockInteraction(signed);
    const { response, data } = await ask(signed, {
      body: {
        step_id: 'complete:step',
        contract_hash: signed.contractHash,
        signature: signed.signature,
      },
    });
    expect(response.status).toBe(409);
    expect(data).toMatchObject({ error: 'step_mismatch', error_code: 'AR_FLOW_STEP_MISMATCH' });
  });

  it('cannot check the contract without the signing secret', async () => {
    const signed = await signedInteraction();
    mockInteraction(signed);
    const { response, data } = await ask(signed, { env: { FLOW_RUNTIME_HMAC_SECRET: '' } });
    expect(response.status).toBe(500);
    expect(data).toMatchObject({
      error: 'flow_runtime_secret_missing',
      error_code: 'AR_FLOW_SECRET_MISSING',
    });
  });

  it('refuses a contract that is not the one signed for the interaction', async () => {
    const signed = await signedInteraction();
    mockInteraction(signed);
    const { response, data } = await ask(signed, {
      body: { step_id: 'auth:step', contract_hash: signed.contractHash, signature: 'forged' },
    });
    expect(response.status).toBe(403);
    expect(data).toMatchObject({
      error: 'invalid_runtime_signature',
      error_code: 'AR_FLOW_SIGNATURE_MISMATCH',
    });
    expect(mocks.challengeStore.storeChallengeRpc).not.toHaveBeenCalled();
  });

  it('answers a configuration error when the published runtime or its step is gone', async () => {
    const signed = await signedInteraction();
    mockInteraction(signed, {}, null);
    const gone = await ask(signed);
    expect(gone.response.status).toBe(409);
    expect(gone.data).toMatchObject({
      error: 'flow_runtime_invalid',
      error_code: 'AR_FLOW_RUNTIME_INVALID',
    });

    mockInteraction(signed, { current_node_id: 'other', current_step_id: 'other:step' });
    const missingStep = await ask(signed, {
      body: {
        step_id: 'other:step',
        contract_hash: signed.contractHash,
        signature: signed.signature,
      },
    });
    expect(missingStep.response.status).toBe(409);
    expect(missingStep.data).toMatchObject({ error_code: 'AR_FLOW_RUNTIME_INVALID' });
  });

  it('binds the nonce to the interaction, its steps, the origin and the contract', async () => {
    const signed = await signedInteraction();
    mockInteraction(signed, { state: 'created' });
    const { response, data, c } = await ask(signed);
    expect(response.status).toBe(200);
    expect(c.header).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(data.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(data.expires_in).toBe(300);
    expect(mocks.challengeStore.storeChallengeRpc).toHaveBeenCalledWith({
      id: `email_verification_protocol:${String(data.challenge_id)}`,
      tenantId: 'tenant_test',
      type: 'email_verification_protocol',
      // No user yet: the challenge is keyed by the interaction.
      userId: 'interaction_1',
      challenge: data.nonce,
      ttl: 300,
      metadata: {
        interaction_id: 'interaction_1',
        source_step_id: 'auth:step',
        verification_step_id: 'email-verify:step',
        expected_origin: 'https://api.example.com',
        contract_hash: signed.contractHash,
      },
    });
  });

  it('keys the challenge by the user, and lives no longer than the interaction', async () => {
    const signed = await signedInteraction();
    vi.useFakeTimers();
    try {
      // 42 seconds before the interaction expires: the nonce lives those 42 seconds.
      vi.setSystemTime((signed.expiresAt - 42) * 1000);
      mockInteraction(signed, { user_id: 'user_1' });
      const { response, data } = await ask(signed);
      expect(response.status).toBe(200);
      expect(data.expires_in).toBe(42);
      expect(mocks.challengeStore.storeChallengeRpc).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user_1', ttl: 42 })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('is made on the email-verification step itself', async () => {
    const signed = await signedInteraction();
    mockInteraction(signed, {
      current_node_id: 'email-verify',
      current_step_id: 'email-verify:step',
    });
    const { response, data } = await ask(signed, {
      body: {
        step_id: 'email-verify:step',
        contract_hash: signed.contractHash,
        signature: signed.signature,
      },
    });
    expect(response.status).toBe(200);
    expect(data).toMatchObject({ available: true, step_id: 'email-verify:step' });
    expect(mocks.challengeStore.storeChallengeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          source_step_id: 'email-verify:step',
          verification_step_id: 'email-verify:step',
        }) as unknown,
      })
    );
  });

  it('is not made on a step that offers no email code', async () => {
    const signed = await signedInteraction();
    mockInteraction(signed, { current_node_id: 'complete', current_step_id: 'complete:step' });
    const onCompletion = await ask(signed, {
      body: {
        step_id: 'complete:step',
        contract_hash: signed.contractHash,
        signature: signed.signature,
      },
    });
    expect(onCompletion.data).toEqual({ available: false });

    mockInteraction(signed);
    const turnedOff = await ask(signed, {
      env: {
        SETTINGS: {
          get: vi.fn(async () =>
            JSON.stringify({ 'authentication-methods.email_otp.enabled': false })
          ),
        },
      },
    });
    expect(turnedOff.data).toEqual({ available: false });
    expect(mocks.challengeStore.storeChallengeRpc).not.toHaveBeenCalled();
  });

  it('is not made when the mail-OTP branch does not lead to email verification', async () => {
    const signed = await signedInteraction();
    mockInteraction(signed, {}, { runtime_snapshot_json: JSON.stringify(runtime) });
    const { data } = await ask(signed);
    expect(data).toEqual({ available: false });
  });

  it('makes a new nonce each time', async () => {
    const signed = await signedInteraction();
    mockInteraction(signed);
    const first = await ask(signed);
    mockInteraction(signed);
    const second = await ask(signed);
    expect(first.data.nonce).not.toBe(second.data.nonce);
    expect(first.data.challenge_id).not.toBe(second.data.challenge_id);
  });

  it('is made on a sign-up method choice that leads to email verification', async () => {
    const signed = await signedInteraction();
    const signUp = {
      ...emailRuntime,
      ui: {
        steps: emailRuntime.ui.steps.map((step) =>
          step.id === 'auth:step' ? { ...step, component: 'registration_method_selector' } : step
        ),
      },
    };
    mockInteraction(signed, {}, { runtime_snapshot_json: JSON.stringify(signUp) });
    const { data } = await ask(signed);
    expect(data).toMatchObject({ available: true, step_id: 'auth:step' });
  });
});
