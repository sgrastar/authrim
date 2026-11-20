import { describe, expect, it, vi } from 'vitest';
import type { AgentAuthorizationDecision } from '../core';
import type {
  AgentElevationCompletion,
  AgentElevationResolution,
  ManagementOperationResult,
} from '../platform/ports';
import {
  ALLOW,
  ELEVATE,
  LOW_TOOL,
  createHarness,
  makeCatalog,
  makeContext,
} from './helpers/mut-mcp-harness';

const highTool = {
  ...LOW_TOOL,
  id: 'admin.write.users.suspend',
  name: 'suspend_user',
  riskLevel: 'high' as const,
  requiredScope: 'agent:write' as const,
  requiredPermissions: ['admin:users:suspend'],
};
const catalog = makeCatalog([highTool]);
const AUTHORIZED: AgentElevationResolution = {
  status: 'authorized',
  challengeId: 'challenge-1',
  executionAttempt: 2,
  executionFence: 9,
  executionToken: 'token-1',
  idempotencyKey: 'elevation-idem-1',
};

function harness(
  options: {
    resolution?: AgentElevationResolution | Error;
    complete?: boolean | Error;
    afterElevation?: AgentAuthorizationDecision;
    result?: ManagementOperationResult | Error;
  } = {}
) {
  const resolve = vi.fn(async () => {
    if (options.resolution instanceof Error) throw options.resolution;
    return options.resolution ?? AUTHORIZED;
  });
  const complete = vi.fn(async (_completion: AgentElevationCompletion) => {
    if (options.complete instanceof Error) throw options.complete;
    return options.complete ?? true;
  });
  const h = createHarness({
    catalog,
    authorize: async ({ elevationCapabilityValid }) =>
      elevationCapabilityValid ? (options.afterElevation ?? ALLOW) : ELEVATE,
    elevation: { resolve, complete },
    execute: async () => {
      if (options.result instanceof Error) throw options.result;
      return options.result ?? { status: 200, body: { user_id: 'u1' } };
    },
  });
  return { ...h, resolve, complete };
}

const fence = {
  tenantId: 'tenant-1',
  challengeId: 'challenge-1',
  executionAttempt: 2,
  executionFence: 9,
  executionToken: 'token-1',
  correlationId: 'correlation-1',
};
const INDETERMINATE = {
  content: [{ type: 'text', text: 'Operation result is indeterminate' }],
  isError: true,
};
const call = (h: ReturnType<typeof harness>) =>
  h.server.callTool(
    makeContext(),
    'suspend_user',
    { user_id: 'u1' },
    {
      elevationChallengeId: 'challenge-1',
    }
  );

describe('operation-bound elevation', () => {
  it('fails closed when no elevation port is configured', async () => {
    const h = createHarness({ catalog, authorize: async () => ELEVATE });
    const result = await h.server.callTool(makeContext(), 'suspend_user', {});
    expect(result).toStrictEqual({
      content: [{ type: 'text', text: 'Elevation unavailable' }],
      isError: true,
    });
    expect(h.lastEvent()).toMatchObject({
      eventType: 'agent.mcp.tool.denied',
      outcome: 'denied',
      details: { tool_id: highTool.id, denied_axis: 'risk', code: 'AGENT_ELEVATION_UNAVAILABLE' },
    });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('fails closed when the elevation store throws', async () => {
    const h = harness({ resolution: new Error('store down') });
    expect(await call(h)).toStrictEqual({
      content: [{ type: 'text', text: 'Elevation state unavailable' }],
      isError: true,
    });
    expect(h.lastEvent()).toMatchObject({
      eventType: 'agent.mcp.tool.denied',
      details: { denied_axis: 'risk', code: 'AGENT_ELEVATION_STATE_UNAVAILABLE' },
    });
  });

  it('returns a URL elicitation when human approval is still required', async () => {
    const h = harness({
      resolution: {
        status: 'required',
        challengeId: 'challenge-2',
        url: 'https://approve.example/c2',
        message: 'Approve suspension',
        expiresAt: 777,
      },
    });
    expect(await call(h)).toStrictEqual({
      content: [{ type: 'text', text: 'Human approval is required' }],
      isError: true,
      urlElicitation: {
        elicitationId: 'challenge-2',
        url: 'https://approve.example/c2',
        message: 'Approve suspension',
      },
    });
    expect(h.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        challengeId: 'challenge-1',
        issuerOrigin: 'https://tenant-1.authrim.example',
        correlationId: 'correlation-1',
        input: { user_id: 'u1' },
      })
    );
    expect(h.lastEvent()).toMatchObject({
      eventType: 'agent.elevation.requested',
      outcome: 'success',
      details: { tool_id: highTool.id, elevation_id: 'challenge-2', expires_at: 777 },
    });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('marks the challenge failed when reauthorization denies the elevated call', async () => {
    const h = harness({
      afterElevation: { allowed: false, requiresElevation: false, deniedAxis: 'grant', code: 'X1' },
    });
    expect(await call(h)).toStrictEqual({ content: [{ type: 'text', text: 'X1' }], isError: true });
    expect(h.complete).toHaveBeenCalledWith({ ...fence, status: 'failed' });
    expect(h.lastEvent()).toMatchObject({
      eventType: 'agent.mcp.tool.denied',
      outcome: 'denied',
      details: { elevation_id: 'challenge-1', denied_axis: 'grant', code: 'X1' },
    });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('uses generic codes on a reauthorization denial without details', async () => {
    const h = harness({ afterElevation: { allowed: false, requiresElevation: false } });
    expect((await call(h)).content).toEqual([{ type: 'text', text: 'Access denied' }]);
    expect(h.lastEvent()?.details).toMatchObject({
      denied_axis: 'unknown',
      code: 'AGENT_ACCESS_DENIED',
    });
  });

  it.each([false, new Error('complete threw')])(
    'reports indeterminate when the failed terminal state is not persisted (%s)',
    async (complete) => {
      const h = harness({
        complete,
        afterElevation: { allowed: false, requiresElevation: false, code: 'X1' },
      });
      expect(await call(h)).toStrictEqual(INDETERMINATE);
      expect(h.lastEvent()).toMatchObject({
        eventType: 'agent.elevation.indeterminate',
        outcome: 'indeterminate',
      });
    }
  );

  it('executes with the elevation idempotency fence and consumes the challenge', async () => {
    const h = harness();
    const result = await h.server.callTool(
      makeContext(),
      'suspend_user',
      { user_id: 'u1' },
      {
        idempotencyKey: 'client-key',
      }
    );
    expect(result.isError).toBe(false);
    expect(h.execute.mock.calls[0]?.[0].idempotencyKey).toBe('elevation-idem-1');
    expect(h.complete).toHaveBeenCalledWith({
      ...fence,
      status: 'consumed',
      result: { user_id: 'u1' },
    });
    const types = h.events.map((event) => event.eventType);
    expect(types).toEqual(['agent.elevation.consumed', 'agent.mcp.tool.executed']);
    expect(h.events[0]).toMatchObject({
      outcome: 'success',
      details: { tool_id: highTool.id, elevation_id: 'challenge-1', management_status: 200 },
    });
  });

  it('marks the challenge failed when the owner API rejects the elevated call', async () => {
    const h = harness({ result: { status: 409, body: { error: 'conflict' } } });
    const result = await call(h);
    expect(result).toMatchObject({ isError: true, structuredContent: { error: 'conflict' } });
    expect(h.complete).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
    expect(h.events[0]).toMatchObject({
      eventType: 'agent.elevation.failed',
      outcome: 'failed',
      details: { management_status: 409 },
    });
  });

  it.each([
    [199, 'failed'],
    [299, 'consumed'],
    [300, 'failed'],
  ])('maps owner status %i to terminal elevation status %s', async (status, terminal) => {
    const h = harness({ result: { status, body: {} } });
    await call(h);
    expect(h.complete).toHaveBeenCalledWith(expect.objectContaining({ status: terminal }));
  });

  it('records an owner-indeterminate execution as indeterminate', async () => {
    const h = harness({
      result: { status: 200, body: {}, executionStatus: 'indeterminate' },
    });
    expect(await call(h)).toStrictEqual(INDETERMINATE);
    expect(h.complete).toHaveBeenCalledWith(expect.objectContaining({ status: 'indeterminate' }));
    expect(h.lastEvent()).toMatchObject({
      eventType: 'agent.elevation.indeterminate',
      outcome: 'indeterminate',
      details: { elevation_id: 'challenge-1', reason: 'owner_execution_indeterminate' },
    });
  });

  it('reports indeterminate when the consumed state cannot be persisted', async () => {
    const h = harness({ complete: false });
    expect(await call(h)).toStrictEqual(INDETERMINATE);
    expect(h.lastEvent()).toMatchObject({
      eventType: 'agent.elevation.indeterminate',
      details: { reason: 'terminal_state_not_persisted' },
    });
  });

  it.each([
    [true, 'owner_transport_outcome_unknown'],
    [false, 'owner_transport_and_terminal_state_unknown'],
  ])('reports transport failures as indeterminate (completed=%s)', async (complete, reason) => {
    const h = harness({ complete, result: new Error('socket closed') });
    expect(await call(h)).toStrictEqual(INDETERMINATE);
    expect(h.complete).toHaveBeenCalledWith({ ...fence, status: 'indeterminate' });
    expect(h.lastEvent()).toMatchObject({
      eventType: 'agent.elevation.indeterminate',
      outcome: 'indeterminate',
      details: { tool_id: highTool.id, elevation_id: 'challenge-1', reason },
    });
  });

  it('falls back to the caller key when the elevation carries no idempotency key', async () => {
    const h = harness({ resolution: { ...AUTHORIZED, idempotencyKey: '' } });
    await h.server.callTool(makeContext(), 'suspend_user', {}, { idempotencyKey: 'client-key' });
    expect(h.execute.mock.calls[0]?.[0].idempotencyKey).toBe('client-key');
  });
});
