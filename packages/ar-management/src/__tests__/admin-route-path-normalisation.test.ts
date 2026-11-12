/**
 * The access gate decides on the path the router dispatches on. Matching the raw URL let an
 * escaped static segment (`/users/x/%6cegal-holds`) miss the specific rule of its route and fall
 * to a weaker catch-all while the router still reached the specific handler.
 *
 * These tests drive the REAL gate (`enforceDeclaredAdminRouteAccess`) on an app that mirrors the
 * route patterns of the management Worker, so they fail if the gate goes back to the raw pathname.
 */
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { AdminAuthContext, Env } from '@authrim/ar-lib-core';
import { ADMIN_PERMISSIONS } from '@authrim/ar-lib-core';
import { app as managementApp } from '../index';
import {
  ADMIN_ROUTE_ACCESS_RULES,
  findAdminRouteAccessRule,
  registerDeclaredAdminRouteAccessMiddleware,
  type AdminRouteAccessRule,
} from '../admin-route-access';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
const METHODS = new Set<string>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/** The route patterns of the real management app under the gated prefixes. */
const REAL_ROUTES = (() => {
  const seen = new Set<string>();
  const routes: Array<{ method: Method; path: string }> = [];
  for (const route of managementApp.routes) {
    if (!METHODS.has(route.method)) continue;
    if (!route.path.startsWith('/api/admin/') && !route.path.startsWith('/api/internal/')) continue;
    const key = `${route.method} ${route.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    routes.push({ method: route.method as Method, path: route.path });
  }
  return routes;
})();

function callerWith(permissions: string[]): AdminAuthContext {
  return {
    userId: 'admin-1',
    authMethod: 'session',
    actorType: 'human',
    tenantId: 'tenant-a',
    roles: [],
    permissions,
    tenantScope: ['tenant-a'],
    hierarchyLevel: 0,
    mfaVerified: false,
  };
}

/** The gate in front of stub handlers on the real route patterns. */
function mirror(auth: AdminAuthContext | null, env: Record<string, unknown> = {}) {
  const app = new Hono<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>();
  app.use('*', async (c, next) => {
    if (auth) c.set('adminAuth', auth);
    await next();
  });
  registerDeclaredAdminRouteAccessMiddleware(app);
  for (const route of REAL_ROUTES) {
    app.on(route.method, route.path, (c) => {
      const segments = c.req.path.split('/');
      return c.json({
        handler: route.path,
        gatePath: c.req.path,
        param: c.req.param(),
        last: segments[segments.length - 1],
      });
    });
  }
  return async (method: string, path: string) => {
    const res = await app.request(path, { method }, env);
    let handler: string | null = null;
    let body: Record<string, unknown> = {};
    if (res.status === 200) {
      body = await res.json<Record<string, unknown>>();
      handler = body.handler as string;
    }
    return { status: res.status, handler, body };
  };
}

const isParam = (segment: string) => segment === '*' || segment.startsWith(':');
const escapeChar = (segment: string, at: number, upper: boolean) => {
  const hex = segment.charCodeAt(at).toString(16).padStart(2, '0');
  return `${segment.slice(0, at)}%${upper ? hex.toUpperCase() : hex}${segment.slice(at + 1)}`;
};
const escapeAll = (segment: string, upper: boolean) =>
  [...segment]
    .map((_, at) => {
      const hex = segment.charCodeAt(at).toString(16).padStart(2, '0');
      return `%${upper ? hex.toUpperCase() : hex}`;
    })
    .join('');

/** Sample path of a rule pattern, with chosen replacements for static segments. */
const sample = (segments: string[], replace: Map<number, string> = new Map()) =>
  segments
    .map((segment, index) => replace.get(index) ?? (isParam(segment) ? 'x' : segment))
    .join('/');

/** The permissions another rule would accept from a caller that holds only them. */
function permissionsOf(rule: AdminRouteAccessRule): string[] {
  return [...(rule.permissions ?? []), ...(rule.anyPermissions ?? [])];
}

const patternToRegExp = (pattern: string) =>
  new RegExp(
    `^${pattern
      .split('/')
      .map((segment) =>
        segment === '*'
          ? '.*'
          : segment.startsWith(':')
            ? '[^/]+'
            : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      )
      .join('/')}$`
  );
const COMPILED = ADMIN_ROUTE_ACCESS_RULES.map((rule) => ({
  rule,
  regex: patternToRegExp(rule.pattern),
}));

describe('the real gate, one escaped spelling at a time, for every rule', () => {
  /**
   * For each rule and method, and for each other rule that also matches the plain path (a
   * catch-all, or a sibling), a caller holding only that other rule's permissions must get the
   * same decision and the same handler for an escaped spelling as for the plain path, or a refusal.
   */
  it('decides an escaped spelling as the plain path, never more permissively', async () => {
    const callers = new Map<string, ReturnType<typeof mirror>>();
    const callerFor = (permissions: string[]) => {
      const key = [...permissions].sort().join(',');
      if (!callers.has(key)) callers.set(key, mirror(callerWith(permissions)));
      return callers.get(key)!;
    };
    const violations: string[] = [];
    let checked = 0;
    for (const rule of ADMIN_ROUTE_ACCESS_RULES) {
      const segments = rule.pattern.split('/');
      const plain = sample(segments);
      const holders = COMPILED.filter(
        (other) =>
          other.rule !== rule &&
          other.regex.test(plain) &&
          other.rule.methods.some((method) => rule.methods.includes(method))
      )
        .map((other) => permissionsOf(other.rule))
        .filter((permissions) => permissions.length > 0);
      const spellings: string[] = [];
      segments.forEach((segment, index) => {
        if (isParam(segment) || segment === '') return;
        const last = segment.length - 1;
        for (const [at, upper] of [
          [0, false],
          [Math.floor(last / 2), true],
          [last, false],
        ] as const) {
          spellings.push(sample(segments, new Map([[index, escapeChar(segment, at, upper)]])));
        }
        spellings.push(sample(segments, new Map([[index, escapeAll(segment, true)]])));
        spellings.push(sample(segments, new Map([[index, escapeAll(segment, false)]])));
      });
      for (const method of rule.methods) {
        for (const permissions of holders) {
          const call = callerFor(permissions);
          const expected = await call(method, plain);
          for (const spelling of spellings) {
            checked += 1;
            const got = await call(method, spelling);
            const widened =
              got.status === 200 &&
              (expected.status !== 200 ||
                (expected.handler !== null && got.handler !== expected.handler));
            if (widened) {
              violations.push(
                `${method} ${spelling} -> ${got.handler} (plain ${plain}: ${expected.status} ${expected.handler})`
              );
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(5_000);
    expect(violations).toEqual([]);
  });

  it('treats a parameter segment that decodes to a static sibling name as that sibling', async () => {
    // Static names that sit next to a parameter in some pattern: an id that decodes to one of them
    // is that route, for the router, so it must be that rule for the gate.
    const names = new Map<string, Set<string>>();
    for (const rule of ADMIN_ROUTE_ACCESS_RULES) {
      const segments = rule.pattern.split('/');
      segments.forEach((segment, index) => {
        if (isParam(segment) || segment === '' || index < 3) return;
        const prefix = segments.slice(0, index).join('/');
        (names.get(prefix) ?? names.set(prefix, new Set()).get(prefix)!).add(segment);
      });
    }
    const violations: string[] = [];
    let checked = 0;
    for (const rule of ADMIN_ROUTE_ACCESS_RULES) {
      const segments = rule.pattern.split('/');
      for (let index = 3; index < segments.length; index += 1) {
        if (!isParam(segments[index])) continue;
        const prefix = segments.slice(0, index).join('/');
        for (const name of names.get(prefix) ?? []) {
          for (const method of rule.methods) {
            const plain = sample(segments, new Map([[index, name]]));
            const permissions = permissionsOf(
              findAdminRouteAccessRule(method, sample(segments, new Map([[index, '~none~']]))) ??
                rule
            );
            const call = mirror(callerWith(permissions));
            const expected = await call(method, plain);
            for (const spelling of [escapeAll(name, false), escapeChar(name, 0, true)]) {
              checked += 1;
              const got = await call(method, sample(segments, new Map([[index, spelling]])));
              if (
                got.status === 200 &&
                (expected.status !== 200 || got.handler !== expected.handler)
              ) {
                violations.push(
                  `${method} ${spelling} at ${prefix}: ${got.handler} vs ${expected.handler}`
                );
              }
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
    expect(violations).toEqual([]);
  });
});

describe('end to end examples', () => {
  const cases: Array<[string, string, string, string]> = [
    [
      'POST',
      '/api/admin/users/x/legal-holds',
      '/api/admin/users/x/%6cegal-holds',
      ADMIN_PERMISSIONS.USERS_WRITE,
    ],
    [
      'GET',
      '/api/admin/jobs/schedules',
      '/api/admin/jobs/%73chedules',
      ADMIN_PERMISSIONS.JOBS_READ,
    ],
  ];

  it.each(cases)(
    '%s %s is refused as %s for a caller holding only the weaker permission',
    async (method, plain, escaped, permission) => {
      const call = mirror(callerWith([permission]));
      expect((await call(method, plain)).status).toBe(403);
      expect((await call(method, escaped)).status).toBe(403);
      expect((await call(method, escaped.replace('/admin/', '/%61dmin/'))).status).toBe(403);
    }
  );

  it('lets the caller with the specific permission reach the route, escaped or not', async () => {
    const call = mirror(callerWith([ADMIN_PERMISSIONS.ACCOUNT_LEGAL_HOLDS_WRITE]));
    expect((await call('POST', '/api/admin/users/x/legal-holds')).status).toBe(200);
    expect((await call('POST', '/api/admin/users/x/%6cegal-holds')).status).toBe(200);
  });
});

describe('malformed and partly decodable paths', () => {
  const SETTINGS = '/api/admin/tenants/tenant-a/settings/';
  const wide = ADMIN_PERMISSIONS.ALL;

  it.each([
    '%6%34cr', // Hono would repair this into the text %64cr, which a param decodes to dcr
    '%2%35', // repaired into %25
    '%',
    '%z',
    '%zz',
    '%e0%a4%a', // truncated UTF-8
    '%64%zz', // valid and invalid mixed
    'd%',
    '%%64cr',
    '%2',
  ])('refuses %s with 400 invalid_request, before anything else path related', async (segment) => {
    const call = mirror(callerWith([wide]));
    const res = await call('PATCH', SETTINGS + segment);
    expect(res.status).toBe(400);
    const anonymous = await mirror(null)('PATCH', SETTINGS + segment);
    // Authentication still comes first.
    expect(anonymous.status).toBe(401);
  });

  it('refuses a malformed escape anywhere in the path, not only in the last segment', async () => {
    const call = mirror(callerWith([wide]));
    for (const path of ['/api/admin/users/%/legal-holds', '/api/admin/users/x/legal-holds%']) {
      expect((await call('GET', path)).status, path).toBe(400);
    }
  });

  it.each(['%c0%af', '%ff', '%c1%81', '%e0%80%af', '%ed%a0%80'])(
    'does not turn well-formed but invalid UTF-8 %s into a rule name or a different handler',
    async (segment) => {
      const call = mirror(callerWith([wide]));
      const res = await call('PATCH', SETTINGS + segment);
      expect([200, 403, 404]).toContain(res.status);
      if (res.status === 200) {
        const param = res.body.param as Record<string, string>;
        expect(param.category).not.toMatch(/^[a-z-]+$/);
      }
    }
  );

  it('allows double-encoded text in an id: it is one segment, once decoded by the handler', async () => {
    const call = mirror(callerWith([wide]));
    const res = await call(
      'GET',
      '/api/admin/resource-permissions/resource/document/report%2520final'
    );
    expect(res.status).toBe(200);
    expect((res.body.param as Record<string, string>).id).toBe('report%20final');
  });

  it('keeps an escaped slash inside its segment', async () => {
    const call = mirror(callerWith([wide]));
    const res = await call('PATCH', SETTINGS + 'd%2Fcr');
    expect(res.status).toBe(200);
    expect((res.body.param as Record<string, string>).category).toBe('d/cr');
    expect([403, 404]).toContain((await call('GET', '/api/admin/jobs%2Fschedules')).status);
  });

  it('never gives more for a trailing slash or a changed case than the plain path gives', async () => {
    const call = mirror(callerWith([ADMIN_PERMISSIONS.USERS_WRITE]));
    for (const path of [
      '/api/admin/users/x/legal-holds/',
      '/api/admin/users/x/%4cegal-holds',
      '/api/admin/users/x/Legal-Holds',
    ]) {
      expect((await call('POST', path)).status, path).not.toBe(200);
    }
  });
});

describe('a double-encoded static name is not the name', () => {
  // The names with a rule of their own: a param equal to one of them would pick that rule's handler.
  const STATIC_NAMES = new Set(
    ADMIN_ROUTE_ACCESS_RULES.flatMap((rule) =>
      rule.pattern.split('/').filter((segment) => segment && !isParam(segment))
    )
  );

  it('ends in the catch-all handler, with the literal text as its param, never the specific name', async () => {
    const call = mirror(callerWith([ADMIN_PERMISSIONS.ALL]));
    for (const path of [
      '/api/admin/tenants/tenant-a/settings/%2564cr',
      '/api/admin/tenants/tenant-a/settings/%25%36%34cr',
      '/api/admin/tenants/tenant-a/settings/%2564%63r',
    ]) {
      const res = await call('PATCH', path);
      expect(res.status, path).toBe(200);
      const category = (res.body.param as Record<string, string>).category;
      expect(category.startsWith('%'), path).toBe(true);
      expect(STATIC_NAMES.has(category), path).toBe(false);
    }
  });

  /**
   * The divergence argument, checked on a corpus: for every well-formed raw segment built from
   * these pieces, the handler's param is a static route name only if the path text the gate
   * matched already was that name.
   */
  it('cannot give a handler param that is a static name the gate did not see', async () => {
    const pieces = [
      '%64',
      '%25',
      '%2564',
      '%63',
      '%72',
      'dcr',
      'd',
      '%2F',
      '%2f',
      '%c0',
      '%af',
      '%ff',
      '%e0',
      '%a4',
      '%a4',
      '25',
      '64',
      '%3A',
      '%40',
    ];
    const call = mirror(callerWith([ADMIN_PERMISSIONS.ALL]));
    let checked = 0;
    const offenders: string[] = [];
    const build = (parts: string[]): string[] =>
      parts.length === 0
        ? ['']
        : [''].concat(...pieces.map((piece) => build(parts.slice(1)).map((rest) => piece + rest)));
    for (const raw of new Set([...build([0, 1, 2].map(String)), ...build([0, 1].map(String))])) {
      if (!raw || /%(?![0-9A-Fa-f]{2})/.test(raw)) continue;
      const res = await call('PATCH', '/api/admin/tenants/tenant-a/settings/' + raw);
      checked += 1;
      if (res.status !== 200) continue;
      const category = (res.body.param as Record<string, string>).category;
      if (STATIC_NAMES.has(category) && res.body.last !== category) {
        offenders.push(`${raw} -> param ${category}, gate saw ${String(res.body.last)}`);
      }
    }
    expect(checked).toBeGreaterThan(1000);
    expect(offenders).toEqual([]);
  });
});

describe('the capability switches and escaped or malformed paths', () => {
  const SETTINGS = '/api/admin/tenants/tenant-a/settings/';
  const switchesOff = (capability: string) => ({
    SETTINGS: {
      get: async (key: string) =>
        key === 'settings:platform:tenant-capabilities'
          ? JSON.stringify({ [`tenant_capabilities.${capability}`]: false })
          : null,
      put: async () => undefined,
      delete: async () => undefined,
      list: async () => ({ keys: [] }),
      getWithMetadata: async () => ({ value: null, metadata: null }),
    },
  });
  const writer = () => callerWith([ADMIN_PERMISSIONS.SETTINGS_WRITE]);

  it.each([
    ['dynamic_client_registration', ['dcr', '%64cr', '%64%63r']],
    ['external_plugins', ['plugin', '%70lugin', '%70%6cugin']],
  ])(
    'refuses %s settings writes in every spelling of the category while it is off',
    async (capability, spellings) => {
      const call = mirror(writer(), switchesOff(capability));
      for (const spelling of spellings) {
        const res = await call('PATCH', SETTINGS + spelling);
        expect(res.status, spelling).toBe(403);
      }
      // Static segments of the path escaped as well.
      expect(
        (await call('PATCH', '/api/admin/tenants/tenant-a/%73ettings/' + spellings[0])).status
      ).toBe(403);
    }
  );

  it('leaves other categories alone while a capability is off', async () => {
    const call = mirror(writer(), switchesOff('dynamic_client_registration'));
    expect((await call('PATCH', SETTINGS + 'diagnostic-logging')).status).toBe(200);
    expect((await call('PATCH', SETTINGS + '%64iagnostic-logging')).status).toBe(200);
  });

  it('answers 400 to a malformed path before the capability is looked at', async () => {
    const call = mirror(writer(), switchesOff('dynamic_client_registration'));
    for (const spelling of ['%6%34cr', '%2%35', '%zz']) {
      expect((await call('PATCH', SETTINGS + spelling)).status, spelling).toBe(400);
    }
    const anonymous = await mirror(null, switchesOff('dynamic_client_registration'))(
      'PATCH',
      SETTINGS + '%6%34cr'
    );
    expect(anonymous.status).toBe(401);
  });

  it('answers 403 capability_disabled with the capability, and 503 when the switch cannot be read', async () => {
    const off = await mirror(writer(), switchesOff('external_plugins'))(
      'PATCH',
      SETTINGS + '%70lugin'
    );
    expect(off.status).toBe(403);
    const unreadable = await mirror(writer(), {
      SETTINGS: {
        get: async () => {
          throw new Error('kv down');
        },
      },
    })('PATCH', SETTINGS + '%70lugin');
    expect(unreadable.status).toBe(503);
  });
});
