import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { buildCoreMock, buildPolicyMock } from './helpers/index-mutation-helpers';
import {
  executionCtx,
  must,
  probe,
  request,
  anyString,
  objectContaining,
  stringContaining,
} from './helpers/index-mutation-helpers';

// hono's logger() binds console.log when the app module is evaluated, so record it before import.
const logCapture = vi.hoisted(() => {
  const lines: string[] = [];
  // eslint-disable-next-line no-console
  const original = console.log;
  // eslint-disable-next-line no-console
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  return { lines, original };
});
const loggerLines = logCapture.lines;

vi.mock('@authrim/ar-lib-core', async (importOriginal) =>
  (await import('./helpers/index-mutation-helpers')).buildCoreMock(
    await importOriginal<Parameters<typeof buildCoreMock>[0]>()
  )
);
vi.mock('@authrim/ar-lib-policy', async (importOriginal) =>
  (await import('./helpers/index-mutation-helpers')).buildPolicyMock(
    await importOriginal<Parameters<typeof buildPolicyMock>[0]>()
  )
);
vi.mock('../rebac-storage-adapter', async () =>
  (await import('./helpers/index-mutation-helpers')).buildAdapterMock()
);

import app, { SAML_DR_WRITER_SURFACES } from '../index';

const NOW_MS = 1_700_000_123_456;

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    POLICY_API_SECRET: 'policy-secret',
    ENABLE_POLICY_SIMULATION_API: 'true',
    ENABLE_REBAC: 'true',
    ...overrides,
  };
}

async function call(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    rawBody?: string;
    auth?: string | null;
    headers?: Record<string, string>;
  } = {},
  env: Record<string, unknown> = makeEnv()
) {
  const response = await app.request(request(path, options), undefined, env, executionCtx);
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // not JSON (for example an empty preflight body)
  }
  return { status: response.status, headers: response.headers, text, json };
}

const post = (path: string, body: unknown, env?: Record<string, unknown>) =>
  call(path, { method: 'POST', body }, env);

beforeEach(() => {
  probe.reset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
afterAll(() => {
  // eslint-disable-next-line no-console
  console.log = logCapture.original;
});

const FROZEN_MS = 1_700_000_123_456;
const freezeDate = () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(FROZEN_MS);
};

describe('global middleware and mounting', () => {
  it('runs the request-context, plugin and logger middleware on every path, 404s included', async () => {
    loggerLines.length = 0;
    const result = await call('/no/such/path', { auth: null });
    expect(result.status).toBe(404);
    expect(probe.errors).toEqual([{ code: 'AR060004', options: undefined }]);
    expect(probe.contextCalls).toBe(1);
    expect(probe.pluginCalls).toBe(1);
    expect(loggerLines).toEqual([
      '<-- GET /no/such/path',
      stringContaining('--> GET /no/such/path'),
    ]);
  });

  it('adds the content security policy and CORS headers to every response', async () => {
    const result = await call('/no/such/path', { auth: null });
    expect(result.headers.get('content-security-policy')).toBe("default-src 'self'");
    expect(result.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('answers a CORS preflight with the allowed methods, headers and max age', async () => {
    const result = await call('/api/policy/health', {
      method: 'OPTIONS',
      auth: null,
      headers: {
        Origin: 'https://client.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'X-Custom-Header',
      },
    });
    expect(result.status).toBe(204);
    expect(result.headers.get('access-control-allow-origin')).toBe('*');
    expect(result.headers.get('access-control-allow-methods')).toBe('GET,POST,OPTIONS');
    expect(result.headers.get('access-control-allow-headers')).toBe('Content-Type,Authorization');
    expect(result.headers.get('access-control-max-age')).toBe('86400');
  });

  it('serves the policy routes under /api/policy and at the root', async () => {
    for (const path of ['/api/policy/health', '/health']) {
      const result = await call(path, { auth: null });
      expect(result.status).toBe(200);
      expect(result.json.service).toBe('ar-policy');
    }
  });

  it('mounts the subscribe routes under /api/check', async () => {
    const result = await call('/api/check/subscribe', { auth: null });
    expect(result.status).toBe(403);
    expect(probe.errors).toEqual([{ code: 'AR050001', options: undefined }]);
  });

  it('logs an unhandled error and answers 500', async () => {
    probe.flagsThrow = true;
    const result = await call('/api/policy/health', { auth: null });
    expect(result.status).toBe(500);
    expect(probe.errors).toEqual([{ code: 'AR900001', options: undefined }]);
    expect(probe.logs).toEqual([
      {
        module: 'POLICY',
        level: 'error',
        message: 'Unhandled error',
        data: { error: 'Error: boom' },
      },
    ]);
  });

  it('declares fetch as its only SAML DR writer surface', () => {
    expect(SAML_DR_WRITER_SURFACES).toEqual(['fetch']);
  });
});

describe('GET /policy/health', () => {
  it('reports every feature flag under its own name', async () => {
    freezeDate();
    const result = await call(
      '/api/policy/health',
      { auth: null },
      makeEnv({
        ENABLE_ABAC: 'true',
        ENABLE_REBAC: 'false',
        ENABLE_POLICY_LOGGING: 'true',
        ENABLE_VERIFIED_ATTRIBUTES: 'false',
        ENABLE_CUSTOM_RULES: 'false',
      })
    );
    expect(result.status).toBe(200);
    expect(result.json).toEqual({
      status: 'ok',
      service: 'ar-policy',
      version: '0.1.0',
      timestamp: new Date(FROZEN_MS).toISOString(),
      features: {
        abac: true,
        rebac: false,
        logging: true,
        verifiedAttributes: false,
        customRules: false,
      },
    });
    expect(probe.flagCalls).toEqual([[undefined]]);
  });
});

describe('internal authentication scheme', () => {
  it.each([
    'Token  policy-secret',
    'bearer policy-secret',
    'Bearer  policy-secret',
    'policy-secret',
  ])('rejects %j even though the secret is present', async (auth) => {
    const result = await call('/api/policy/flags', { auth });
    expect(result.status).toBe(401);
    expect(probe.settingsCalls).toEqual([]);
  });

  it('rejects a bearer token that is only a prefix of the secret, or an unset secret', async () => {
    expect((await call('/api/policy/flags', { auth: 'Bearer policy' })).status).toBe(401);
    expect(
      (await call('/api/policy/flags', { auth: 'Bearer ' }, makeEnv({ POLICY_API_SECRET: '' })))
        .status
    ).toBe(401);
  });
});

describe('GET /policy/flags', () => {
  const allSettings = {
    'feature.enable_abac': true,
    'feature.enable_rebac': false,
    'feature.enable_policy_logging': true,
    'feature.enable_verified_attributes': true,
    'feature.enable_custom_rules': false,
  };

  it('requires internal authentication', async () => {
    const result = await call('/api/policy/flags', { auth: null });
    expect(result.status).toBe(401);
    expect(probe.errors).toEqual([{ code: 'AR000003', options: undefined }]);
    expect(probe.settingsCalls).toEqual([]);
  });

  it('reads the authenticated tenant fresh and reports each flag with its source', async () => {
    probe.settingsResult = () => ({
      values: allSettings,
      sources: {
        'feature.enable_abac': 'tenant',
        'feature.enable_rebac': 'platform',
        'feature.enable_policy_logging': 'env',
      },
    });
    const result = await call('/api/policy/flags', { headers: { 'X-Test-Tenant': 'tt ' } });
    expect(result.status).toBe(200);
    expect(result.json).toEqual({
      tenant_id: 'tt',
      flags: {
        ENABLE_ABAC: { value: true, source: 'tenant' },
        ENABLE_REBAC: { value: false, source: 'platform' },
        ENABLE_POLICY_LOGGING: { value: true, source: 'env' },
        ENABLE_VERIFIED_ATTRIBUTES: { value: true, source: 'default' },
        ENABLE_CUSTOM_RULES: { value: false, source: 'default' },
      },
    });
    expect(probe.settingsCalls).toEqual([
      { kind: 'effective', args: ['feature-flags', { tenantId: 'tt', fresh: true }] },
    ]);
  });

  it.each([[undefined], [''], [' ']])(
    'reads the platform fresh without an authenticated tenant (%j)',
    async (tenant) => {
      probe.settingsResult = () => ({ values: { 'feature.enable_abac': 'true' }, sources: {} });
      const headers: Record<string, string> =
        tenant === undefined ? {} : { 'X-Test-Tenant': tenant };
      const result = await call('/api/policy/flags', { headers });
      expect(result.status).toBe(200);
      expect(result.json.tenant_id).toBeNull();
      expect(result.json.flags).toMatchObject({
        ENABLE_ABAC: { value: false, source: 'default' },
      });
      expect(probe.settingsCalls).toEqual([
        { kind: 'platform', args: ['feature-flags', { fresh: true }] },
      ]);
    }
  );

  it('answers 503 when the settings cannot be read', async () => {
    probe.settingsThrows = true;
    const result = await call('/api/policy/flags');
    expect(result.status).toBe(503);
    expect(result.json).toEqual({
      error: 'temporarily_unavailable',
      error_description: 'Policy feature flags cannot be read; try again',
    });
  });

  it.each(['PUT', 'DELETE'])(
    '%s /flags/:name is gone, for authenticated callers only',
    async (method) => {
      const gone = await call('/api/policy/flags/ENABLE_ABAC', { method, body: { value: true } });
      expect(gone.status).toBe(410);
      expect(gone.json).toEqual({
        error: 'unsupported_operation',
        error_description:
          'Policy feature flags are set through the Settings API (feature.enable_*), not here',
      });

      probe.errors = [];
      const denied = await call('/api/policy/flags/ENABLE_ABAC', { method, auth: null });
      expect(denied.status).toBe(401);
      expect(probe.errors).toEqual([{ code: 'AR000003', options: undefined }]);
    }
  );
});

describe.each(['/evaluate', '/check-role', '/check-access', '/is-admin'])(
  'POST /policy%s gates',
  (path) => {
    it('requires internal authentication before anything else', async () => {
      const result = await call(`/api/policy${path}`, { method: 'POST', body: {}, auth: null });
      expect(result.status).toBe(401);
      expect(probe.errors).toEqual([{ code: 'AR000003', options: undefined }]);
      expect(probe.modules).toEqual(['POLICY']);
    });

    it('fails closed when the simulation API is disabled', async () => {
      const result = await post(
        `/api/policy${path}`,
        {},
        makeEnv({ ENABLE_POLICY_SIMULATION_API: 'false' })
      );
      expect(result.status).toBe(403);
      expect(probe.errors).toEqual([{ code: 'AR050001', options: undefined }]);
    });

    it('logs a malformed body and answers 500', async () => {
      const result = await call(`/api/policy${path}`, { method: 'POST', rawBody: '{' });
      expect(result.status).toBe(500);
      expect(probe.errors).toEqual([{ code: 'AR900001', options: undefined }]);
      const logged = must(probe.logs[0]);
      expect(probe.logs).toHaveLength(1);
      expect(logged.module).toBe('POLICY');
      expect(logged.level).toBe('error');
      expect(logged.message).toBe(
        {
          '/evaluate': 'Policy evaluation error',
          '/check-role': 'Role check error',
          '/check-access': 'Access check error',
          '/is-admin': 'Admin check error',
        }[path]
      );
      expect(logged.data).toEqual({ error: stringContaining('SyntaxError') });
    });
  }
);

describe('POST /policy/evaluate', () => {
  const subject = { id: 'user', roles: [{ name: 'admin', scope: 'global' }] };
  const full = { subject, resource: { type: 'document', id: 'doc' }, action: { name: 'read' } };

  it.each(['subject', 'resource', 'action'])('rejects a body without %s', async (field) => {
    const result = await post('/api/policy/evaluate', { ...full, [field]: undefined });
    expect(result.status).toBe(400);
    expect(probe.errors).toEqual([{ code: 'AR130003', options: undefined }]);
    expect(probe.engineContexts).toEqual([]);
  });

  it('evaluates the context with the supplied timestamp', async () => {
    const result = await post('/api/policy/evaluate', { ...full, timestamp: 5 });
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ allowed: true, decidedBy: 'admin_full_access' });
    expect(probe.engineContexts).toEqual([{ ...full, timestamp: 5 }]);
  });

  it('stamps the current time when no timestamp is supplied', async () => {
    freezeDate();
    await post('/api/policy/evaluate', full);
    expect(must(probe.engineContexts[0])).toMatchObject({ timestamp: FROZEN_MS });
  });

  it('denies a non-admin subject', async () => {
    const result = await post('/api/policy/evaluate', {
      ...full,
      subject: { id: 'user', roles: [] },
    });
    expect(result.status).toBe(200);
    expect(result.json.allowed).toBe(false);
  });
});

describe('POST /policy/check-role', () => {
  const subject = {
    id: 'user',
    roles: [{ name: 'admin', scope: 'organization', scopeTarget: 'org1' }],
  };

  it('requires a subject', async () => {
    const result = await post('/api/policy/check-role', { role: 'admin' });
    expect(result.status).toBe(400);
    expect(probe.errors).toEqual([
      { code: 'AR130001', options: { variables: { field: 'subject' } } },
    ]);
  });

  it.each([{}, { roles: [] }])('requires a role or a non-empty role list: %j', async (extra) => {
    const result = await post('/api/policy/check-role', { subject, ...extra });
    expect(result.status).toBe(400);
    expect(probe.errors).toEqual([{ code: 'AR130003', options: undefined }]);
    expect(probe.roleCalls).toEqual([]);
  });

  it('checks a single role with its scope, preferring it over a role list', async () => {
    const result = await post('/api/policy/check-role', {
      subject,
      role: 'admin',
      roles: ['other'],
      scope: 'organization',
      scopeTarget: 'org1',
    });
    expect(result.json).toEqual({ hasRole: true, activeRoles: ['admin'] });
    expect(probe.roleCalls).toEqual([
      { fn: 'hasRole', args: [subject, 'admin', { scope: 'organization', scopeTarget: 'org1' }] },
    ]);
  });

  it('reports a missing role as false', async () => {
    const result = await post('/api/policy/check-role', { subject, role: 'editor' });
    expect(result.json).toEqual({ hasRole: false, activeRoles: ['admin'] });
  });

  it('checks every listed role in all mode', async () => {
    const result = await post('/api/policy/check-role', {
      subject: { id: 'u', roles: [{ name: 'a', scope: 'global' }] },
      roles: ['a', 'b'],
      mode: 'all',
    });
    expect(result.json.hasRole).toBe(false);
    expect(probe.roleCalls.map((c) => c.fn)).toEqual(['hasAllRoles']);
    expect(probe.roleCalls[0]?.args).toEqual([
      { id: 'u', roles: [{ name: 'a', scope: 'global' }] },
      ['a', 'b'],
      { scope: undefined, scopeTarget: undefined },
    ]);
  });

  it.each([undefined, 'any'])('checks any listed role in %s mode', async (mode) => {
    probe.roleCalls = [];
    const result = await post('/api/policy/check-role', {
      subject: { id: 'u', roles: [{ name: 'a', scope: 'global' }] },
      roles: ['a', 'b'],
      mode,
    });
    expect(result.json.hasRole).toBe(true);
    expect(probe.roleCalls.map((c) => c.fn)).toEqual(['hasAnyRole']);
  });

  it('derives the subject from claims', async () => {
    const result = await post('/api/policy/check-role', {
      subject: { claims: { sub: 'claim-user', authrim_roles: ['admin'] } },
      role: 'admin',
    });
    expect(result.json).toEqual({ hasRole: true, activeRoles: ['admin'] });
  });

  it('lists only active roles, once each, treating the expiry instant as expired', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(10_000);
    const result = await post('/api/policy/check-role', {
      subject: {
        id: 'u',
        roles: [
          { name: 'expired', scope: 'global', expiresAt: 9_999 },
          { name: 'at-expiry', scope: 'global', expiresAt: 10_000 },
          { name: 'future', scope: 'global', expiresAt: 10_001 },
          { name: 'forever', scope: 'global' },
          { name: 'forever', scope: 'global' },
        ],
      },
      role: 'forever',
    });
    expect(result.json).toEqual({ hasRole: true, activeRoles: ['future', 'forever'] });
  });
});

describe('POST /policy/check-access', () => {
  const base = { resourceType: 'document', resourceId: 'doc', action: 'read' };

  it.each(['resourceType', 'resourceId', 'action'])('rejects a body without %s', async (field) => {
    const result = await post('/api/policy/check-access', {
      ...base,
      roles: [],
      [field]: undefined,
    });
    expect(result.status).toBe(400);
    expect(probe.errors).toEqual([{ code: 'AR130003', options: undefined }]);
    expect(probe.engineContexts).toEqual([]);
  });

  it('rejects a body with neither claims nor roles', async () => {
    const result = await post('/api/policy/check-access', base);
    expect(result.status).toBe(400);
    expect(probe.errors).toEqual([{ code: 'AR130003', options: undefined }]);
    expect(probe.engineContexts).toEqual([]);
  });

  it('builds the context from claims, letting subjectId override the claim subject', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
    const result = await post('/api/policy/check-access', {
      ...base,
      claims: { sub: 'claim-user', authrim_roles: ['end_user'] },
      subjectId: 'explicit-user',
      resourceOwnerId: 'explicit-user',
      resourceOrgId: 'org',
      operation: 'view',
    });
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ allowed: true, reason: anyString });
    const context = must(probe.engineContexts[0]) as { subject: { id: string } };
    expect(context).toEqual({
      subject: objectContaining({ id: 'explicit-user' }),
      resource: { type: 'document', id: 'doc', ownerId: 'explicit-user', orgId: 'org' },
      action: { name: 'read', operation: 'view' },
      timestamp: NOW_MS,
    });
  });

  it('keeps the claim subject when no subjectId is given', async () => {
    await post('/api/policy/check-access', {
      ...base,
      claims: { sub: 'claim-user', authrim_roles: ['end_user'] },
    });
    const context = must(probe.engineContexts[0]) as { subject: { id: string } };
    expect(context.subject.id).toBe('claim-user');
  });

  it('builds the context from direct roles with an empty subject id by default', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
    const result = await post('/api/policy/check-access', { ...base, roles: [] });
    expect(result.json).toEqual({ allowed: false, reason: anyString });
    expect(probe.engineContexts).toEqual([
      {
        subject: { id: '', roles: [] },
        resource: { type: 'document', id: 'doc', ownerId: undefined, orgId: undefined },
        action: { name: 'read', operation: undefined },
        timestamp: NOW_MS,
      },
    ]);
  });

  it('uses subjectId with direct roles', async () => {
    await post('/api/policy/check-access', {
      ...base,
      subjectId: 'u9',
      roles: [{ name: 'admin', scope: 'global' }],
    });
    expect(must(probe.engineContexts[0])).toMatchObject({
      subject: { id: 'u9', roles: [{ name: 'admin', scope: 'global' }] },
    });
  });
});

describe('POST /policy/is-admin', () => {
  it('rejects a body with neither claims nor roles', async () => {
    const result = await post('/api/policy/is-admin', {});
    expect(result.status).toBe(400);
    expect(probe.errors).toEqual([{ code: 'AR130003', options: undefined }]);
    expect(probe.isAdminSubjects).toEqual([]);
  });

  it('wraps role names as global roles of an anonymous subject', async () => {
    const result = await post('/api/policy/is-admin', { roles: ['admin', 'editor'] });
    expect(result.json).toEqual({ isAdmin: true });
    expect(probe.isAdminSubjects).toEqual([
      {
        id: '',
        roles: [
          { name: 'admin', scope: 'global' },
          { name: 'editor', scope: 'global' },
        ],
      },
    ]);
  });

  it('reports a non-admin as false', async () => {
    const result = await post('/api/policy/is-admin', { roles: ['editor'] });
    expect(result.json).toEqual({ isAdmin: false });
  });

  it('derives the subject from claims', async () => {
    const result = await post('/api/policy/is-admin', {
      claims: { sub: 'claim-user', authrim_roles: ['admin'] },
    });
    expect(result.json).toEqual({ isAdmin: true });
    expect(must(probe.isAdminSubjects[0])).toMatchObject({ id: 'claim-user' });
  });
});
