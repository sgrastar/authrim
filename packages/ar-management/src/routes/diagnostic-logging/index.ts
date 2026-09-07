/**
 * Diagnostic Logging Routes
 *
 * Admin API routes for diagnostic logging management.
 */

import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { rateLimitMiddleware, getRateLimitProfileAsync } from '@authrim/ar-lib-core';
import { testDiagnosticLogR2Connection } from './test-connection';
import exportLogsRouter from './export-logs.js';

const diagnosticLoggingRouter = new Hono<{
  Bindings: Env;
  Variables: {
    adminAuth?: {
      userId: string;
      roles: string[];
      org_id?: string;
    };
  };
}>();

// =============================================================================
// Rate Limiting
// =============================================================================

// Use moderate profile for all diagnostic logging endpoints
diagnosticLoggingRouter.use('/*', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'moderate');
  const middleware = rateLimitMiddleware({
    ...profile,
    endpoints: ['/diagnostic-logging/*'],
  });
  return middleware(c as any, next);
});

// =============================================================================
// Routes
// =============================================================================

/**
 * POST /api/admin/diagnostic-logging/test-connection
 * Test R2 bucket connectivity
 */
diagnosticLoggingRouter.post('/test-connection', testDiagnosticLogR2Connection);

/**
 * GET /api/admin/diagnostic-logging/export
 * Export diagnostic logs
 */
diagnosticLoggingRouter.route('/export', exportLogsRouter);

export default diagnosticLoggingRouter;
