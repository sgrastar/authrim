import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleRequest } from '../index';
import { CREATE_LEASE_SECONDS, MAX_CREATE_ATTEMPTS } from '../registry';
import {
  allRows,
  createTestDb,
  createUpstream,
  json,
  K,
  makeEnv,
  start,
  cookieOf,
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

const poll = () => handleRequest(statusRequest(ticket), env, upstream.deps);
const rowNow = () => allRows(testDb)[0];
const tick = (seconds: number) => {
  upstream.clock.now += seconds * 1000;
};
const nowSeconds = () => Math.floor(upstream.clock.now / 1000);
const creates = () =>
  upstream.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/tenants'));

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
  ticket = cookieOf(await start(env, upstream)) as string;
  tenantId = rowNow().id as string;
  upstream.calls.length = 0;
});
afterEach(() => vi.restoreAllMocks());

/** A create call the test releases by hand; `arrived` counts the calls that reached the core. */
function gatedCreate() {
  const gate = { arrived: 0, release: (_response: Response | Error) => undefined as void };
  const pending: Array<(r: Response | Error) => void> = [];
  upstream.on(K.create, () => {
    gate.arrived += 1;
    return new Promise<Response>((resolve, reject) => {
      pending.push((r) => (r instanceof Error ? reject(r) : resolve(r)));
    });
  });
  gate.release = (response) => pending.splice(0).forEach((fn) => fn(response));
  return gate;
}

describe('the first /status creates the tenant', () => {
  it('claims the row, creates once, records the acceptance and goes on to the provisioning check', async () => {
    upstream.on(K.provisioning, () => json({ status: 'running' }));
    const response = await poll();
    expect(await response.json()).toEqual({ state: 'provisioning', stage: 'provisioning' });
    expect(creates()).toHaveLength(1);
    expect(JSON.parse(creates()[0].body)).toMatchObject({ id: tenantId });
    expect(creates()[0].headers['idempotency-key']).toBe(tenantId);
    expect(rowNow()).toMatchObject({
      state: 'provisioning',
      create_attempts: 1,
      create_started_at: nowSeconds(),
      create_accepted_at: nowSeconds(),
    });
    expect(upstream.count(K.provisioning)).toBe(1);
    expect(logs.some((l) => l.includes('tenant_requested'))).toBe(true);
  });

  it('a concurrent /status does not create and answers at once, while the claimant is inside the call', async () => {
    const gate = gatedCreate();
    const first = poll();
    await vi.waitFor(() => expect(gate.arrived).toBe(1));
    // the second request is not blocked by the first one's long call
    const second = await poll();
    expect(await second.json()).toEqual({ state: 'provisioning', stage: 'provisioning' });
    const third = await poll();
    expect(await third.json()).toEqual({ state: 'provisioning', stage: 'provisioning' });
    expect(gate.arrived).toBe(1);
    expect(upstream.count(K.provisioning)).toBe(0); // not accepted yet: nobody asks the core about it

    gate.release(json({ id: tenantId }, 202));
    upstream.on(K.provisioning, () => json({ status: 'queued' }));
    expect(await (await first).json()).toEqual({ state: 'provisioning', stage: 'provisioning' });
    expect(rowNow().create_accepted_at).not.toBeNull();
    expect(creates()).toHaveLength(1);
  });

  it('two requests racing for the claim make one create call (the statement decides, not memory)', async () => {
    const gate = gatedCreate();
    testDb.beforeStatement.current = async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
    };
    const both = Promise.all([poll(), poll()]);
    await vi.waitFor(() => expect(gate.arrived).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(gate.arrived).toBe(1);
    expect(rowNow().create_attempts).toBe(1);
    gate.release(json({}, 202));
    await both;
    expect(creates()).toHaveLength(1);
  });

  it('a refused creation (non-202) fails the row and logs the op and short code', async () => {
    upstream.on(K.create, () => json({ error: 'tenant_id_exists', detail: 'secret' }, 409));
    expect(await (await poll()).json()).toEqual({ state: 'failed' });
    expect(rowNow().state).toBe('failed');
    const line = logs.find((l) => l.includes('upstream_failure')) ?? '';
    expect(JSON.parse(line)).toMatchObject({
      op: 'create_tenant',
      status: 409,
      error: 'tenant_id_exists',
      tenantId,
    });
    expect(line).not.toContain('secret');
    tick(3);
    expect(await (await poll()).json()).toEqual({ state: 'failed' });
    expect(creates()).toHaveLength(1);
  });

  it('a lost acceptance write after a 202 fails the row', async () => {
    let failed = false;
    testDb.beforeStatement.current = (sql) => {
      if (!failed && sql.includes('create_accepted_at = ?1 WHERE')) {
        failed = true;
        throw new Error('db down');
      }
      return Promise.resolve();
    };
    expect(await (await poll()).json()).toEqual({ state: 'failed' });
    expect(rowNow().create_accepted_at).toBeNull();
  });
});

describe('a claim that never completes', () => {
  it('is not taken over inside the lease, and then only with the same tenant id and key', async () => {
    const gate = gatedCreate();
    void poll(); // the claimant: stays inside the call (it "dies": nobody answers it)
    await vi.waitFor(() => expect(gate.arrived).toBe(1));

    tick(CREATE_LEASE_SECONDS - 1);
    expect(await (await poll()).json()).toEqual({ state: 'provisioning', stage: 'provisioning' });
    expect(gate.arrived).toBe(1);

    tick(1);
    upstream.on(K.create, () => json({}, 202));
    upstream.on(K.provisioning, () => json({ status: 'running' }));
    expect(await (await poll()).json()).toEqual({ state: 'provisioning', stage: 'provisioning' });
    const calls = creates();
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[1].body) as { id: string }).toMatchObject({ id: tenantId });
    expect(calls[1].headers['idempotency-key']).toBe(tenantId);
    expect(rowNow()).toMatchObject({ create_attempts: 2, state: 'provisioning' });
    expect(rowNow().create_accepted_at).not.toBeNull();
    expect(logs.some((l) => l.includes('create_reclaimed'))).toBe(true);
    gate.release(json({}, 202)); // the dead claimant finally answers: nothing breaks
  });

  it('a timed-out or broken call leaves the row for its lease instead of failing it', async () => {
    upstream.on(K.create, () => {
      throw new Error('network down');
    });
    expect(await (await poll()).json()).toEqual({ state: 'provisioning', stage: 'provisioning' });
    expect(rowNow()).toMatchObject({ state: 'provisioning', create_accepted_at: null });
    tick(5);
    await poll();
    expect(creates()).toHaveLength(1);
    tick(CREATE_LEASE_SECONDS);
    upstream.on(K.create, () => json({}, 202));
    upstream.on(K.provisioning, () => json({ status: 'running' }));
    await poll();
    expect(creates()).toHaveLength(2);
    expect(rowNow().create_accepted_at).not.toBeNull();
  });

  it('is bounded: after the attempts are used and the last lease ran out, the row fails', async () => {
    upstream.on(K.create, () => {
      throw new Error('network down');
    });
    for (let attempt = 1; attempt <= MAX_CREATE_ATTEMPTS; attempt += 1) {
      await poll();
      expect(rowNow().create_attempts).toBe(attempt);
      if (attempt < MAX_CREATE_ATTEMPTS) tick(CREATE_LEASE_SECONDS);
    }
    // inside the last lease: still waiting
    tick(CREATE_LEASE_SECONDS - 1);
    expect(await (await poll()).json()).toEqual({ state: 'provisioning', stage: 'provisioning' });
    expect(rowNow().state).toBe('provisioning');
    tick(1);
    expect(await (await poll()).json()).toEqual({ state: 'failed' });
    expect(rowNow().state).toBe('failed');
    expect(creates()).toHaveLength(MAX_CREATE_ATTEMPTS);
    expect(logs.some((l) => l.includes('create_exhausted'))).toBe(true);
    tick(3);
    expect(await (await poll()).json()).toEqual({ state: 'failed' });
    expect(creates()).toHaveLength(MAX_CREATE_ATTEMPTS);
  });

  it('never re-claims a row that was accepted', async () => {
    upstream.on(K.provisioning, () => json({ status: 'running' }));
    await poll();
    tick(CREATE_LEASE_SECONDS * 3);
    await poll();
    expect(creates()).toHaveLength(1);
  });
});

describe('stages across the whole life', () => {
  it('provisioning, then inviting (seen by a concurrent poll), then ready with join_expires_in', async () => {
    upstream.on(K.provisioning, () => json({ status: 'running' }));
    expect(await (await poll()).json()).toEqual({ state: 'provisioning', stage: 'provisioning' });

    // The tenant exists: the claimant is inside the invitation call while another poll arrives.
    tick(3);
    upstream.on(K.provisioning, () => json({ status: 'succeeded' }));
    let release: (r: Response) => void = () => undefined;
    upstream.on(
      K.invite,
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        })
    );
    const claimant = poll();
    await vi.waitFor(() => expect(upstream.count(K.invite)).toBe(1));
    expect(await (await poll()).json()).toEqual({ state: 'provisioning', stage: 'inviting' });
    release(
      json(
        {
          email: `${tenantId}@demo.invalid`,
          code: 'SECRET-CODE-123',
          join_url: 'https://console.demo-test.example/admin/join',
          expires_at: upstream.clock.now + 600_000,
        },
        201
      )
    );
    const ready = await (await claimant).json<Record<string, unknown>>();
    expect(ready).toMatchObject({ state: 'ready', stage: 'ready', join_expires_in: 600 });
    expect(String(ready.join)).toContain('/admin/join#code=SECRET-CODE-123');
    expect(rowNow().state).toBe('handed_off');
  });

  it("derives join_expires_in from the core's expires_at, else from the 15 minutes it asked for", async () => {
    // helper fake answers expires_at: 1 (in the past): the asked-for 15 minutes
    expect(await (await poll()).json()).toMatchObject({ state: 'ready', join_expires_in: 900 });
  });

  it('ignores an expires_at beyond the core maximum (clock skew) and uses the asked-for value', async () => {
    upstream.on(K.invite, (call) =>
      json(
        {
          email: (JSON.parse(call.body) as { email: string }).email,
          code: 'c',
          join_url: 'https://console.demo-test.example/admin/join',
          expires_at: upstream.clock.now + 3 * 3600 * 1000,
        },
        201
      )
    );
    expect(await (await poll()).json()).toMatchObject({ join_expires_in: 900 });
  });

  it('keeps the old keys: state ready carries join, handed_off and failed carry state only', async () => {
    const ready = await (await poll()).json<Record<string, unknown>>();
    expect(Object.keys(ready).sort()).toEqual(['join', 'join_expires_in', 'stage', 'state']);
    tick(3);
    expect(await (await poll()).json()).toEqual({ state: 'handed_off' });
  });
});

describe('no secret leaks', () => {
  it('keeps codes, tokens, the ticket and the address out of every log line and the database', async () => {
    await poll();
    tick(3);
    await poll();
    const everything = [
      logs.join('\n'),
      JSON.stringify(allRows(testDb)),
      testDb.statements.join('\n'),
    ].join('\n');
    for (const secret of [
      'SECRET-CODE-123',
      'token-1',
      ticket,
      '203.0.113.7',
      'client_assertion',
    ]) {
      expect(everything).not.toContain(secret);
    }
  });
});
