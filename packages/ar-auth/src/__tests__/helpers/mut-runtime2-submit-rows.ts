/**
 * A submit over stored rows (an interaction at a step, its visit, its published version), read by
 * table, for the mut-runtime2-submit* tests.
 */
import type { FlowRuntimeContract } from '@authrim/ar-lib-core';
import { auditRows, mocks } from './mut-runtime2-mocks';
import { createContext, readJson, resetAdapter, startInteraction } from './mut-runtime2-requests';

export const flowOf = (...steps: Array<Record<string, unknown>>) =>
  ({ flow_kind: 'login', ui: { steps } }) as unknown as FlowRuntimeContract;

/** A session of user_1, proven now. */
export function sessionOf(userId = 'user_1') {
  const now = Date.now();
  return {
    id: 'sess_runtime_1',
    userId,
    createdAt: now - 1000,
    expiresAt: now + 60_000,
    data: { amr: ['email_code'], authTime: Math.floor(now / 1000), proven_at: now - 1000 },
  };
}

export type Signed = { contractHash: string; signature: string; expiresAt: number };
export type Rows = {
  runtime: FlowRuntimeContract;
  editor?: Record<string, unknown> | null;
  current?: string;
  step?: Record<string, unknown> | null;
  version?: boolean;
  userId?: string | null;
  /** The signed-in session the request carries (resolved by the session store). */
  session?: Record<string, unknown> | null;
  context?: Record<string, unknown>;
  headers?: Record<string, string>;
};

export async function signedInteraction(): Promise<Signed> {
  await resetAdapter();
  const { data } = await startInteraction();
  const interaction = data.interaction as Record<string, unknown>;
  await resetAdapter();
  return {
    contractHash: String(data.contract_hash),
    signature: String(data.signature),
    expiresAt: Number(interaction.expires_at),
  };
}

export function storedRows(signed: Signed, rows: Rows) {
  const current = rows.current ?? 'auth';
  mocks.coreAdapter.queryOne.mockImplementation(async (sql: string) => {
    const text = String(sql);
    if (text.includes('SELECT state FROM flow_interactions')) return { state: 'active' };
    if (text.includes('FROM flow_interactions')) {
      return {
        id: 'interaction_1',
        flow_id: 'flow_login',
        flow_version_id: 'fv_1',
        user_id: rows.userId ?? null,
        client_id: null,
        saml_sp_id: null,
        state: 'active',
        current_node_id: current,
        current_step_id: `${current}:step`,
        context_json: JSON.stringify({
          protocol: 'direct',
          target_type: 'tenant',
          locale: 'en',
          ...rows.context,
        }),
        contract_hash: signed.contractHash,
        signature: signed.signature,
        expires_at: signed.expiresAt,
      };
    }
    if (text.includes('FROM flow_interaction_steps') && text.includes('ORDER BY CASE')) {
      return rows.step === undefined
        ? {
            id: 'step_1',
            interaction_id: 'interaction_1',
            node_id: current,
            step_id: `${current}:step`,
            state: 'waiting_input',
            selected_handle: null,
            state_json: null,
          }
        : rows.step;
    }
    if (text.includes('FROM flow_versions')) {
      return rows.version === false
        ? null
        : {
            id: 'fv_1',
            flow_id: 'flow_login',
            schema_version: 'authrim.login_ui.contract.v1',
            runtime_snapshot_json: JSON.stringify(rows.runtime),
            editor_snapshot_json: rows.editor ? JSON.stringify(rows.editor) : null,
            published_at: 1782770000,
          };
    }
    return null;
  });
}

export async function submit(signed: Signed, rows: Rows, body: Record<string, unknown> = {}) {
  const { loginRuntimeInteractionSubmitHandler } = await import('../../login-runtime-flow');
  storedRows(signed, rows);
  mocks.sessionStore.getSessionRpc.mockResolvedValue(rows.session ?? null);
  const current = rows.current ?? 'auth';
  const response = await loginRuntimeInteractionSubmitHandler(
    createContext({
      params: { interaction_id: 'interaction_1' },
      headers: {
        ...(rows.session ? { Cookie: 'authrim_session=sess_runtime_1' } : {}),
        ...rows.headers,
      },
      body: {
        step_id: `${current}:step`,
        node_id: current,
        contract_hash: signed.contractHash,
        signature: signed.signature,
        ...body,
      },
    })
  );
  return { response, data: await readJson(response) };
}

export function failures() {
  return auditRows()
    .filter((row) => row.overview.action === 'flow.interaction.failed')
    .map((row) => ({
      result: row.overview.result,
      reason_code: row.overview.reason_code,
      branch: row.row.branch_handle_id,
      node: row.row.node_id,
    }));
}
