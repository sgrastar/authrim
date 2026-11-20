/**
 * The start of a runtime interaction: which app and Flow kind it is for (resolveTarget,
 * normalizeFlowKind), which assignment is read for it, and the request context it records.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearLoginRuntimeFlowVersionCacheForTests,
  loginRuntimeInteractionStartHandler,
} from '../login-runtime-flow';
import {
  assignmentRow,
  createContext,
  insertedInteraction,
  loginRuntime,
  mocks,
  readJson,
  resetHarness,
  versionRow,
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

async function start(body: Record<string, unknown>) {
  const response = await loginRuntimeInteractionStartHandler(createContext({ body }));
  return { response, data: await readJson(response) };
}

/** The parameters of each assignment read the start made. */
function assignmentReads(): unknown[][] {
  return mocks.coreAdapter.queryOne.mock.calls
    .filter(([sql]) => String(sql).includes('FROM flow_assignments'))
    .map(([, params]) => params as unknown[]);
}

beforeEach(() => {
  resetHarness();
  clearLoginRuntimeFlowVersionCacheForTests();
});

describe('the Flow kind a start runs', () => {
  it.each([
    ['an unknown kind', 'bogus'],
    ['a kind that only ends like a custom one', 'mine:custom:'],
    ['a number', 42],
    ['an empty kind', ''],
  ])('refuses %s before reading anything', async (_label, flowKind) => {
    const { response, data } = await start({ flow_kind: flowKind });
    expect(response.status).toBe(400);
    expect(data.error).toBe('unsupported_flow_kind');
    expect(mocks.coreAdapter.queryOne).not.toHaveBeenCalled();
  });

  it.each([
    ['no kind', undefined, 'login'],
    ['a null kind', null, 'login'],
    ['a standard kind', 'registration', 'registration'],
    ['a custom kind', 'custom:onboarding', 'custom:onboarding'],
  ])('reads the assignment of %s', async (_label, flowKind, expected) => {
    mocks.coreAdapter.queryOne
      .mockResolvedValueOnce(assignmentRow({ flow_kind: expected }))
      .mockResolvedValueOnce(versionRow());
    const { response } = await start({ flow_kind: flowKind });
    expect(response.status).toBe(200);
    expect(assignmentReads()).toEqual([['tenant_test', expected]]);
  });
});

describe('the app a start is for', () => {
  it.each([
    ['a tenant target naming an OIDC client', { target_type: 'tenant', client_id: 'client_1' }],
    ['a tenant target naming a SAML SP', { target_type: 'tenant', saml_sp_id: 'sp_1' }],
    [
      'a client target naming another client',
      { target_type: 'oidc_client', target_id: 'client_1', client_id: 'client_2' },
    ],
    [
      'a client target naming a SAML SP',
      { target_type: 'oidc_client', target_id: 'client_1', saml_sp_id: 'sp_1' },
    ],
    ['a client target without its id', { target_type: 'oidc_client' }],
    [
      'an SP target naming another SP',
      { target_type: 'saml_sp', target_id: 'sp_1', saml_sp_id: 'sp_2' },
    ],
    [
      'an SP target naming an OIDC client',
      { target_type: 'saml_sp', target_id: 'sp_1', client_id: 'client_1' },
    ],
    ['an SP target without its id', { target_type: 'saml_sp', target_id: '  ' }],
    ['an unknown target type', { target_type: 'device', target_id: 'd_1' }],
    ['both an OIDC client and a SAML SP', { client_id: 'client_1', saml_sp_id: 'sp_1' }],
  ])('refuses %s', async (_label, target) => {
    const { response, data } = await start({ flow_kind: 'login', ...target });
    expect(response.status).toBe(400);
    expect(data).toMatchObject({
      error: 'invalid_target',
      error_description: 'Flow assignment target is invalid',
      error_code: 'AR_FLOW_RUNTIME_ERROR',
    });
    expect(mocks.coreAdapter.queryOne).not.toHaveBeenCalled();
  });

  it('reads only the tenant assignment for an explicit tenant target', async () => {
    mocks.coreAdapter.queryOne
      .mockResolvedValueOnce(assignmentRow())
      .mockResolvedValueOnce(versionRow());
    const { response, data } = await start({ flow_kind: 'login', target_type: 'tenant' });
    expect(response.status).toBe(200);
    expect(assignmentReads()).toEqual([['tenant_test', 'login']]);
    expect(insertedInteraction().params.slice(4, 6)).toEqual([null, null]);
    expect(insertedInteraction().context).toMatchObject({
      protocol: 'direct',
      target_type: 'tenant',
      target_id: null,
    });
    expect(data.contract).toMatchObject({ protocol_context: { oidc: null, saml: null } });
  });

  it.each([
    [
      'an explicit client target',
      { target_type: 'oidc_client', target_id: 'client_1', client_id: 'client_1' },
      ['oidc_client', 'client_1'],
      ['client_1', null],
      'oidc',
    ],
    [
      'an explicit client target without the client id repeated',
      { target_type: 'oidc_client', target_id: 'client_1' },
      ['oidc_client', 'client_1'],
      ['client_1', null],
      'oidc',
    ],
    [
      'an explicit SP target',
      { target_type: 'saml_sp', target_id: 'sp_1', saml_sp_id: 'sp_1' },
      ['saml_sp', 'sp_1'],
      [null, 'sp_1'],
      'saml',
    ],
    [
      'an explicit SP target without the SP id repeated',
      { target_type: 'saml_sp', target_id: 'sp_1' },
      ['saml_sp', 'sp_1'],
      [null, 'sp_1'],
      'saml',
    ],
    [
      'a client id',
      { client_id: ' client_1 ' },
      ['oidc_client', 'client_1'],
      ['client_1', null],
      'oidc',
    ],
    ['an SP id', { saml_sp_id: 'sp_1' }, ['saml_sp', 'sp_1'], [null, 'sp_1'], 'saml'],
  ])(
    'reads the app assignment first for %s, then the tenant default',
    async (_label, target, [targetType, targetId], recorded, protocol) => {
      mocks.coreAdapter.queryOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(assignmentRow())
        .mockResolvedValueOnce(versionRow());
      const { response } = await start({ flow_kind: 'login', ...target });
      expect(response.status).toBe(200);
      expect(assignmentReads()).toEqual([
        ['tenant_test', targetType, targetId, 'login'],
        ['tenant_test', 'login'],
      ]);
      const { params, context } = insertedInteraction();
      expect(params.slice(4, 6)).toEqual(recorded);
      expect(context).toMatchObject({ protocol, target_type: targetType, target_id: targetId });
    }
  );

  it('runs the app assignment when there is one, without reading the tenant default', async () => {
    mocks.coreAdapter.queryOne
      .mockResolvedValueOnce(
        assignmentRow({ flow_id: 'flow_app', target_type: 'oidc_client', target_id: 'client_1' })
      )
      .mockResolvedValueOnce(versionRow(loginRuntime, null, { flow_id: 'flow_app' }));
    const { response, data } = await start({ flow_kind: 'login', client_id: 'client_1' });
    expect(response.status).toBe(200);
    expect(assignmentReads()).toHaveLength(1);
    expect(data.contract).toMatchObject({ flow_id: 'flow_app', flow_version_id: 'fv_1' });
    expect(insertedInteraction().params[2]).toBe('flow_app');
  });
});

describe('what a start needs to run', () => {
  it('answers flow_assignment_missing when no Flow is assigned', async () => {
    mocks.coreAdapter.queryOne.mockResolvedValueOnce(null);
    const { response, data } = await start({ flow_kind: 'login' });
    expect(response.status).toBe(409);
    expect(data.error).toBe('flow_assignment_missing');
    expect(mocks.coreAdapter.batch).not.toHaveBeenCalled();
  });

  it.each([
    ['no published version', assignmentRow({ published_version_id: null }), undefined],
    ['a version that is gone', assignmentRow(), null],
    ['a snapshot that is not JSON', assignmentRow(), versionRow('{not json')],
    ['a snapshot without steps', assignmentRow(), versionRow({ flow_kind: 'login', ui: {} })],
    ['a null snapshot', assignmentRow(), versionRow('null')],
  ])('answers flow_version_unavailable for %s', async (_label, assignment, version) => {
    mocks.coreAdapter.queryOne.mockResolvedValueOnce(assignment);
    if (version !== undefined) mocks.coreAdapter.queryOne.mockResolvedValueOnce(version);
    const { response, data } = await start({ flow_kind: 'login' });
    expect(response.status).toBe(409);
    expect(data.error).toBe('flow_version_unavailable');
    expect(mocks.coreAdapter.batch).not.toHaveBeenCalled();
  });

  it.each([
    ['no steps', []],
    ['a first step without an id', [{ source_node_id: 'auth', component: 'completion' }]],
    ['a first step without a node', [{ id: 'auth:step', component: 'completion' }]],
  ])('answers flow_runtime_invalid for %s', async (_label, steps) => {
    mocks.coreAdapter.queryOne
      .mockResolvedValueOnce(assignmentRow())
      .mockResolvedValueOnce(versionRow({ flow_kind: 'login', ui: { steps } }));
    const { response, data } = await start({ flow_kind: 'login' });
    expect(response.status).toBe(409);
    expect(data.error).toBe('flow_runtime_invalid');
  });

  it('answers flow_runtime_secret_missing without a signing secret, and writes nothing', async () => {
    mocks.coreAdapter.queryOne
      .mockResolvedValueOnce(assignmentRow())
      .mockResolvedValueOnce(versionRow());
    const response = await loginRuntimeInteractionStartHandler(
      createContext({ body: { flow_kind: 'login' }, env: { FLOW_RUNTIME_HMAC_SECRET: '' } })
    );
    expect(response.status).toBe(500);
    expect((await readJson(response)).error).toBe('flow_runtime_secret_missing');
    expect(mocks.coreAdapter.batch).not.toHaveBeenCalled();
  });

  it('reads a published version once while it is cached', async () => {
    mocks.coreAdapter.queryOne
      .mockResolvedValueOnce(assignmentRow())
      .mockResolvedValueOnce(versionRow())
      .mockResolvedValueOnce(assignmentRow());
    expect((await start({ flow_kind: 'login' })).response.status).toBe(200);
    expect((await start({ flow_kind: 'login' })).response.status).toBe(200);
    const versionReads = mocks.coreAdapter.queryOne.mock.calls.filter(([sql]) =>
      String(sql).includes('FROM flow_versions')
    );
    expect(versionReads).toEqual([[expect.any(String), ['tenant_test', 'flow_login', 'fv_1']]]);
  });
});

describe('the caches of a start', () => {
  it('let go of the oldest version and contract past 256 of them', async () => {
    let current = 'fv_0';
    mocks.coreAdapter.queryOne.mockImplementation(async (sql: string, params: unknown[]) => {
      if (String(sql).includes('FROM flow_assignments')) {
        return assignmentRow({ published_version_id: current });
      }
      if (String(sql).includes('FROM flow_versions')) {
        return versionRow(loginRuntime, null, { id: params[2] });
      }
      return null;
    });
    const settings = { get: vi.fn(async (..._args: unknown[]): Promise<string | null> => null) };
    const startVersion = async (versionId: string) => {
      current = versionId;
      const response = await loginRuntimeInteractionStartHandler(
        createContext({ body: { flow_kind: 'login' }, env: { SETTINGS: settings } })
      );
      expect(response.status).toBe(200);
    };
    const reads = () => ({
      versions: mocks.coreAdapter.queryOne.mock.calls.filter(([sql]) =>
        String(sql).includes('FROM flow_versions')
      ).length,
      contracts: settings.get.mock.calls.filter(
        ([key]) => key === 'settings:tenant:tenant_test:authentication-methods'
      ).length,
    });

    await startVersion('fv_0');
    await startVersion('fv_0');
    expect(reads()).toEqual({ versions: 1, contracts: 1 });
    for (let index = 1; index <= 256; index += 1) await startVersion(`fv_${index}`);
    expect(reads()).toEqual({ versions: 257, contracts: 257 });
    // fv_1 is still kept, fv_0 is not.
    await startVersion('fv_1');
    expect(reads()).toEqual({ versions: 257, contracts: 257 });
    await startVersion('fv_0');
    expect(reads()).toEqual({ versions: 258, contracts: 258 });
  });
});
