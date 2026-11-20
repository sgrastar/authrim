/**
 * Going back to a screen (interactions/<id>/back): what is refused, the claim it is held under,
 * what it writes and what it answers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowRuntimeContract } from '@authrim/ar-lib-core';
import { loginRuntimeInteractionBackHandler } from '../login-runtime-flow';
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

const screenStep = (name: string) => ({
  id: `${name}:step`,
  source_node_id: name,
  component: 'screen' as const,
  render: true,
  config: { screen_ref: `page_${name}` },
});
const backRuntime: FlowRuntimeContract = {
  flow_kind: 'login',
  ui: { steps: [screenStep('a'), screenStep('b'), screenStep('c')] },
};
const screenRow = (ref: string) => ({
  id: ref,
  screen_key: ref,
  display_name: ref,
  description: null,
  screen_kind: 'custom',
  fields_json: JSON.stringify([{ field: 'note', label: 'Note', block_type: 'text' }]),
  localizations_json: null,
  settings_json: null,
});
const visit = (id: string, stepId: string, ms: number) => ({
  id,
  step_id: stepId,
  selected_handle: 'submitted',
  created_at: Math.floor(ms / 1000),
  state_json: JSON.stringify({ completed_at_ms: ms }),
});
const visitsToC = [visit('v_a', 'a:step', 1_000), visit('v_b', 'b:step', 2_000)];

type Stored = { contract_hash: unknown; signature: unknown; expires_at: number };

async function started(): Promise<Stored> {
  await resetAdapter();
  mocks.coreAdapter.queryOne.mockImplementation(async (sql: string, params?: unknown[]) =>
    String(sql).includes('FROM screens') ? screenRow(String(params?.[1])) : undefined
  );
  const { data } = await startInteraction({ flow_kind: 'login' }, backRuntime);
  await resetAdapter();
  return {
    contract_hash: data.contract_hash,
    signature: data.signature,
    expires_at: Number((data.interaction as Record<string, unknown>).expires_at),
  };
}

function storedRows(stored: Stored, options: { version?: boolean; claimState?: string } = {}) {
  mocks.coreAdapter.queryOne.mockImplementation(async (sql: string, params?: unknown[]) => {
    const text = String(sql);
    if (text.includes('SELECT state FROM flow_interactions')) {
      return { state: options.claimState ?? 'active' };
    }
    if (text.includes('FROM flow_interactions')) {
      return {
        id: 'interaction_1',
        flow_id: 'flow_login',
        flow_version_id: 'fv_1',
        user_id: 'user_1',
        client_id: null,
        saml_sp_id: null,
        state: 'active',
        current_node_id: 'c',
        current_step_id: 'c:step',
        context_json: JSON.stringify({ protocol: 'oidc', target_type: 'tenant', locale: 'en' }),
        ...stored,
      };
    }
    if (text.includes('FROM flow_versions')) {
      return options.version === false
        ? null
        : {
            id: 'fv_1',
            flow_id: 'flow_login',
            schema_version: 'authrim.login_ui.contract.v1',
            runtime_snapshot_json: JSON.stringify(backRuntime),
            editor_snapshot_json: null,
            published_at: 1782770000,
          };
    }
    if (text.includes('FROM screens')) return screenRow(String(params?.[1]));
    if (text.includes('SELECT id FROM flow_interaction_steps')) return { id: 'visit_now' };
    return undefined;
  });
  mocks.coreAdapter.query.mockImplementation(async (sql: string) =>
    String(sql).includes('FROM flow_interaction_steps') ? visitsToC : []
  );
}

async function goBack(stored: Stored, extra: Record<string, unknown> = {}) {
  const response = await loginRuntimeInteractionBackHandler(
    createContext({
      params: { interaction_id: 'interaction_1' },
      body: {
        step_id: 'c:step',
        node_id: 'c',
        contract_hash: stored.contract_hash,
        signature: stored.signature,
        target_screen: 'page_b',
        ...extra,
      },
    })
  );
  return { response, data: await readJson(response) };
}

const executed = (fragment: string) =>
  mocks.coreAdapter.execute.mock.calls.filter(([sql]) => String(sql).includes(fragment));
const releases = () => executed('SET submit_claim_id = NULL');
const batched = () =>
  (mocks.coreAdapter.batch.mock.calls[0]?.[0] ?? []) as Array<{ sql: string; params: unknown[] }>;

describe('going back to a screen', () => {
  let stored: Stored;
  beforeEach(async () => {
    stored = await started();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is not allowed without a screen to go back to', async () => {
    storedRows(stored);
    const { response, data } = await goBack(stored, { target_screen: '' });
    expect(response.status).toBe(409);
    expect(data).toEqual({
      error: 'back_not_allowed',
      error_description: 'This screen cannot be gone back to from here',
      error_code: 'AR_FLOW_BACK_NOT_ALLOWED',
      category: 'recoverable',
      action: 'retry_step',
      interaction_id: 'interaction_1',
    });
    expect(executed('SET submit_claim_id = ?')).toEqual([]);
  });

  it('answers a configuration error when the published version is gone', async () => {
    storedRows(stored, { version: false });
    const { response, data } = await goBack(stored);
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

  it.each([
    ['ended meanwhile', 'completed', 'interaction_not_active', 'AR_FLOW_NOT_ACTIVE'],
    ['held by a submit', 'active', 'step_conflict', 'AR_FLOW_STEP_CONFLICT'],
  ])('is refused for an interaction %s', async (_label, claimState, error, code) => {
    storedRows(stored, { claimState });
    mocks.coreAdapter.execute.mockResolvedValueOnce({ success: true, rowsAffected: 0 });
    const { response, data } = await goBack(stored);
    expect(response.status).toBe(409);
    expect(data).toMatchObject({ error, error_code: code });
    expect(mocks.coreAdapter.query).not.toHaveBeenCalled();
    expect(mocks.coreAdapter.batch).not.toHaveBeenCalled();
  });

  it('reads the visit named for the current step', async () => {
    storedRows(stored);
    const { response } = await goBack(stored, { visit_id: 'visit_now' });
    expect(response.status).toBe(200);
    const read = mocks.coreAdapter.queryOne.mock.calls.find(([sql]) =>
      String(sql).includes('SELECT id FROM flow_interaction_steps')
    );
    expect(read?.[1]).toEqual(['tenant_test', 'interaction_1', 'c:step']);
  });

  it('stops at a visit of a step the Flow does not have', async () => {
    storedRows(stored);
    mocks.coreAdapter.query.mockResolvedValueOnce([
      ...visitsToC,
      visit('v_gone', 'gone:step', 3_000),
    ]);
    const { data } = await goBack(stored);
    expect(data.error).toBe('back_not_allowed');
  });

  it('writes the way back under the claim, and keeps the claim it saved', async () => {
    storedRows(stored);
    const { response, data } = await goBack(stored);
    expect(response.status).toBe(200);
    expect(data).toMatchObject({ completed: false, output: null });
    expect(data.interaction).toMatchObject({
      id: 'interaction_1',
      state: 'active',
      current_node_id: 'b',
      current_step_id: 'b:step',
      expires_at: stored.expires_at,
    });
    const claimId = executed('SET submit_claim_id = ?')[0]?.[1]?.[0];
    const statements = batched();
    const left = statements[1];
    expect(JSON.parse(String(left?.params[0]))).toEqual({
      returned_to_step_id: 'b:step',
      returned_at_ms: expect.any(Number) as unknown,
    });
    expect(left?.params.slice(2)).toEqual([
      'tenant_test',
      'interaction_1',
      'c:step',
      'tenant_test',
      'interaction_1',
      claimId,
    ]);
    expect(left?.sql).toContain('submit_claim_id = ? AND submit_claim_expires_at IS NULL');
    const undone = statements[2];
    expect(undone?.sql).toContain("SET state = 'skipped', updated_at = ?");
    expect(undone?.sql).toContain("state = 'completed'");
    expect(undone?.params.slice(1)).toEqual([
      'tenant_test',
      'v_b',
      'interaction_1',
      'tenant_test',
      'interaction_1',
      claimId,
    ]);
    // Saved: the claim is not let go of here (the save cleared its expiry).
    expect(releases()).toEqual([]);
    const entered = auditRows().filter((row) => row.overview.action === 'flow.node.entered');
    expect(entered).toHaveLength(1);
    expect(entered[0]?.overview).toMatchObject({ result: 'success', subject_id: 'user_1' });
    expect(entered[0]?.row.node_id).toBe('b');
  });

  it('answers step_conflict when the interaction moved before the save', async () => {
    storedRows(stored);
    mocks.coreAdapter.batch.mockResolvedValueOnce([{ success: true, rowsAffected: 0 }]);
    const { data } = await goBack(stored);
    expect(data.error_code).toBe('AR_FLOW_STEP_CONFLICT');
    expect(releases()).toHaveLength(1);
  });

  it('answers step_conflict for a save the database refused as concurrent', async () => {
    storedRows(stored);
    mocks.coreAdapter.batch.mockRejectedValueOnce(Object.assign(new Error('c'), { code: '40001' }));
    expect((await goBack(stored)).data.error_code).toBe('AR_FLOW_STEP_CONFLICT');
    mocks.coreAdapter.batch.mockRejectedValueOnce(new Error('disk'));
    await expect(goBack(stored)).rejects.toThrow('disk');
  });

  it('answers step_conflict for a concurrent read before the save, not after it', async () => {
    storedRows(stored);
    mocks.coreAdapter.query.mockRejectedValueOnce(Object.assign(new Error('c'), { code: '40001' }));
    expect((await goBack(stored)).data.error_code).toBe('AR_FLOW_STEP_CONFLICT');
    expect(releases()).toHaveLength(1);

    // Saved, then the screens to go back to from there cannot be read: not a conflict.
    mocks.coreAdapter.query
      .mockResolvedValueOnce(visitsToC)
      .mockRejectedValueOnce(Object.assign(new Error('c'), { code: '40001' }));
    await expect(goBack(stored)).rejects.toThrow('c');
  });

  it('answers step_conflict when the claim lapsed while the way back was read', async () => {
    storedRows(stored);
    const realNow = Date.now.bind(Date);
    let late = false;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + (late ? 60_000 : 0));
    mocks.coreAdapter.query.mockImplementationOnce(async () => {
      late = true;
      return visitsToC;
    });
    const { data } = await goBack(stored);
    expect(data.error_code).toBe('AR_FLOW_STEP_CONFLICT');
    expect(mocks.coreAdapter.batch).not.toHaveBeenCalled();
  });
});
