/**
 * Flow API - Hono API handler
 *
 * Endpoints:
 * - POST /api/flow/init      - Flow initialization, return UIContract
 * - POST /api/flow/submit    - Submit capability response
 * - GET  /api/flow/state/:sessionId - get the current UIContract
 * - POST /api/flow/cancel    - Flow cancellation
 *
 * @see /private/docs/track-c-flow-engine-design.md
 */

import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { getFeatureFlag, getTenantIdFromContext } from '@authrim/ar-lib-core';
import type {
  FlowInitRequest,
  FlowInitResponse,
  FlowSubmitRequest,
  FlowSubmitResponse,
  FlowStateResponse,
} from './types';
import { createFlowExecutor } from './flow-executor';
import type { FlowType } from './flow-registry';

// =============================================================================
// Flow API Router
// =============================================================================

export const flowApi = new Hono<{ Bindings: Env }>();

/**
 * Check if Flow Engine is enabled for the given tenant
 * Checks Settings Manager KV format first, then falls back to legacy flag format
 */
async function isFlowEngineEnabled(env: Env, tenantId: string): Promise<boolean> {
  // Check Settings Manager KV format first (settings:tenant:<tenantId>:feature-flags)
  if (env.AUTHRIM_CONFIG) {
    try {
      const settingsKey = `settings:tenant:${tenantId}:feature-flags`;
      const settingsJson = await env.AUTHRIM_CONFIG.get(settingsKey);
      if (settingsJson) {
        const settings = JSON.parse(settingsJson);
        if (typeof settings === 'object' && settings !== null) {
          if (settings['feature.enable_flow_engine'] === true) {
            return true;
          }
        }
      }
    } catch {
      // Fall through to legacy check
    }
  }
  // Legacy fallback: check flag:ENABLE_FLOW_ENGINE or env variable
  return getFeatureFlag('ENABLE_FLOW_ENGINE', env, false);
}

/**
 * Middleware: Check if Flow Engine is enabled
 * Returns 403 Forbidden if Flow Engine is disabled for this tenant
 */
flowApi.use('*', async (c, next) => {
  const tenantId = getTenantIdFromContext(c);
  const flowEngineEnabled = await isFlowEngineEnabled(c.env, tenantId);
  if (!flowEngineEnabled) {
    return c.json(
      {
        error: 'flow_engine_disabled',
        error_description: 'Flow Engine is not enabled for this tenant',
      },
      403
    );
  }
  await next();
});

/**
 * POST /api/flow/init
 * Flow initialization - return UIContract
 *
 * Using FlowExecutor:
 * 1. Retrieve the flow definition from FlowRegistry
 * 2. Generate CompiledPlan with FlowCompiler
 * 3. Create RuntimeState in the FlowStateStore DO
 * 4. Generate UIContract with UIContractGenerator
 */
flowApi.post('/init', async (c) => {
  try {
    const body = await c.req.json<FlowInitRequest>();
    const tenantId = getTenantIdFromContext(c);

    if (body.tenantId && body.tenantId !== tenantId) {
      return c.json(
        {
          type: 'error',
          error: {
            code: 'invalid_tenant',
            message: 'Request tenant does not match the resolved tenant context',
          },
        } as FlowSubmitResponse,
        403
      );
    }

    // Create a FlowExecutor
    const executor = createFlowExecutor(c.env);

    // Flow initialization
    const response = await executor.initFlow({
      flowType: (body.flowType || 'login') as FlowType,
      clientId: body.clientId,
      tenantId,
      oauthParams: body.oauthParams,
    });

    return c.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json(
      {
        type: 'error',
        error: {
          code: 'init_failed',
          message,
        },
      } as FlowSubmitResponse,
      500
    );
  }
});

/**
 * POST /api/flow/submit
 * Submit a capability response
 *
 * Idempotency guarantee: detect duplicates with the sessionId + requestId combination
 */
flowApi.post('/submit', async (c) => {
  try {
    const body = await c.req.json<FlowSubmitRequest>();
    const tenantId = getTenantIdFromContext(c);

    if (body.tenantId && body.tenantId !== tenantId) {
      return c.json(
        {
          type: 'error',
          error: {
            code: 'invalid_tenant',
            message: 'Request tenant does not match the resolved tenant context',
          },
        } as FlowSubmitResponse,
        403
      );
    }

    // Create a FlowExecutor
    const executor = createFlowExecutor(c.env);

    // Process the capability response
    const response = await executor.submitCapability({ ...body, tenantId });

    return c.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json(
      {
        type: 'error',
        error: {
          code: 'submit_failed',
          message,
        },
      } as FlowSubmitResponse,
      500
    );
  }
});

/**
 * GET /api/flow/state/:sessionId
 * Get the current UIContract (idempotent)
 */
flowApi.get('/state/:sessionId', async (c) => {
  try {
    const sessionId = c.req.param('sessionId');
    const tenantId = getTenantIdFromContext(c);

    // Create a FlowExecutor
    const executor = createFlowExecutor(c.env);

    // Get state
    const response = await executor.getFlowState(sessionId, tenantId);

    return c.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json(
      {
        error: {
          code: 'state_fetch_failed',
          message,
        },
      },
      404
    );
  }
});

/**
 * POST /api/flow/cancel
 * Flow cancellation
 */
flowApi.post('/cancel', async (c) => {
  try {
    const { sessionId } = await c.req.json<{ sessionId: string }>();
    const tenantId = getTenantIdFromContext(c);

    // Create a FlowExecutor
    const executor = createFlowExecutor(c.env);

    // Flow cancellation
    await executor.cancelFlow(sessionId, tenantId);

    return c.json({ success: true, sessionId });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json(
      {
        success: false,
        error: {
          code: 'cancel_failed',
          message,
        },
      },
      500
    );
  }
});

// =============================================================================
// Export
// =============================================================================

export default flowApi;
