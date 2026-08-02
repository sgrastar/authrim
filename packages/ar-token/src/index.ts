import { Hono, type Context, type Next } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { logger } from 'hono/logger';
import type { Env } from '@authrim/ar-lib-core';
import {
  rateLimitMiddleware,
  getRateLimitProfileAsync,
  requestContextMiddleware,
  diagnosticLoggingMiddleware,
  // Plugin Context (Phase 9 - Plugin Architecture)
  pluginContextMiddleware,
  // Health Check
  createHealthCheckHandlers,
  createTenantPlacementWriteFenceResponse,
  getLogger,
} from '@authrim/ar-lib-core';

// Import handlers
import { tokenHandler } from './token';
import { adminAgentDelegationHandler, adminAgentTokenHandler } from './admin-agent-token';
import {
  isTokenRequestDiagnosticTimingEnabled,
  TOKEN_REQUEST_DIAGNOSTIC_CONTEXT_KEY,
} from './request-diagnostics';
export { isTokenRequestDiagnosticTimingEnabled } from './request-diagnostics';

// Create Hono app with Cloudflare Workers types
const app = new Hono<{ Bindings: Env }>();

const DIAGNOSTIC_SESSION_ID_HEADER = 'X-Diagnostic-Session-Id';
const MAX_DIAGNOSTIC_SESSION_ID_LENGTH = 128;

interface MiddlewareDiagnosticSpan {
  name: string;
  durationMs: number;
}

interface MiddlewareDiagnosticState {
  sessionId: string;
  startedAt: number;
  lastMarkAt: number;
  spans: MiddlewareDiagnosticSpan[];
}

function sanitizeDiagnosticSessionId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, MAX_DIAGNOSTIC_SESSION_ID_LENGTH);
}

function roundDiagnosticDurationMs(durationMs: number): number {
  return Math.round(durationMs * 10) / 10;
}

function getMiddlewareDiagnosticState(
  c: Context<{ Bindings: Env }>
): MiddlewareDiagnosticState | null {
  return (
    ((c as unknown as { get(key: string): unknown }).get(TOKEN_REQUEST_DIAGNOSTIC_CONTEXT_KEY) as
      | MiddlewareDiagnosticState
      | undefined) ?? null
  );
}

function setMiddlewareDiagnosticState(
  c: Context<{ Bindings: Env }>,
  state: MiddlewareDiagnosticState
): void {
  (c as unknown as { set(key: string, value: unknown): void }).set(
    TOKEN_REQUEST_DIAGNOSTIC_CONTEXT_KEY,
    state
  );
}

function recordMiddlewareDiagnosticSpan(c: Context<{ Bindings: Env }>, name: string): void {
  const state = getMiddlewareDiagnosticState(c);
  if (!state) return;
  const now = performance.now();
  state.spans.push({
    name,
    durationMs: roundDiagnosticDurationMs(now - state.lastMarkAt),
  });
  state.lastMarkAt = now;
}

async function timeMiddlewareDiagnosticOperation<T>(
  c: Context<{ Bindings: Env }>,
  name: string,
  operation: () => Promise<T>
): Promise<T> {
  const state = getMiddlewareDiagnosticState(c);
  if (!state) return operation();
  const startedAt = performance.now();
  try {
    return await operation();
  } finally {
    const now = performance.now();
    state.spans.push({
      name,
      durationMs: roundDiagnosticDurationMs(now - startedAt),
    });
    state.lastMarkAt = now;
  }
}

function tokenRequestDiagnosticStartMiddleware() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const sessionId = sanitizeDiagnosticSessionId(c.req.header(DIAGNOSTIC_SESSION_ID_HEADER));
    if (!sessionId || !isTokenRequestDiagnosticTimingEnabled(c.env, sessionId)) return next();

    const startedAt = performance.now();
    setMiddlewareDiagnosticState(c, {
      sessionId,
      startedAt,
      lastMarkAt: startedAt,
      spans: [],
    });

    try {
      await next();
    } finally {
      const state = getMiddlewareDiagnosticState(c);
      if (!state) return;
      recordMiddlewareDiagnosticSpan(c, 'token_handler_downstream');
      state.spans.push({
        name: 'token_total',
        durationMs: roundDiagnosticDurationMs(performance.now() - state.startedAt),
      });
      const timing = state.spans
        .map((span) => `${span.name};dur=${span.durationMs.toFixed(1)}`)
        .join(', ');
      c.res.headers.set('Server-Timing', timing);
      c.res.headers.set('X-Authrim-Diagnostic-Session-Id', state.sessionId);
      getLogger(c)
        .module('TOKEN-REQUEST-TIMING')
        .info('Token request middleware diagnostics', {
          diagnosticSessionId: state.sessionId,
          method: c.req.method,
          path: c.req.path,
          status: c.res.status,
          timingMs: Object.fromEntries(state.spans.map((span) => [span.name, span.durationMs])),
        });
    }
  };
}

function tokenRequestDiagnosticCheckpoint(name: string) {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    recordMiddlewareDiagnosticSpan(c, name);
    await next();
  };
}

// Middleware
app.use('/token', tokenRequestDiagnosticStartMiddleware());
app.use('*', logger());
app.use('/token', tokenRequestDiagnosticCheckpoint('token_logger'));
app.use('*', requestContextMiddleware());
app.use('/token', tokenRequestDiagnosticCheckpoint('token_request_context'));
app.use(
  '*',
  diagnosticLoggingMiddleware({
    excludePatterns: [/^\/api\/health/, /^\/health\//, /^\/internal\//],
  })
);
app.use('/token', tokenRequestDiagnosticCheckpoint('token_diagnostic_logging'));

// Plugin Context - provides access to notifiers, idp handlers, authenticators
// Plugins are loaded lazily on first request and cached per Worker lifecycle
app.use('*', pluginContextMiddleware());
app.use('/token', tokenRequestDiagnosticCheckpoint('token_plugin_context'));

// Enhanced security headers
app.use(
  '*',
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
    strictTransportSecurity: 'max-age=63072000; includeSubDomains; preload',
    xFrameOptions: 'DENY',
    xContentTypeOptions: 'nosniff',
    referrerPolicy: 'strict-origin-when-cross-origin',
  })
);
app.use('/token', tokenRequestDiagnosticCheckpoint('token_secure_headers'));

// CORS configuration
app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'DPoP', 'X-Diagnostic-Session-Id'],
    exposeHeaders: [
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
      'Server-Timing',
      'X-Authrim-Diagnostic-Session-Id',
    ],
    maxAge: 86400,
  })
);
app.use('/token', tokenRequestDiagnosticCheckpoint('token_cors'));

// Rate limiting for token endpoint
// Configurable via KV (rate_limit_{profile}_max_requests, rate_limit_{profile}_window_seconds)
// or RATE_LIMIT_PROFILE env var for profile selection
app.use('/token', async (c, next) => {
  const profile = await timeMiddlewareDiagnosticOperation(c, 'token_rate_limit_profile', () =>
    getRateLimitProfileAsync(c.env, 'strict')
  );
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/token'],
  })(c, next);
});
app.use('/token', tokenRequestDiagnosticCheckpoint('token_rate_limit'));
app.use('/oauth/admin-agent/token', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'strict');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/oauth/admin-agent/token'],
  })(c, next);
});
app.use('/oauth/admin-agent/delegation', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'strict');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/oauth/admin-agent/delegation'],
  })(c, next);
});

// Health check endpoints
app.get('/api/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'op-token',
    timestamp: new Date().toISOString(),
  });
});

// Kubernetes health probes
const healthHandlers = createHealthCheckHandlers({
  serviceName: 'op-token',
  version: '0.1.0',
  checkDatabase: true,
  checkKV: true,
  checkKeyManager: true,
});
app.get('/health/live', healthHandlers.liveness);
app.get('/health/ready', healthHandlers.readiness);

// Token endpoint
app.post('/token', tokenHandler);
app.post('/oauth/admin-agent/token', adminAgentTokenHandler);
app.post('/oauth/admin-agent/delegation', adminAgentDelegationHandler);

// 404 handler
app.notFound((c) => {
  return c.json({ error: 'not_found', message: 'The requested resource was not found' }, 404);
});

// Error handler
app.onError((err, c) => {
  const writeFenceResponse = createTenantPlacementWriteFenceResponse(c, err);
  if (writeFenceResponse) return writeFenceResponse;
  // Use structured logger for consistency across the codebase
  const log = getLogger(c).module('AR-TOKEN');
  log.error('Unhandled error', { action: 'error_handler' }, err);
  return c.json({ error: 'server_error', error_description: 'An unexpected error occurred' }, 500);
});

// Export for Cloudflare Workers
export default app;
export { AgentDownscopeEntrypoint } from './entrypoints/AgentDownscopeEntrypoint';
export { RuntimeSmokeEntrypoint } from '@authrim/ar-lib-core';
