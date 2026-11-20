/**
 * A submit once it holds the interaction (submitClaimedRuntimeStep): the step's visit, the
 * published runtime, a Flow that ends or cannot go on after the step, a screen's answers and a
 * consent step's statements.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAdapter } from './helpers/mut-runtime2-requests';
import {
  failures,
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

import { flowOf } from './helpers/mut-runtime2-submit-rows';
const auth = {
  id: 'auth:step',
  source_node_id: 'auth',
  component: 'authentication_method_selector',
  render: true,
};
const complete = { id: 'complete:step', source_node_id: 'complete', component: 'completion' };

const endsWith = (terminal: Record<string, unknown>) => ({
  id: 'c:step',
  source_node_id: 'c',
  component: 'condition',
  render: false,
  config: { conditions: { rows: [], otherwise: { terminal_error: terminal } } },
});

describe('a submit that holds its interaction', () => {
  let signed: Signed;
  beforeEach(async () => {
    signed = await signedInteraction();
  });

  it('goes on for a request made on the current visit of the step', async () => {
    const { response, data } = await submit(
      signed,
      { runtime: flowOf(auth, { ...complete, render: true }) },
      { selected_handle: 'passkey', visit_id: 'step_1' }
    );
    expect(response.status).toBe(200);
    expect(data.interaction).toMatchObject({ current_step_id: 'complete:step' });
  });

  it.each([
    ['without a visit', null],
    ['completed', { id: 'step_1', state: 'completed' }],
    ['failed', { id: 'step_1', state: 'failed' }],
  ])('refuses a step whose visit is %s', async (_label, step) => {
    const { response, data } = await submit(
      signed,
      { runtime: flowOf(auth, complete), step },
      { selected_handle: 'passkey' }
    );
    expect(response.status).toBe(409);
    expect(data).toEqual({
      error: 'step_not_active',
      error_description: 'The submitted Flow step is no longer active',
      error_code: 'AR_FLOW_STEP_NOT_ACTIVE',
      category: 'restart_required',
      action: 'restart_interaction',
      interaction_id: 'interaction_1',
    });
  });

  it('answers a configuration error when the published version or the step is gone', async () => {
    const gone = await submit(signed, { runtime: flowOf(auth), version: false });
    expect(gone.response.status).toBe(409);
    expect(gone.data).toEqual({
      error: 'flow_version_unavailable',
      error_description: 'Published Flow version is unavailable',
      error_code: 'AR_FLOW_VERSION_UNAVAILABLE',
      category: 'configuration_error',
      action: 'contact_administrator',
      interaction_id: 'interaction_1',
    });

    await resetAdapter();
    const missing = await submit(signed, { runtime: flowOf(complete), current: 'auth' });
    expect(missing.response.status).toBe(409);
    expect(missing.data).toEqual({
      error: 'flow_runtime_invalid',
      error_description: 'Active Flow step is not present in the published runtime',
      error_code: 'AR_FLOW_RUNTIME_INVALID',
      category: 'configuration_error',
      action: 'contact_administrator',
      interaction_id: 'interaction_1',
    });
  });

  it('records and answers a condition submitted that ends the interaction', async () => {
    const { response, data } = await submit(signed, {
      runtime: flowOf(endsWith({ error: 'blocked' }), complete),
      current: 'c',
    });
    expect(response.status).toBe(409);
    expect(data).toEqual({
      error: 'blocked',
      error_description: 'Flow condition ended this interaction',
      error_code: 'AR_FLOW_TERMINAL',
      category: 'terminal_error',
      action: 'show_terminal_error',
      interaction_id: 'interaction_1',
    });
    expect(failures()).toEqual([
      { result: 'terminal_error', reason_code: 'blocked', branch: null, node: 'c' },
    ]);
  });

  it('records and answers a Flow that ends on the steps after the submit', async () => {
    const { response, data } = await submit(
      signed,
      { runtime: flowOf(auth, endsWith({ error: 'blocked', message: 'Not here' }), complete) },
      { selected_handle: 'passkey' }
    );
    expect(response.status).toBe(409);
    expect(data).toMatchObject({
      error: 'blocked',
      error_description: 'Not here',
      error_code: 'AR_FLOW_TERMINAL',
    });
    expect(failures()).toEqual([
      { result: 'terminal_error', reason_code: 'blocked', branch: 'passkey', node: 'auth' },
    ]);
  });

  it('records and answers a branch after the submit that leads nowhere', async () => {
    const pass = {
      id: 'p:step',
      source_node_id: 'p',
      component: 'interaction_context',
      render: false,
    };
    const { response, data } = await submit(
      signed,
      {
        runtime: flowOf(auth, pass, complete),
        editor: {
          nodes: [
            { id: 'auth', type: 'authentication' },
            { id: 'p', type: 'entry' },
            { id: 'complete', type: 'complete' },
          ],
          edges: [
            { id: 'e1', source: 'auth', target: 'p', source_handle: 'passkey' },
            { id: 'e2', source: 'p', target: 'ghost', source_handle: 'next' },
          ],
        },
      },
      { selected_handle: 'passkey' }
    );
    expect(response.status).toBe(409);
    expect(data).toEqual({
      error: 'invalid_flow_branch',
      error_description: 'Submitted Flow branch does not match the active Flow step',
      error_code: 'AR_FLOW_EDGE_TARGET_MISSING',
      category: 'configuration_error',
      action: 'contact_administrator',
      interaction_id: 'interaction_1',
    });
    expect(failures()).toEqual([
      {
        result: 'configuration_error',
        reason_code: 'AR_FLOW_EDGE_TARGET_MISSING',
        branch: 'passkey',
        node: 'auth',
      },
    ]);
  });

  it('records a way out the step does not have as a security failure', async () => {
    const { response, data } = await submit(
      signed,
      {
        runtime: flowOf(auth, complete),
        editor: {
          nodes: [
            { id: 'auth', type: 'authentication' },
            { id: 'complete', type: 'complete' },
          ],
          edges: [{ id: 'e1', source: 'auth', target: 'complete', source_handle: 'passkey' }],
        },
      },
      { selected_handle: 'mail_otp' }
    );
    expect(response.status).toBe(409);
    expect(data).toMatchObject({
      error: 'invalid_flow_branch',
      error_code: 'AR_FLOW_INVALID_SELECTED_HANDLE',
      category: 'security_error',
    });
    expect(failures()).toEqual([
      {
        result: 'security_error',
        reason_code: 'AR_FLOW_INVALID_SELECTED_HANDLE',
        branch: 'mail_otp',
        node: 'auth',
      },
    ]);
  });
});
