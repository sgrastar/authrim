/**
 * Starting a runtime interaction: each refusal before one is created, a Flow that ends or cannot
 * go on from its first steps, and what is written for the steps passed on the way.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowRuntimeContract } from '@authrim/ar-lib-core';
import { loginRuntimeInteractionStartHandler } from '../login-runtime-flow';
import { auditRows, mocks } from './helpers/mut-runtime2-mocks';
import {
  createContext,
  mockStartQueries,
  readJson,
  resetAdapter,
  txExecuteCalls,
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

const flowOf = (...steps: Array<Record<string, unknown>>) =>
  ({ flow_kind: 'login', ui: { steps } }) as unknown as FlowRuntimeContract;
const entry = {
  id: 'entry:step',
  source_node_id: 'entry',
  component: 'interaction_context',
  render: false,
};
const sessionCheck = {
  id: 'sc:step',
  source_node_id: 'sc',
  component: 'session_check',
  render: false,
};
const auth = {
  id: 'auth:step',
  source_node_id: 'auth',
  component: 'authentication_method_selector',
  render: true,
};
const endsWith = (terminal: Record<string, unknown>) => ({
  id: 'c:step',
  source_node_id: 'c',
  component: 'condition',
  render: false,
  config: { conditions: { rows: [], otherwise: { terminal_error: terminal } } },
});

async function start(
  body: Record<string, unknown> = { flow_kind: 'login' },
  env: Record<string, unknown> = {}
) {
  const response = await loginRuntimeInteractionStartHandler(createContext({ body, env }));
  return { response, data: await readJson(response) };
}

function auditActions() {
  return auditRows().map((row) => ({
    action: row.overview.action,
    result: row.overview.result,
    reason_code: row.overview.reason_code,
    node_id: row.row.node_id,
  }));
}

function written(sqlStart: string) {
  return txExecuteCalls
    .filter(([sql]) => sql.replace(/\s+/g, ' ').trim().startsWith(sqlStart))
    .map(([, params]) => params ?? []);
}

describe('starting a runtime interaction', () => {
  beforeEach(async () => {
    await resetAdapter();
  });

  it('is refused while the runtime Flow is off', async () => {
    const { response, data } = await start(
      { flow_kind: 'login' },
      {
        ENABLE_LOGIN_RUNTIME_FLOW: 'false',
      }
    );
    expect(response.status).toBe(403);
    expect(data).toMatchObject({
      error: 'flow_runtime_disabled',
      error_description: 'LoginUI runtime Flow is disabled',
    });
    expect(mocks.coreAdapter.queryOne).not.toHaveBeenCalled();
  });

  it('reads an unreadable body as an empty one', async () => {
    const c = createContext({});
    (c.req.json as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new SyntaxError('bad'));
    mocks.coreAdapter.queryOne.mockResolvedValue(null);
    const response = await loginRuntimeInteractionStartHandler(c);
    // An empty body is a sign-in for the tenant: its assignment is looked for.
    expect(response.status).toBe(409);
    expect(await readJson(response)).toMatchObject({ error: 'flow_assignment_missing' });
  });

  it('describes an invalid target and a flow kind it does not run', async () => {
    const target = await start({ flow_kind: 'login', client_id: 'c', saml_sp_id: 's' });
    expect(target.response.status).toBe(400);
    expect(target.data).toMatchObject({
      error: 'invalid_target',
      error_description: 'Flow assignment target is invalid',
    });
    const kind = await start({ flow_kind: 'credential_issuance' });
    expect(kind.data).toMatchObject({
      error: 'unsupported_flow_kind',
      error_description: 'This flow kind is not executed by the LoginUI runtime',
    });
  });

  it('creates nothing without a published assignment or version', async () => {
    mocks.coreAdapter.queryOne.mockResolvedValueOnce(null);
    const noAssignment = await start();
    expect(noAssignment.response.status).toBe(409);
    expect(noAssignment.data).toMatchObject({
      error: 'flow_assignment_missing',
      error_description: 'No published Flow assignment is available',
    });

    mocks.coreAdapter.queryOne
      .mockResolvedValueOnce({
        flow_id: 'flow_login',
        target_type: 'tenant',
        target_id: null,
        flow_kind: 'login',
        published_version_id: 'fv_1',
      })
      .mockResolvedValueOnce(null);
    const noVersion = await start();
    expect(noVersion.response.status).toBe(409);
    expect(noVersion.data).toMatchObject({
      error: 'flow_version_unavailable',
      error_description: 'Published Flow version is unavailable',
    });
    expect(mocks.coreAdapter.batch).not.toHaveBeenCalled();
  });

  it('creates nothing for a Flow without steps, or without its signing secret', async () => {
    mockStartQueries(flowOf());
    const empty = await start();
    expect(empty.response.status).toBe(409);
    expect(empty.data).toMatchObject({
      error: 'flow_runtime_invalid',
      error_description: 'Published Flow runtime has no executable steps',
    });

    // A new version, read anew (the published version is cached).
    await resetAdapter();
    mockStartQueries(flowOf(auth));
    const unsigned = await start({ flow_kind: 'login' }, { FLOW_RUNTIME_HMAC_SECRET: '' });
    expect(unsigned.response.status).toBe(500);
    expect(unsigned.data).toMatchObject({
      error: 'flow_runtime_secret_missing',
      error_description: 'Flow runtime signing secret is not configured',
    });
    expect(mocks.coreAdapter.batch).not.toHaveBeenCalled();
  });

  it('records and answers a Flow that ends on its first steps', async () => {
    mockStartQueries(flowOf(endsWith({ error: 'unsupported_protocol' })));
    const { response, data } = await start();
    expect(response.status).toBe(409);
    expect(data).toEqual({
      error: 'unsupported_protocol',
      error_description: 'Flow condition ended this interaction',
      error_code: 'AR_FLOW_TERMINAL',
      category: 'terminal_error',
      action: 'show_terminal_error',
      interaction_id: 'interaction_1',
    });
    expect(auditActions()).toContainEqual({
      action: 'flow.interaction.failed',
      result: 'terminal_error',
      reason_code: 'unsupported_protocol',
      node_id: 'c',
    });
  });

  it("answers the Flow's own message when it ends with one", async () => {
    mockStartQueries(flowOf(endsWith({ error: 'blocked', message: 'Not from here' })));
    const { data } = await start();
    expect(data).toMatchObject({ error: 'blocked', error_description: 'Not from here' });
  });

  it('records and answers a first branch that leads nowhere', async () => {
    mockStartQueries(flowOf(entry, auth), {
      nodes: [
        { id: 'entry', type: 'entry' },
        { id: 'auth', type: 'authentication' },
      ],
      edges: [{ id: 'e', source: 'entry', target: 'ghost', source_handle: 'next' }],
    });
    const { response, data } = await start();
    expect(response.status).toBe(409);
    expect(data).toEqual({
      error: 'invalid_flow_branch',
      error_description: 'Published Flow initial branch cannot be evaluated',
      error_code: 'AR_FLOW_EDGE_TARGET_MISSING',
      category: 'configuration_error',
      action: 'contact_administrator',
      interaction_id: 'interaction_1',
    });
    expect(auditActions()).toContainEqual({
      action: 'flow.interaction.failed',
      result: 'configuration_error',
      reason_code: 'AR_FLOW_EDGE_TARGET_MISSING',
      node_id: 'entry',
    });
  });

  it('answers a Flow whose first steps show nothing', async () => {
    mockStartQueries(flowOf(entry));
    const { response, data } = await start();
    expect(response.status).toBe(409);
    expect(data).toMatchObject({
      error: 'flow_runtime_invalid',
      error_description: 'Published Flow runtime has no displayable initial step',
    });
  });

  it('completes the steps passed on the way, and answers the visit of the step shown', async () => {
    mockStartQueries(flowOf(entry, sessionCheck, auth));
    const { response, data } = await start();
    expect(response.status).toBe(200);

    const [completedFirst] = written("UPDATE flow_interaction_steps SET state = 'completed'");
    expect(completedFirst?.[0]).toBeNull();
    expect(JSON.parse(String(completedFirst?.[1]))).toMatchObject({
      selected_handle: null,
      submitted_handle: null,
      auto_advanced: true,
    });
    expect(completedFirst?.slice(3)).toEqual(['tenant_test', 'step_1']);

    const visits = written('INSERT INTO flow_interaction_steps');
    // The first step's visit, the session check passed, and the visit of the step shown.
    expect(visits.map((params) => params[3])).toEqual(['entry', 'sc', 'auth']);
    expect(visits[1]?.slice(1, 6)).toEqual([
      'tenant_test',
      'interaction_1',
      'sc',
      'sc:step',
      'authenticate',
    ]);
    expect(JSON.parse(String(visits[1]?.[6]))).toMatchObject({
      selected_handle: 'authenticate',
      auto_advanced: true,
    });
    expect(visits[2]?.[5]).toBe('waiting_input');
    expect((data.interaction as Record<string, unknown>).current_visit_id).toBe(visits[2]?.[0]);

    const [moved] = written('UPDATE flow_interactions SET user_id = COALESCE');
    expect(moved).toEqual([
      null,
      'auth',
      'auth:step',
      expect.any(Number),
      'tenant_test',
      'interaction_1',
    ]);

    expect(auditActions().map(({ action, node_id }) => [action, node_id])).toEqual([
      ['flow.interaction.started', 'entry'],
      ['flow.node.completed', 'entry'],
      ['flow.node.completed', 'sc'],
      ['flow.node.entered', 'auth'],
    ]);
    const handles = mocks.emitLog.mock.calls.map(
      ([, row]) => (row.row as Record<string, unknown>).branch_handle_id
    );
    expect(handles).toEqual([null, null, 'authenticate', null]);
  });

  it('writes nothing more when the first step is the one shown', async () => {
    mockStartQueries(flowOf(auth));
    const { data } = await start();
    expect((data.interaction as Record<string, unknown>).current_visit_id).toBe('step_1');
    expect(written('INSERT INTO flow_interaction_steps')).toHaveLength(1);
    expect(written('INSERT INTO flow_interaction_steps')[0]?.[5]).toBe('waiting_input');
    expect(written("UPDATE flow_interaction_steps SET state = 'completed'")).toEqual([]);
  });
});
