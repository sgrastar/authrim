import { Hono, type Context, type Next } from 'hono';
import { vi } from 'vitest';

/**
 * Stand-ins for the auth worker's route handlers, so index-level tests can drive the real Hono
 * wiring (middleware order, route table, error handling) without reaching storage.
 * Every stub answers `{ handled: <export name>, path }`, and is shared across mock factories
 * through this module so a test can inspect calls by name.
 */
export const stubHandlers = new Map<string, ReturnType<typeof vi.fn>>();

export function resetStubHandlers(): void {
  for (const [name, handler] of stubHandlers) {
    handler
      .mockReset()
      .mockImplementation((c: Context) =>
        c.json({ handled: name, path: c.req.path, method: c.req.method })
      );
  }
}

export function stubModule(names: readonly string[]): Record<string, unknown> {
  const mod: Record<string, unknown> = {};
  for (const name of names) {
    let handler = stubHandlers.get(name);
    if (!handler) {
      handler = vi.fn((c: Context) =>
        c.json({ handled: name, path: c.req.path, method: c.req.method })
      );
      stubHandlers.set(name, handler);
    }
    mod[name] = handler;
  }
  return mod;
}

export function stubHandler(name: string): ReturnType<typeof vi.fn> {
  const handler = stubHandlers.get(name);
  if (!handler) throw new Error(`no stub handler named ${name}`);
  return handler;
}

/** Records each middleware that a lite-mode guard was asked to build, and where it ran. */
export const liteGuardCalls: Array<{ kind: string; name?: string; path: string }> = [];
export const liteBudgetOptions: Array<{ name: string; budget: unknown }> = [];

export function liteModeStub(): Record<string, unknown> {
  return {
    ...stubModule(['litePowChallengeHandler']),
    refuseForLiteTenant: () => async (c: Context, next: Next) => {
      liteGuardCalls.push({ kind: 'refuse', path: c.req.path });
      await next();
    },
    liteTenantBudget: (name: string, budget: unknown) => {
      liteBudgetOptions.push({ name, budget });
      return async (c: Context, next: Next) => {
        liteGuardCalls.push({ kind: 'budget', name, path: c.req.path });
        await next();
      };
    },
  };
}

export function emptySubApp(): Hono {
  return new Hono();
}

/** What the mocked ar-lib-core middleware factories were asked to build, and where they ran. */
export const coreCalls = {
  rateLimitOptions: [] as Array<Record<string, unknown>>,
  rateLimitBlock: { value: false },
  csrfOptions: [] as Array<unknown>,
  csrfRuns: [] as Array<{ instance: number; path: string }>,
  adminAuthOptions: [] as Array<Record<string, unknown>>,
  adminAuthRuns: [] as string[],
  diagnosticLoggingOptions: [] as Array<{ excludePatterns: RegExp[] }>,
  getRateLimitProfileAsync: vi.fn(),
  getTenantSettingsDocument: vi.fn(),
  getUIConfig: vi.fn(),
  writeFence: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn(),
  logModules: [] as string[],
};

export function resetCoreCalls(): void {
  coreCalls.rateLimitOptions.length = 0;
  coreCalls.rateLimitBlock.value = false;
  coreCalls.csrfRuns.length = 0;
  coreCalls.adminAuthRuns.length = 0;
  coreCalls.logModules.length = 0;
  coreCalls.getRateLimitProfileAsync
    .mockReset()
    .mockImplementation(async (_env: unknown, profile: string) => ({
      maxRequests: 7,
      windowSeconds: 30,
      profile,
    }));
  coreCalls.getTenantSettingsDocument.mockReset().mockResolvedValue(null);
  coreCalls.getUIConfig.mockReset().mockResolvedValue(null);
  coreCalls.writeFence.mockReset().mockReturnValue(null);
  coreCalls.logError.mockReset();
  coreCalls.logInfo.mockReset();
}

export function coreMock(actual: Record<string, unknown>): Record<string, unknown> {
  const passThrough = () => async (_c: Context, next: Next) => next();
  return {
    ...actual,
    requestContextMiddleware: () => async (c: Context, next: Next) => {
      const ctx = c as unknown as { set(key: string, value: unknown): void };
      ctx.set('requestId', 'mut-index');
      ctx.set('tenantId', c.req.header('X-Test-Tenant') ?? 'default');
      await next();
    },
    diagnosticLoggingMiddleware: (options: { excludePatterns: RegExp[] }) => {
      coreCalls.diagnosticLoggingOptions.push(options);
      return passThrough();
    },
    getRateLimitProfileAsync: coreCalls.getRateLimitProfileAsync,
    rateLimitMiddleware: (options: Record<string, unknown>) => {
      coreCalls.rateLimitOptions.push(options);
      return async (c: Context, next: Next) =>
        coreCalls.rateLimitBlock.value ? c.json({ error: 'rate_limited' }, 429) : next();
    },
    csrfProtectionMiddleware: (options?: unknown) => {
      const instance = coreCalls.csrfOptions.push(options) - 1;
      return async (c: Context, next: Next) => {
        coreCalls.csrfRuns.push({ instance, path: c.req.path });
        await next();
      };
    },
    adminAuthMiddleware: (options: Record<string, unknown>) => {
      coreCalls.adminAuthOptions.push(options);
      return async (c: Context, next: Next) => {
        coreCalls.adminAuthRuns.push(c.req.path);
        await next();
      };
    },
    getTenantSettingsDocument: coreCalls.getTenantSettingsDocument,
    getUIConfig: coreCalls.getUIConfig,
    createTenantPlacementWriteFenceResponse: coreCalls.writeFence,
    getLogger: () => ({
      module: (name: string) => {
        coreCalls.logModules.push(name);
        return { info: coreCalls.logInfo, error: coreCalls.logError, warn: vi.fn() };
      },
    }),
  };
}
