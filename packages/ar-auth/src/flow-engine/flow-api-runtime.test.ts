import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getFeatureFlag: vi.fn(),
  initFlow: vi.fn(),
  submitCapability: vi.fn(),
  getFlowState: vi.fn(),
  cancelFlow: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async () => {
  const actual =
    await vi.importActual<typeof import('@authrim/ar-lib-core')>('@authrim/ar-lib-core');
  return {
    ...actual,
    getTenantIdFromContext: vi.fn(() => 'tenant-1'),
    getFeatureFlag: mocks.getFeatureFlag,
  };
});

vi.mock('./flow-executor', () => ({
  createFlowExecutor: vi.fn(() => ({
    initFlow: mocks.initFlow,
    submitCapability: mocks.submitCapability,
    getFlowState: mocks.getFlowState,
    cancelFlow: mocks.cancelFlow,
  })),
}));

import { flowApi } from './flow-api';

function kv(value: string | null = null, rejects = false) {
  return {
    get: rejects
      ? vi.fn().mockRejectedValue(new Error('KV unavailable'))
      : vi.fn().mockResolvedValue(value),
  };
}

function jsonRequest(path: string, body: unknown, env: Record<string, unknown>) {
  return flowApi.request(
    path,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    env
  );
}

describe('Flow API HTTP boundary', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.getFeatureFlag.mockResolvedValue(true);
    mocks.initFlow.mockResolvedValue({
      sessionId: 'flow-1',
      uiContractVersion: '0.1',
      uiContract: {},
    });
    mocks.submitCapability.mockResolvedValue({ type: 'continue', uiContract: {} });
    mocks.getFlowState.mockResolvedValue({ state: { currentNodeId: 'node-1' }, uiContract: {} });
    mocks.cancelFlow.mockResolvedValue(undefined);
  });

  it('disables every endpoint when neither settings nor legacy flag enables the engine', async () => {
    mocks.getFeatureFlag.mockResolvedValueOnce(false);
    const response = await jsonRequest('/init', {}, { AUTHRIM_CONFIG: kv() });
    expect(response.status).toBe(403);
    expect(mocks.initFlow).not.toHaveBeenCalled();
  });

  it.each([
    [JSON.stringify({ 'feature.enable_flow_engine': true }), 200],
    [JSON.stringify({ 'feature.enable_flow_engine': false }), 200],
    ['not-json', 200],
  ])('resolves feature settings with safe legacy fallback', async (settings, status) => {
    mocks.getFeatureFlag.mockResolvedValue(true);
    const response = await jsonRequest(
      '/init',
      { clientId: 'client-1' },
      { AUTHRIM_CONFIG: kv(settings) }
    );
    expect(response.status).toBe(status);
  });

  it('falls back to the legacy flag when settings KV fails', async () => {
    const response = await jsonRequest(
      '/init',
      { clientId: 'client-1' },
      { AUTHRIM_CONFIG: kv(null, true) }
    );
    expect(response.status).toBe(200);
    expect(mocks.getFeatureFlag).toHaveBeenCalled();
  });

  it.each(['/init', '/submit'])(
    'rejects caller-supplied cross-tenant context on %s',
    async (path) => {
      const response = await jsonRequest(
        path,
        { tenantId: 'tenant-2', clientId: 'client-1' },
        { AUTHRIM_CONFIG: kv(JSON.stringify({ 'feature.enable_flow_engine': true })) }
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: 'invalid_tenant' } });
    }
  );

  it('initializes with the resolved tenant and default login flow', async () => {
    const response = await jsonRequest(
      '/init',
      { clientId: 'client-1', oauthParams: { state: 'state-1' } },
      { AUTHRIM_CONFIG: kv(JSON.stringify({ 'feature.enable_flow_engine': true })) }
    );
    expect(response.status).toBe(200);
    expect(mocks.initFlow).toHaveBeenCalledWith({
      flowType: 'login',
      clientId: 'client-1',
      tenantId: 'tenant-1',
      oauthParams: { state: 'state-1' },
    });
  });

  it('overwrites submit tenant context with the resolved tenant', async () => {
    await jsonRequest(
      '/submit',
      { sessionId: 'flow-1', requestId: 'request-1', capabilityId: 'email', response: {} },
      { AUTHRIM_CONFIG: kv(JSON.stringify({ 'feature.enable_flow_engine': true })) }
    );
    expect(mocks.submitCapability).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-1', sessionId: 'flow-1' })
    );
  });

  it.each([
    ['/init', mocks.initFlow, 'init_failed'],
    ['/submit', mocks.submitCapability, 'submit_failed'],
  ] as const)(
    'maps executor failure on %s without changing its message',
    async (path, mock, code) => {
      mock.mockRejectedValueOnce(new Error('runtime unavailable'));
      const response = await jsonRequest(
        path,
        { clientId: 'client-1' },
        { AUTHRIM_CONFIG: kv(JSON.stringify({ 'feature.enable_flow_engine': true })) }
      );
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({
        error: { code, message: 'runtime unavailable' },
      });
    }
  );

  it('returns current state for the resolved tenant', async () => {
    const response = await flowApi.request('/state/flow-1', undefined, {
      AUTHRIM_CONFIG: kv(JSON.stringify({ 'feature.enable_flow_engine': true })),
    });
    expect(response.status).toBe(200);
    expect(mocks.getFlowState).toHaveBeenCalledWith('flow-1', 'tenant-1');
  });

  it('maps missing state to the stable 404 contract', async () => {
    mocks.getFlowState.mockRejectedValueOnce(new Error('session missing'));
    const response = await flowApi.request('/state/missing', undefined, {
      AUTHRIM_CONFIG: kv(JSON.stringify({ 'feature.enable_flow_engine': true })),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: 'state_fetch_failed', message: 'session missing' },
    });
  });

  it('cancels only within the resolved tenant', async () => {
    const response = await jsonRequest(
      '/cancel',
      { sessionId: 'flow-1' },
      { AUTHRIM_CONFIG: kv(JSON.stringify({ 'feature.enable_flow_engine': true })) }
    );
    expect(response.status).toBe(200);
    expect(mocks.cancelFlow).toHaveBeenCalledWith('flow-1', 'tenant-1');
  });

  it('maps cancellation failure to the stable error contract', async () => {
    mocks.cancelFlow.mockRejectedValueOnce(new Error('cancel unavailable'));
    const response = await jsonRequest(
      '/cancel',
      { sessionId: 'flow-1' },
      { AUTHRIM_CONFIG: kv(JSON.stringify({ 'feature.enable_flow_engine': true })) }
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      success: false,
      error: { code: 'cancel_failed', message: 'cancel unavailable' },
    });
  });
});
