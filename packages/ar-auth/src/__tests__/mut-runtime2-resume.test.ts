/**
 * Resuming a runtime interaction (interactions/start with resume_interaction_id): the refusals,
 * a submit that holds the step (read again, then step_conflict), and what is written back.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupExpiredFlowInteractions,
  loginRuntimeInteractionStartHandler,
} from '../login-runtime-flow';
import { mocks } from './helpers/mut-runtime2-mocks';
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

const versionRow = {
  id: 'fv_1',
  flow_id: 'flow_login',
  schema_version: 'authrim.login_ui.contract.v1',
  runtime_snapshot_json: JSON.stringify({
    flow_kind: 'login',
    ui: {
      steps: [
        {
          id: 'auth:step',
          source_node_id: 'auth',
          component: 'authentication_method_selector',
          render: true,
        },
      ],
    },
  }),
  editor_snapshot_json: null,
  published_at: 1782770000,
};

/** The stored rows the resume reads, by table. */
function storedRows(
  signed: Signed,
  input: {
    interaction?: Record<string, unknown> | null;
    version?: Record<string, unknown> | null;
    visit?: { id: string } | null;
  } = {}
) {
  const interaction =
    input.interaction === null
      ? null
      : {
          id: 'interaction_1',
          flow_id: 'flow_login',
          flow_version_id: 'fv_1',
          user_id: null,
          client_id: null,
          saml_sp_id: null,
          state: 'active',
          current_node_id: 'auth',
          current_step_id: 'auth:step',
          context_json: JSON.stringify({ protocol: 'direct', target_type: 'tenant', locale: 'en' }),
          contract_hash: signed.contractHash,
          signature: signed.signature,
          expires_at: signed.expiresAt,
          submit_claim_expires_at: null,
          ...input.interaction,
        };
  mocks.coreAdapter.queryOne.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM flow_interactions')) return interaction;
    if (sql.includes('FROM flow_versions')) return input.version === null ? null : versionRow;
    if (sql.includes('FROM flow_interaction_steps')) {
      return input.visit === undefined ? { id: 'visit_1' } : input.visit;
    }
    return null;
  });
}

async function resume(signed: Signed, extra: Record<string, unknown> = {}) {
  const response = await loginRuntimeInteractionStartHandler(
    createContext({
      body: {
        resume_interaction_id: 'interaction_1',
        contract_hash: signed.contractHash,
        signature: signed.signature,
        ...extra,
      },
    })
  );
  return { response, data: await readJson(response) };
}

function contextWrites() {
  return mocks.coreAdapter.execute.mock.calls.filter(([sql]) =>
    String(sql).includes('SET context_json = ?')
  );
}

describe('resuming a runtime interaction', () => {
  beforeEach(async () => {
    await resetAdapter();
  });

  it('answers not found for an interaction that is not open', async () => {
    const signed = await signedInteraction();
    storedRows(signed, { interaction: null });
    const { response, data } = await resume(signed);
    expect(response.status).toBe(404);
    expect(data.error).toBe('interaction_not_found');
    expect(data.error_description).toBe('Flow interaction was not found or expired');
  });

  it('cannot check the contract without the signing secret', async () => {
    const signed = await signedInteraction();
    storedRows(signed);
    const response = await loginRuntimeInteractionStartHandler(
      createContext({
        env: { FLOW_RUNTIME_HMAC_SECRET: '' },
        body: { resume_interaction_id: 'interaction_1', ...signed },
      })
    );
    expect(response.status).toBe(500);
    expect(await readJson(response)).toMatchObject({
      error: 'flow_runtime_secret_missing',
      error_code: 'AR_FLOW_SECRET_MISSING',
      category: 'configuration_error',
      action: 'contact_administrator',
    });
  });

  it('refuses a contract that was not signed for it', async () => {
    const signed = await signedInteraction();
    storedRows(signed);
    const { response, data } = await resume(signed, { signature: 'forged' });
    expect(response.status).toBe(403);
    expect(data).toMatchObject({
      error: 'invalid_runtime_signature',
      error_description: 'Flow runtime contract verification failed',
      error_code: 'AR_FLOW_SIGNATURE_MISMATCH',
    });
    expect(contextWrites()).toEqual([]);
  });

  it('answers a conflict when the published version is gone', async () => {
    const signed = await signedInteraction();
    storedRows(signed, { version: null });
    const { response, data } = await resume(signed);
    expect(response.status).toBe(409);
    expect(data).toMatchObject({
      error: 'flow_version_unavailable',
      error_description: 'Published Flow version is unavailable',
    });
  });

  it('answers try again when the authorization request cannot be read', async () => {
    const signed = await signedInteraction();
    storedRows(signed, {
      interaction: {
        context_json: JSON.stringify({ protocol: 'oidc', authorization_challenge_id: 'ch_1' }),
      },
    });
    mocks.readAuthorizationChallengeFreshness.mockRejectedValueOnce(new Error('down'));
    const { response, data } = await resume(signed);
    expect(response.status).toBe(503);
    expect(data).toMatchObject({
      error: 'temporarily_unavailable',
      error_code: 'AR_FLOW_CHALLENGE_UNAVAILABLE',
      action: 'retry_step',
    });
  });

  it('asks for a restart when the authorization request is gone', async () => {
    const signed = await signedInteraction();
    storedRows(signed, {
      interaction: {
        context_json: JSON.stringify({ protocol: 'oidc', authorization_challenge_id: 'ch_1' }),
      },
    });
    mocks.readAuthorizationChallengeFreshness.mockResolvedValueOnce({ gone: true });
    const { response, data } = await resume(signed);
    expect(response.status).toBe(400);
    expect(data).toMatchObject({
      error_code: 'AR_FLOW_AUTH_REQUEST_EXPIRED',
      category: 'restart_required',
    });
    expect(String(data.error_description)).not.toBe('');
    expect(mocks.readAuthorizationChallengeFreshness).toHaveBeenCalledWith(
      expect.anything(),
      'tenant_test',
      'ch_1'
    );
  });

  it('writes back the locale asked for and the statements shown, over what it read', async () => {
    const signed = await signedInteraction();
    storedRows(signed, { visit: { id: 'visit_7' } });
    mocks.coreAdapter.execute.mockResolvedValue({ success: true, rowsAffected: 1 });
    const { response, data } = await resume(signed, { requested_locale: 'ja' });
    expect(response.status).toBe(200);
    expect(data).toMatchObject({ resumed: true, back_screens: [] });
    expect(data.interaction).toMatchObject({
      id: 'interaction_1',
      state: 'active',
      current_step_id: 'auth:step',
      current_visit_id: 'visit_7',
      expires_at: signed.expiresAt,
    });
    expect(Number(data.expires_in)).toBeGreaterThan(0);
    const [sql, params] = contextWrites()[0] ?? [];
    expect(String(sql)).toContain('submit_claim_expires_at IS NULL');
    const written = JSON.parse(String((params as unknown[])[0])) as Record<string, unknown>;
    expect(written).toMatchObject({ protocol: 'direct', locale: 'ja', consent_presented: {} });
    expect((params as unknown[]).slice(4, 8)).toEqual([
      'tenant_test',
      'interaction_1',
      'auth:step',
      JSON.stringify({ protocol: 'direct', target_type: 'tenant', locale: 'en' }),
    ]);
  });

  it('keeps the stored locale when none is asked for', async () => {
    const signed = await signedInteraction();
    storedRows(signed);
    await resume(signed);
    const written = JSON.parse(String(contextWrites()[0]?.[1]?.[0])) as Record<string, unknown>;
    expect(written.locale).toBe('en');
  });

  it(
    'reads again while a submit holds the step, then answers step_conflict',
    { timeout: 10_000 },
    async () => {
      const signed = await signedInteraction();
      storedRows(signed, {
        interaction: { submit_claim_expires_at: signed.expiresAt },
      });
      // Real waits: 100 + 200 + 400 + 800 ms.
      const { response, data } = await resume(signed);
      expect(response.status).toBe(409);
      expect(data).toMatchObject({ error: 'step_conflict', error_code: 'AR_FLOW_STEP_CONFLICT' });
      // The first reading and the four after the waits.
      expect(
        mocks.coreAdapter.queryOne.mock.calls.filter(([sql]) =>
          String(sql).includes('FROM flow_interactions')
        )
      ).toHaveLength(5);
      expect(contextWrites()).toEqual([]);
    }
  );

  it.each([
    ['a write that changed nothing', { success: true, rowsAffected: 0 }, { id: 'visit_1' }],
    ['a step taken before its visit was read', { success: true, rowsAffected: 1 }, null],
  ])('reads again after %s', async (_label, firstWrite, firstVisit) => {
    const signed = await signedInteraction();
    storedRows(signed, { visit: firstVisit });
    mocks.coreAdapter.execute.mockResolvedValueOnce(firstWrite);
    if (firstVisit === null) {
      const route = mocks.coreAdapter.queryOne.getMockImplementation();
      let visits = 0;
      mocks.coreAdapter.queryOne.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM flow_interaction_steps')) {
          visits += 1;
          return visits === 1 ? null : { id: 'visit_2' };
        }
        return route?.(sql, params);
      });
    }
    const { response } = await resume(signed);
    expect(response.status).toBe(200);
    expect(contextWrites()).toHaveLength(2);
  });

  it('reads again after a serialization conflict, and throws any other failure', async () => {
    const signed = await signedInteraction();
    storedRows(signed);
    mocks.coreAdapter.execute.mockRejectedValueOnce(
      Object.assign(new Error('conflict'), { code: '40001' })
    );
    expect((await resume(signed)).response.status).toBe(200);

    mocks.coreAdapter.execute.mockRejectedValueOnce(new Error('disk'));
    await expect(resume(signed)).rejects.toThrow('disk');
  });
});

describe('the cleanup of ended interactions', () => {
  beforeEach(async () => {
    await resetAdapter();
  });

  it('keeps the steps of an ended interaction for a day unless told otherwise', async () => {
    mocks.coreAdapter.execute.mockResolvedValue({ success: true, rowsAffected: 0 });
    await cleanupExpiredFlowInteractions(mocks.coreAdapter as never, 'tenant_test', {
      now: 1_782_770_600,
    });
    const deleted = mocks.coreAdapter.execute.mock.calls.find(([sql]) =>
      sql.includes('DELETE FROM flow_interaction_steps')
    );
    expect(deleted?.[1]).toEqual(['tenant_test', 'tenant_test', 1_782_770_600 - 86_400]);
  });
});
