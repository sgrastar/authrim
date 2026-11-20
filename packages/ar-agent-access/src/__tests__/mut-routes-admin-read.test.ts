import { describe, expect, it } from 'vitest';
import type { JsonObject, JsonValue } from '../core';
import {
  CLOUDFLARE_ADMIN_READ_ROUTES,
  projectAgentInspectionResponse,
} from '../platform/cloudflare/admin-read-routes';

const context = { tenantId: 'tenant-1' };

function path(operation: string, input: JsonObject = {}): string {
  const route = CLOUDFLARE_ADMIN_READ_ROUTES[operation];
  if (!route) throw new Error(`missing route ${operation}`);
  return typeof route.path === 'function' ? route.path(input, context) : route.path;
}

function cursor(value: JsonValue): string {
  return btoa(JSON.stringify(value)).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

describe('admin read routes: pagination and cursors', () => {
  it('accepts page_size only as a safe integer within 1..50, otherwise defaults to 20', () => {
    const limit = (page_size: JsonValue) =>
      new URL(path('admin.read.clients.list', { page_size }), 'https://x').searchParams.get(
        'limit'
      );
    expect(limit(1)).toBe('1');
    expect(limit(50)).toBe('50');
    expect(limit(0)).toBe('20');
    expect(limit(51)).toBe('20');
    expect(limit(-5)).toBe('20');
    expect(limit(2.5)).toBe('20');
    expect(limit('10')).toBe('20');
    expect(path('admin.read.clients.list')).toBe('/api/admin/agent-read/clients?page=1&limit=20');
  });

  it('decodes base64url cursors including - and _ characters and unpadded input', () => {
    // {"v":1,"p":1000003,"x":"???>>>"} produces '+' and '/' in standard base64.
    const value = { v: 1, p: 1_000_003, x: '???>>>' };
    const encoded = cursor(value);
    expect(encoded).toMatch(/[-_]/u);
    expect(encoded.length % 4).not.toBe(0);
    expect(path('admin.read.clients.list', { cursor: encoded })).toBe(
      '/api/admin/agent-read/clients?page=1000003&limit=20'
    );
    expect(path('admin.read.clients.list', { cursor: cursor({ v: 1, p: 1 }) })).toBe(
      '/api/admin/agent-read/clients?page=1&limit=20'
    );
    expect(path('admin.read.clients.list', { cursor: '' })).toContain('page=1&');
  });

  it.each([
    ['null', null],
    ['array', [1]],
    ['string', 'abc'],
    ['wrong version', { v: 2, p: 3 }],
    ['zero page', { v: 1, p: 0 }],
    ['fractional page', { v: 1, p: 1.5 }],
    ['missing page', { v: 1 }],
  ])('rejects a %s cursor with the exact error', (_name, value) => {
    expect(() => path('admin.read.users.search', { cursor: cursor(value as JsonValue) })).toThrow(
      new TypeError('Invalid Agent read cursor')
    );
  });

  it('maps search filters to their Admin API query names', () => {
    expect(
      path('admin.read.users.search', {
        query: 'alice',
        verified: false,
        lifecycle_state: 'suspended',
        ignored: 'x',
      })
    ).toBe(
      '/api/admin/agent-read/users?page=1&limit=20&search=alice&verified=false&lifecycle_state=suspended'
    );
    expect(path('admin.read.clients.list', { query: 'app', verified: true })).toBe(
      '/api/admin/agent-read/clients?page=1&limit=20&search=app'
    );
    expect(
      path('admin.read.audit.search', {
        actor_id: 'admin-1',
        action: 'user.suspend',
        resource_type: 'user',
        result: 'failure',
        severity: 'warn',
        start_date: '2026-01-01',
        end_date: '2026-02-01',
        page_size: 5,
      })
    ).toBe(
      '/api/admin/agent-read/admin-audit-log?page=1&limit=5&admin_user_id=admin-1&action=user.suspend&resource_type=user&result=failure&severity=warn&start_date=2026-01-01&end_date=2026-02-01'
    );
  });
});

describe('admin read routes: identifiers', () => {
  it('validates user ids and reports the exact error', () => {
    expect(path('admin.read.users.get', { user_id: 'user_1.a~b-c' })).toBe(
      '/api/admin/agent-read/users/user_1.a~b-c'
    );
    expect(() => path('admin.read.users.get', {})).toThrow(new TypeError('Invalid user_id'));
    expect(() => path('admin.read.users.get', { user_id: 'a'.repeat(129) })).toThrow(
      'Invalid user_id'
    );
    expect(() => path('admin.read.flows.validate', { resource_id: 'a/b' })).toThrow(
      new TypeError('Invalid resource_id')
    );
  });

  it('accepts opaque or https metadata-URL client ids and rejects everything else', () => {
    const get = (client_id: JsonValue) => path('admin.read.clients.get', { client_id });
    expect(get('client-1')).toBe('/api/admin/agent-read/clients/client-1');
    expect(get('a')).toBe('/api/admin/agent-read/clients/a');
    expect(get('https://m.example/c?x=1')).toBe(
      '/api/admin/agent-read/clients/https%3A%2F%2Fm.example%2Fc%3Fx%3D1'
    );
    const longUrl = `https://m.example/${'a'.repeat(2048 - 'https://m.example/'.length)}`;
    expect(longUrl).toHaveLength(2048);
    expect(get(longUrl)).toContain('https%3A');
    for (const bad of [
      undefined,
      '',
      `${longUrl}a`,
      'not a url',
      'client id',
      'https://M.example/c',
      'https://m.example',
      'https://user:pw@m.example/c',
      'https://user@m.example/c',
      'https://m.example/c#frag',
      'http://m.example/c',
    ]) {
      expect(() => get(bad as JsonValue), String(bad)).toThrow(new TypeError('Invalid client_id'));
    }
  });

  it('builds the agent grant list query and validates offset', () => {
    const list = (input: JsonObject) => path('admin.read.agent-grants.list', input);
    expect(list({})).toBe('/api/admin/agent-grants?limit=20&offset=0');
    expect(list({ offset: 0 })).toBe('/api/admin/agent-grants?limit=20&offset=0');
    expect(list({ offset: 10_000 })).toBe('/api/admin/agent-grants?limit=20&offset=10000');
    expect(list({ principal_id: 'mp-1', status: '', delegator_id: '' })).toBe(
      '/api/admin/agent-grants?limit=20&offset=0&principal_id=mp-1'
    );
    for (const offset of [-1, 10_001, 1.5, '5', null]) {
      expect(() => list({ offset: offset }), String(offset)).toThrow(
        new TypeError('Invalid offset')
      );
    }
  });

  it('derives every tenant settings path from the verified tenant context', () => {
    const expected: Record<string, string> = {
      'admin.read.assurance.inspect': 'assurance',
      'admin.read.protocol-security.inspect': 'security',
      'admin.read.oauth.inspect': 'oauth',
      'admin.read.token-exchange.inspect': 'tokens',
      'admin.read.logout.inspect': 'session',
      'admin.read.login-ui.inspect': 'login-ui',
      'admin.read.conformance.inspect': 'feature-flags',
    };
    for (const [operation, category] of Object.entries(expected)) {
      expect(path(operation)).toBe(`/api/admin/tenants/tenant-1/settings/${category}`);
    }
  });

  it('pins the fixed inspection paths, methods and bodies', () => {
    expect(
      Object.fromEntries(
        Object.entries(CLOUDFLARE_ADMIN_READ_ROUTES)
          .filter(([, route]) => typeof route.path === 'string')
          .map(([operation, route]) => [operation, `${route.method} ${route.path as string}`])
      )
    ).toEqual({
      'admin.read.agent-settings.get': 'GET /api/admin/settings/agent',
      'admin.read.identity-providers.inspect': 'GET /api/admin/external-providers',
      'admin.read.authorization.organizations': 'GET /api/admin/organizations?page=1&limit=50',
      'admin.read.authorization.roles': 'GET /api/admin/roles?page=1&limit=50',
      'admin.read.authorization.policies': 'GET /api/admin/policies?page=1&limit=50',
      'admin.read.flows.inspect': 'GET /api/admin/flows?page=1&limit=50',
      'admin.read.consent.inspect': 'GET /api/admin/consent-statements?page=1&limit=50',
      'admin.read.sessions.inspect': 'GET /api/admin/agent-read/session-posture',
      'admin.read.webhooks.inspect': 'GET /api/admin/webhooks?page=1&limit=50',
      'admin.read.authorization.simulate': 'POST /api/admin/policies/simulate',
      'admin.read.tenant-policy.validate': 'GET /api/admin/tenant-policy/validate',
    });
    const validate = CLOUDFLARE_ADMIN_READ_ROUTES['admin.read.flows.validate'];
    expect(validate?.method).toBe('POST');
    expect(validate?.body?.({ resource_id: 'flow-1', extra: 'x' })).toEqual({});
  });
});

describe('admin read routes: inspection redaction', () => {
  it('drops private and PII keys in any naming style but keeps lookalikes', () => {
    expect(
      projectAgentInspectionResponse({
        Password: 'x',
        'client-secret': 'x',
        api_key_hash: 'x',
        PRIVATE_KEY: 'x',
        x_cookie: 'x',
        homeAddress: 'x',
        Phone: 'x',
        secretive: 'keep',
        emailer_enabled: 'keep',
        keyed: 'keep',
        passwords: 'keep',
        mycontact: 'keep',
      })
    ).toEqual({
      snapshot: {
        secretive: 'keep',
        emailer_enabled: 'keep',
        keyed: 'keep',
        passwords: 'keep',
        mycontact: 'keep',
      },
    });
  });

  it('strips userinfo, query and fragment from absolute http(s) and relative URLs only', () => {
    expect(
      projectAgentInspectionResponse({
        a: 'http://user:pw@host.example/p?q=1#f',
        b: 'https://host.example/p',
        c: '/relative/path?token=1',
        d: 'mailto:someone@example.com?subject=x',
        e: 'plain text',
        f: 'x'.repeat(5000),
      })
    ).toEqual({
      snapshot: {
        a: 'http://host.example/p',
        b: 'https://host.example/p',
        c: '/relative/path',
        d: 'mailto:someone@example.com?subject=x',
        e: 'plain text',
        f: 'x'.repeat(4096),
      },
    });
  });

  it('bounds arrays, object keys and nesting depth', () => {
    const projected = projectAgentInspectionResponse({
      list: Array.from({ length: 60 }, (_, i) => i),
      obj: Object.fromEntries(Array.from({ length: 110 }, (_, i) => [`k${i}`, i])),
      flag: true,
    }) as { snapshot: { list: number[]; obj: Record<string, number>; flag: boolean } };
    expect(projected.snapshot.list).toHaveLength(50);
    expect(projected.snapshot.list[49]).toBe(49);
    expect(Object.keys(projected.snapshot.obj)).toHaveLength(100);
    expect(projected.snapshot.obj.k99).toBe(99);
    expect(projected.snapshot.flag).toBe(true);

    // The 100-key limit applies after redaction.
    const withSecrets = projectAgentInspectionResponse({
      ...Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`secret_${i}`, i])),
      ...Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, i])),
    }) as { snapshot: Record<string, number> };
    expect(Object.keys(withSecrets.snapshot)).toHaveLength(100);
    expect(withSecrets.snapshot.k99).toBe(99);

    let nested: JsonValue = 'leaf';
    for (let i = 0; i < 9; i += 1) nested = { n: nested };
    // snapshot(depth0).n(1)...: depth 8 is kept, depth 9 becomes null.
    let cursorValue = (projectAgentInspectionResponse(nested) as { snapshot: JsonValue }).snapshot;
    for (let i = 0; i < 8; i += 1) cursorValue = (cursorValue as { n: JsonValue }).n;
    expect(cursorValue).toEqual({ n: null });

    let nestedArray: JsonValue = 'leaf';
    for (let i = 0; i < 8; i += 1) nestedArray = [nestedArray];
    expect(JSON.stringify(projectAgentInspectionResponse(nestedArray))).toBe(
      `{"snapshot":${'['.repeat(8)}"leaf"${']'.repeat(8)}}`
    );
    nestedArray = [nestedArray];
    expect(JSON.stringify(projectAgentInspectionResponse(nestedArray))).toBe(
      `{"snapshot":${'['.repeat(8)}[null]${']'.repeat(8)}}`
    );
  });
});
