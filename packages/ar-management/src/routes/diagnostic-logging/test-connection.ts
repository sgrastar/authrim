/**
 * Diagnostic Logging - Log Storage Connection Test
 *
 * Test the configured Iceberg log storage connectivity for diagnostic logging.
 * POST /api/admin/diagnostic-logging/test-connection
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { createDiagnosticLogR2Adapter, getTenantIdFromContext } from '@authrim/ar-lib-core';

const DIAGNOSTIC_LOG_R2_BINDING = 'LOG_ARCHIVE';

/**
 * Test log storage connection for diagnostic logging
 *
 * POST /api/admin/diagnostic-logging/test-connection
 *
 * Request body:
 * {
 *   "tenantId": "tenant-id"
 * }
 *
 * Response:
 * {
 *   "success": true,
 *   "healthy": true,
 *   "latencyMs": 123,
 *   "message": "Log archive connection successful"
 * }
 */
export async function testDiagnosticLogR2Connection(c: Context<{ Bindings: Env }>) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const bindingName = DIAGNOSTIC_LOG_R2_BINDING;

    const adapter = createDiagnosticLogR2Adapter(c.env, { tenantId });

    // Test health
    const health = await adapter.isHealthy();

    if (health.healthy) {
      return c.json({
        success: true,
        healthy: true,
        latencyMs: health.latencyMs,
        message: 'Log archive connection successful',
        details: {
          bindingName,
          tenantId,
        },
      });
    } else {
      return c.json(
        {
          success: false,
          healthy: false,
          latencyMs: health.latencyMs,
          error: 'log_archive_health_check_failed',
          message: health.errorMessage ?? 'Log archive health check failed',
          details: {
            bindingName,
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
