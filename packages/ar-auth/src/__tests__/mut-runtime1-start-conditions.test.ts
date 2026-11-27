/**
 * The condition steps a start passes through: what their context is built of (the request, the
 * method chosen, the signed-in user's roles, organisations and attributes) and how a condition
 * that cannot decide ends the start.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowRuntimeContract } from '@authrim/ar-lib-core';
import {
  clearLoginRuntimeFlowVersionCacheForTests,
  loginRuntimeInteractionStartHandler,
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

type Step = FlowRuntimeContract['ui']['steps'][number];

const shown = (node: string): Step => ({
  id: `${node}:step`,
  source_node_id: node,
  component: 'consent_policy',
  render: true,
});
const edge = (source: string, target: string, handle = 'next') => ({
  id: `${source}-${target}-${handle}`,
  source,
  target,
  source_handle: handle,
});

function conditionFlow(conditions: unknown, options: { withSessionCheck?: boolean } = {}) {
  const steps = [
    ...(options.withSessionCheck
      ? [
          {
            id: 'session:step',
            source_node_id: 'session',
            component: 'session_check',
            render: false,
          },
        ]
      : []),
    {
      id: 'cond:step',
      source_node_id: 'cond',
      component: 'condition',
      render: false,
      config: { conditions },
    },
    shown('yes'),
    shown('no'),
    {
      id: 'auth:step',
      source_node_id: 'auth',
      component: 'authentication_method_selector',
      render: true,
    },
  ];
  return {
    runtime: { flow_kind: 'login', ui: { steps } } as unknown as FlowRuntimeContract,
    editor: {
      nodes: [],
      edges: [
        edge('session', 'cond', 'continue'),
        edge('session', 'no', 'authenticate'),
        edge('cond', 'yes', 'yes'),
        edge('cond', 'no', 'no'),
      ],
    },
  };
}

const when = (condition: Record<string, unknown>) => ({
  rows: [{ id: 'r', condition, output_handle: 'yes' }],
  otherwise: { output_handle: 'no' },
});

async function startWith(
  conditions: unknown,
  body: Record<string, unknown> = {},
  options: { signedIn?: boolean } = {}
) {
  clearLoginRuntimeFlowVersionCacheForTests();
  const { runtime, editor } = conditionFlow(conditions, { withSessionCheck: options.signedIn });
  if (body.client_id || body.saml_sp_id) mocks.coreAdapter.queryOne.mockResolvedValueOnce(null);
  mockStart(runtime, editor);
  if (options.signedIn) {
    mocks.sessionStore.getSessionRpc.mockResolvedValueOnce({
      userId: 'user_1',
      expiresAt: Date.now() + 60_000,
      createdAt: Date.now() - 1000,
      data: { authTime: Math.floor(Date.now() / 1000) },
    });
  }
  const response = await loginRuntimeInteractionStartHandler(
    createContext({
      body: { flow_kind: 'login', ...body },
      headers: options.signedIn ? { Cookie: 'authrim_session=sess_runtime_1' } : {},
    })
  );
  const data = await readJson(response);
  return {
    status: response.status,
    data,
    at: (data.interaction as { current_step_id?: string } | undefined)?.current_step_id,
  };
}

/** The overview of each audit row the start wrote. */
function auditOverviews(): unknown[] {
  return mocks.emitLog.mock.calls.map(([, row]) => (row as { overview: unknown }).overview);
}

beforeEach(() => resetHarness());

describe('a condition that cannot decide', () => {
  it.each([
    ['no conditions', undefined],
    ['conditions that are a list', []],
    ['rows that are not a list', { rows: 'x', otherwise: {} }],
    ['no otherwise', { rows: [] }],
    ['an otherwise that is not an object', { rows: [], otherwise: 'no' }],
  ])('refuses the start for %s', async (_label, conditions) => {
    const { status, data } = await startWith(conditions);
    expect(status).toBe(409);
    expect(data).toMatchObject({
      error: 'invalid_flow_branch',
      error_code: 'AR_FLOW_CONDITION_CONFIG_INVALID',
    });
    expect(auditOverviews()).toContainEqual(
      expect.objectContaining({
        action: 'flow.interaction.failed',
        result: 'configuration_error',
        reason_code: 'AR_FLOW_CONDITION_CONFIG_INVALID',
      })
    );
  });

  it('refuses the start when nothing matches and nothing is said otherwise', async () => {
    const { data } = await startWith({ ...when({ type: 'flow_kind', value: 'x' }), otherwise: {} });
    expect(data.error_code).toBe('AR_FLOW_CONDITION_NO_MATCH');
  });

  it('refuses the start when a row chooses a handle no edge takes', async () => {
    const { data } = await startWith({
      rows: [{ id: 'r', condition: { type: 'always' }, output_handle: 'maybe' }],
      otherwise: { output_handle: 'no' },
    });
    expect(data.error_code).toBe('AR_FLOW_INVALID_SELECTED_HANDLE');
  });

  it('ends the interaction with the terminal error the otherwise names', async () => {
    const otherwise = { terminal_error: { error: 'access_blocked', message: 'Not from here' } };
    const { status, data } = await startWith({ rows: [], otherwise });
    expect(status).toBe(409);
    expect(data).toMatchObject({
      error: 'access_blocked',
      error_description: 'Not from here',
      error_code: 'AR_FLOW_TERMINAL',
      category: 'terminal_error',
      action: 'show_terminal_error',
      interaction_id: 'interaction_1',
    });
    expect(auditOverviews()).toContainEqual(
      expect.objectContaining({
        result: 'terminal_error',
        reason_code: 'access_blocked',
      })
    );

    const plain = await startWith({ rows: [], otherwise: { terminal_error: { error: 'nope' } } });
    expect(plain.data.error_description).toBe('Flow condition ended this interaction');
  });
});

describe('the request a condition reads', () => {
  it.each([
    ['the client', { type: 'client_id', value: 'client_1' }, { client_id: 'client_1' }],
    ['the SAML SP', { type: 'saml_sp_id', value: 'sp_1' }, { saml_sp_id: 'sp_1' }],
    ['the OIDC protocol', { type: 'protocol', value: 'oidc' }, { client_id: 'client_1' }],
    ['the SAML protocol', { type: 'protocol', value: 'saml' }, { saml_sp_id: 'sp_1' }],
    ['the Flow kind', { type: 'flow_kind', value: 'login' }, {}],
    ['a requested scope', { type: 'requested_scope', value: 'email' }, { scope: 'openid email' }],
    ['the locale', { type: 'locale', operator: 'eq', value: 'ja' }, { locale: 'ja' }],
  ])('matches %s', async (_label, condition, body) => {
    expect((await startWith(when(condition), body)).at).toBe('yes:step');
  });

  it.each([
    ['a direct request as no protocol', { type: 'protocol', value: 'direct' }, {}],
    ['another client', { type: 'client_id', value: 'client_2' }, { client_id: 'client_1' }],
    ['no locale', { type: 'locale', operator: 'eq', value: 'en' }, {}],
    ['nobody signed in as not authenticated', { type: 'authenticated', value: true }, {}],
  ])('does not match %s', async (_label, condition, body) => {
    expect((await startWith(when(condition), body)).at).toBe('no:step');
  });
});

describe('the method a condition reads', () => {
  it('is the latest method chosen on a method selector step of this Flow', async () => {
    mocks.coreAdapter.query.mockImplementation(async (sql: string) =>
      String(sql).includes('SELECT step_id, selected_handle')
        ? [
            { step_id: 'other:step', selected_handle: 'passkey' },
            { step_id: 'auth:step', selected_handle: '  ' },
            { step_id: 'auth:step', selected_handle: 'mail_otp' },
          ]
        : []
    );
    expect((await startWith(when({ type: 'authentication_method', value: 'mail_otp' }))).at).toBe(
      'yes:step'
    );
    expect(mocks.coreAdapter.query).toHaveBeenCalledWith(
      expect.stringContaining('SELECT step_id, selected_handle'),
      ['tenant_test', 'interaction_1']
    );
    expect((await startWith(when({ type: 'authenticated', value: true }))).at).toBe('yes:step');
  });

  it('is none when only other steps chose one', async () => {
    mocks.coreAdapter.query.mockImplementation(async (sql: string) =>
      String(sql).includes('SELECT step_id, selected_handle')
        ? [{ step_id: 'other:step', selected_handle: 'passkey' }]
        : []
    );
    expect((await startWith(when({ type: 'authenticated', value: false }))).at).toBe('yes:step');
  });
});

describe('the signed-in user a condition reads', () => {
  const signedIn = { signedIn: true };
  const direct = { via: { kind: 'direct' }, scope_type: 'global', scope_target: '' };
  const held = (name: string, assignment: Record<string, unknown> = direct) => ({
    role: { name },
    assignment,
  });

  it('never reads the SCIM role table (user_roles)', async () => {
    mocks.resolveAccountCoreDataContext.mockReset().mockResolvedValue({ coreDb: {} });
    mocks.resolveSubjectRoles.mockResolvedValue([held('admin')]);
    expect((await startWith(when({ type: 'user.role', value: 'admin' }), {}, signedIn)).at).toBe(
      'yes:step'
    );
    for (const [sql] of mocks.coreAdapter.query.mock.calls)
      expect(String(sql)).not.toContain('user_roles');
  });

  it('has no roles without an account', async () => {
    expect((await startWith(when({ type: 'user.role', value: 'admin' }), {}, signedIn)).at).toBe(
      'no:step'
    );
    expect(mocks.resolveSubjectRoles).not.toHaveBeenCalled();
  });

  it('matches a role a group gives when it holds across the tenant', async () => {
    mocks.resolveAccountCoreDataContext.mockReset().mockResolvedValue({ coreDb: {} });
    const viaGroup = { kind: 'group', groupId: 'g1', throughGroupId: 'g1' };
    mocks.resolveSubjectRoles.mockResolvedValue([
      held('member', { via: viaGroup, scope_type: 'global', scope_target: '' }),
      // Held only for resources of one group: not a tenant-wide role.
      held('editor', { via: viaGroup, scope_type: 'group', scope_target: 'group:g2' }),
    ]);
    expect((await startWith(when({ type: 'user.role', value: 'member' }), {}, signedIn)).at).toBe(
      'yes:step'
    );
    expect((await startWith(when({ type: 'user.role', value: 'editor' }), {}, signedIn)).at).toBe(
      'no:step'
    );
  });

  it('does not match a directly assigned role held only for one resource', async () => {
    mocks.resolveAccountCoreDataContext.mockReset().mockResolvedValue({ coreDb: {} });
    mocks.resolveSubjectRoles.mockResolvedValue([
      held('owner', {
        via: { kind: 'direct' },
        scope_type: 'resource',
        scope_target: 'resource:doc:1',
      }),
      held('tenant-admin', {
        via: { kind: 'direct' },
        scope_type: 'tenant',
        scope_target: 'tenant_test',
      }),
    ]);
    expect((await startWith(when({ type: 'user.role', value: 'owner' }), {}, signedIn)).at).toBe(
      'no:step'
    );
    expect(
      (await startWith(when({ type: 'user.role', value: 'tenant-admin' }), {}, signedIn)).at
    ).toBe('yes:step');
  });

  it('reads the roles and groups of the account, each once', async () => {
    const account = { coreDb: { name: 'account-db' } };
    mocks.resolveAccountCoreDataContext.mockReset().mockResolvedValue(account);
    mocks.resolveSubjectRoles.mockResolvedValue([held('admin'), held('admin'), held('')]);
    mocks.resolveSubjectGroups.mockResolvedValue({ effectiveGroupIds: new Set(['grp_1']) });
    const conditions = {
      rows: [
        {
          id: 'r',
          condition: {
            type: 'all',
            all: [
              { type: 'user.role', value: 'admin' },
              { type: 'group_membership', group_ref: { id: 'grp_1' } },
            ],
          },
          output_handle: 'yes',
        },
      ],
      otherwise: { output_handle: 'no' },
    };
    expect((await startWith(conditions, {}, signedIn)).at).toBe('yes:step');
    const rbac = { metadata: mocks.coreAdapter, account: account.coreDb };
    expect(mocks.resolveAccountCoreDataContext).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'tenant_test',
      accountId: 'user_1',
    });
    expect(mocks.resolveSubjectRoles).toHaveBeenCalledWith(rbac, 'tenant_test', 'user_1');
    expect(mocks.resolveSubjectGroups).toHaveBeenCalledTimes(1);
    expect(mocks.resolveSubjectGroups).toHaveBeenCalledWith(
      rbac,
      'tenant_test',
      'user_1',
      expect.any(Number)
    );
    // Nothing reads an attribute: none is asked for.
    expect(mocks.readConditionAttributes).not.toHaveBeenCalled();
  });

  it('reads only the attributes the conditions name, for a user with an account', async () => {
    mocks.resolveAccountCoreDataContext.mockReset().mockResolvedValue({ coreDb: {} });
    mocks.readConditionAttributes.mockResolvedValue({ nationality: 'FR' });
    const condition = {
      type: 'user.attribute',
      attribute: 'nationality',
      operator: 'ne',
      value: 'JP',
    };
    expect((await startWith(when(condition), {}, signedIn)).at).toBe('yes:step');
    expect(mocks.readConditionAttributes).toHaveBeenCalledWith(['nationality']);
  });

  it('reads no attribute for a user without an account', async () => {
    const condition = {
      type: 'user.attribute',
      attribute: 'nationality',
      operator: 'eq',
      value: 'JP',
    };
    expect((await startWith(when(condition), {}, signedIn)).at).toBe('no:step');
    expect(mocks.readConditionAttributes).not.toHaveBeenCalled();
  });

  it('decides nothing on a group whose membership is not known, and decides on the others', async () => {
    mocks.resolveAccountCoreDataContext.mockReset().mockResolvedValue({ coreDb: {} });
    mocks.resolveSubjectRoles.mockResolvedValue([]);
    // grp_2's membership (a service group whose rule changed) is not known.
    mocks.resolveSubjectGroups.mockResolvedValue({
      effectiveGroupIds: new Set(['grp_1']),
      unknownGroupIds: new Set(['grp_2']),
    });
    const unknown = await startWith(
      when({ type: 'group_membership', group_ref: { id: 'grp_2' } }),
      {},
      signedIn
    );
    expect(unknown.status).toBe(409);
    expect(unknown.data.error_code).toBe('AR_FLOW_CONDITION_CONTEXT_UNAVAILABLE');
    // A condition on a known group is decided as usual.
    const known = await startWith(
      when({ type: 'group_membership', group_ref: { id: 'grp_1' } }),
      {},
      signedIn
    );
    expect(known.at).toBe('yes:step');
  });

  it('decides no "any group" condition while none is known and some is unknown', async () => {
    mocks.resolveAccountCoreDataContext.mockReset().mockResolvedValue({ coreDb: {} });
    mocks.resolveSubjectRoles.mockResolvedValue([]);
    const exists = when({ type: 'user.group', operator: 'exists' });
    mocks.resolveSubjectGroups.mockResolvedValue({
      effectiveGroupIds: new Set<string>(),
      unknownGroupIds: new Set(['grp_2']),
    });
    const unknown = await startWith(exists, {}, signedIn);
    expect(unknown.status).toBe(409);
    expect(unknown.data.error_code).toBe('AR_FLOW_CONDITION_CONTEXT_UNAVAILABLE');
    // One group known: there is a group, whatever the unknown one is.
    mocks.resolveSubjectGroups.mockResolvedValue({
      effectiveGroupIds: new Set(['grp_1']),
      unknownGroupIds: new Set(['grp_2']),
    });
    expect((await startWith(exists, {}, signedIn)).at).toBe('yes:step');
  });

  it('reads not_exists by its operator, whatever value is left on it', async () => {
    mocks.resolveAccountCoreDataContext.mockReset().mockResolvedValue({ coreDb: {} });
    mocks.resolveSubjectRoles.mockResolvedValue([]);
    mocks.resolveSubjectGroups.mockResolvedValue({
      effectiveGroupIds: new Set<string>(),
      unknownGroupIds: new Set(['grp_2']),
    });
    // A value left from an earlier operator: not_exists still reads "any group at all".
    const { status, data } = await startWith(
      when({ type: 'user.group', operator: 'not_exists', value: 'grp_1' }),
      {},
      signedIn
    );
    expect(status).toBe(409);
    expect(data.error_code).toBe('AR_FLOW_CONDITION_CONTEXT_UNAVAILABLE');
  });

  it('decides a branch that reads no role while the roles are incomplete', async () => {
    mocks.resolveAccountCoreDataContext.mockReset().mockResolvedValue({ coreDb: {} });
    mocks.resolveSubjectRoles.mockResolvedValue([]);
    // A role-bearing service group's membership is unknown: only a role condition cares.
    mocks.resolveSubjectGroups.mockResolvedValue({
      effectiveGroupIds: new Set<string>(),
      unknownGroupIds: new Set(['grp_9']),
      rolesComplete: false,
    });
    expect((await startWith(when({ type: 'flow_kind', value: 'login' }), {}, signedIn)).at).toBe(
      'yes:step'
    );
  });

  it('judges per condition whether it names a group (two naming the same one)', async () => {
    mocks.resolveAccountCoreDataContext.mockReset().mockResolvedValue({ coreDb: {} });
    mocks.resolveSubjectRoles.mockResolvedValue([]);
    mocks.resolveSubjectGroups.mockResolvedValue({
      effectiveGroupIds: new Set<string>(),
      unknownGroupIds: new Set(['grp_9']),
    });
    // Both name grp_1 (known: not a member): decided, not "any group" on unknown memberships.
    const both = when({
      type: 'all',
      all: [
        { type: 'user.group', value: 'grp_1' },
        { type: 'user.group', value: 'grp_1' },
      ],
    });
    expect((await startWith(both, {}, signedIn)).at).toBe('no:step');
  });

  it('decides nothing while the roles are incomplete', async () => {
    mocks.resolveAccountCoreDataContext.mockReset().mockResolvedValue({ coreDb: {} });
    mocks.resolveSubjectRoles.mockResolvedValue([]);
    // An unknown group with a role grant: "has no role X" cannot be decided.
    mocks.resolveSubjectGroups.mockResolvedValue({
      effectiveGroupIds: new Set<string>(),
      unknownGroupIds: new Set(['grp_9']),
      rolesComplete: false,
    });
    const { status, data } = await startWith(
      when({ type: 'user.role', value: 'admin' }),
      {},
      signedIn
    );
    expect(status).toBe(409);
    expect(data.error_code).toBe('AR_FLOW_CONDITION_CONTEXT_UNAVAILABLE');
  });

  it('decides nothing when the account cannot be read', async () => {
    mocks.resolveAccountCoreDataContext.mockReset().mockRejectedValue(new Error('db down'));
    const { status, data } = await startWith(
      when({ type: 'user.role', value: 'admin' }),
      {},
      signedIn
    );
    expect(status).toBe(409);
    expect(data.error_code).toBe('AR_FLOW_CONDITION_CONTEXT_UNAVAILABLE');
    expect(mocks.warn).toHaveBeenCalledWith(
      'Flow condition context unavailable',
      expect.objectContaining({ tenantId: 'tenant_test', errorType: 'Error' })
    );
  });
});
