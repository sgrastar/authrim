/**
 * Shared collaborators for the check route mutation tests.
 *
 * The test files install these through `vi.mock` factories that import this module lazily, so the
 * spies below are the very ones check.ts calls.
 */
import { expect, vi } from 'vitest';
import type { CheckAuthResult } from '../../middleware/check-auth';
import type { RateLimitResult } from '../../middleware/rate-limit';

export const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};
/** Every module name a logger was requested for (survives resetMocks: created at import time). */
export const loggerNames: string[] = [];
export const loggerModule = vi.fn((name: string) => {
  loggerNames.push(name);
  return logger;
});

export const fns = {
  authenticate: vi.fn(),
  checkRateLimit: vi.fn(),
  check: vi.fn(),
  batchCheck: vi.fn(),
  createService: vi.fn(),
  createAudit: vi.fn(),
  resolveSettings: vi.fn(),
  resolveOptional: vi.fn(),
  resolveAccount: vi.fn(),
  resolveTenantPolicy: vi.fn(),
  getAdapter: vi.fn(),
  createRebac: vi.fn(),
  errorResponse: vi.fn(),
};

export const adapter = { name: 'core-adapter' };
export const rebacService = { name: 'rebac-service' };
export const auditService = { name: 'audit-service' };
export const repositories: Array<{ db: unknown }> = [];

export class FakeAttributeRepository {
  constructor(public db: unknown) {
    repositories.push(this);
  }
}

export const policySecretAuth: CheckAuthResult = {
  authenticated: true,
  method: 'policy_secret',
  allowedOperations: ['check', 'batch', 'subscribe'],
  rateLimitTier: 'lenient',
};

export const tenantAuth: CheckAuthResult = {
  authenticated: true,
  method: 'api_key',
  tenantId: 'tenant-a',
  apiKeyId: 'key-2',
  clientId: 'client-2',
  allowedOperations: ['check', 'batch'],
  rateLimitTier: 'moderate',
};

export const allowedRate: RateLimitResult = {
  allowed: true,
  current: 1,
  limit: 100,
  remaining: 99,
  resetAt: 1_700_000_000_999,
};

export function settingsReturning(values: {
  flags?: Record<string, unknown> | Error;
  limits?: Record<string, unknown> | Error;
  audit?: Record<string, unknown> | Error;
}): void {
  fns.resolveSettings.mockImplementation(async (_env: unknown, category: string) => {
    const value =
      category === 'feature-flags'
        ? values.flags
        : category === 'limits'
          ? values.limits
          : values.audit;
    if (value instanceof Error) throw value;
    return { values: value ?? {} };
  });
}

/** Resets every spy and installs the happy-path defaults. */
export function resetMocks(): void {
  for (const [name, fn] of Object.entries(fns)) {
    if (name === 'errorResponse') fn.mockClear();
    else fn.mockReset();
  }
  for (const fn of Object.values(logger)) fn.mockReset();
  loggerModule.mockClear();
  repositories.length = 0;
  settingsReturning({
    flags: { 'feature.enable_check_api': true },
    audit: { 'audit.check_api_enabled': false },
  });
  fns.authenticate.mockResolvedValue(policySecretAuth);
  fns.checkRateLimit.mockResolvedValue(allowedRate);
  fns.getAdapter.mockReturnValue(adapter);
  fns.createRebac.mockReturnValue(rebacService);
  fns.createAudit.mockReturnValue(auditService);
  fns.resolveOptional.mockReturnValue(adapter);
  fns.resolveTenantPolicy.mockResolvedValue({ name: 'tenant-policy' });
  fns.check.mockResolvedValue({ allowed: true, resolved_via: ['id_level'] });
  fns.batchCheck.mockResolvedValue({ results: [], summary: { total: 0 } });
  fns.createService.mockImplementation(() => ({ check: fns.check, batchCheck: fns.batchCheck }));
}

// --- vi.mock factories -------------------------------------------------------------------------

export function coreFactory<T extends object>(original: T): T {
  const realCreateErrorResponse = (original as unknown as { createErrorResponse: unknown })
    .createErrorResponse as (...args: unknown[]) => unknown;
  fns.errorResponse.mockImplementation((...args: unknown[]) => realCreateErrorResponse(...args));
  return {
    ...original,
    createErrorResponse: fns.errorResponse,
    createLogger: () => ({ module: loggerModule }),
    resolvePlatformSettingsWithSources: fns.resolveSettings,
    resolveOptionalCoreAdapterFromHono: fns.resolveOptional,
    resolveAccountCoreDataContext: fns.resolveAccount,
    UserVerifiedAttributeRepository: FakeAttributeRepository,
  };
}

export function authFactory<T extends object>(original: T): T {
  return { ...original, authenticateCheckApiRequest: fns.authenticate };
}

export function rateLimitFactory<T extends object>(original: T): T {
  return { ...original, checkRateLimit: fns.checkRateLimit };
}

export function adapterFactory() {
  return { getPolicyCoreAdapter: fns.getAdapter, createPolicyReBACService: fns.createRebac };
}

export function tenantPolicyFactory() {
  return { resolveTenantPolicy: fns.resolveTenantPolicy };
}

export function unifiedFactory<T extends object>(original: T): T {
  return { ...original, createUnifiedCheckService: fns.createService };
}

export function auditFactory<T extends object>(original: T): T {
  return { ...original, createCheckAuditService: fns.createAudit };
}

// --- request helpers ---------------------------------------------------------------------------

export function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
}

export const executionCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() };

export function makeEnv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    POLICY_API_SECRET: 'policy-secret',
    RATE_LIMITER: { name: 'limiter' },
    CHECK_CACHE_KV: { name: 'check-kv' },
    REBAC_CACHE_KV: { name: 'rebac-kv' },
    ...overrides,
  };
}

/** The `[code, options]` of the nth createErrorResponse call (default: the last). */
/** Forget earlier error responses so a stale call cannot satisfy an assertion. */
export function clearErrorCalls(): void {
  fns.errorResponse.mockClear();
}

export function errorCall(n = -1): { code: unknown; options: unknown } {
  const calls = fns.errorResponse.mock.calls;
  expect(calls).toHaveLength(1);
  const call = must(calls.at(n), 'an error response call');
  return { code: call[1], options: call[2] };
}

export function postJson(
  routes: { request: (...args: never[]) => Promise<Response> | Response },
  path: string,
  body: unknown,
  env: Record<string, unknown> = makeEnv(),
  headers: Record<string, string> = {}
): Promise<Response> {
  const request = routes.request as (
    input: string,
    init: RequestInit,
    env: unknown,
    ctx: unknown
  ) => Promise<Response>;
  return request(
    path,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer s', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
    env,
    executionCtx
  );
}

/** The `code`/description of an AR error response, as the client sees it. */
export async function errorBody(response: Response): Promise<Record<string, unknown>> {
  return await response.json<Record<string, unknown>>();
}

// --- typed views of the recorded calls -------------------------------------------------------

export interface ServiceConfig {
  db: unknown;
  cache: unknown;
  rebacService: unknown;
  cacheTTL: number;
  debugMode: boolean;
  auditService: unknown;
  attributeRepository: unknown;
  subjectAccountDb(tenantId: string, subjectId: string): Promise<unknown>;
  tenantPolicy(tenantId: string): Promise<unknown>;
}

export interface RecordedCall {
  request: { subject_type?: string; stop_on_deny?: boolean; checks: Array<{ tenant_id: string }> };
  options: { requestId?: string };
}

export function serviceConfig(): ServiceConfig {
  const config = fns.createService.mock.calls[0]?.[0] as ServiceConfig | undefined;
  return must(config, 'a service config');
}

function recorded(fn: typeof fns.check): RecordedCall {
  const call = must(fn.mock.calls[0], 'a recorded call') as unknown[];
  return {
    request: call[0] as RecordedCall['request'],
    options: call[1] as RecordedCall['options'],
  };
}

export const firstCheckCall = (): RecordedCall => recorded(fns.check);
export const firstBatchCall = (): RecordedCall => recorded(fns.batchCheck);
