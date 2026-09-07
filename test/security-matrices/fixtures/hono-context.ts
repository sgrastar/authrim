import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../../../packages/ar-lib-core/src/types/env';
import type { Logger } from '../../../packages/ar-lib-core/src/utils/logger';
import { tokenHandler } from '../../../packages/ar-token/src/token';
import {
  authorizeHandler,
  authorizeLoginHandler,
  authorizeConfirmHandler,
} from '../../../packages/ar-auth/src/authorize';
import type { CallLedger } from './call-ledger';
import { TEST_ISSUER, TEST_TENANT, TEST_ACCOUNT, type SecurityMatrixEnvKit } from './env';

class NoopLogger implements Logger {
  info(_message: string, _context?: Partial<Record<string, unknown>>): void {
    return undefined;
  }
  warn(_message: string, _context?: Partial<Record<string, unknown>>, _error?: Error): void {
    return undefined;
  }
  error(_message: string, _context?: Partial<Record<string, unknown>>, _error?: Error): void {
    return undefined;
  }
  debug(_message: string, _context?: Partial<Record<string, unknown>>): void {
    return undefined;
  }
  child(): Logger {
    return this;
  }
  module(): Logger {
    return this;
  }
  startTimer(): () => void {
    return () => undefined;
  }
}

export interface MatrixContextSeed {
  tenantId?: string;
  accountId?: string;
}

/**
 * Reviewer-approved middleware that seeds declared Hono variables and runtime contexts only.
 * It never reproduces a production authorization decision; the seed simply supplies the tenant,
 * account-data, and logging context that requestContextMiddleware and
 * resolveAccountDataContextFromHono would otherwise establish.
 */
export function seedMatrixContext(kit: SecurityMatrixEnvKit, seed: MatrixContextSeed = {}) {
  return async (c: Context<{ Bindings: Env }>, next: () => Promise<void>): Promise<void> => {
    const tenantId = seed.tenantId ?? TEST_TENANT;
    const ctx = c as unknown as {
      set(key: string, value: unknown): void;
      get(key: string): unknown;
    };
    ctx.set('requestId', 'matrix-request-00000000-0000-4000-8000-000000000000');
    ctx.set('tenantId', tenantId);
    ctx.set('startTime', 1700000000);
    ctx.set('logger', new NoopLogger());
    ctx.set('tenantMetadataContext', {
      tenantId,
      coreDb: kit.coreAdapter,
    });
    ctx.set('accountDataContext', {
      tenantId,
      accountId: seed.accountId ?? TEST_ACCOUNT,
      legacyUserId: 'user-001',
      coreDb: kit.coreAdapter,
      piiDb: kit.piiAdapter,
      userCacheScope: 'tenant',
      piiCacheMode: 'merged',
    });
    await next();
  };
}

export interface MatrixAppOptions {
  tenantId?: string;
}

/**
 * Build the token endpoint Hono application with `tokenHandler` registered at the exact
 * production route `POST /token`. The returned app is invoked with `app.fetch(request, env, ctx)`
 * using a real `Request`, the frozen Env, and a ledger-backed `ExecutionContext`.
 */
export function createMatrixTokenApp(kit: SecurityMatrixEnvKit, options: MatrixAppOptions = {}) {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', seedMatrixContext(kit, options));
  app.post('/token', tokenHandler);
  return app;
}

export function createMatrixAuthorizeApp(
  kit: SecurityMatrixEnvKit,
  options: MatrixAppOptions = {}
) {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', seedMatrixContext(kit, options));
  app.get('/authorize', authorizeHandler);
  app.post('/authorize', authorizeHandler);
  app.get('/flow/login', authorizeLoginHandler);
  app.post('/flow/login', authorizeLoginHandler);
  app.get('/flow/confirm', authorizeConfirmHandler);
  app.post('/flow/confirm', authorizeConfirmHandler);
  return app;
}

export function requestUrl(path: string): string {
  return `${TEST_ISSUER}${path}`;
}
