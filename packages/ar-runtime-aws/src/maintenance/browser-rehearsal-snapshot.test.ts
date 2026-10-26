import { describe, expect, it, vi } from 'vitest';
import { readBrowserRehearsalSnapshot } from './browser-rehearsal-snapshot';
import type { MaintenanceSqlClient } from './database';

function targets() {
  return Object.fromEntries(
    ['core', 'state'].map((family) => {
      const name = `authrim_dr_browser_${family}`;
      return [
        family,
        {
          name,
          user: name,
          password: 'private-test-password',
          connectionString: `postgresql://${name}:private-test-password@fixture.rds.amazonaws.com:5432/${name}?sslmode=verify-full`,
        },
      ];
    })
  ) as Parameters<typeof readBrowserRehearsalSnapshot>[0];
}

function world() {
  const settings = {
    tls: true,
    duplicate: false,
    missing: false,
    coreCounter: '1',
    stateCounter: '1',
    sessions: '1',
    audits: '1',
    outstanding: '0',
    consumed: '1',
    wrongIdentity: false,
    fail: false,
  };
  const clients: MaintenanceSqlClient[] = [];
  const sql: string[] = [];
  const factory = vi.fn((url: string): MaintenanceSqlClient => {
    const name = new URL(url).pathname.slice(1);
    const client = {
      connect: vi.fn(async () => undefined),
      end: vi.fn(async () => undefined),
      query: vi.fn(async (query: string, values?: unknown[]) => {
        sql.push(query);
        let rows: object[] = [];
        if (query.includes('pg_stat_ssl')) rows = [{ ssl: settings.tls }];
        else if (query.includes('current_database'))
          rows = [{ database: settings.wrongIdentity ? 'production' : name, username: name }];
        else if (query.includes('FROM passkeys')) {
          expect(values).toEqual(['tenant-a', 'user-tenant-a']);
          if (settings.fail) throw new Error('private-test-password secret-row');
          rows = settings.missing ? [] : [{ id: 'passkey-a', counter: settings.coreCounter }];
          if (settings.duplicate) rows.push({ id: 'passkey-b', counter: settings.coreCounter });
        } else if (query.includes('FROM flow_audit_events')) rows = [{ count: settings.audits }];
        else if (query.includes('FROM authrim_aws_passkey_counters')) {
          expect(values).toEqual(['tenant-a', 'user-tenant-a', 'passkey-a']);
          rows = [{ counter: settings.stateCounter }];
        } else if (query.includes("kind='session'")) rows = [{ count: settings.sessions }];
        else if (query.includes("kind='challenge'")) {
          expect(query).toContain("payload->>'type'='synthetic-browser-sp'");
          expect(query).toContain("starts_with(id, 'browser-sp:_browser_')");
          expect(query).toContain('expires_at_ms >');
          rows = [{ outstanding: settings.outstanding, consumed: settings.consumed }];
        }
        return { rows, rowCount: rows.length };
      }) as MaintenanceSqlClient['query'],
    };
    clients.push(client);
    return client;
  });
  return { settings, factory, clients, sql };
}

describe('read-only browser rehearsal evidence', () => {
  it('returns only bounded counters/counts and maps the authority by the Core passkey row ID', async () => {
    const fake = world();
    const report = await readBrowserRehearsalSnapshot(targets(), fake.factory);
    expect(report).toEqual({
      corePasskeyCounter: 1,
      statePasskeyCounter: 1,
      managedSessionCount: 1,
      completedFlowAuditCount: 1,
      outstandingBrowserSpRequestCount: 0,
      consumedBrowserSpRequestCount: 1,
    });
    expect(JSON.stringify(report)).not.toMatch(
      /passkey-a|tenant-a|password|credential|connectionString/u
    );
    expect(fake.sql.filter((query) => query.startsWith('BEGIN'))).toEqual([
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
    ]);
    expect(fake.sql.every((query) => !/INSERT|UPDATE|DELETE|DROP|TRUNCATE/u.test(query))).toBe(
      true
    );
    for (const client of fake.clients) expect(client.end).toHaveBeenCalledOnce();
  });

  it.each(['name', 'user', 'path', 'tls', 'host'] as const)(
    'rejects changed %s before DB access',
    async (kind) => {
      const value = targets();
      if (kind === 'name') value.core.name = 'authrim_dr_rehearsal_core';
      if (kind === 'user') value.state.user = 'postgres';
      if (kind === 'path')
        value.core.connectionString = value.core.connectionString.replace(
          '/authrim_dr_browser_core?',
          '/production?'
        );
      if (kind === 'tls')
        value.state.connectionString = value.state.connectionString.replace(
          'verify-full',
          'require'
        );
      if (kind === 'host')
        value.state.connectionString = value.state.connectionString.replace(
          'fixture.rds',
          'other.rds'
        );
      const fake = world();
      await expect(readBrowserRehearsalSnapshot(value, fake.factory)).rejects.toThrow(
        'aws_browser_rehearsal_snapshot_failed'
      );
      expect(fake.factory).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['TLS rejected', { tls: false }],
    ['wrong database identity', { wrongIdentity: true }],
    ['missing passkey', { missing: true }],
    ['ambiguous passkey', { duplicate: true }],
    ['counter mismatch', { stateCounter: '2' }],
    ['negative counter', { coreCounter: '-1' }],
    ['counter overflow', { coreCounter: '4294967296' }],
    ['noninteger count', { sessions: '1.5' }],
    ['driver error with sensitive data', { fail: true }],
  ])('fails closed for %s and closes connections', async (_label, change) => {
    const fake = world();
    Object.assign(fake.settings, change);
    await expect(readBrowserRehearsalSnapshot(targets(), fake.factory)).rejects.toThrow(
      /^aws_browser_rehearsal_snapshot_failed$/u
    );
    for (const client of fake.clients) expect(client.end).toHaveBeenCalledOnce();
  });
});
