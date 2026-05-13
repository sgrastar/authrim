/**
 * Diagnostic Logging - R2 Connection Test
 *
 * Test R2 bucket connectivity for diagnostic logging.
 * POST /api/admin/diagnostic-logging/test-connection
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  createDiagnosticLogR2Adapter,
  getTenantIdFromContext,
} from '@authrim/ar-lib-core';

/**
 * Test R2 connection for diagnostic logging
 *
 * POST /api/admin/diagnostic-logging/test-connection
 *
 * Request body:
 * {
 *   "r2BucketBinding": "DIAGNOSTIC_LOGS",
 *   "pathPrefix": "diagnostic-logs"
 * }
 *
 * Response:
 * {
 *   "success": true,
 *   "healthy": true,
 *   "latencyMs": 123,
 *   "message": "R2 connection successful"
 * }
 */
export async function testDiagnosticLogR2Connection(c: Context<{ Bindings: Env }>) {
  try {
    const body = await c.req.json<{
      r2BucketBinding?: string;
      pathPrefix?: string;
    }>();

    const tenantId = getTenantIdFromContext(c);
    const bindingName = body.r2BucketBinding ?? 'DIAGNOSTIC_LOGS';
    const pathPrefix = body.pathPrefix ?? 'diagnostic-logs';

    // Get R2 bucket
    const bucket = c.env[bindingName as keyof Env] as R2Bucket | undefined;

    if (!bucket) {
      return c.json(
        {
          success: false,
          error: 'r2_binding_not_found',
          message: `R2 bucket binding "${bindingName}" not found in environment`,
        },
        404
      );
    }

    // Create adapter
    const adapter = createDiagnosticLogR2Adapter(bucket, {
      pathPrefix,
      tenantId,
    });

    // Test health
    const health = await adapter.isHealthy();

    if (health.healthy) {
      return c.json({
        success: true,
        healthy: true,
        latencyMs: health.latencyMs,
        message: 'R2 connection successful',
        details: {
          bindingName,
          pathPrefix,
          tenantId,
        },
      });
    } else {
      return c.json(
        {
          success: false,
          healthy: false,
          latencyMs: health.latencyMs,
          error: 'r2_health_check_failed',
          message: health.errorMessage ?? 'R2 health check failed',
          details: {
            bindingName,
            pathPrefix,
            tenantId,
          },
        },
        503
      );
    }
  } catch (error) {
    return c.json(
      {
        success: false,
        error: 'test_failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      500
    );
  }
}
