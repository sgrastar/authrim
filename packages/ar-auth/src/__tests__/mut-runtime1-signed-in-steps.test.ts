/**
 * Steps a start passes for a person a session check found: the email check of a sign-up whose
 * account has no address (signedInUserHasNoEmail), and the statements of a consent step the person
 * has answered already (statementAlreadyAnswered).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowRuntimeContract } from '@authrim/ar-lib-core';
import {
  clearLoginRuntimeFlowVersionCacheForTests,
  loginRuntimeInteractionStartHandler,
} from '../login-runtime-flow';
import {
  assignmentRow,
  createContext,
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

const sessionStep = {
  id: 'session:step',
  source_node_id: 'session',
  component: 'session_check',
  render: false,
};
const shown = (node: string, config?: Record<string, unknown>) => ({
  id: `${node}:step`,
  source_node_id: node,
  component: 'consent_policy',
  render: true,
  ...(config ? { config } : {}),
});
const edge = (source: string, target: string, handle: string) => ({
  id: `${source}-${handle}`,
  source,
  target,
  source_handle: handle,
});

async function startSignedIn(
  flowKind: 'login' | 'registration',
  steps: unknown[],
  edges: unknown[],
  session: Record<string, unknown> = {}
) {
  clearLoginRuntimeFlowVersionCacheForTests();
  const runtime = { flow_kind: flowKind, ui: { steps } } as unknown as FlowRuntimeContract;
  mocks.coreAdapter.queryOne
    .mockResolvedValueOnce(assignmentRow({ flow_kind: flowKind }))
    .mockResolvedValueOnce(versionRow(runtime, { nodes: [], edges }));
  mocks.sessionStore.getSessionRpc.mockResolvedValue({
    userId: 'user_1',
    expiresAt: Date.now() + 600_000,
    // Made in this interaction, after it began (a registration takes no session from before).
    createdAt: Date.now() + 1_000,
    data: { authTime: Math.floor(Date.now() / 1000), runtime_interaction_id: 'interaction_1' },
    ...session,
  });
  const response = await loginRuntimeInteractionStartHandler(
    createContext({
      body: { flow_kind: flowKind },
      headers: { Cookie: 'authrim_session=sess_1' },
    })
  );
  const data = await readJson(response);
  expect(response.status).toBe(200);
  return data;
}

const at = (data: Record<string, unknown>) =>
  (data.interaction as { current_step_id: string }).current_step_id;

beforeEach(() => resetHarness());

describe('the email check of a sign-up for an account without an address', () => {
  const steps = [
    sessionStep,
    { id: 'ev:step', source_node_id: 'ev', component: 'email_verification', render: false },
    shown('done'),
    shown('sign-in'),
  ];
  const edges = [
    edge('session', 'ev', 'continue'),
    edge('session', 'sign-in', 'authenticate'),
    edge('ev', 'done', 'verified'),
  ];
  const account = (extra: Record<string, unknown> = {}) => ({
    id: 'user_1',
    active: 1,
    email: null,
    account_id: 'acct_1',
    subject_id: 'subj_1',
    ...extra,
  });

  it('goes on by its verified edge when the account has no address anywhere', async () => {
    mocks.runtimeUsers.findById.mockResolvedValueOnce(account());
    expect(at(await startSignedIn('registration', steps, edges))).toBe('done:step');
    expect(mocks.runtimeUsers.findById).toHaveBeenCalledWith('user_1', { includeInactive: true });
    expect(mocks.coreAdapter.queryOne).toHaveBeenCalledWith(
      expect.stringContaining('FROM contact_points'),
      ['tenant_test', 'acct_1', 'subj_1']
    );
    expect(mocks.coreAdapter.queryOne).toHaveBeenCalledWith(
      expect.stringContaining('FROM profiles p'),
      ['tenant_test', 'subj_1']
    );
  });

  it.each([
    ['an account with an address', () => account({ email: 'ada@example.test' })],
    ['an inactive account', () => account({ active: 0 })],
    ['an account without its account id', () => account({ account_id: null })],
    ['an account without its subject', () => account({ subject_id: '' })],
    ['no account', () => null],
  ])('is shown for %s', async (_label, found) => {
    mocks.runtimeUsers.findById.mockResolvedValueOnce(found());
    expect(at(await startSignedIn('registration', steps, edges))).toBe('ev:step');
  });

  it.each([
    ['an email contact point', [{ present: 1 }, null]],
    ['an email attribute of the profile', [null, { present: 1 }]],
  ])('is shown when %s is still there', async (_label, [contact, attribute]) => {
    mocks.runtimeUsers.findById.mockResolvedValueOnce(account());
    mocks.coreAdapter.queryOne.mockImplementation(async (sql: string) => {
      if (String(sql).includes('FROM contact_points')) return contact;
      if (String(sql).includes('FROM profiles p')) return attribute;
      return null;
    });
    // The start's own reads (queued once) come first.
    expect(at(await startSignedIn('registration', steps, edges))).toBe('ev:step');
  });

  it('is shown when the account cannot be read', async () => {
    mocks.runtimeUsers.findById.mockRejectedValueOnce(new Error('down'));
    expect(at(await startSignedIn('registration', steps, edges))).toBe('ev:step');
  });

  it('is shown in a sign-in Flow, whatever the account', async () => {
    mocks.runtimeUsers.findById.mockResolvedValue(account());
    expect(at(await startSignedIn('login', steps, edges, { createdAt: Date.now() - 1_000 }))).toBe(
      'ev:step'
    );
    expect(mocks.runtimeUsers.findById).not.toHaveBeenCalled();
  });
});

describe('a statement the signed-in person has answered', () => {
  const steps = (required: boolean) => [
    sessionStep,
    shown('consent', { statements: [{ statement_id: 'st_terms', required }] }),
    shown('done'),
  ];
  const edges = [
    edge('session', 'consent', 'continue'),
    edge('session', 'done', 'authenticate'),
    edge('consent', 'done', 'next'),
  ];
  const definition = {
    statement_id: 'st_terms',
    version_id: 'st_terms_v2',
    version: '20260701',
    required_consent_version: '20260601',
    is_active: 1,
  };

  function withStatement(record: Record<string, unknown> | null, def: unknown = definition) {
    mocks.resolveStatementRequirements.mockImplementation(
      async (_db: unknown, _tenantId: unknown, entries: unknown) =>
        (entries as Array<{ statement_id: string; required: boolean }>).map((entry, order) => ({
          statement_id: entry.statement_id,
          statement: { id: entry.statement_id, slug: 'terms', category: 'terms_of_service' },
          current_version: { id: 'st_terms_v2', version: '20260701', status: 'active' },
          is_required: entry.required,
          min_version: '20260601',
          display_order: order,
        }))
    );
    mocks.readStatementConsentDefinition.mockResolvedValue(def);
    mocks.readStatementConsentRecord.mockResolvedValue(
      record ? { expires_at: null, granted_at: null, ...record } : null
    );
  }

  const start = (required: boolean) =>
    startSignedIn('login', steps(required), edges, { createdAt: Date.now() - 1_000 });

  it('is not asked again once agreed to from the version required', async () => {
    withStatement({ status: 'granted', version: '20260601' });
    expect(at(await start(true))).toBe('done:step');
    expect(mocks.readStatementConsentRecord).toHaveBeenCalledWith(
      mocks.coreAdapter,
      'tenant_test',
      'user_1',
      'st_terms'
    );
    expect(mocks.resolveAccountDataContextFromHono).toHaveBeenCalledWith(
      expect.anything(),
      'user_1'
    );
  });

  it.each([
    ['a required statement declined', true, { status: 'denied', version: '20260701' }],
    ['a required statement withdrawn', true, { status: 'withdrawn', version: '20260701' }],
    ['an agreement to an older version', true, { status: 'granted', version: '20260501' }],
    [
      'an optional statement declined before the version',
      false,
      { status: 'denied', version: '20260501' },
    ],
    ['an optional statement never answered', false, null],
  ])('is asked again for %s', async (_label, required, record) => {
    withStatement(record);
    const data = await start(required);
    expect(at(data)).toBe('consent:step');
  });

  it.each([
    ['declined', 'denied'],
    ['withdrawn', 'withdrawn'],
  ])('is not asked again when optional and %s since the version', async (_label, status) => {
    withStatement({ status, version: '20260601' });
    expect(at(await start(false))).toBe('done:step');
  });

  it('judges from the current version when no version is required', async () => {
    withStatement(
      { status: 'denied', version: '20260601' },
      { ...definition, required_consent_version: null }
    );
    expect(at(await start(false))).toBe('consent:step');
  });

  it('is asked when the statement cannot be found', async () => {
    withStatement({ status: 'granted', version: '20260701' }, null);
    expect(at(await start(true))).toBe('consent:step');
    expect(mocks.readStatementConsentRecord).not.toHaveBeenCalled();
  });
});

describe('the text a consent step shows for a statement', () => {
  const runtime = {
    flow_kind: 'login',
    ui: {
      steps: [shown('consent', { statements: [{ statement_id: 'st_terms', required: true }] })],
    },
  } as unknown as FlowRuntimeContract;
  const row = (language: string, extra: Record<string, unknown> = {}) => ({
    language,
    title: `Terms (${language})`,
    description: `About (${language})`,
    document_url: `https://example.test/${language}`,
    inline_content: null,
    ...extra,
  });

  async function itemShown(locale: string | undefined, rows: unknown[]) {
    clearLoginRuntimeFlowVersionCacheForTests();
    mocks.resolveStatementRequirements.mockResolvedValue([
      {
        statement_id: 'st_terms',
        statement: { id: 'st_terms', slug: 'terms', category: 'terms_of_service' },
        current_version: { id: 'st_terms_v2', version: '20260701', status: 'active' },
        is_required: true,
        min_version: '20260701',
        display_order: 0,
      },
    ]);
    mocks.coreAdapter.query.mockImplementation(async (sql: string) =>
      String(sql).includes('FROM consent_statement_localizations') ? rows : []
    );
    mocks.coreAdapter.queryOne
      .mockResolvedValueOnce(assignmentRow())
      .mockResolvedValueOnce(versionRow(runtime));
    const response = await loginRuntimeInteractionStartHandler(
      createContext({ body: { flow_kind: 'login', ...(locale ? { locale } : {}) } })
    );
    const data = await readJson(response);
    const step = (data.contract as FlowRuntimeContract).ui.steps[0];
    const policy = (step.content as { consent_policy: { items: Array<Record<string, unknown>> } })
      .consent_policy;
    expect(mocks.coreAdapter.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM consent_statement_localizations'),
      ['tenant_test', 'st_terms_v2']
    );
    return policy.items[0];
  }

  it('is in the language of the request', async () => {
    expect(await itemShown('ja', [row('de'), row('en'), row('ja')])).toMatchObject({
      title: 'Terms (ja)',
      description: 'About (ja)',
      document_url: 'https://example.test/ja',
      version_id: 'st_terms_v2',
      content_mode: 'checkbox',
      checkbox_mode: 'required',
    });
  });

  it('falls back to English, then to the first language there is', async () => {
    expect((await itemShown('fr', [row('de'), row('en')])).title).toBe('Terms (en)');
    expect((await itemShown(undefined, [row('de'), row('en')])).title).toBe('Terms (en)');
    expect((await itemShown('fr', [row('de'), row('it')])).title).toBe('Terms (de)');
  });

  it('shows the statement slug without a title of its own', async () => {
    expect(await itemShown('en', [])).toMatchObject({
      title: 'terms',
      description: '',
      document_url: null,
      inline_content: null,
    });
    expect(
      await itemShown('en', [row('en', { title: '', description: '', document_url: undefined })])
    ).toMatchObject({ title: 'terms', description: '', document_url: null });
  });
});
