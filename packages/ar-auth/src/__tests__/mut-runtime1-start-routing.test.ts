/**
 * Where a start's first steps lead (resolveNextStep, the protocol of the edges a step may take,
 * the loops and the edges that go nowhere), as the start advances through steps that draw nothing.
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

const entry: Step = {
  id: 'entry:step',
  source_node_id: 'entry',
  component: 'interaction_context',
  render: false,
};
const pass = (node: string): Step => ({ ...entry, id: `${node}:step`, source_node_id: node });
/** A consent step without statements: it is shown (the start stops there). */
const shown = (node: string): Step => ({
  id: `${node}:step`,
  source_node_id: node,
  component: 'consent_policy',
  render: true,
});
const completion = (node: string, protocol?: string): Step => ({
  id: `${node}:step`,
  source_node_id: node,
  component: 'completion',
  render: true,
  config: {
    completion_block: { id: `${node}-block`, ...(protocol ? { protocol } : {}) },
  },
});
const runtimeOf = (...steps: Step[]): FlowRuntimeContract => ({
  flow_kind: 'login',
  ui: { steps },
});
const edge = (source: string, target: string, handle = 'next') => ({
  id: `${source}-${target}-${handle}`,
  source,
  target,
  source_handle: handle,
});
const editorOf = (...edges: ReturnType<typeof edge>[]) => ({ nodes: [], edges });

const forApp = {
  oidc: { client_id: 'client_1' },
  saml: { saml_sp_id: 'sp_1' },
  direct: {},
};

async function startAt(
  runtime: FlowRuntimeContract,
  editor: unknown,
  app: Record<string, unknown> = forApp.oidc
) {
  clearLoginRuntimeFlowVersionCacheForTests();
  if ('client_id' in app || 'saml_sp_id' in app) {
    // No assignment of the app's own: the tenant default runs.
    mocks.coreAdapter.queryOne.mockResolvedValueOnce(null);
  }
  mockStart(runtime, editor);
  const response = await loginRuntimeInteractionStartHandler(
    createContext({ body: { flow_kind: 'login', ...app } })
  );
  const data = await readJson(response);
  return {
    status: response.status,
    data,
    at: (data.interaction as { current_step_id?: string } | undefined)?.current_step_id,
  };
}

beforeEach(() => resetHarness());

describe('the completion a step goes on to', () => {
  const runtime = runtimeOf(entry, completion('saml-c', 'saml'), completion('oidc-c', 'oidc'));
  const editor = editorOf(edge('entry', 'saml-c'), edge('entry', 'oidc-c'));

  it.each([
    ['oidc', 'oidc-c:step'],
    ['saml', 'saml-c:step'],
    ['direct', 'saml-c:step'],
  ] as const)('is the one of the request protocol for %s (else the first)', async (app, at) => {
    expect((await startAt(runtime, editor, forApp[app])).at).toBe(at);
  });
});

describe('a step before a completion', () => {
  const steps = [
    entry,
    shown('c-a'),
    shown('c-b'),
    shown('mid'),
    shown('dead'),
    completion('saml-c', 'saml'),
    completion('oidc-c', 'oidc'),
    completion('plain-c'),
  ];
  const runtime = runtimeOf(...steps);
  const toB = [edge('entry', 'c-a'), edge('entry', 'c-b'), edge('c-b', 'oidc-c')];

  it('is judged by the completions it leads to through the steps between, loops included', async () => {
    const editor = editorOf(
      ...toB,
      edge('c-a', 'mid'),
      edge('mid', 'c-a'),
      edge('mid', 'mid', 'again'),
      edge('mid', 'saml-c', 'done')
    );
    expect((await startAt(runtime, editor, forApp.oidc)).at).toBe('c-b:step');
    expect((await startAt(runtime, editor, forApp.saml)).at).toBe('c-a:step');
  });

  it('may suit any protocol when one of its ends is not a step', async () => {
    const editor = editorOf(...toB, edge('c-a', 'ghost'), edge('c-a', 'saml-c', 'done'));
    expect((await startAt(runtime, editor, forApp.oidc)).at).toBe('c-a:step');
  });

  it('may suit any protocol when one of its ends goes on in order', async () => {
    const editor = editorOf(...toB, edge('c-a', 'dead'), edge('c-a', 'saml-c', 'done'));
    expect((await startAt(runtime, editor, forApp.oidc)).at).toBe('c-a:step');
  });

  it('suits any protocol when its completion names none', async () => {
    const editor = editorOf(...toB, edge('c-a', 'plain-c'));
    expect((await startAt(runtime, editor, forApp.oidc)).at).toBe('c-a:step');
  });

  it('suits any protocol when its completions are of more than one', async () => {
    const editor = editorOf(
      edge('entry', 'c-b'),
      edge('entry', 'c-a'),
      edge('c-b', 'saml-c'),
      edge('c-a', 'saml-c'),
      edge('c-a', 'oidc-c', 'other')
    );
    expect((await startAt(runtime, editor, forApp.oidc)).at).toBe('c-a:step');
  });
});

describe('the edges a step takes', () => {
  const runtime = runtimeOf(entry, shown('a'), shown('b'));

  it('go on in order when the step has none, or the editor cannot be read', async () => {
    expect((await startAt(runtime, editorOf(edge('a', 'b')))).at).toBe('a:step');
    for (const editor of [
      'not json',
      { nodes: 'x', edges: [edge('entry', 'b')] },
      { nodes: [] },
      'null',
    ]) {
      expect((await startAt(runtime, editor)).at).toBe('a:step');
    }
  });

  it('follow a single edge whatever its handle, and an unnamed one as the default', async () => {
    expect((await startAt(runtime, editorOf(edge('entry', 'b', 'custom')))).at).toBe('b:step');
    const unnamed = { id: 'e', source: 'entry', target: 'b' };
    expect(
      (
        await startAt(
          runtime,
          editorOf(unnamed as ReturnType<typeof edge>, edge('entry', 'a', 'x'))
        )
      ).at
    ).toBe('b:step');
  });

  it.each([
    [
      'no default among several edges',
      editorOf(edge('entry', 'a', 'x'), edge('entry', 'b', 'y')),
      'AR_FLOW_SELECTED_HANDLE_REQUIRED',
    ],
    [
      'an edge to a step that is not there',
      editorOf(edge('entry', 'ghost')),
      'AR_FLOW_EDGE_TARGET_MISSING',
    ],
  ])('refuse to start with %s', async (_label, editor, code) => {
    const { status, data } = await startAt(runtime, editor);
    expect(status).toBe(409);
    expect(data).toMatchObject({
      error: 'invalid_flow_branch',
      error_description: 'Published Flow initial branch cannot be evaluated',
      error_code: code,
    });
  });

  it('take the first default edge to a step that is not there, whatever the protocol', async () => {
    const both = runtimeOf(entry, completion('oidc-c', 'oidc'));
    const { data } = await startAt(both, editorOf(edge('entry', 'ghost'), edge('entry', 'oidc-c')));
    expect(data.error_code).toBe('AR_FLOW_EDGE_TARGET_MISSING');
  });

  it('refuse a Flow whose steps lead back to themselves', async () => {
    const loop = runtimeOf(entry, pass('again'), shown('a'));
    const { status, data } = await startAt(
      loop,
      editorOf(edge('entry', 'again'), edge('again', 'entry'))
    );
    expect(status).toBe(409);
    expect(data.error_code).toBe('AR_FLOW_RUNTIME_LOOP');
  });

  it('answer flow_runtime_invalid when the steps run out before one is shown', async () => {
    const { status, data } = await startAt(runtimeOf(entry, pass('next')), null);
    expect(status).toBe(409);
    expect(data).toMatchObject({
      error: 'flow_runtime_invalid',
      error_description: 'Published Flow runtime has no displayable initial step',
    });
  });
});
