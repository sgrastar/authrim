import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createTenant } from '../admin-api';
import { deleteSweepUser, listSweepUsers, SWEEP_SCOPES } from '../sweep-api';
import { loadSweepConfig, type SweepConfig } from '../sweep-config';
import { handleSweep, runSweep } from '../sweep';
import type { Env } from '../types';
import {
  API,
  configOf,
  createTestDb,
  createUpstream,
  generateKey,
  json,
  K,
  makeEnv,
  type Upstream,
} from './helpers';

let upstream: Upstream;
let env: Env;
let config: SweepConfig;
let logged: string[];
let errors: string[];
const LIST = `GET ${new URL(API).host}/api/admin/users`;
const deleteKey = (id: string) => `DELETE ${new URL(API).host}/api/admin/users/${id}`;
const deletes = () => upstream.calls.filter((call) => call.method === 'DELETE');
const lists = () => upstream.calls.filter((call) => call.method === 'GET');
const user = (id: string, createdAt?: number | null) => ({
  id,
  tenant_id: 'default',
  created_at: createdAt === undefined ? Date.UTC(2026, 10, 13, 11) : createdAt,
  email: 'private-email@example.com',
  name: 'Private Visitor Name',
});
const page = (users: unknown[], nextCursor: string | null = null) => ({
  users,
  pagination: { mode: 'cursor', limit: 100, hasNext: nextCursor !== null, nextCursor },
});
function serve(users: ReturnType<typeof user>[]) {
  upstream.on(LIST, () => json(page(users)));
  for (const entry of users) upstream.on(deleteKey(entry.id), () => json({ success: true }));
}
function sweepConfig(): SweepConfig {
  const result = loadSweepConfig(env);
  if (!result.ok || !result.config) throw new Error('configuration');
  return result.config;
}

beforeEach(async () => {
  upstream = createUpstream();
  env = await makeEnv(createTestDb(), {
    SWEEP_ENABLED: 'true',
    SWEEP_DRY_RUN: 'false',
    SWEEP_KEEP_USER_IDS: '',
    SWEEP_MACHINE_CLIENT_ID: 'janitor-client',
    SWEEP_MACHINE_KEY_ID: 'janitor-key',
    SWEEP_MACHINE_PRIVATE_JWK: JSON.stringify((await generateKey()).privateJwk),
  });
  config = sweepConfig();
  logged = [];
  errors = [];
  vi.spyOn(console, 'log').mockImplementation((message: unknown) => {
    logged.push(String(message));
  });
  vi.spyOn(console, 'error').mockImplementation((message: unknown) => {
    errors.push(String(message));
  });
});
afterEach(() => vi.restoreAllMocks());

describe('default-only sweep API', () => {
  it('uses the separate signed credential, exact scopes, and an independent token cache', async () => {
    serve([user('visitor-secret-id')]);
    await createTenant(configOf(env), upstream.deps, 'demo-test23456');
    await runSweep(config, upstream.deps);
    const tokens = upstream.calls.filter((call) => call.url === `${API}/token`);
    expect(tokens).toHaveLength(2);
    const form = new URLSearchParams(tokens[1].body);
    expect(form.get('scope')).toBe(SWEEP_SCOPES.join(' '));
    const assertion = form.get('client_assertion');
    if (!assertion) throw new Error('missing assertion');
    const [header, claims] = assertion.split('.');
    const decode = (value: string): Record<string, unknown> =>
      JSON.parse(atob(value.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>;
    expect(decode(header)).toMatchObject({ kid: 'janitor-key', alg: 'ES256' });
    expect(decode(claims)).toMatchObject({ sub: 'janitor-client', iss: 'janitor-client' });
    for (const call of [...lists(), ...deletes()]) {
      expect(call.headers['x-tenant-id']).toBe('default');
      expect(call.headers.authorization).toBe('Bearer token-2');
      expect(new URL(call.url).origin).toBe(API);
      expect(call.redirect).toBe('manual');
    }
  });

  it('does not expose PII in the reduced response or summary logs', async () => {
    serve([user('visitor-secret-id')]);
    expect(await listSweepUsers(config, upstream.deps)).toEqual({
      users: [{ id: 'visitor-secret-id', createdAt: upstream.clock.now - 3600_000 }],
      next: null,
    });
    await handleSweep(env, upstream.deps);
    const output = JSON.stringify([logged, errors]);
    expect(output).toContain('sweep_run');
    for (const secret of [
      'visitor-secret-id',
      'private-email',
      'Private Visitor',
      'token-1',
      'janitor-key',
    ]) {
      expect(output).not.toContain(secret);
    }
  });

  it('refuses missing scopes before reading or deleting users', async () => {
    serve([user('old')]);
    upstream.on(K.token, () =>
      json({
        access_token: 'sensitive',
        token_type: 'Bearer',
        expires_in: 900,
        scope: 'admin:users:read',
      })
    );
    expect(await runSweep(config, upstream.deps)).toMatchObject({ stopped: true, errors: 1 });
    expect(lists()).toHaveLength(0);
    expect(deletes()).toHaveLength(0);
  });

  it.each([
    [{ ...user('foreign'), tenant_id: 'another-tenant' }],
    [{ ...user('bad'), tenant_id: undefined }],
    [user('../traversal')],
    [user('bad', -1)],
    [{ ...user('bad'), created_at: '2026-01-01' }],
  ])('refuses malformed or cross-tenant users before deletion', async (entry) => {
    upstream.on(LIST, () => json(page([entry])));
    expect(await runSweep(config, upstream.deps)).toMatchObject({ stopped: true, errors: 1 });
    expect(deletes()).toHaveLength(0);
  });

  it.each([
    { users: [], pagination: {} },
    { users: [], pagination: { mode: 'cursor', hasNext: true, nextCursor: '' } },
    { users: [], pagination: { mode: 'cursor', hasNext: false, nextCursor: 'unexpected' } },
    { users: [], pagination: { page: 2, limit: 100, totalPages: 2, hasNext: false } },
    { users: Array.from({ length: 101 }, () => user('old')), pagination: page([]).pagination },
  ])('fails closed on invalid pagination or oversized pages', async (body) => {
    upstream.on(LIST, () => json(body));
    await expect(listSweepUsers(config, upstream.deps)).rejects.toMatchObject({
      kind: 'invalid_response',
    });
    expect(deletes()).toHaveLength(0);
  });

  it('rejects redirects and bounds bytes while streaming, cancelling oversized bodies', async () => {
    upstream.on(
      LIST,
      () => new Response(null, { status: 302, headers: { Location: 'https://foreign.invalid' } })
    );
    await expect(listSweepUsers(config, upstream.deps)).rejects.toMatchObject({ kind: 'redirect' });
    let cancelled = false;
    upstream.on(
      LIST,
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new Uint8Array(65536));
            },
            cancel() {
              cancelled = true;
            },
          })
        )
    );
    await expect(listSweepUsers(config, upstream.deps)).rejects.toMatchObject({
      kind: 'invalid_response',
    });
    expect(cancelled).toBe(true);
    expect(deletes()).toHaveLength(0);
  });

  it('accepts a bounded rich page larger than the other endpoints allow', async () => {
    const users = Array.from({ length: 100 }, (_, i) => ({
      ...user(`user-${i}`),
      name: 'x'.repeat(1000),
    }));
    upstream.on(LIST, () => json(page(users)));
    const result = await listSweepUsers(config, upstream.deps);
    expect(result.users).toHaveLength(100);
    expect(Object.keys(result.users[0])).toEqual(['id', 'createdAt']);
    expect(deletes()).toHaveLength(0);
  });

  it('rejects path injection even for a direct delete helper call', async () => {
    await expect(
      deleteSweepUser(config, upstream.deps, '../tenants/default')
    ).rejects.toMatchObject({ kind: 'invalid_response' });
    expect(upstream.calls).toHaveLength(0);
  });
});

describe('bounded sweep policy', () => {
  it('protects keep ids, unknown creation times, and accounts younger than the age boundary', async () => {
    const cutoff = upstream.clock.now - 30 * 60_000;
    serve([
      user('keep'),
      user('young', cutoff + 1),
      user('boundary', cutoff),
      user('old', cutoff - 1),
      user('unknown', null),
      user('future', upstream.clock.now + 1),
    ]);
    const summary = await runSweep({ ...config, keepUserIds: new Set(['keep']) }, upstream.deps);
    expect(summary).toMatchObject({
      scanned: 6,
      eligible: 2,
      attempted: 2,
      deleted: 2,
      skipped: 4,
    });
    expect(deletes().map((call) => new URL(call.url).pathname.split('/').pop())).toEqual([
      'old',
      'boundary',
    ]);
  });

  it('sorts oldest first, deduplicates ids, and caps deletion attempts', async () => {
    serve([user('newest', 9000), user('oldest', 1000), user('middle', 5000), user('oldest', 1000)]);
    const summary = await runSweep({ ...config, maxDeletes: 2 }, upstream.deps);
    expect(summary).toMatchObject({
      scanned: 4,
      eligible: 3,
      attempted: 2,
      deleted: 2,
      limited: true,
    });
    expect(deletes().map((call) => new URL(call.url).pathname.split('/').pop())).toEqual([
      'oldest',
      'middle',
    ]);
  });

  it('dry run reads and counts without deleting', async () => {
    serve([user('old')]);
    delete env.SWEEP_DRY_RUN;
    expect(await handleSweep(env, upstream.deps)).toMatchObject({
      dryRun: true,
      eligible: 1,
      attempted: 0,
    });
    expect(lists()).toHaveLength(1);
    expect(deletes()).toHaveLength(0);
  });

  it('does not touch the portal registry or any database binding', async () => {
    serve([user('old')]);
    const db = {
      prepare() {
        throw new Error('database access forbidden');
      },
    };
    expect(await handleSweep({ ...env, DB: db }, upstream.deps)).toMatchObject({ deleted: 1 });
  });

  it('does nothing when disabled or configured unsafely', async () => {
    expect(await handleSweep({ ...env, SWEEP_ENABLED: 'false' }, upstream.deps)).toBeNull();
    expect(await handleSweep({ ...env, SWEEP_KEEP_USER_IDS: undefined }, upstream.deps)).toBeNull();
    expect(upstream.calls).toHaveLength(0);
  });

  it('reads every cursor page before deleting and encodes opaque cursors', async () => {
    const cursor = 'opaque+/=&?cursor';
    upstream.on(LIST, (call) => {
      const value = new URL(call.url).searchParams.get('cursor');
      return json(value === null ? page([user('first')], cursor) : page([user('second')]));
    });
    upstream.on(deleteKey('first'), () => json({}));
    upstream.on(deleteKey('second'), () => json({}));
    expect(await runSweep(config, upstream.deps)).toMatchObject({ deleted: 2 });
    expect(new URL(lists()[1].url).searchParams.get('cursor')).toBe(cursor);
    expect(upstream.calls.map((call) => call.method)).toEqual([
      'POST',
      'GET',
      'GET',
      'DELETE',
      'DELETE',
    ]);
  });

  it('supports legacy offset pagination without shifting pages through deletes', async () => {
    upstream.on(LIST, (call) => {
      const index = Number(new URL(call.url).searchParams.get('page') ?? '1');
      return json({
        users: [user(`user-${index}`)],
        pagination: { page: index, limit: 100, totalPages: 2, hasNext: index < 2 },
      });
    });
    upstream.on(deleteKey('user-1'), () => json({}));
    upstream.on(deleteKey('user-2'), () => json({}));
    expect(await runSweep(config, upstream.deps)).toMatchObject({ deleted: 2 });
    expect(upstream.calls.map((call) => call.method)).toEqual([
      'POST',
      'GET',
      'GET',
      'DELETE',
      'DELETE',
    ]);
  });

  it.each(['page_cap', 'repeated_cursor', 'later_error', 'changed_user', 'changed_mode'])(
    'deletes nothing for an incomplete or inconsistent scan: %s',
    async (mode) => {
      let count = 0;
      upstream.on(LIST, () => {
        count += 1;
        if (count === 1) return json(page([user('old')], 'cursor-secret'));
        if (mode === 'later_error') return json({ error: 'sensitive-body' }, 500);
        if (mode === 'changed_user') return json(page([user('old', 1000)]));
        if (mode === 'changed_mode')
          return json({
            users: [],
            pagination: { page: 2, limit: 100, totalPages: 2, hasNext: false },
          });
        return json(page([], 'cursor-secret'));
      });
      const summary = await runSweep(
        { ...config, maxPages: mode === 'page_cap' ? 1 : 10 },
        upstream.deps
      );
      expect(summary.stopped).toBe(true);
      expect(deletes()).toHaveLength(0);
      expect(lists().length).toBeLessThanOrEqual(2);
      expect(JSON.stringify(errors)).not.toContain('cursor-secret');
    }
  );

  it('allows an empty intermediate cursor page and finishes exactly at the page limit', async () => {
    let count = 0;
    upstream.on(LIST, () => json(++count === 1 ? page([], 'next') : page([user('old')])));
    upstream.on(deleteKey('old'), () => json({}));
    expect(await runSweep({ ...config, maxPages: 2 }, upstream.deps)).toMatchObject({
      deleted: 1,
      stopped: false,
    });
  });

  it('skips gone accounts and legal holds, counts other failures, and continues', async () => {
    const entries = ['gone', 'hold', 'failure', 'conflict', 'ok'].map((id) => user(id));
    serve(entries);
    upstream.on(deleteKey('gone'), () => json({}, 404));
    upstream.on(deleteKey('hold'), () => json({ error: 'legal_hold_active' }, 409));
    upstream.on(deleteKey('failure'), () =>
      json({ error_description: 'sensitive upstream text' }, 500)
    );
    upstream.on(deleteKey('conflict'), () => json({ error: 'other_conflict' }, 409));
    expect(await handleSweep(env, upstream.deps)).toMatchObject({
      attempted: 5,
      deleted: 1,
      skipped: 2,
      errors: 2,
      stopped: false,
    });
    expect(JSON.stringify(logged)).not.toContain('sensitive');
  });

  it.each([401, 403])('stops without any deletes on a list %s', async (status) => {
    upstream.on(LIST, () => json({}, status));
    expect(await runSweep(config, upstream.deps)).toMatchObject({ stopped: true, errors: 1 });
    expect(deletes()).toHaveLength(0);
    expect(errors).toContain(JSON.stringify({ event: 'sweep_config_error' }));
  });

  it.each([401, 403])('stops after the first refused delete (%s)', async (status) => {
    serve(Array.from({ length: 8 }, (_, i) => user(`user-${i}`)));
    upstream.on(deleteKey('user-0'), () => json({}, status));
    expect(await runSweep(config, upstream.deps)).toMatchObject({
      stopped: true,
      attempted: 1,
      deleted: 0,
      errors: 1,
    });
    expect(deletes()).toHaveLength(1);
  });

  it('waits for each delete and limits a thirty-account backlog to five attempts', async () => {
    serve(Array.from({ length: 30 }, (_, i) => user(`user-${String(i).padStart(2, '0')}`)));
    let release!: () => void;
    let active = 0;
    let maximum = 0;
    for (let i = 0; i < 30; i += 1) {
      upstream.on(deleteKey(`user-${String(i).padStart(2, '0')}`), async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        if (i === 0)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        await Promise.resolve();
        active -= 1;
        return json({});
      });
    }
    const running = runSweep(config, upstream.deps);
    await vi.waitFor(() => expect(deletes()).toHaveLength(1));
    expect(active).toBe(1);
    expect(maximum).toBe(1);
    release();
    expect(await running).toMatchObject({ eligible: 30, attempted: 5, deleted: 5, limited: true });
    expect(deletes()).toHaveLength(5);
    expect(maximum).toBe(1);
  });
});
