import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAdminTokenCache } from '../admin-api';
import { handleRequest } from '../index';
import {
  allRows,
  cookieOf,
  createTestDb,
  createUpstream,
  json,
  K,
  makeEnv,
  start,
  statusRequest,
  type TestDb,
  type Upstream,
} from './helpers';
import type { Env } from '../types';

let testDb: TestDb;
let upstream: Upstream;
let env: Env;
let ticket: string;
let tenantId: string;
const logs: string[] = [];

async function poll(t: string | null = ticket): Promise<Response> {
  return handleRequest(statusRequest(t), env, upstream.deps);
}
const state = () => allRows(testDb)[0].state;
const tick = (seconds = 3) => {
  upstream.clock.now += seconds * 1000;
};

beforeEach(async () => {
  logs.length = 0;
  for (const method of ['log', 'error', 'warn', 'info'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
  }
  testDb = createTestDb();
  upstream = createUpstream();
  env = await makeEnv(testDb);
  const response = await start(env, upstream);
  ticket = cookieOf(response) as string;
  tenantId = allRows(testDb)[0].id as string;
});
afterEach(() => vi.restoreAllMocks());

describe('HEAD /status', () => {
  it('is refused and changes nothing, so the later GET still gets the link', async () => {
    const head = await handleRequest(
      new Request('https://start.demo-test.example/status', {
        method: 'HEAD',
        headers: { Cookie: `__Host-demo_ticket=${ticket}` },
      }),
      env,
      upstream.deps
    );
    expect(head.status).toBe(405);
    expect(head.headers.get('Allow')).toBe('GET');
    expect(upstream.count(K.invite)).toBe(0);
    expect(state()).toBe('provisioning');
    const body = await (await poll()).json<{ state: string; join: string }>();
    expect(body.state).toBe('ready');
    expect(body.join).toContain('/admin/join#code=');
  });
});

describe('ticket lifetime', () => {
  const created = () => Number(allRows(testDb)[0].created_at);
  const setNow = (seconds: number) => {
    upstream.clock.now = seconds * 1000;
  };

  it('still polls one second before the limit', async () => {
    setNow(created() + 1799);
    upstream.on(K.provisioning, () => json({ status: 'running' }));
    expect(await (await poll()).json()).toEqual({ state: 'provisioning' });
    expect(upstream.count(K.provisioning)).toBe(1);
  });

  it('fails the row at the limit without calling the Admin API', async () => {
    setNow(created() + 1800);
    const response = await poll();
    expect(await response.json()).toEqual({ state: 'failed' });
    expect(response.headers.get('Set-Cookie')).toMatch(/Max-Age=0/);
    expect(state()).toBe('failed');
    expect(upstream.count(K.provisioning)).toBe(0);
    expect(upstream.count(K.invite)).toBe(0);
  });

  it('fails a row past expires_at', async () => {
    testDb.sqlite.exec('UPDATE demo_tenants SET expires_at = created_at + 100');
    setNow(created() + 100);
    expect(await (await poll()).json()).toEqual({ state: 'failed' });
    expect(state()).toBe('failed');
    expect(upstream.count(K.provisioning)).toBe(0);
  });

  it('answers failed for an inviting row past the limit without changing it', async () => {
    testDb.sqlite.exec("UPDATE demo_tenants SET state = 'inviting'");
    setNow(created() + 1800);
    expect(await (await poll()).json()).toEqual({ state: 'failed' });
    expect(state()).toBe('inviting');
  });

  it('keeps answering handed_off past the limit', async () => {
    testDb.sqlite.exec("UPDATE demo_tenants SET state = 'handed_off'");
    setNow(created() + 5000);
    expect(await (await poll()).json()).toEqual({ state: 'handed_off' });
  });
});

describe('GET /status', () => {
  it('answers 404 JSON without a cookie, with a malformed one or an unknown ticket', async () => {
    for (const t of [null, 'short', 'A'.repeat(43)]) {
      const response = await poll(t);
      expect(response.status).toBe(404);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.json()).toEqual({ error: 'not_found' });
    }
  });

  it('keeps provisioning while the tenant is queued, running or waiting_retry', async () => {
    for (const status of ['queued', 'running', 'waiting_retry']) {
      tick();
      upstream.on(K.provisioning, () => json({ status }));
      const response = await poll();
      expect(await response.json()).toEqual({ state: 'provisioning' });
      expect(state()).toBe('provisioning');
    }
    expect(upstream.count(K.invite)).toBe(0);
  });

  it('marks the row failed when provisioning is blocked or canceled', async () => {
    for (const status of ['blocked', 'canceled']) {
      testDb.sqlite.exec("UPDATE demo_tenants SET state = 'provisioning', last_polled_at = NULL");
      upstream.on(K.provisioning, () => json({ status }));
      expect(await (await poll()).json()).toEqual({ state: 'failed' });
      expect(state()).toBe('failed');
    }
  });

  it('treats an unreachable or odd provisioning answer as temporary', async () => {
    upstream.on(K.provisioning, () => json({ error: 'x' }, 503));
    expect(await (await poll()).json()).toEqual({ state: 'provisioning' });
    tick();
    upstream.on(K.provisioning, () => json({ nope: true }));
    expect(await (await poll()).json()).toEqual({ state: 'provisioning' });
    expect(state()).toBe('provisioning');
  });

  it('treats a 3xx from the provisioning call as temporary and never follows it', async () => {
    upstream.on(
      K.provisioning,
      () => new Response(null, { status: 307, headers: { Location: 'https://evil.example' } })
    );
    expect(await (await poll()).json()).toEqual({ state: 'provisioning' });
    expect(
      upstream.calls
        .filter((c) => c.url.startsWith('https://api.'))
        .every((c) => c.redirect === 'manual')
    ).toBe(true);
  });

  it('throttles upstream polls to one per 2 seconds per row', async () => {
    upstream.on(K.provisioning, () => json({ status: 'running' }));
    await poll();
    await poll();
    await poll();
    expect(upstream.count(K.provisioning)).toBe(1);
    upstream.clock.now += 1000;
    await poll();
    expect(upstream.count(K.provisioning)).toBe(1);
    upstream.clock.now += 1500;
    await poll();
    expect(upstream.count(K.provisioning)).toBe(2);
  });

  it('hands the code over once and clears the cookie', async () => {
    const response = await poll();
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const cookie = response.headers.get('Set-Cookie') ?? '';
    expect(cookie).toMatch(/Max-Age=0/);
    expect(cookie).toMatch(/Secure; HttpOnly; SameSite=Strict/);
    const body = await response.json<{ state: string; join: string }>();
    expect(body.state).toBe('ready');
    expect(body.join).toBe(
      `https://console.demo-test.example/admin/join#code=SECRET-CODE-123&email=${encodeURIComponent(`${tenantId}@demo.invalid`)}`
    );
    expect(state()).toBe('handed_off');

    const invite = upstream.calls.find((c) => c.url.endsWith('/admin-invitations'));
    expect(invite?.headers['x-tenant-id']).toBe(tenantId);
    expect(JSON.parse(invite?.body ?? '{}')).toEqual({
      email: `${tenantId}@demo.invalid`,
      role_id: 'role_ar_tenant_admin',
      scope_type: 'tenant',
      scope_id: tenantId,
      code_delivery: 'response',
      expires_in_minutes: 15,
    });

    // a later call never returns the code again
    tick();
    const again = await poll();
    expect(await again.json()).toEqual({ state: 'handed_off' });
    expect(upstream.count(K.invite)).toBe(1);
  });

  it('url-encodes the code in the fragment', async () => {
    upstream.on(K.invite, (call) =>
      json(
        {
          email: (JSON.parse(call.body) as { email: string }).email,
          code: 'a b&c=d#e',
          join_url: 'https://console.demo-test.example/admin/join',
        },
        201
      )
    );
    const body = await (await poll()).json<{ join: string }>();
    expect(body.join).toContain('#code=a%20b%26c%3Dd%23e&email=');
  });

  it('under two concurrent calls calls the invitation API once and returns the code once', async () => {
    // Both callers get past the poll throttle and see "succeeded" before either claims.
    let arrived = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    upstream.on(K.provisioning, async () => {
      arrived += 1;
      if (arrived === 2) release();
      await gate;
      return json({ status: 'succeeded' });
    });
    testDb.beforeStatement.current = async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
    };
    const first = poll();
    await vi.waitFor(() => expect(arrived).toBe(1));
    testDb.sqlite.exec('UPDATE demo_tenants SET last_polled_at = NULL');
    const second = poll();
    const bodies = (await Promise.all([first, second]).then((rs) =>
      Promise.all(rs.map((r) => r.json()))
    )) as Array<{ state: string; join?: string }>;
    expect(arrived).toBe(2);
    expect(bodies.filter((b) => b.state === 'ready')).toHaveLength(1);
    expect(bodies.filter((b) => b.state === 'provisioning')).toHaveLength(1);
    expect(upstream.count(K.invite)).toBe(1);
    expect(state()).toBe('handed_off');
  });

  it('answers provisioning to a caller that finds the row already claimed', async () => {
    testDb.sqlite.exec("UPDATE demo_tenants SET state = 'inviting'");
    expect(await (await poll()).json()).toEqual({ state: 'provisioning' });
    expect(upstream.count(K.invite)).toBe(0);
    expect(upstream.count(K.provisioning)).toBe(0);
  });

  it('marks the row failed when the invitation call fails, and reveals nothing', async () => {
    upstream.on(K.invite, () => json({ error: 'code_handoff_disabled', detail: 'secret' }, 403));
    const response = await poll();
    expect(await response.json()).toEqual({ state: 'failed' });
    expect(state()).toBe('failed');
    expect(logs.join('\n')).toContain('code_handoff_disabled');
    tick();
    expect(await (await poll()).json()).toEqual({ state: 'failed' });
  });

  it.each([
    ['null', null],
    ['another origin', 'https://evil.example/admin/join'],
    ['another path', 'https://console.demo-test.example/other'],
    ['a prefix-look-alike origin', 'https://console.demo-test.example.evil.example/admin/join'],
    ['a query string', 'https://console.demo-test.example/admin/join?next=https://evil.example'],
    ['a fragment', 'https://console.demo-test.example/admin/join#x'],
    ['credentials', 'https://user:pw@console.demo-test.example/admin/join'],
    ['not a URL', 'not a url'],
  ])('marks the row failed when join_url is %s', async (_name, joinUrl) => {
    upstream.on(K.invite, () =>
      json({ email: 'x@demo.invalid', code: 'SECRET-CODE-123', join_url: joinUrl }, 201)
    );
    const response = await poll();
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ state: 'failed' });
    expect(text).not.toContain('SECRET-CODE-123');
    expect(state()).toBe('failed');
  });

  it('marks the row failed when the invitation has no code', async () => {
    upstream.on(K.invite, () =>
      json({ join_url: 'https://console.demo-test.example/admin/join' }, 201)
    );
    expect(await (await poll()).json()).toEqual({ state: 'failed' });
  });

  it('never puts the code, a token, the ticket or the raw IP in the logs or the database', async () => {
    await poll();
    tick();
    await poll();
    const everything = [
      logs.join('\n'),
      JSON.stringify(allRows(testDb)),
      testDb.statements.join('\n'),
    ].join('\n');
    expect(everything).not.toContain('SECRET-CODE-123');
    expect(everything).not.toContain('token-1');
    expect(everything).not.toContain(ticket);
    expect(everything).not.toContain('203.0.113.7');
    expect(everything).not.toContain('client_assertion');
    expect(logs.some((line) => line.includes(tenantId))).toBe(true);
  });

  it('reports failed rows and a missing-scope token as failed', async () => {
    resetAdminTokenCache();
    upstream.on(K.token, () =>
      json({
        access_token: 't',
        token_type: 'Bearer',
        expires_in: 900,
        scope: 'admin:tenants:provision',
      })
    );
    expect(await (await poll()).json()).toEqual({ state: 'failed' });
    expect(state()).toBe('failed');
    expect(upstream.count(K.invite)).toBe(0);
  });
});
