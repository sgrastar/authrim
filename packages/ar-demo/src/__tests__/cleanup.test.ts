import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAdminTokenCache, TENANT_DESCRIPTION, tenantDisplayName } from '../admin-api';
import { handleScheduled, runCleanup } from '../cleanup';
import worker, { handleRequest } from '../index';
import {
  allRows,
  configOf,
  cookieOf,
  createTestDb,
  createUpstream,
  json,
  K,
  makeEnv,
  start,
  startAndCreate,
  statusRequest,
  type TestDb,
  type Upstream,
} from './helpers';
import type { Env } from '../types';

type Lifecycle = 'provisioning' | 'active' | 'suspended' | 'deleting' | 'deleted';

/** A small model of the Admin API's tenant state, behind the fake upstream. */
function installTenantModel(upstream: Upstream) {
  const tenants = new Map<string, Lifecycle>();
  const activeJob = new Set<string>();
  const failures: { delete?: number; get?: number; cleanup?: number; retry?: number } = {};
  // Provisioning operations that the core refuses to clean up (activation has begun).
  const stuck = new Map<string, { status: string; current_step: string }>();
  const idOf = (url: string) => new URL(url).pathname.split('/')[4];
  upstream.on(K.getTenant, (call) => {
    if (failures.get) return json({ error: 'boom' }, failures.get);
    const state = tenants.get(idOf(call.url));
    return state
      ? json({ lifecycle_state: state })
      : json({ error: 'invalid_request', error_code: 'AR060004' }, 404);
  });
  upstream.on(K.deleteTenant, (call) => {
    if (failures.delete) return json({ error: 'refused' }, failures.delete);
    const id = idOf(call.url);
    const state = tenants.get(id);
    if (!state) return json({ error: 'invalid_request', error_code: 'AR060004' }, 404);
    if (activeJob.has(id)) return json({ error: 'tenant_state_changed' }, 409);
    if (state === 'active' || state === 'suspended') {
      tenants.set(id, 'deleting');
      return json({ job_id: 'j', status: 'pending' }, 202);
    }
    return json({ error: 'invalid' }, 400);
  });
  upstream.on(K.cleanup, (call) => {
    if (failures.cleanup) return json({ error: 'conflict' }, failures.cleanup);
    const id = idOf(call.url);
    const operation = stuck.get(id);
    if (operation) {
      return json({ error: 'tenant_provisioning_cleanup_conflict', provisioning: operation }, 409);
    }
    if (tenants.get(id) !== 'provisioning') return json({ error: 'conflict' }, 409);
    tenants.set(id, 'deleted');
    return json({ status: 'cleaned' });
  });
  upstream.on(K.retry, (call) => {
    if (failures.retry) return json({ error: 'refused' }, failures.retry);
    const id = idOf(call.url);
    const operation = stuck.get(id);
    if (operation?.status !== 'blocked') {
      return json({ error: 'tenant_provisioning_not_blocked' }, 409);
    }
    stuck.delete(id);
    tenants.set(id, 'active'); // the retried activation completes
    return json({ status: 'queued' }, 202);
  });
  return { tenants, activeJob, failures, stuck };
}

let testDb: TestDb;
let upstream: Upstream;
let env: Env;
let model: ReturnType<typeof installTenantModel>;
const logs: string[] = [];
const nowSeconds = () => Math.floor(upstream.clock.now / 1000);
let counter = 0;

function seed(
  fields: Partial<{
    id: string;
    state: string;
    created_at: number;
    expires_at: number;
    updated_at: number;
    delete_attempted_at: number | null;
    delete_attempts: number;
    ip_hash: string;
    create_accepted_at: number | null;
  }> = {}
): string {
  counter += 1;
  const now = nowSeconds();
  const id = fields.id ?? `demo-seed${String(counter).padStart(5, '0')}`;
  testDb.sqlite
    .prepare(
      `INSERT INTO demo_tenants (id, ticket_hash, ip_hash, state, created_at, expires_at, updated_at, delete_attempted_at, delete_attempts, create_accepted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      `hash-${id}`,
      fields.ip_hash ?? 'ip-x',
      fields.state ?? 'handed_off',
      fields.created_at ?? now - 100,
      fields.expires_at ?? now + 40_000,
      fields.updated_at ?? now - 100,
      fields.delete_attempted_at ?? null,
      fields.delete_attempts ?? 0,
      fields.create_accepted_at === undefined ? now - 100 : fields.create_accepted_at
    );
  return id;
}

const row = (id: string) => allRows(testDb).find((r) => r.id === id);
const stateOf = (id: string) => row(id)?.state;
const run = () => runCleanup(env, upstream.deps, configOf(env));
const callsFor = (id: string) => upstream.calls.filter((c) => c.url.includes(id));
const deletesFor = (id: string) => callsFor(id).filter((c) => c.method === 'DELETE');

beforeEach(async () => {
  logs.length = 0;
  for (const method of ['log', 'error', 'warn', 'info'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
  }
  testDb = createTestDb();
  upstream = createUpstream();
  model = installTenantModel(upstream);
  env = await makeEnv(testDb);
});
afterEach(() => vi.restoreAllMocks());

describe('candidate selection', () => {
  const taken = async (fields: Parameters<typeof seed>[0]) => {
    const id = seed(fields);
    model.tenants.set(id, 'active');
    await run();
    return stateOf(id) !== (fields?.state ?? 'handed_off');
  };

  it('takes a row at expires_at, not one second before', async () => {
    const now = nowSeconds();
    expect(await taken({ expires_at: now + 1 })).toBe(false);
    expect(await taken({ expires_at: now })).toBe(true);
  });

  it('takes a failed row 300 seconds after it failed, not one second before', async () => {
    const now = nowSeconds();
    expect(await taken({ state: 'failed', updated_at: now - 299 })).toBe(false);
    expect(await taken({ state: 'failed', updated_at: now - 300 })).toBe(true);
  });

  it.each(['provisioning', 'inviting'])(
    'takes an abandoned %s row only after 1800 + 120 seconds (the hand-off window)',
    async (state) => {
      const now = nowSeconds();
      expect(await taken({ state, created_at: now - 1919 })).toBe(false);
      expect(await taken({ state, created_at: now - 1920 })).toBe(true);
    }
  );

  it('leaves a handed-off row that has not expired', async () => {
    const now = nowSeconds();
    expect(
      await taken({ state: 'handed_off', created_at: now - 100_000, expires_at: now + 5 })
    ).toBe(false);
  });

  it('does not take rows already deleting or deleted as candidates', async () => {
    const id = seed({ state: 'deleted', expires_at: 1, updated_at: nowSeconds() - 10 });
    await run();
    expect(callsFor(id)).toHaveLength(0);
  });
});

describe('outcomes of the first deletion', () => {
  it('202: the row stays deleting with the attempt recorded and updated_at untouched', async () => {
    const id = seed({ expires_at: 1 });
    model.tenants.set(id, 'active');
    const summary = await run();
    expect(summary).toMatchObject({ claimed: 1, deleted: 0, deleting: 1, errors: 0 });
    expect(stateOf(id)).toBe('deleting');
    expect(row(id)?.delete_attempts).toBe(1);
    expect(row(id)?.delete_attempted_at).toBe(nowSeconds());
    expect(row(id)?.updated_at).toBe(nowSeconds());
    expect(model.tenants.get(id)).toBe('deleting');
    const del = deletesFor(id)[0];
    expect(del.headers.authorization).toMatch(/^Bearer token-/);
    expect(del.redirect).toBe('manual');
  });

  it('404 (never created): the row becomes deleted', async () => {
    const id = seed({ state: 'failed', updated_at: 1 });
    expect(await run()).toMatchObject({ claimed: 1, deleted: 1 });
    expect(stateOf(id)).toBe('deleted');
  });

  it('a tombstone with lifecycle deleted counts as gone', async () => {
    const id = seed({ expires_at: 1 });
    model.tenants.set(id, 'deleted');
    await run();
    expect(stateOf(id)).toBe('deleted');
  });

  it('a tenant still provisioning is removed with the provisioning cleanup', async () => {
    const id = seed({ state: 'provisioning', created_at: 1 });
    model.tenants.set(id, 'provisioning');
    await run();
    expect(stateOf(id)).toBe('deleted');
    expect(upstream.count(K.cleanup)).toBe(1);
    expect(deletesFor(id)).toHaveLength(0);
  });

  it('a provisioning cleanup that conflicts leaves the row deleting for a later run', async () => {
    const id = seed({ state: 'provisioning', created_at: 1 });
    model.tenants.set(id, 'provisioning');
    model.failures.cleanup = 409;
    expect(await run()).toMatchObject({ deleting: 1, deleted: 0 });
    expect(stateOf(id)).toBe('deleting');
  });

  it('409 (a deletion is already queued) leaves the row deleting', async () => {
    const id = seed({ expires_at: 1 });
    model.tenants.set(id, 'suspended');
    model.activeJob.add(id);
    await run();
    expect(stateOf(id)).toBe('deleting');
  });

  it.each([400, 404, 500, 503])('a failed lookup (%i) never releases the slot', async (status) => {
    const id = seed({ expires_at: 1 });
    model.tenants.set(id, 'active');
    model.failures.get = status;
    if (status === 404) {
      upstream.on(K.getTenant, () => new Response('<html>not found</html>', { status: 404 }));
    }
    const summary = await run();
    expect(stateOf(id)).toBe('deleting');
    expect(summary.deleted).toBe(0);
  });

  it('a 404 without the not-found error code never releases the slot', async () => {
    const id = seed({ expires_at: 1 });
    upstream.on(K.getTenant, () => json({ error: 'not_found' }, 404));
    const summary = await run();
    expect(stateOf(id)).toBe('deleting');
    expect(summary.deleted).toBe(0);
  });

  it.each([401, 403])(
    'a %i on the lookup is a configuration error: the run stops and it is logged',
    async (status) => {
      const ids = [seed({ expires_at: 1 }), seed({ expires_at: 2 })];
      model.failures.get = status;
      const summary = await run();
      expect(summary).toMatchObject({ claimed: 1, stopped: true, errors: 1 });
      expect(ids.map(stateOf)).toEqual(['deleting', 'handed_off']);
      const line = logs.find((l) => l.includes('cleanup_config_error'));
      expect(JSON.parse(line ?? '{}')).toMatchObject({ event: 'cleanup_config_error', status });
      expect(upstream.count(K.deleteTenant)).toBe(0);
    }
  );

  it('a DELETE that fails with 500 stays deleting and counts as pending, not as gone', async () => {
    const id = seed({ expires_at: 1 });
    model.tenants.set(id, 'active');
    model.failures.delete = 500;
    const summary = await run();
    expect(stateOf(id)).toBe('deleting');
    expect(summary).toMatchObject({ errors: 1, deleted: 0 });
  });

  it('a network error stays deleting', async () => {
    const id = seed({ expires_at: 1 });
    upstream.on(K.getTenant, () => {
      throw new Error('down');
    });
    await run();
    expect(stateOf(id)).toBe('deleting');
  });

  it('stops the run at a configuration error (a refused delete)', async () => {
    const ids = [seed({ expires_at: 1 }), seed({ expires_at: 2 }), seed({ expires_at: 3 })];
    for (const id of ids) model.tenants.set(id, 'active');
    model.failures.delete = 403;
    const summary = await run();
    expect(summary).toMatchObject({ claimed: 1, stopped: true });
    expect(ids.map(stateOf)).toEqual(['deleting', 'handed_off', 'handed_off']);
    expect(logs.some((l) => l.includes('cleanup_config_error'))).toBe(true);
    expect(upstream.count(K.deleteTenant)).toBe(1);
  });

  it('does not probe after a configuration error', async () => {
    const stale = seed({ state: 'deleting', delete_attempted_at: nowSeconds() - 5000 });
    const fresh = seed({ expires_at: 1 });
    model.tenants.set(fresh, 'active');
    model.failures.delete = 401;
    await run();
    expect(callsFor(stale)).toHaveLength(0);
  });
});

describe('probing starvation', () => {
  it('reaches rows behind ten that never finish: a probed row goes to the back', async () => {
    const now = nowSeconds();
    const never: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const id = seed({ state: 'deleting', updated_at: 1000 + i, delete_attempted_at: now - 4000 });
      model.tenants.set(id, 'deleting');
      never.push(id);
    }
    const gone = [
      seed({ state: 'deleting', updated_at: 2000, delete_attempted_at: now - 3000 }),
      seed({ state: 'deleting', updated_at: 2001, delete_attempted_at: now - 3000 }),
    ];
    // the two last rows are gone upstream (404): no model entry
    await run();
    upstream.clock.now += 600 * 1000;
    await run();
    expect(gone.map(stateOf)).toEqual(['deleted', 'deleted']);
    expect(never.every((id) => stateOf(id) === 'deleting')).toBe(true);
  });
});

describe('late-blocked provisioning', () => {
  const stuckRow = () => {
    const id = seed({ state: 'provisioning', created_at: 1 });
    model.tenants.set(id, 'provisioning');
    return id;
  };
  const retries = (id: string) => callsFor(id).filter((c) => c.url.endsWith('/provisioning/retry'));

  it.each(['lookup_activate', 'tenant_active'])(
    'retries a blocked provisioning stuck at %s once per probe window and stays deleting',
    async (step) => {
      const id = stuckRow();
      model.stuck.set(id, { status: 'blocked', current_step: step });
      // keep it blocked after the retry so the window rule can be seen
      upstream.on(K.retry, () => json({ status: 'queued' }, 202));
      await run();
      expect(stateOf(id)).toBe('deleting');
      expect(retries(id)).toHaveLength(1);
      expect(callsFor(id).length).toBeLessThanOrEqual(3);
      await run(); // same window: not asked again
      expect(retries(id)).toHaveLength(1);
      upstream.clock.now += 540 * 1000;
      await run();
      expect(retries(id)).toHaveLength(2);
    }
  );

  it.each(['running', 'queued', 'waiting_retry', 'canceled'])(
    'does not retry a %s operation',
    async (status) => {
      const id = stuckRow();
      model.stuck.set(id, { status, current_step: 'lookup_activate' });
      await run();
      expect(retries(id)).toHaveLength(0);
      expect(stateOf(id)).toBe('deleting');
    }
  );

  it('does not retry a conflict at another step', async () => {
    const id = stuckRow();
    model.stuck.set(id, { status: 'blocked', current_step: 'registry_publish' });
    await run();
    expect(retries(id)).toHaveLength(0);
  });

  it('deletes the tenant on a later run once the retried activation made it active', async () => {
    const id = stuckRow();
    model.stuck.set(id, { status: 'blocked', current_step: 'lookup_activate' });
    await run();
    expect(model.tenants.get(id)).toBe('active');
    expect(stateOf(id)).toBe('deleting');
    upstream.clock.now += 540 * 1000;
    await run();
    expect(model.tenants.get(id)).toBe('deleting');
    expect(deletesFor(id)).toHaveLength(1);
    model.tenants.set(id, 'deleted');
    upstream.clock.now += 540 * 1000;
    await run();
    expect(stateOf(id)).toBe('deleted');
  });

  it.each([401, 403])(
    'a %i on the retry is a configuration error that stops the run',
    async (status) => {
      const id = stuckRow();
      const other = seed({ expires_at: 5 });
      model.tenants.set(other, 'active');
      model.stuck.set(id, { status: 'blocked', current_step: 'lookup_activate' });
      model.failures.retry = status;
      const summary = await run();
      expect(summary.stopped).toBe(true);
      expect(stateOf(other)).toBe('handed_off');
      expect(logs.some((l) => l.includes('cleanup_config_error'))).toBe(true);
    }
  );
});

describe('probing rows in deleting', () => {
  it('moves a purged tenant to deleted', async () => {
    const id = seed({ state: 'deleting', delete_attempted_at: nowSeconds() - 700 });
    model.tenants.set(id, 'deleted');
    expect(await run()).toMatchObject({ deleted: 1 });
    expect(stateOf(id)).toBe('deleted');
  });

  it('leaves a tenant that is still deleting, and does not touch updated_at', async () => {
    const updated = nowSeconds() - 1000;
    const id = seed({ state: 'deleting', delete_attempted_at: null, updated_at: updated });
    model.tenants.set(id, 'deleting');
    await run();
    expect(stateOf(id)).toBe('deleting');
    expect(row(id)?.updated_at).toBe(updated);
    expect(row(id)?.delete_attempted_at).toBe(nowSeconds());
    expect(deletesFor(id)).toHaveLength(0);
  });

  it('asks again only after 9 minutes', async () => {
    const early = seed({ state: 'deleting', delete_attempted_at: nowSeconds() - 539 });
    const due = seed({ state: 'deleting', delete_attempted_at: nowSeconds() - 540 });
    model.tenants.set(early, 'deleting');
    model.tenants.set(due, 'deleting');
    await run();
    expect(callsFor(early)).toHaveLength(0);
    expect(callsFor(due).length).toBeGreaterThan(0);
  });

  it('retries a deletion whose job failed (tenant back in a deletable state)', async () => {
    const id = seed({
      state: 'deleting',
      delete_attempted_at: nowSeconds() - 900,
      delete_attempts: 1,
    });
    model.tenants.set(id, 'suspended');
    await run();
    expect(deletesFor(id)).toHaveLength(1);
    expect(model.tenants.get(id)).toBe('deleting');
    expect(row(id)?.delete_attempts).toBe(2);
  });

  it('a 404 for a row in deleting means gone', async () => {
    const id = seed({ state: 'deleting', delete_attempted_at: null });
    await run();
    expect(stateOf(id)).toBe('deleted');
  });

  it('two overlapping runs send exactly one DELETE per row', async () => {
    const ids = [seed({ expires_at: 1 }), seed({ expires_at: 2 }), seed({ expires_at: 3 })];
    for (const id of ids) model.tenants.set(id, 'active');
    testDb.beforeStatement.current = async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
    };
    await Promise.all([run(), run()]);
    for (const id of ids) {
      expect(deletesFor(id)).toHaveLength(1);
      expect(callsFor(id)).toHaveLength(2); // one lookup and one DELETE, not one pair per run
    }
  });

  it('two overlapping probes ask once per row and window', async () => {
    const id = seed({ state: 'deleting', delete_attempted_at: nowSeconds() - 700 });
    model.tenants.set(id, 'deleting');
    testDb.beforeStatement.current = async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
    };
    await Promise.all([run(), run()]);
    expect(upstream.calls.filter((c) => c.method === 'GET' && c.url.includes(id))).toHaveLength(1);
  });
});

describe('bounded work', () => {
  it('handles at most 10 rows per phase and keeps the upstream calls small', async () => {
    for (let i = 0; i < 25; i += 1) {
      const id = seed({ expires_at: i + 1, created_at: 100 + i });
      model.tenants.set(id, 'active');
    }
    const summary = await run();
    expect(summary.claimed).toBe(10);
    expect(upstream.calls.length).toBeLessThanOrEqual(1 + 10 * 2);
    expect(allRows(testDb).filter((r) => r.state === 'deleting')).toHaveLength(10);
    // oldest first
    const taken = allRows(testDb)
      .filter((r) => r.state === 'deleting')
      .map((r) => Number(r.created_at));
    expect(Math.max(...taken)).toBeLessThan(110);
  });

  it('probes at most 10 rows', async () => {
    for (let i = 0; i < 15; i += 1) {
      const id = seed({ state: 'deleting', delete_attempted_at: null, updated_at: 1000 + i });
      model.tenants.set(id, 'deleting');
    }
    await run();
    expect(
      upstream.calls.filter((c) => c.method === 'GET' && c.url.includes('/tenants/'))
    ).toHaveLength(10);
  });
});

describe('scope sets', () => {
  const scopesOf = (call: { body: string }) =>
    (new URLSearchParams(call.body).get('scope') ?? '').split(' ');
  const tokenCalls = () => upstream.calls.filter((c) => c.url.endsWith('/token'));

  it('keeps the delete scopes out of the web token and the invitation scope out of the cleanup token', async () => {
    await startAndCreate(env, upstream); // web path: create tenant
    const id = seed({ expires_at: 1 });
    model.tenants.set(id, 'active');
    await run();
    const [web, cleanup] = tokenCalls().map(scopesOf);
    expect(web).toContain('admin:admin_invitations:code_handoff');
    expect(web).not.toContain('admin:tenants:delete');
    expect(web).not.toContain('admin:step_up_exempt:tenant.delete');
    expect(cleanup).toEqual([
      'admin:tenants:delete',
      'admin:step_up_exempt:tenant.delete',
      'admin:tenants:provision',
    ]);
    expect(cleanup).not.toContain('admin:admin_invitations:code_handoff');
    expect(cleanup).not.toContain('admin:admin_users:write');
  });

  it('each path uses its own cached token', async () => {
    await startAndCreate(env, upstream);
    const id = seed({ expires_at: 1 });
    model.tenants.set(id, 'active');
    await run();
    const bearers = upstream.calls
      .filter((c) => c.url.includes('/api/admin/'))
      .map((c) => c.headers.authorization);
    expect(new Set(bearers).size).toBe(2);
    expect(tokenCalls()).toHaveLength(2);
  });

  it('fails closed when the delete scope is not granted, while the web path still works', async () => {
    upstream.on(K.token, (call) => {
      const requested = scopesOf(call).filter((s) => s !== 'admin:tenants:delete');
      return json({
        access_token: 't-limited',
        token_type: 'Bearer',
        expires_in: 900,
        scope: requested.join(' '),
      });
    });
    resetAdminTokenCache();
    const id = seed({ expires_at: 1 });
    model.tenants.set(id, 'active');
    const summary = await run();
    expect(summary.stopped).toBe(true);
    expect(upstream.count(K.deleteTenant)).toBe(0);
    expect(stateOf(id)).toBe('deleting');
    // the web path is unaffected: its token request is a different scope set
    upstream.on(K.token, (call) =>
      json({
        access_token: 't-web',
        token_type: 'Bearer',
        expires_in: 900,
        scope: new URLSearchParams(call.body).get('scope'),
      })
    );
    resetAdminTokenCache();
    expect((await start(env, upstream)).status).toBe(303);
  });
});

describe('capacity and purge', () => {
  it('releases a slot only when the row is deleted, not when it becomes deleting', async () => {
    env = await makeEnv(testDb, { MAX_ACTIVE_TENANTS: '1', MAX_STARTS_PER_IP_PER_DAY: '20' });
    const first = await startAndCreate(env, upstream, { ip: '198.51.100.1' });
    expect(first.started.status).toBe(303);
    const id = allRows(testDb)[0].id as string;
    expect((await start(env, upstream, { ip: '198.51.100.2' })).status).toBe(503);

    // it expires and goes to deleting: still no room
    testDb.sqlite.exec('UPDATE demo_tenants SET expires_at = 1');
    model.tenants.set(id, 'active');
    await run();
    expect(stateOf(id)).toBe('deleting');
    expect((await start(env, upstream, { ip: '198.51.100.2' })).status).toBe(503);

    // the tenant is purged: the next probe makes room
    model.tenants.set(id, 'deleted');
    upstream.clock.now += 11 * 60 * 1000;
    await run();
    expect(stateOf(id)).toBe('deleted');
    expect((await start(env, upstream, { ip: '198.51.100.2' })).status).toBe(303);
  });

  it('purges deleted rows older than 7 days, not before', async () => {
    const now = nowSeconds();
    const keep = seed({
      state: 'deleted',
      updated_at: now - 7 * 86_400,
      created_at: now - 8 * 86_400,
    });
    const drop = seed({
      state: 'deleted',
      updated_at: now - 7 * 86_400 - 1,
      created_at: now - 8 * 86_400,
    });
    const recent = seed({ state: 'deleted', updated_at: now - 3600 });
    const other = seed({ state: 'failed', updated_at: now - 8 * 86_400, expires_at: now + 99 });
    model.tenants.set(other, 'active');
    expect((await run()).purged).toBe(1);
    expect(row(drop)).toBeUndefined();
    expect(row(keep)).toBeDefined();
    expect(row(recent)).toBeDefined();
  });

  it('a purged row no longer counts for the per-IP limit only because it is older than 24 hours', async () => {
    const now = nowSeconds();
    const ip = 'ip-hash-fixed';
    env = await makeEnv(testDb, { MAX_STARTS_PER_IP_PER_DAY: '1' });
    // fill the IP's allowance with a recent row that is already deleted but not yet purged
    seed({ state: 'deleted', ip_hash: ip, created_at: now - 3600, updated_at: now - 3600 });
    const before = testDb.sqlite
      .prepare('SELECT COUNT(*) AS n FROM demo_tenants WHERE ip_hash = ? AND created_at > ?')
      .get(ip, now - 86_400) as { n: number };
    expect(before.n).toBe(1);
    await run();
    expect(allRows(testDb)).toHaveLength(1); // not purged: kept for the 24 h look-back
    const old = seed({
      state: 'deleted',
      ip_hash: ip,
      created_at: now - 8 * 86_400,
      updated_at: now - 8 * 86_400,
    });
    await run();
    expect(row(old)).toBeUndefined();
    const after = testDb.sqlite
      .prepare('SELECT COUNT(*) AS n FROM demo_tenants WHERE ip_hash = ? AND created_at > ?')
      .get(ip, now - 86_400) as { n: number };
    expect(after.n).toBe(1); // the purged row was outside the window anyway
  });
});

describe('alarm and logs', () => {
  it('logs cleanup_stuck for rows deleting for 3 hours or more', async () => {
    const now = nowSeconds();
    const stuck = seed({ state: 'deleting', updated_at: now - 3 * 3600, delete_attempted_at: now });
    seed({ state: 'deleting', updated_at: now - 3 * 3600 + 1, delete_attempted_at: now });
    model.tenants.set(stuck, 'deleting');
    const spy = vi.spyOn(console, 'error');
    const summary = await run();
    expect(summary.stuck).toBe(1);
    const line = spy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('cleanup_stuck'));
    expect(JSON.parse(line ?? '{}')).toEqual({ event: 'cleanup_stuck', count: 1 });
  });

  it('logs no alarm when nothing is stuck, and one summary line per run', async () => {
    await run();
    expect(logs.some((l) => l.includes('cleanup_stuck'))).toBe(false);
    expect(logs.filter((l) => l.includes('cleanup_run'))).toHaveLength(1);
  });

  it('never logs a token', async () => {
    const id = seed({ expires_at: 1 });
    model.tenants.set(id, 'active');
    model.failures.delete = 403;
    await run();
    expect(logs.join('\n')).not.toMatch(/token-\d|Bearer|client_assertion/);
  });
});

describe('scheduled', () => {
  it('is exported next to fetch', () => {
    expect(typeof worker.scheduled).toBe('function');
    expect(typeof worker.fetch).toBe('function');
  });

  it('swallows unexpected errors', async () => {
    const broken = {
      ...env,
      DB: {
        prepare: () => {
          throw new Error('db down');
        },
      },
    } as unknown as Env;
    await expect(handleScheduled(broken, upstream.deps)).resolves.toBeNull();
    expect(logs.some((l) => l.includes('cleanup_unhandled_error'))).toBe(true);
  });

  it('does nothing with an invalid configuration', async () => {
    const bad = await makeEnv(testDb, { MACHINE_KEY_ID: undefined });
    await expect(handleScheduled(bad, upstream.deps)).resolves.toBeNull();
    expect(upstream.calls).toHaveLength(0);
  });

  it('a handed-off visitor row is still answered failed once deleting', async () => {
    const response = await start(env, upstream);
    const ticket = cookieOf(response) as string;
    testDb.sqlite.exec("UPDATE demo_tenants SET state = 'deleting'");
    const status = await handleRequest(statusRequest(ticket), env, upstream.deps);
    expect(await status.json()).toEqual({ state: 'failed' });
  });
});

describe('ownership of the tenant', () => {
  const ID_OF = () => allRows(testDb)[0].id as string;
  /** A tenant of someone else under the portal's id, as the fake core returns it. */
  const foreign = (id: string, lifecycle: Lifecycle = 'active') => {
    model.tenants.set(id, lifecycle);
    upstream.on(K.getTenant, () =>
      json({ lifecycle_state: lifecycle, name: 'Somebody else', description: 'not ours' })
    );
  };
  const ours = (id: string, lifecycle: Lifecycle = 'active') => {
    model.tenants.set(id, lifecycle);
    upstream.on(K.getTenant, () =>
      json({
        lifecycle_state: model.tenants.get(id),
        name: tenantDisplayName(id),
        description: TENANT_DESCRIPTION,
      })
    );
  };
  const expectReleased = async (id: string) => {
    upstream.calls.length = 0;
    upstream.clock.now += 3600 * 1000;
    await run();
    expect(upstream.calls.filter((c) => c.url.includes(id)).map((c) => c.method)).toEqual(['GET']);
    expect(stateOf(id)).toBe('deleted');
    expect(logs.some((l) => l.includes('cleanup_not_ours') && l.includes(id))).toBe(true);
    expect(model.tenants.get(id)).not.toBe('deleting');
    expect(model.tenants.get(id)).not.toBe('deleted');
  };

  it('records the acceptance of a 202 and the cleanup deletes as before', async () => {
    expect((await startAndCreate(env, upstream)).started.status).toBe(303);
    const id = ID_OF();
    expect(row(id)?.create_accepted_at).toBe(nowSeconds());
    model.tenants.set(id, 'active');
    upstream.clock.now += 13 * 3600 * 1000;
    await run();
    expect(deletesFor(id)).toHaveLength(1);
    expect(stateOf(id)).toBe('deleting');
  });

  it.each([400, 403])(
    'a %i on create with a foreign tenant of that id: failed, then released without a write',
    async (status) => {
      upstream.on(K.create, () => json({ error: 'tenant_id_exists' }, status));
      expect(await (await startAndCreate(env, upstream)).status?.json()).toEqual({
        state: 'failed',
      });
      const id = ID_OF();
      expect(stateOf(id)).toBe('failed');
      foreign(id);
      await expectReleased(id);
    }
  );

  it('a token failure before the create request is sent: same expectations', async () => {
    upstream.on(K.token, () => json({ error: 'server_error' }, 500));
    expect(await (await startAndCreate(env, upstream)).status?.json()).toEqual({
      state: 'failed',
    });
    expect(upstream.count(K.create)).toBe(0);
    const id = ID_OF();
    expect(stateOf(id)).toBe('failed');
    resetAdminTokenCache();
    upstream.on(K.token, (call) =>
      json({
        access_token: 't',
        token_type: 'Bearer',
        expires_in: 900,
        scope: new URLSearchParams(call.body).get('scope'),
      })
    );
    foreign(id);
    await expectReleased(id);
  });

  it('a failing acceptance write after a 202: error, no cookie, and the cleanup deletes by marker', async () => {
    let failed = false;
    testDb.beforeStatement.current = (sql) => {
      if (!failed && sql.includes('create_accepted_at = ')) {
        failed = true;
        throw new Error('db down');
      }
      return Promise.resolve();
    };
    const { started, status } = await startAndCreate(env, upstream);
    expect(started.status).toBe(303);
    expect(await status?.json()).toEqual({ state: 'failed' });
    expect(logs.some((l) => l.includes('registry_update_failed'))).toBe(true);
    const id = ID_OF();
    expect(row(id)?.create_accepted_at).toBeNull();
    ours(id);
    upstream.calls.length = 0;
    upstream.clock.now += 13 * 3600 * 1000;
    await run();
    expect(deletesFor(id)).toHaveLength(1);
    expect(stateOf(id)).toBe('deleting');
  });

  it('an unconfirmed row with a foreign provisioning tenant gets no provisioning cleanup or retry', async () => {
    const id = seed({ state: 'provisioning', create_accepted_at: null, created_at: 1 });
    foreign(id, 'provisioning');
    await run();
    expect(upstream.count(K.cleanup)).toBe(0);
    expect(upstream.count(K.retry)).toBe(0);
    expect(stateOf(id)).toBe('deleted');
  });

  it('an unconfirmed row with the portal marker is cleaned as before', async () => {
    const id = seed({ state: 'failed', create_accepted_at: null, updated_at: 1 });
    ours(id);
    await run();
    expect(deletesFor(id)).toHaveLength(1);
  });

  it.each([['500', () => json({ error: 'x' }, 500)]])(
    '%s with nothing created: failed, then gone without a write',
    async (_name, handler) => {
      upstream.on(K.create, handler);
      expect(await (await startAndCreate(env, upstream)).status?.json()).toEqual({
        state: 'failed',
      });
      const id = ID_OF();
      expect(stateOf(id)).toBe('failed');
      upstream.calls.length = 0;
      upstream.clock.now += 301 * 1000;
      await run();
      expect(callsFor(id).map((c) => c.method)).toEqual(['GET']);
      expect(stateOf(id)).toBe('deleted');
    }
  );

  describe('rows of the deferred creation', () => {
    const ABANDONED = 1800 + 120;
    const queued = (fields: Parameters<typeof seed>[0] = {}) =>
      seed({ state: 'provisioning', create_accepted_at: null, ...fields });
    const inFlight = (fields: Parameters<typeof seed>[0] = {}) => {
      const id = queued(fields);
      testDb.sqlite
        .prepare('UPDATE demo_tenants SET create_started_at = ?, create_attempts = 1 WHERE id = ?')
        .run(nowSeconds() - 1000, id);
      return id;
    };

    it('a queued row has no tenant: after the abandoned time it is gone with one lookup, no write', async () => {
      const id = queued({ created_at: nowSeconds() - ABANDONED });
      await run();
      expect(callsFor(id).map((c) => c.method)).toEqual(['GET']);
      expect(stateOf(id)).toBe('deleted');
      expect(logs.some((l) => l.includes('cleanup_not_ours'))).toBe(false);
    });

    it('a queued row is left alone before the abandoned time, and counts toward capacity until then', async () => {
      const id = queued({ created_at: nowSeconds() - ABANDONED + 5 });
      await run();
      expect(stateOf(id)).toBe('provisioning');
      expect(upstream.calls).toHaveLength(0);
      const small = await makeEnv(testDb, { MAX_ACTIVE_TENANTS: '1' });
      expect((await start(small, upstream, { ip: '198.51.100.9' })).status).toBe(503);
    });

    it('a row whose creation is in flight (or was lost) and carries the portal marker is cleaned up', async () => {
      const id = inFlight({ created_at: nowSeconds() - ABANDONED });
      ours(id, 'provisioning');
      upstream.on(K.cleanup, () => json({}, 200));
      await run();
      expect(upstream.count(K.cleanup)).toBe(1);
      expect(stateOf(id)).toBe('deleted');
    });

    it('a row whose creation was attempted, with a foreign tenant of that id, is released without a write', async () => {
      const id = inFlight({ created_at: nowSeconds() - ABANDONED });
      foreign(id, 'provisioning');
      await run();
      expect(callsFor(id).map((c) => c.method)).toEqual(['GET']);
      expect(stateOf(id)).toBe('deleted');
      expect(logs.some((l) => l.includes('cleanup_not_ours'))).toBe(true);
    });

    it('a row that failed after attempts is removed by the failed-row rule like any other', async () => {
      const id = inFlight({ state: 'failed', updated_at: nowSeconds() - 300 });
      ours(id, 'active');
      await run();
      expect(deletesFor(id)).toHaveLength(1);
    });
  });
});

describe('the clock during a run', () => {
  it('stamps each claim and settle write with the time it happens', async () => {
    const t0 = nowSeconds();
    const first = seed({ expires_at: 1, created_at: t0 - 20 });
    const second = seed({ expires_at: 1, created_at: t0 - 10 });
    model.tenants.set(first, 'active');
    model.tenants.set(second, 'active');
    upstream.on(K.getTenant, () => {
      upstream.clock.now += 100 * 1000; // every lookup takes 100 s
      return json({ lifecycle_state: 'active' });
    });
    await run();
    expect(row(first)?.delete_attempted_at).toBe(t0 + 100);
    expect(row(first)?.updated_at).toBe(t0);
    expect(row(second)?.updated_at).toBe(t0 + 100);
    expect(row(second)?.delete_attempted_at).toBe(t0 + 200);
  });
});
