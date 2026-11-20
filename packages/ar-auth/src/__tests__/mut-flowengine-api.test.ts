/**
 * Flow API - exact HTTP error contracts, legacy flag lookup and same-tenant acceptance.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getFeatureFlag: vi.fn(),
  initFlow: vi.fn(),
  submitCapability: vi.fn(),
  getFlowState: vi.fn(),
  cancelFlow: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getTenantIdFromContext: vi.fn(() => 'tenant-1'),
    getFeatureFlag: mocks.getFeatureFlag,
  };
});

vi.mock('../flow-engine/flow-executor', () => ({
  createFlowExecutor: vi.fn(() => ({
    initFlow: mocks.initFlow,
    submitCapability: mocks.submitCapability,
    getFlowState: mocks.getFlowState,
    cancelFlow: mocks.cancelFlow,
  })),
}));

import { flowApi } from '../flow-engine/flow-api';

const enabledEnv = () => ({
  AUTHRIM_CONFIG: {
    get: vi.fn().mockResolvedValue(JSON.stringify({ 'feature.enable_flow_engine': true })),
  },
});

function post(path: string, body: unknown, env: Record<string, unknown> = enabledEnv()) {
  return flowApi.request(
    path,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    env
  );
}

/** A rejection value that is not an Error instance. */
const nonError = { reason: 'opaque failure' };

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.initFlow.mockResolvedValue({
    sessionId: 'flow-1',
    uiContractVersion: '0.1',
    uiContract: {},
  });
  mocks.submitCapability.mockResolvedValue({ type: 'continue', uiContract: {} });
  mocks.getFlowState.mockResolvedValue({ state: {}, uiContract: {} });
  mocks.cancelFlow.mockResolvedValue(undefined);
});

describe('feature gate', () => {
  it('falls back to the legacy ENABLE_FLOW_ENGINE flag defaulting to false', async () => {
    mocks.getFeatureFlag.mockResolvedValue(false);
    const env = { AUTHRIM_CONFIG: { get: vi.fn().mockResolvedValue(null) } };
    const response = await post('/init', {}, env);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'flow_engine_disabled',
      error_description: 'Flow Engine is not enabled for this tenant',
    });
    expect(mocks.getFeatureFlag).toHaveBeenCalledWith('ENABLE_FLOW_ENGINE', env, false);
  });
});

describe('tenant context', () => {
  it.each(['/init', '/submit'])(
    'accepts a body tenantId equal to the resolved tenant on %s',
    async (path) => {
      const response = await post(path, { tenantId: 'tenant-1', clientId: 'client-1' });
      expect(response.status).toBe(200);
    }
  );

  it.each(['/init', '/submit'])('returns the exact invalid_tenant contract on %s', async (path) => {
    const response = await post(path, { tenantId: 'tenant-2', clientId: 'client-1' });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      type: 'error',
      error: {
        code: 'invalid_tenant',
        message: 'Request tenant does not match the resolved tenant context',
      },
    });
  });
});

describe('non-Error failures', () => {
  it.each([
    ['/init', mocks.initFlow, 'init_failed'],
    ['/submit', mocks.submitCapability, 'submit_failed'],
  ] as const)('%s reports Unknown error', async (path, mock, code) => {
    mock.mockRejectedValueOnce(nonError);
    const response = await post(path, { clientId: 'client-1' });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      type: 'error',
      error: { code, message: 'Unknown error' },
    });
  });

  it('/state reports Unknown error', async () => {
    mocks.getFlowState.mockRejectedValueOnce(nonError);
    const response = await flowApi.request('/state/s1', undefined, enabledEnv());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: 'state_fetch_failed', message: 'Unknown error' },
    });
  });

  it('/cancel reports Unknown error', async () => {
    mocks.cancelFlow.mockRejectedValueOnce(nonError);
    const response = await post('/cancel', { sessionId: 's1' });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      success: false,
      error: { code: 'cancel_failed', message: 'Unknown error' },
    });
  });
});

describe('success bodies', () => {
  it('/cancel echoes the session id', async () => {
    const response = await post('/cancel', { sessionId: 's1' });
    expect(await response.json()).toEqual({ success: true, sessionId: 's1' });
  });
});
