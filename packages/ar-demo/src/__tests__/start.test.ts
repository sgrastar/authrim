import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newTenantId, newTicket, sha256Hex } from '../crypto';
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
  type TestDb,
  type Upstream,
} from './helpers';
import type { Env } from '../types';

let testDb: TestDb;
let upstream: Upstream;
let env: Env;

beforeEach(async () => {
  testDb = createTestDb();
  upstream = createUpstream();
  env = await makeEnv(testDb);
});

describe('POST /start: origin and content type', () => {
  it.each([
    ['a foreign origin', 'https://evil.example'],
    ['a missing origin', null],
    ['a look-alike origin', 'https://start.demo-test.example.evil.example'],
  ])('refuses %s with 403 and sends nothing upstream', async (_name, origin) => {
    const response = await start(env, upstream, { origin });
    expect(response.status).toBe(403);
    expect(upstream.calls).toHaveLength(0);
    expect(allRows(testDb)).toHaveLength(0);
  });

  it('refuses a body that is not form-encoded', async () => {
    const response = await start(env, upstream, {
      contentType: 'application/json',
      body: '{"cf-turnstile-response":"good-token"}',
    });
    expect(response.status).toBe(415);
    expect(upstream.calls).toHaveLength(0);
  });

  it('refuses a request without CF-Connecting-IP outside development', async () => {
    const response = await start(env, upstream, { ip: null });
    expect(response.status).toBe(400);
    expect(upstream.calls).toHaveLength(0);
  });

  it('accepts a request without CF-Connecting-IP in development', async () => {
    const dev = await makeEnv(testDb, {
      ENVIRONMENT: 'development',
      PORTAL_ORIGIN: 'http://localhost:8787',
    });
    const request = new Request('http://localhost:8787/start', {
      method: 'POST',
      headers: {
        Origin: 'http://localhost:8787',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'cf-turnstile-response=t',
    });
    upstream.on(K.siteverify, () => json({ success: true, hostname: 'localhost' }));
    const response = await handleRequest(request, dev, upstream.deps);
    expect(response.status).toBe(303);
  });
});

describe('POST /start: body size', () => {
  function streamed(chunks: number, chunkBytes: number) {
    const stats = { pulls: 0, cancelled: false };
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        stats.pulls += 1;
        if (stats.pulls > chunks) controller.close();
        else controller.enqueue(new Uint8Array(chunkBytes).fill(97));
      },
      cancel() {
        stats.cancelled = true;
      },
    });
    const request = new Request('https://start.demo-test.example/start', {
      method: 'POST',
      headers: {
        Origin: 'https://start.demo-test.example',
        'CF-Connecting-IP': '203.0.113.7',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
      duplex: 'half',
    } as RequestInit);
    return { request, stats };
  }

  it('answers 413 to a chunked body over the cap without reading it to the end', async () => {
    const { request, stats } = streamed(1000, 1024);
    const response = await handleRequest(request, env, upstream.deps);
    expect(response.status).toBe(413);
    expect(stats.cancelled).toBe(true);
    expect(stats.pulls).toBeLessThan(50);
    expect(upstream.calls).toHaveLength(0);
  });

  it('accepts a body of exactly the cap as far as the Turnstile step', async () => {
    const { request } = streamed(8, 1024);
    const response = await handleRequest(request, env, upstream.deps);
    expect(response.status).toBe(403);
    expect(upstream.count(K.siteverify)).toBe(0);
    const over = streamed(1, 8193);
    expect((await handleRequest(over.request, env, upstream.deps)).status).toBe(413);
  });

  it('treats a request without a body as an empty form', async () => {
    const response = await handleRequest(
      new Request('https://start.demo-test.example/start', {
        method: 'POST',
        headers: {
          Origin: 'https://start.demo-test.example',
          'CF-Connecting-IP': '203.0.113.7',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }),
      env,
      upstream.deps
    );
    expect(response.status).toBe(403);
  });
});

describe('POST /start: Turnstile fails closed', () => {
  const refused = async () => {
    const response = await start(env, upstream);
    expect(response.status).toBe(403);
    expect(allRows(testDb)).toHaveLength(0);
    expect(upstream.count(K.create)).toBe(0);
    expect(cookieOf(response)).toBeNull();
  };

  it('sends secret, token and the visitor address to siteverify', async () => {
    await start(env, upstream);
    const call = upstream.calls.find((c) => c.url.includes('siteverify'));
    const form = new URLSearchParams(call?.body);
    expect(form.get('secret')).toBe('turnstile-secret-1');
    expect(form.get('response')).toBe('good-token');
    expect(form.get('remoteip')).toBe('203.0.113.7');
  });

  it('refuses when Turnstile says success:false', async () => {
    upstream.on(K.siteverify, () =>
      json({ success: false, 'error-codes': ['invalid-input-response'] })
    );
    await refused();
  });

  it('refuses when siteverify answers with an error status', async () => {
    upstream.on(K.siteverify, () => json({ success: true }, 500));
    await refused();
  });

  it('refuses when the network fails', async () => {
    upstream.on(K.siteverify, () => {
      throw new Error('network down');
    });
    await refused();
  });

  it('refuses when the answer is not JSON', async () => {
    upstream.on(K.siteverify, () => new Response('<html>', { status: 200 }));
    await refused();
  });

  it('refuses when the hostname is not the portal host', async () => {
    upstream.on(K.siteverify, () => json({ success: true, hostname: 'other.example' }));
    await refused();
  });

  it('accepts an answer without a hostname', async () => {
    upstream.on(K.siteverify, () => json({ success: true }));
    expect((await start(env, upstream)).status).toBe(303);
  });

  it('refuses an empty token without calling siteverify', async () => {
    const response = await start(env, upstream, { body: 'other=1' });
    expect(response.status).toBe(403);
    expect(upstream.count(K.siteverify)).toBe(0);
  });

  it('refuses when siteverify does not answer within the timeout', async () => {
    vi.useFakeTimers();
    try {
      upstream.on(K.siteverify, () => new Promise<Response>(() => undefined));
      const original = upstream.deps.fetch;
      // The fake never settles, so it must honour the abort signal like a real fetch.
      upstream.deps.fetch = (input, init) =>
        input.includes('siteverify')
          ? new Promise<Response>((_resolve, reject) => {
              init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
            })
          : original(input, init);
      const pending = start(env, upstream);
      await vi.advanceTimersByTimeAsync(5001);
      const response = await pending;
      expect(response.status).toBe(403);
      expect(allRows(testDb)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('POST /start: limits', () => {
  it('allows exactly MAX_STARTS_PER_IP_PER_DAY starts per address, then refuses with 429', async () => {
    for (let i = 0; i < 3; i += 1) {
      expect((await start(env, upstream)).status).toBe(303);
    }
    const fourth = await start(env, upstream);
    expect(fourth.status).toBe(429);
    expect(allRows(testDb)).toHaveLength(3);
    // another address is unaffected
    expect((await start(env, upstream, { ip: '203.0.113.8' })).status).toBe(303);
  });

  it('counts only the last 24 hours', async () => {
    for (let i = 0; i < 3; i += 1) await start(env, upstream);
    upstream.clock.now += 24 * 3600 * 1000 + 2000;
    expect((await start(env, upstream)).status).toBe(303);
  });

  it('refuses at capacity with 503, and failed rows count toward it', async () => {
    env = await makeEnv(testDb, { MAX_ACTIVE_TENANTS: '2', MAX_STARTS_PER_IP_PER_DAY: '20' });
    upstream.on(K.create, () => json({ error: 'boom' }, 500));
    const failed = await start(env, upstream, { ip: '198.51.100.1' });
    expect(failed.status).toBe(502);
    expect(allRows(testDb)[0].state).toBe('failed');
    upstream.on(K.create, () => json({}, 202));
    expect((await start(env, upstream, { ip: '198.51.100.2' })).status).toBe(303);
    const full = await start(env, upstream, { ip: '198.51.100.3' });
    expect(full.status).toBe(503);
    expect(allRows(testDb)).toHaveLength(2);
  });

  it('does not count deleted rows', async () => {
    env = await makeEnv(testDb, { MAX_ACTIVE_TENANTS: '1', MAX_STARTS_PER_IP_PER_DAY: '20' });
    expect((await start(env, upstream, { ip: '198.51.100.1' })).status).toBe(303);
    expect((await start(env, upstream, { ip: '198.51.100.2' })).status).toBe(503);
    testDb.sqlite.exec("UPDATE demo_tenants SET state = 'deleted'");
    expect((await start(env, upstream, { ip: '198.51.100.2' })).status).toBe(303);
  });

  it('of two interleaved starts at capacity-1 only one succeeds', async () => {
    env = await makeEnv(testDb, { MAX_ACTIVE_TENANTS: '3', MAX_STARTS_PER_IP_PER_DAY: '20' });
    for (const ip of ['198.51.100.1', '198.51.100.2']) await start(env, upstream, { ip });
    // Let every statement yield to the other request, so a read-then-write would interleave.
    testDb.beforeStatement.current = async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
    };
    const [a, b] = await Promise.all([
      start(env, upstream, { ip: '198.51.100.3' }),
      start(env, upstream, { ip: '198.51.100.4' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([303, 503]);
    expect(allRows(testDb)).toHaveLength(3);
  });

  it('of two interleaved starts from one address at the per-IP limit only one succeeds', async () => {
    env = await makeEnv(testDb, { MAX_STARTS_PER_IP_PER_DAY: '2' });
    await start(env, upstream);
    testDb.beforeStatement.current = async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
    };
    const [a, b] = await Promise.all([start(env, upstream), start(env, upstream)]);
    expect([a.status, b.status].sort()).toEqual([303, 429]);
  });
});

describe('POST /start: what is generated and stored', () => {
  it('generates the tenant id and ticket in the specified shape', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newTenantId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^demo-[a-z2-7]{10}$/);
    expect(newTicket()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('stores only hashes, sets the cookie and redirects to /wait', async () => {
    const response = await start(env, upstream, { ip: '203.0.113.99' });
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('/wait');
    const setCookie = response.headers.get('Set-Cookie') ?? '';
    expect(setCookie).toMatch(
      /^__Host-demo_ticket=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=1800$/
    );
    expect(setCookie).not.toMatch(/Domain=/i);
    const ticket = cookieOf(response) as string;

    const rows = allRows(testDb);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.id).toMatch(/^demo-[a-z2-7]{10}$/);
    expect(row.state).toBe('provisioning');
    expect(row.ticket_hash).toBe(await sha256Hex(ticket));
    expect(row.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(Number(row.expires_at) - Number(row.created_at)).toBe(12 * 3600);

    const dump = JSON.stringify(rows) + testDb.statements.join('\n');
    expect(dump).not.toContain(ticket);
    expect(dump).not.toContain('203.0.113.99');
  });

  it('creates the tenant with the specified request', async () => {
    const response = await start(env, upstream);
    expect(response.status).toBe(303);
    const call = upstream.calls.find((c) => c.url.endsWith('/api/admin/tenants'));
    const id = allRows(testDb)[0].id;
    expect(call?.headers['idempotency-key']).toBe(id);
    expect(call?.headers.authorization).toMatch(/^Bearer token-1$/);
    expect(JSON.parse(call?.body ?? '{}')).toMatchObject({
      id,
      isolation_policy: 'shared_pool',
    });
  });

  it('keeps a failed row, shows a generic error and echoes no upstream body', async () => {
    upstream.on(K.create, () => json({ error: 'internal_secret_detail', trace: 'stack...' }, 500));
    const response = await start(env, upstream);
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).not.toContain('internal_secret_detail');
    expect(cookieOf(response)).toBeNull();
    expect(allRows(testDb)[0].state).toBe('failed');
  });

  it('shows a 3xx from the Admin API as a failure', async () => {
    upstream.on(
      K.create,
      () => new Response(null, { status: 302, headers: { Location: 'https://evil.example/' } })
    );
    const response = await start(env, upstream);
    expect(response.status).toBe(502);
    expect(allRows(testDb)[0].state).toBe('failed');
  });

  it('uses the language of Accept-Language', async () => {
    const ja = await start(env, upstream, {
      origin: 'https://evil.example',
      language: 'ja,en;q=0.5',
    });
    expect(await ja.text()).toContain('lang="ja"');
    const en = await start(env, upstream, { origin: 'https://evil.example', language: 'en-US' });
    expect(await en.text()).toContain('lang="en"');
  });
});
