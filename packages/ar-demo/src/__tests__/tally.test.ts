import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAdminTokenCache } from '../admin-api';
import { startPage } from '../html';
import { LANGS } from '../i18n';
import { handleRequest } from '../index';
import * as registry from '../registry';
import {
  readTally,
  resetTallyCache,
  TALLY_ABANDON_MS,
  TALLY_RETRY_MS,
  TALLY_TTL_MS,
  TALLY_WAIT_MS,
} from '../tally';
import type { Env } from '../types';
import {
  allRows,
  configOf,
  cookieOf,
  createTestDb,
  createUpstream,
  makeEnv,
  PORTAL,
  start,
  statusRequest,
  type TestDb,
  type Upstream,
} from './helpers';

let testDb: TestDb;
let upstream: Upstream;
let env: Env;
const logs: string[] = [];

const created = () =>
  (
    testDb.sqlite
      .prepare(`SELECT value FROM demo_counters WHERE name = 'tenants_created'`)
      .get() as {
      value: number;
    }
  ).value;
const page = async (path = '/?lang=en') =>
  (await handleRequest(new Request(`${PORTAL}${path}`), env, upstream.deps)).text();
const reads = () => testDb.statements.filter((sql) => sql.includes('AS active')).length;

beforeEach(async () => {
  logs.length = 0;
  for (const method of ['log', 'error', 'warn', 'info'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
  }
  resetTallyCache();
  resetAdminTokenCache();
  testDb = createTestDb();
  upstream = createUpstream();
  env = await makeEnv(testDb);
});
afterEach(() => vi.restoreAllMocks());

describe('the total of created tenants', () => {
  it('moves once when the creation is accepted, not when the start is queued', async () => {
    const ticket = cookieOf(await start(env, upstream)) as string;
    expect(created()).toBe(0);
    await handleRequest(statusRequest(ticket), env, upstream.deps);
    expect(allRows(testDb)[0].create_accepted_at).not.toBeNull();
    expect(created()).toBe(1);
    for (let i = 0; i < 3; i += 1) {
      upstream.clock.now += 3000;
      await handleRequest(statusRequest(ticket), env, upstream.deps);
    }
    expect(created()).toBe(1);
  });

  it('is not counted twice when the same row is marked again', async () => {
    await start(env, upstream);
    const id = allRows(testDb)[0].id as string;
    expect(await registry.markCreateAccepted(testDb.db, id, 100)).toBe(true);
    // The row is still `provisioning`, so the mark is written again, as before; the count is not.
    expect(await registry.markCreateAccepted(testDb.db, id, 200)).toBe(true);
    expect(created()).toBe(1);
  });

  it('does not move for a row that already left provisioning', async () => {
    await start(env, upstream);
    const id = allRows(testDb)[0].id as string;
    testDb.sqlite.prepare(`UPDATE demo_tenants SET state = 'failed' WHERE id = ?`).run(id);
    expect(await registry.markCreateAccepted(testDb.db, id, 100)).toBe(false);
    expect(created()).toBe(0);
  });

  it('leaves the count alone when the mark cannot be written', async () => {
    await start(env, upstream);
    const id = allRows(testDb)[0].id as string;
    testDb.sqlite.exec(
      `CREATE TRIGGER refuse_mark BEFORE UPDATE OF create_accepted_at ON demo_tenants
       BEGIN SELECT RAISE(ABORT, 'refused'); END`
    );
    await expect(registry.markCreateAccepted(testDb.db, id, 100)).rejects.toThrow();
    expect(created()).toBe(0);
  });

  it('records the acceptance without the table, and the migration then counts it', async () => {
    testDb.sqlite.exec('DROP TABLE demo_counters');
    const ticket = cookieOf(await start(env, upstream)) as string;
    const body = await (
      await handleRequest(statusRequest(ticket), env, upstream.deps)
    ).json<{ state: string }>();
    expect(body.state).not.toBe('failed');
    expect(allRows(testDb)[0].create_accepted_at).not.toBeNull();
    expect(logs.some((line) => line.includes('counter_table_missing'))).toBe(true);
    testDb.sqlite.exec(
      readFileSync(
        fileURLToPath(new URL('../../migrations/0004_counters.sql', import.meta.url)),
        'utf8'
      )
    );
    expect(created()).toBe(1);
  });

  it('counts the row when the migration lands between the failed batch and the plain mark', async () => {
    await start(env, upstream);
    const id = allRows(testDb)[0].id as string;
    testDb.sqlite.exec('DROP TABLE demo_counters');
    const migration = readFileSync(
      fileURLToPath(new URL('../../migrations/0004_counters.sql', import.meta.url)),
      'utf8'
    );
    testDb.beforeStatement.current = async (sql) => {
      if (sql.includes('sqlite_master')) testDb.sqlite.exec(migration);
    };
    expect(await registry.markCreateAccepted(testDb.db, id, 100)).toBe(true);
    expect(allRows(testDb)[0].create_accepted_at).toBe(100);
    expect(created()).toBe(1);
  });

  it('does not hide any other database error', async () => {
    await start(env, upstream);
    const id = allRows(testDb)[0].id as string;
    const broken = {
      prepare: testDb.db.prepare.bind(testDb.db),
      batch: () => Promise.reject(new Error('D1_ERROR: database is locked')),
    };
    await expect(registry.markCreateAccepted(broken, id, 100)).rejects.toThrow('locked');
    expect(allRows(testDb)[0].create_accepted_at).toBeNull();
  });

  it('survives the purge of deleted rows', async () => {
    const ticket = cookieOf(await start(env, upstream)) as string;
    await handleRequest(statusRequest(ticket), env, upstream.deps);
    testDb.sqlite.prepare(`UPDATE demo_tenants SET state = 'deleted', updated_at = 0`).run();
    expect(await registry.purgeDeleted(testDb.db, 30 * 24 * 3600)).toBe(1);
    expect(allRows(testDb)).toHaveLength(0);
    expect(created()).toBe(1);
  });

  it('starts from the accepted rows the registry still holds', () => {
    const sqlite = createTestDb().sqlite;
    sqlite.exec('DROP TABLE demo_counters');
    const insert = sqlite.prepare(
      `INSERT INTO demo_tenants (id, ticket_hash, ip_hash, state, created_at, expires_at, updated_at, create_accepted_at)
       VALUES (?, ?, 'ip', ?, 1, 2, 1, ?)`
    );
    insert.run('a', 'ha', 'handed_off', 1);
    insert.run('b', 'hb', 'deleted', 1);
    insert.run('c', 'hc', 'provisioning', null);
    const migration = readFileSync(
      fileURLToPath(new URL('../../migrations/0004_counters.sql', import.meta.url)),
      'utf8'
    );
    sqlite.exec(migration);
    sqlite.exec(migration); // applying it again changes nothing
    expect(
      sqlite.prepare(`SELECT value FROM demo_counters WHERE name = 'tenants_created'`).get()
    ).toEqual({ value: 2 });
  });
});

describe('the numbers on the start page', () => {
  it('shows the count of the capacity decision and the total', async () => {
    const ticket = cookieOf(await start(env, upstream)) as string;
    await handleRequest(statusRequest(ticket), env, upstream.deps);
    await start(env, upstream, { ip: '198.51.100.9' }); // queued only: takes a place, not created yet
    testDb.sqlite
      .prepare(
        `INSERT INTO demo_tenants (id, ticket_hash, ip_hash, state, created_at, expires_at, updated_at)
         VALUES ('gone', 'hg', 'ip', 'deleted', 1, 2, 1)`
      )
      .run();
    const html = await page();
    expect(html).toContain('<dt>Demo slots in use</dt><dd>2<span> / 50</span></dd>');
    expect(html).toContain('<dt>Tenants created so far</dt><dd>1</dd>');
  });

  it('reads the database once per interval, however often the page is asked for', async () => {
    for (let i = 0; i < 5; i += 1) await page();
    expect(reads()).toBe(1);
    upstream.clock.now += TALLY_TTL_MS - 1;
    await page();
    expect(reads()).toBe(1);
    upstream.clock.now += 1;
    await page();
    expect(reads()).toBe(2);
  });

  it('serves the page without numbers when they cannot be read, and asks again later', async () => {
    testDb.sqlite.exec('DROP TABLE demo_counters');
    const response = await handleRequest(new Request(`${PORTAL}/?lang=en`), env, upstream.deps);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain('class="tally"');
    expect(html).toContain('id="start-form"');
    expect(logs.some((line) => line.includes('tally_read_failed'))).toBe(true);
    await page();
    expect(reads()).toBe(1);
    upstream.clock.now += TALLY_RETRY_MS;
    await page();
    expect(reads()).toBe(2);
  });

  it('keeps the last numbers when a later read fails', async () => {
    expect(await readTally(env, upstream.deps)).toEqual({ active: 0, created: 0 });
    testDb.sqlite.exec('DROP TABLE demo_counters');
    upstream.clock.now += TALLY_TTL_MS;
    expect(await readTally(env, upstream.deps)).toEqual({ active: 0, created: 0 });
  });

  /** Holds every read of the numbers until released; `entered` resolves when one waits there. */
  function holdReads(): { release: () => void; entered: Promise<void> } {
    let release: () => void = () => undefined;
    let enter: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    testDb.beforeStatement.current = async (sql) => {
      if (!sql.includes('AS active')) return;
      enter();
      await gate;
    };
    return {
      entered,
      release: () => {
        testDb.beforeStatement.current = null;
        release();
      },
    };
  }
  const addRow = (id: string) =>
    testDb.sqlite
      .prepare(
        `INSERT INTO demo_tenants (id, ticket_hash, ip_hash, state, created_at, expires_at, updated_at)
         VALUES (?, ?, 'ip', 'handed_off', 1, 2, 1)`
      )
      .run(id, `h-${id}`);

  it('does not let a second request read while the first is still reading', async () => {
    const { release } = holdReads();
    const first = readTally(env, upstream.deps);
    upstream.clock.now += TALLY_ABANDON_MS - 1; // long past the retry interval, still one reader
    expect(await readTally(env, upstream.deps)).toBeNull();
    release();
    expect(await first).toEqual({ active: 0, created: 0 });
    expect(reads()).toBe(1);
  });

  it('does not hold the page for a slow read; the result serves the next request', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { release } = holdReads();
      let answered = false;
      const first = readTally(env, upstream.deps).then((value) => {
        answered = true;
        return value;
      });
      await vi.advanceTimersByTimeAsync(TALLY_WAIT_MS - 1);
      expect(answered).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await first).toBeNull();
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(await readTally(env, upstream.deps)).toEqual({ active: 0, created: 0 });
      expect(reads()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts the interval from the end of a read', async () => {
    const { release } = holdReads();
    const first = readTally(env, upstream.deps);
    upstream.clock.now += 20_000;
    release();
    await first;
    upstream.clock.now += TALLY_TTL_MS - 1;
    await readTally(env, upstream.deps);
    expect(reads()).toBe(1);
  });

  it('lets a later read replace one that never ends, and ignores the late answer', async () => {
    const { release, entered } = holdReads();
    let stuckEnded = false;
    const stuck = readTally(env, upstream.deps).then(() => {
      stuckEnded = true;
    });
    await entered;
    upstream.clock.now += TALLY_ABANDON_MS;
    testDb.beforeStatement.current = null;
    expect(await readTally(env, upstream.deps)).toEqual({ active: 0, created: 0 });
    expect(stuckEnded).toBe(false);
    addRow('later');
    release();
    await stuck; // it read the newer state, but it is no longer the newest read
    expect(await readTally(env, upstream.deps)).toEqual({ active: 0, created: 0 });
    expect(reads()).toBe(2);
    upstream.clock.now += TALLY_TTL_MS;
    expect(await readTally(env, upstream.deps)).toEqual({ active: 1, created: 0 });
  });

  it('hands a read that outlives the page to the platform', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { release } = holdReads();
      const kept: Promise<unknown>[] = [];
      const response = handleRequest(new Request(`${PORTAL}/?lang=en`), env, upstream.deps, {
        waitUntil: (work) => void kept.push(work),
      });
      await vi.advanceTimersByTimeAsync(TALLY_WAIT_MS);
      expect(await (await response).text()).not.toContain('class="tally"');
      expect(kept).toHaveLength(1);
      release();
      await expect(kept[0]).resolves.toEqual({ active: 0, created: 0 });
      expect(await page()).toContain('class="tally"');
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes large numbers in each language with Western digits', async () => {
    const config = configOf(env);
    const tally = { active: 12, created: 1234567 };
    expect(startPage('en', config, tally)).toContain('<dd>1,234,567</dd>');
    expect(startPage('ja', config, tally)).toContain('<dd>1,234,567</dd>');
    expect(startPage('de', config, tally)).toContain('<dd>1.234.567</dd>');
    expect(startPage('ar', config, tally)).toContain('<dd>1,234,567</dd>');
    for (const lang of LANGS) {
      expect(startPage(lang, config, tally)).toContain('<dd>12<span> / 50</span></dd>');
      expect(startPage(lang, config)).not.toContain('class="tally"');
    }
  });
});
