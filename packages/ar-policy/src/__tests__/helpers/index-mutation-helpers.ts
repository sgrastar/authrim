/**
 * Shared probes and module-mock factories for the src/index.ts mutation tests.
 *
 * Only observation points are replaced (request context, logger, notifier, ReBAC storage);
 * authentication, validation, flag resolution and routing in src/index.ts run for real.
 */
import { expect, vi } from 'vitest';
import type { Context, Next } from 'hono';

export function must<T>(value: T | null | undefined, label = 'value'): T {
  if (value === null || value === undefined) {
    throw new Error(`Expected ${label} to be defined`);
  }
  return value;
}

export interface LoggedCall {
  module: string;
  level: 'error' | 'warn';
  message: string;
  data: unknown;
}

export interface FakeAdapter {
  queryOne: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
}

export interface FakeRebacService {
  check: ReturnType<typeof vi.fn>;
  batchCheck: ReturnType<typeof vi.fn>;
  listObjects: ReturnType<typeof vi.fn>;
  listUsers: ReturnType<typeof vi.fn>;
  invalidateCache: ReturnType<typeof vi.fn>;
  invalidateUserCache: ReturnType<typeof vi.fn>;
}

export const probe = {
  modules: [] as string[],
  logs: [] as LoggedCall[],
  events: [] as unknown[],
  notifierOptions: [] as Array<Record<string, unknown>>,
  publishThrows: false,
  adapterThrows: false,
  serviceThrows: false,
  serviceFactoryArgs: [] as unknown[][],
  flagCalls: [] as unknown[][],
  flagsThrow: false,
  healthAdapter: null as unknown,
  healthAdapterNames: [] as unknown[],
  settingsCalls: [] as Array<{ kind: 'effective' | 'platform'; args: unknown[] }>,
  settingsResult: undefined as
    | undefined
    | (() => { values: Record<string, unknown>; sources: Record<string, string> }),
  settingsThrows: false,
  engineContexts: [] as unknown[],
  isAdminSubjects: [] as unknown[],
  roleCalls: [] as Array<{ fn: string; args: unknown[] }>,
  errors: [] as Array<{ code: string; options: unknown }>,
  contextCalls: 0,
  pluginCalls: 0,
  adapter: undefined as unknown as FakeAdapter,
  service: undefined as unknown as FakeRebacService,
  reset() {
    this.modules = [];
    this.logs = [];
    this.events = [];
    this.notifierOptions = [];
    this.publishThrows = false;
    this.adapterThrows = false;
    this.serviceThrows = false;
    this.serviceFactoryArgs = [];
    this.flagCalls = [];
    this.flagsThrow = false;
    this.healthAdapter = null;
    this.healthAdapterNames = [];
    this.settingsCalls = [];
    this.settingsResult = undefined;
    this.settingsThrows = false;
    this.engineContexts = [];
    this.isAdminSubjects = [];
    this.roleCalls = [];
    this.errors = [];
    this.contextCalls = 0;
    this.pluginCalls = 0;
    this.adapter = {
      queryOne: vi.fn().mockResolvedValue(null),
      execute: vi.fn().mockResolvedValue({ rowsAffected: 1 }),
    };
    this.service = {
      check: vi.fn().mockResolvedValue({ allowed: true }),
      batchCheck: vi.fn().mockResolvedValue({ results: [] }),
      listObjects: vi.fn().mockResolvedValue({ objects: [] }),
      listUsers: vi.fn().mockResolvedValue({ users: [] }),
      invalidateCache: vi.fn().mockResolvedValue(undefined),
      invalidateUserCache: vi.fn().mockResolvedValue(undefined),
    };
  },
};
probe.reset();

type CoreModule = typeof import('@authrim/ar-lib-core');

/**
 * Header-driven request context: X-Test-Tenant sets the authenticated tenant, X-Test-Admin sets
 * an authenticated administrator (X-Test-Perms=none gives it no permissions).
 */
export function buildCoreMock(actual: CoreModule): Record<string, unknown> {
  return {
    ...actual,
    requestContextMiddleware: () => async (c: Context, next: Next) => {
      probe.contextCalls += 1;
      const ctx = c as unknown as { set(key: string, value: unknown): void };
      const tenant = c.req.header('X-Test-Tenant');
      if (tenant !== undefined) ctx.set('tenantId', tenant);
      const admin = c.req.header('X-Test-Admin');
      if (admin) {
        ctx.set('adminAuth', {
          userId: admin,
          authMethod: 'machine_access_token',
          actorType: 'machine',
          actorId: admin,
          tenantId: c.req.header('X-Test-Admin-Tenant') ?? 'default',
          tenantScope: ['*'],
          roles: [],
          permissions:
            c.req.header('X-Test-Perms') === 'none'
              ? []
              : [actual.ADMIN_PERMISSIONS.POLICY_REBAC_WRITE],
          hierarchyLevel: 0,
          mfaVerified: false,
        });
      }
      await next();
    },
    pluginContextMiddleware: () => async (_c: Context, next: Next) => {
      probe.pluginCalls += 1;
      await next();
    },
    getLogger: () => ({
      module: (name: string) => {
        probe.modules.push(name);
        return {
          error: (message: string, data?: unknown) =>
            probe.logs.push({ module: name, level: 'error', message, data }),
          warn: (message: string, data?: unknown) =>
            probe.logs.push({ module: name, level: 'warn', message, data }),
          info: () => undefined,
          debug: () => undefined,
        };
      },
    }),
    createPermissionChangeNotifier: (options: Record<string, unknown>) => {
      probe.notifierOptions.push(options);
      return {
        publish: async (event: unknown) => {
          if (probe.publishThrows) throw new Error('hub down');
          probe.events.push(event);
        },
      };
    },
    createErrorResponse: (...args: Parameters<CoreModule['createErrorResponse']>) => {
      probe.errors.push({ code: args[1], options: args[2] });
      return actual.createErrorResponse(...args);
    },
    resolveEffectiveSettingsWithSources: async (
      ...args: Parameters<CoreModule['resolveEffectiveSettingsWithSources']>
    ) => {
      probe.settingsCalls.push({ kind: 'effective', args: args.slice(1) });
      if (probe.settingsThrows) throw new Error('settings down');
      if (probe.settingsResult) return probe.settingsResult() as never;
      return actual.resolveEffectiveSettingsWithSources(...args);
    },
    resolvePlatformSettingsWithSources: async (
      ...args: Parameters<CoreModule['resolvePlatformSettingsWithSources']>
    ) => {
      probe.settingsCalls.push({ kind: 'platform', args: args.slice(1) });
      if (probe.settingsThrows) throw new Error('settings down');
      if (probe.settingsResult) return probe.settingsResult() as never;
      return actual.resolvePlatformSettingsWithSources(...args);
    },
    resolveOptionalCoreAdapterFromHono: (_c: unknown, name: unknown) => {
      probe.healthAdapterNames.push(name);
      return probe.healthAdapter;
    },
    resolvePolicyFlags: async (...args: Parameters<CoreModule['resolvePolicyFlags']>) => {
      probe.flagCalls.push([args[1]]);
      if (probe.flagsThrow) throw new Error('boom');
      return actual.resolvePolicyFlags(...args);
    },
  };
}

type PolicyModule = typeof import('@authrim/ar-lib-policy');

/** Pass-through wrappers that record what src/index.ts hands to the policy engine. */
export function buildPolicyMock(actual: PolicyModule): Record<string, unknown> {
  const recordRole =
    <K extends 'hasRole' | 'hasAnyRole' | 'hasAllRoles'>(name: K) =>
    (...args: Parameters<PolicyModule[K]>) => {
      probe.roleCalls.push({ fn: name, args });
      return (actual[name] as (...a: unknown[]) => boolean)(...args);
    };
  return {
    ...actual,
    createDefaultPolicyEngine: () => {
      const engine = actual.createDefaultPolicyEngine();
      return {
        evaluate: (context: Parameters<typeof engine.evaluate>[0]) => {
          probe.engineContexts.push(context);
          return engine.evaluate(context);
        },
      };
    },
    isAdmin: (subject: Parameters<PolicyModule['isAdmin']>[0]) => {
      probe.isAdminSubjects.push(subject);
      return actual.isAdmin(subject);
    },
    hasRole: recordRole('hasRole'),
    hasAnyRole: recordRole('hasAnyRole'),
    hasAllRoles: recordRole('hasAllRoles'),
  };
}

export function buildAdapterMock() {
  return {
    getPolicyCoreAdapter: () => {
      if (probe.adapterThrows) throw new Error('no core adapter');
      return probe.adapter;
    },
    createPolicyReBACService: (...args: unknown[]) => {
      probe.serviceFactoryArgs.push(args);
      if (probe.serviceThrows) throw new Error('no rebac service');
      return probe.service;
    },
  };
}

export function request(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    rawBody?: string;
    auth?: string | null;
    headers?: Record<string, string>;
  } = {}
): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.auth !== null) headers.Authorization = options.auth ?? 'Bearer policy-secret';
  Object.assign(headers, options.headers);
  return new Request(`https://policy.example${path}`, {
    method: options.method ?? 'GET',
    headers,
    body:
      options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
  });
}

export const executionCtx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

/** Typed asymmetric matchers (expect.* return `any`). */
export const anyString = expect.any(String) as string;
export const objectContaining = (value: Record<string, unknown>): Record<string, unknown> =>
  expect.objectContaining(value) as Record<string, unknown>;
export const stringContaining = (value: string): string => expect.stringContaining(value) as string;
