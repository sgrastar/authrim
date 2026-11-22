import { describe, expect, it, vi } from 'vitest';
import { readBrowserRehearsalSnapshot } from './browser-rehearsal-snapshot';
import type { MaintenanceSqlClient } from './database';

type Targets = Parameters<typeof readBrowserRehearsalSnapshot>[0];
const HOST = 'fixture.rds.amazonaws.com';
function targets(host = HOST): Targets {
  return Object.fromEntries(
    ['core', 'state'].map((family) => {
      const name = `authrim_dr_browser_${family}`;
      return [
        family,
        {
          name,
          user: name,
          password: 'private-test-password',
          connectionString: `postgresql://${name}:private-test-password@${host}:5432/${name}?sslmode=verify-full`,
        },
      ];
    })
  ) as Targets;
}

type Rows = Record<string, object[]>;
function world(overrides: Rows = {}) {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const factory = vi.fn((url: string): MaintenanceSqlClient => {
    const name = new URL(url).pathname.slice(1);
    return {
      connect: async () => undefined,
      end: async () => undefined,
      query: (async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        const defaults: Rows = {
          pg_stat_ssl: [{ ssl: true }],
          current_database: [{ database: name, username: name }],
          'FROM passkeys': [{ id: 'passkey-a', counter: '1' }],
          flow_audit_events: [{ count: '1' }],
          authrim_aws_passkey_counters: [{ counter: '1' }],
          "kind='session'": [{ count: '1' }],
          "kind='challenge'": [{ outstanding: '0', consumed: '1' }],
        };
        const key = Object.keys(defaults).find((candidate) => sql.includes(candidate));
        const rows = key ? (overrides[key] ?? defaults[key]) : [];
        return { rows, rowCount: rows.length };
      }) as MaintenanceSqlClient['query'],
    };
  });
  return { factory, calls };
}
const failed = /^aws_browser_rehearsal_snapshot_failed$/u;
const read = (overrides: Rows, value = targets()) =>
  readBrowserRehearsalSnapshot(value, world(overrides).factory);

describe('browser rehearsal snapshot count parsing', () => {
  it('accepts multi-digit counts and the exact maximum counter', async () => {
    const report = await read({
      'FROM passkeys': [{ id: 'passkey-a', counter: '4294967295' }],
      authrim_aws_passkey_counters: [{ counter: '4294967295' }],
      flow_audit_events: [{ count: '12' }],
      "kind='session'": [{ count: '340' }],
      "kind='challenge'": [{ outstanding: '50', consumed: '600' }],
    });
    expect(report).toEqual({
      corePasskeyCounter: 4294967295,
      statePasskeyCounter: 4294967295,
      managedSessionCount: 340,
      completedFlowAuditCount: 12,
      outstandingBrowserSpRequestCount: 50,
      consumedBrowserSpRequestCount: 600,
    });
  });
  it('accepts zero counts', async () => {
    const report = await read({
      'FROM passkeys': [{ id: 'passkey-a', counter: '0' }],
      authrim_aws_passkey_counters: [{ counter: '0' }],
      flow_audit_events: [{ count: '0' }],
    });
    expect(report.corePasskeyCounter).toBe(0);
    expect(report.completedFlowAuditCount).toBe(0);
  });
  it.each(['-1', '01', '1 ', ' 1', '1e0', '1x', '', 'x1'])(
    'rejects the malformed counter %j even when both sides agree',
    async (counter) => {
      await expect(
        read({
          'FROM passkeys': [{ id: 'passkey-a', counter }],
          authrim_aws_passkey_counters: [{ counter }],
        })
      ).rejects.toThrow(failed);
    }
  );
  it('rejects a counter above the 32-bit maximum when both sides agree', async () => {
    await expect(
      read({
        'FROM passkeys': [{ id: 'passkey-a', counter: '4294967296' }],
        authrim_aws_passkey_counters: [{ counter: '4294967296' }],
      })
    ).rejects.toThrow(failed);
  });
  it('rejects a numeric (non-string) count', async () => {
    await expect(read({ flow_audit_events: [{ count: 1 }] })).rejects.toThrow(failed);
  });
  it('rejects unsafe or malformed unbounded counts', async () => {
    for (const bad of ['9007199254740993', '1 ', '01', '-3']) {
      await expect(read({ flow_audit_events: [{ count: bad }] })).rejects.toThrow(failed);
      await expect(read({ "kind='session'": [{ count: bad }] })).rejects.toThrow(failed);
      await expect(
        read({ "kind='challenge'": [{ outstanding: bad, consumed: '1' }] })
      ).rejects.toThrow(failed);
      await expect(
        read({ "kind='challenge'": [{ outstanding: '0', consumed: bad }] })
      ).rejects.toThrow(failed);
    }
  });
});

describe('browser rehearsal snapshot target validation', () => {
  const mutate = (family: 'core' | 'state', from: string, to: string) => {
    const value = targets();
    value[family].connectionString = value[family].connectionString.replace(from, to);
    return value;
  };
  it('rejects non-postgresql protocols', async () => {
    const fake = world();
    await expect(
      readBrowserRehearsalSnapshot(mutate('core', 'postgresql:', 'postgres:'), fake.factory)
    ).rejects.toThrow(failed);
    expect(fake.factory).not.toHaveBeenCalled();
  });
  it('rejects a username that differs from the database name', async () => {
    const value = mutate('state', '//authrim_dr_browser_state:', '//other:');
    await expect(readBrowserRehearsalSnapshot(value, world().factory)).rejects.toThrow(failed);
  });
  it('rejects an empty password', async () => {
    const value = mutate('core', ':private-test-password', '');
    await expect(readBrowserRehearsalSnapshot(value, world().factory)).rejects.toThrow(failed);
  });
  it('rejects other ports, including a missing explicit port', async () => {
    await expect(
      readBrowserRehearsalSnapshot(mutate('core', ':5432/', ':5433/'), world().factory)
    ).rejects.toThrow(failed);
    await expect(
      readBrowserRehearsalSnapshot(mutate('state', ':5432/', '/'), world().factory)
    ).rejects.toThrow(failed);
  });
  it.each(['a_b.rds.amazonaws.com', 'x.rds.amazonaws.com.evil.com', 'x.rds.amazonaws.org'])(
    'rejects the host %s',
    async (host) => {
      const value = targets();
      value.core.connectionString = targets(host).core.connectionString;
      value.state.connectionString = targets(host).state.connectionString;
      await expect(readBrowserRehearsalSnapshot(value, world().factory)).rejects.toThrow(failed);
    }
  );
  it('rejects extra query parameters and fragments', async () => {
    await expect(
      readBrowserRehearsalSnapshot(
        mutate('core', 'sslmode=verify-full', 'sslmode=verify-full&application_name=x'),
        world().factory
      )
    ).rejects.toThrow(failed);
    await expect(
      readBrowserRehearsalSnapshot(
        mutate('state', 'verify-full', 'verify-full#frag'),
        world().factory
      )
    ).rejects.toThrow(failed);
  });
});

describe('browser rehearsal snapshot queries', () => {
  it('binds the fixed tenant and user to every observation and commits each transaction', async () => {
    const fake = world();
    await readBrowserRehearsalSnapshot(targets(), fake.factory);
    const bound = (needle: string) => fake.calls.find((call) => call.sql.includes(needle));
    expect(bound('FROM passkeys')?.values).toEqual(['tenant-a', 'user-tenant-a']);
    expect(bound('flow_audit_events')?.values).toEqual(['tenant-a', 'user-tenant-a']);
    expect(bound('authrim_aws_passkey_counters')?.values).toEqual([
      'tenant-a',
      'user-tenant-a',
      'passkey-a',
    ]);
    expect(bound("kind='session'")?.values).toEqual(['tenant-a', 'user-tenant-a']);
    expect(bound("kind='challenge'")?.values).toEqual(['tenant-a', 'user-tenant-a']);
    expect(fake.calls.filter((call) => call.sql === 'COMMIT')).toHaveLength(2);
    expect(bound('current_database')?.sql).toBe(
      'SELECT current_database() AS database, current_user AS username'
    );
  });
  it('rejects an identity query returning more than one row', async () => {
    const name = 'authrim_dr_browser_core';
    await expect(
      read({
        current_database: [
          { database: name, username: name },
          { database: name, username: name },
        ],
      })
    ).rejects.toThrow(failed);
  });
  it('rejects a connection whose current user is not the target user', async () => {
    await expect(
      read({
        current_database: [{ database: 'authrim_dr_browser_core', username: 'postgres' }],
      })
    ).rejects.toThrow(failed);
  });
  it.each(['a b', 'a/b', 'a'.repeat(201), ''])('rejects the passkey row id %j', async (id) => {
    await expect(read({ 'FROM passkeys': [{ id, counter: '1' }] })).rejects.toThrow(failed);
  });
  it('accepts a 200 character row id of the allowed alphabet', async () => {
    const id = `${'a.:_-'.repeat(40)}`;
    expect(id).toHaveLength(200);
    const report = await read({ 'FROM passkeys': [{ id, counter: '1' }] });
    expect(report.corePasskeyCounter).toBe(1);
  });
  it('rejects ambiguous audit, state counter, session and request results', async () => {
    await expect(read({ flow_audit_events: [{ count: '1' }, { count: '1' }] })).rejects.toThrow(
      failed
    );
    await expect(
      read({ authrim_aws_passkey_counters: [{ counter: '1' }, { counter: '1' }] })
    ).rejects.toThrow(failed);
    await expect(read({ "kind='session'": [{ count: '1' }, { count: '1' }] })).rejects.toThrow(
      failed
    );
    await expect(
      read({
        "kind='challenge'": [
          { outstanding: '0', consumed: '1' },
          { outstanding: '0', consumed: '1' },
        ],
      })
    ).rejects.toThrow(failed);
  });
  it('rejects empty session and request results', async () => {
    await expect(read({ "kind='session'": [] })).rejects.toThrow(failed);
    await expect(read({ "kind='challenge'": [] })).rejects.toThrow(failed);
  });
});
