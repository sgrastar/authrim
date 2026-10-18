import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createLookupBlindIndex, type LookupBlindIndex } from '@authrim/ar-lib-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The statements of docs/operations/lookup-directory-known-limits.md, taken from the document
 * itself and run on the real Lookup baseline: the diagnostics must not call a healthy account an
 * orphan, and a repair must change nothing once the row it was diagnosed on has moved.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const DOCUMENT = readFileSync(
  resolve(REPO_ROOT, 'docs/operations/lookup-directory-known-limits.md'),
  'utf8'
);
const KEYS = [
  { generation: 1, secret: 'lookup-key-a-0123456789abcdef0123456789abcdef' },
  { generation: 2, secret: 'lookup-key-b-0123456789abcdef0123456789abcdef' },
];
const NOW = Math.floor(Date.now() / 1000);

function runbook(name: string): string {
  // The fence may be indented (inside a numbered step); the statement is un-indented.
  const match = new RegExp(
    '^( *)```sql\\n\\1(-- runbook: ' + name + '\\n[\\s\\S]*?)\\n\\1```',
    'm'
  ).exec(DOCUMENT);
  if (!match) throw new Error(`runbook statement missing: ${name}`);
  return match[2].replace(new RegExp('^' + match[1], 'gm'), '');
}

type Params = Record<string, string | number>;

describe('lookup directory runbook SQL', () => {
  let lookup: DatabaseSync;

  beforeEach(() => {
    lookup = new DatabaseSync(':memory:');
    lookup.exec(
      readFileSync(resolve(REPO_ROOT, 'migrations/lookup/d1/001_0_4_0_lookup_baseline.sql'), 'utf8')
        .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '(unixepoch() * 1000)')
        .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', 'unixepoch()')
    );
  });

  afterEach(() => lookup.close());

  function bound(sql: string, params: Params): Params {
    const names = new Set([...sql.matchAll(/:([a-z_]+)/g)].map((match) => match[1]));
    return Object.fromEntries(Object.entries(params).filter(([key]) => names.has(key)));
  }
  const all = (sql: string, params: Params = {}) =>
    lookup.prepare(sql).all(bound(sql, params)) as Array<Record<string, unknown>>;
  const run = (sql: string, params: Params = {}) =>
    Number(lookup.prepare(sql).run(bound(sql, params)).changes);

  /** One identifier under both generations, with the rows a link leaves in the directory. */
  async function link(input: {
    kind: 'email_exact' | 'external_subject';
    value: string | { issuer: string; subject: string };
    account: string;
    state?: string;
    operation?: string;
    updatedAt?: number;
    route?: 'active' | 'disabled';
  }): Promise<LookupBlindIndex[]> {
    const indexes: LookupBlindIndex[] = [];
    for (const key of KEYS) {
      const index = await createLookupBlindIndex(input.kind, input.value, key);
      indexes.push(index);
      lookup
        .prepare(
          `INSERT INTO lookup_identifier_reservations (
             virtual_bucket, tenant_id, index_kind, normalization_version,
             hmac_key_generation, identifier_blind_digest, account_id, reservation_state,
             operation_id, committed_at, released_at, created_at, updated_at
           ) VALUES (?, 'tenant-a', ?, 1, ?, ?, ?, ?, ?, 100, ?, 100, ?)`
        )
        .run(
          index.virtualBucket,
          input.kind,
          key.generation,
          index.digest,
          input.account,
          input.state ?? 'committed',
          input.operation ?? 'add-1',
          input.state === 'released' ? 100 : null,
          input.updatedAt ?? 100
        );
      lookup
        .prepare(
          `INSERT INTO lookup_identifiers (
             virtual_bucket, index_kind, normalization_version, hmac_key_generation,
             identifier_blind_digest, tenant_id, account_id, route_schema_version,
             account_route_generation, required_binding_route_generation, residency_policy_id,
             route_projection_json, tenant_lifecycle_state, runtime_route_status,
             lifecycle_state, created_at, updated_at
           ) VALUES (?, ?, 1, ?, ?, 'tenant-a', ?, 1, 1, 1, 'default-policy', '{}',
                     'active', ?, ?, 100, 100)`
        )
        .run(
          index.virtualBucket,
          input.kind,
          key.generation,
          index.digest,
          input.account,
          input.route === 'disabled' ? 'disabled' : 'active',
          input.route ?? 'active'
        );
    }
    return indexes;
  }

  const DID = {
    issuer: 'did',
    subject: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
  };
  const PASSKEY = { issuer: 'urn:authrim:passkey:login.example.com', subject: 'credential-a' };

  function withDigests(sql: string, indexes: LookupBlindIndex[]): string {
    const list = indexes.map((index) => `'${index.digest}'`).join(', ');
    return sql.replace("'<digest 1>', '<digest 2>'", list);
  }

  describe('stuck-rows', () => {
    it('returns only the releasing / repair_required rows that stood for two hours', async () => {
      await link({
        kind: 'external_subject',
        value: DID,
        account: 'account:a',
        state: 'releasing',
        updatedAt: NOW - 8000,
      });
      await link({
        kind: 'external_subject',
        value: PASSKEY,
        account: 'account:a',
        state: 'releasing',
        updatedAt: NOW - 100,
      });
      await link({
        kind: 'email_exact',
        value: 'a@example.test',
        account: 'account:a',
        state: 'repair_required',
        updatedAt: NOW - 9000,
      });
      await link({
        kind: 'email_exact',
        value: 'b@example.test',
        account: 'account:b',
        updatedAt: 1,
      });
      await link({
        kind: 'email_exact',
        value: 'c@example.test',
        account: 'account:c',
        state: 'released',
        updatedAt: 1,
      });
      const rows = all(runbook('stuck-rows'));
      expect(rows).toHaveLength(4);
      expect(new Set(rows.map((row) => `${row.index_kind}:${row.reservation_state}`))).toEqual(
        new Set(['external_subject:releasing', 'email_exact:repair_required'])
      );
    });
  });

  describe('committed-without-link', () => {
    it('does not flag an account whose identifiers the authority explains', async () => {
      const did = await link({ kind: 'external_subject', value: DID, account: 'account:a' });
      const passkey = await link({
        kind: 'external_subject',
        value: PASSKEY,
        account: 'account:a',
      });
      const email = await link({
        kind: 'email_exact',
        value: 'a@example.test',
        account: 'account:a',
      });
      const sql = withDigests(runbook('committed-without-link'), [...did, ...passkey, ...email]);
      expect(all(sql, { tenant: 'tenant-a', account: 'account:a' })).toEqual([]);
    });

    it('does not flag an account that has a passkey and no external link at all', async () => {
      const passkey = await link({
        kind: 'external_subject',
        value: PASSKEY,
        account: 'account:a',
      });
      const sql = withDigests(runbook('committed-without-link'), passkey);
      expect(all(sql, { tenant: 'tenant-a', account: 'account:a' })).toEqual([]);
    });

    it('flags the rows (every generation) of an identifier the authority no longer has', async () => {
      const did = await link({ kind: 'external_subject', value: DID, account: 'account:a' });
      const passkey = await link({
        kind: 'external_subject',
        value: PASSKEY,
        account: 'account:a',
      });
      await link({ kind: 'external_subject', value: PASSKEY, account: 'account:b' }).catch(
        () => {}
      );
      const sql = withDigests(runbook('committed-without-link'), passkey);
      const rows = all(sql, { tenant: 'tenant-a', account: 'account:a' });
      expect(rows.map((row) => row.identifier_blind_digest).sort()).toEqual(
        did.map((index) => index.digest).sort()
      );
    });

    it('ignores rows of other accounts and rows that are not committed', async () => {
      const did = await link({
        kind: 'external_subject',
        value: DID,
        account: 'account:a',
        state: 'released',
      });
      await link({ kind: 'email_exact', value: 'z@example.test', account: 'account:z' });
      const sql = withDigests(runbook('committed-without-link'), did.slice(0, 1));
      expect(all(sql, { tenant: 'tenant-a', account: 'account:a' })).toEqual([]);
    });
  });

  describe('repair', () => {
    async function stuck() {
      const [first] = await link({
        kind: 'external_subject',
        value: DID,
        account: 'account:a',
        state: 'releasing',
        operation: 'hmac-reindex:op-1',
        updatedAt: NOW - 8000,
      });
      const row = all(runbook('stuck-rows'))[0];
      const params: Params = {
        bucket: Number(row.virtual_bucket),
        tenant: String(row.tenant_id),
        kind: String(row.index_kind),
        norm: Number(row.normalization_version),
        generation: Number(row.hmac_key_generation),
        digest: String(row.identifier_blind_digest),
        account: String(row.account_id),
        observed_state: String(row.reservation_state),
        observed_operation: String(row.operation_id),
        observed_created_at: Number(row.created_at),
        observed_updated_at: Number(row.updated_at),
      };
      return { first, params };
    }
    const route = (params: Params) =>
      all(
        `SELECT lifecycle_state, runtime_route_status FROM lookup_identifiers
          WHERE virtual_bucket = :bucket AND hmac_key_generation = :generation
            AND identifier_blind_digest = :digest AND account_id = :account`,
        params
      )[0];
    const reservation = (params: Params) =>
      all(runbook('verify'), params)[0] as {
        reservation_state: string;
        released_at: number | null;
      };

    it('releases the reservation and disables the route of the diagnosed row, and nothing else', async () => {
      const { params } = await stuck();
      const others = all(
        `SELECT * FROM lookup_identifier_reservations WHERE hmac_key_generation <> :generation`,
        params
      );
      expect(run(runbook('repair-reservation'), params)).toBe(1);
      expect(run(runbook('repair-route'), params)).toBe(1);
      expect(reservation(params)).toMatchObject({ reservation_state: 'released' });
      expect(reservation(params).released_at).toBeGreaterThan(0);
      expect(route(params)).toEqual({
        lifecycle_state: 'disabled',
        runtime_route_status: 'disabled',
      });
      expect(
        all(
          `SELECT * FROM lookup_identifier_reservations WHERE hmac_key_generation <> :generation`,
          params
        )
      ).toEqual(others);
      // The other key generation of the identifier is still listed: each one is repaired in turn.
      expect(all(runbook('stuck-rows'))).toHaveLength(1);
    });

    it.each([
      ['the operation changed', `UPDATE lookup_identifier_reservations SET operation_id = 'add-2'`],
      [
        'the row was re-added and committed by the same account',
        `UPDATE lookup_identifier_reservations
            SET operation_id = 'add-2', reservation_state = 'committed', created_at = created_at + 5,
                updated_at = updated_at + 5`,
      ],
      [
        'only its updated_at moved',
        `UPDATE lookup_identifier_reservations SET updated_at = updated_at + 1`,
      ],
      [
        'only its created_at moved',
        `UPDATE lookup_identifier_reservations SET created_at = created_at + 1`,
      ],
      [
        'the row is held by another account',
        `UPDATE lookup_identifier_reservations SET account_id = 'account:b', reservation_state = 'reserved'`,
      ],
    ])('changes nothing when %s after the diagnosis', async (_name, change) => {
      const { params } = await stuck();
      lookup
        .prepare(`${change} WHERE hmac_key_generation = ? AND identifier_blind_digest = ?`)
        .run(params.generation, params.digest);
      const before = all(`SELECT * FROM lookup_identifier_reservations`);
      expect(run(runbook('repair-reservation'), params)).toBe(0);
      expect(all(`SELECT * FROM lookup_identifier_reservations`)).toEqual(before);
    });

    it('leaves the route alone when the same account links the identifier again between the two statements', async () => {
      const { params } = await stuck();
      expect(run(runbook('repair-reservation'), params)).toBe(1);
      lookup
        .prepare(
          `UPDATE lookup_identifier_reservations
              SET reservation_state = 'reserved', operation_id = 'add-new',
                  released_at = NULL, lease_expires_at = ?
            WHERE hmac_key_generation = ? AND identifier_blind_digest = ?`
        )
        .run(NOW + 7200, params.generation, params.digest);
      expect(run(runbook('repair-route'), params)).toBe(0);
      expect(route(params)).toEqual({ lifecycle_state: 'active', runtime_route_status: 'active' });
    });

    it('disables the orphan route when another account took the freed identifier, so two accounts never answer for it', async () => {
      const { params } = await stuck();
      expect(run(runbook('repair-reservation'), params)).toBe(1);
      // Account b links the identifier (takes the released row) and publishes its own route.
      lookup
        .prepare(
          `UPDATE lookup_identifier_reservations
              SET account_id = 'account:b', reservation_state = 'committed',
                  operation_id = 'add-b', released_at = NULL, lease_expires_at = NULL
            WHERE hmac_key_generation = ? AND identifier_blind_digest = ?`
        )
        .run(params.generation, params.digest);
      lookup
        .prepare(
          `INSERT INTO lookup_identifiers (
             virtual_bucket, index_kind, normalization_version, hmac_key_generation,
             identifier_blind_digest, tenant_id, account_id, route_schema_version,
             account_route_generation, required_binding_route_generation, residency_policy_id,
             route_projection_json, tenant_lifecycle_state, runtime_route_status,
             lifecycle_state, created_at, updated_at
           ) SELECT virtual_bucket, index_kind, normalization_version, hmac_key_generation,
                    identifier_blind_digest, tenant_id, 'account:b', route_schema_version,
                    account_route_generation, required_binding_route_generation,
                    residency_policy_id, route_projection_json, tenant_lifecycle_state,
                    runtime_route_status, 'active', 200, 200
               FROM lookup_identifiers
              WHERE hmac_key_generation = ? AND identifier_blind_digest = ?`
        )
        .run(params.generation, params.digest);
      expect(run(runbook('repair-route'), params)).toBe(1);
      expect(route(params)).toEqual({
        lifecycle_state: 'disabled',
        runtime_route_status: 'disabled',
      });
      const active = all(
        `SELECT account_id FROM lookup_identifiers
          WHERE hmac_key_generation = :generation AND identifier_blind_digest = :digest
            AND lifecycle_state = 'active'`,
        params
      );
      expect(active).toEqual([{ account_id: 'account:b' }]);
    });

    it('is repeatable: the second run of the route statement changes nothing', async () => {
      const { params } = await stuck();
      run(runbook('repair-reservation'), params);
      expect(run(runbook('repair-route'), params)).toBe(1);
      expect(run(runbook('repair-route'), params)).toBe(0);
      expect(run(runbook('repair-reservation'), params)).toBe(0);
    });
  });
});

describe('lookup directory runbook outbox check and row restore', () => {
  let core: DatabaseSync;
  let lookup: DatabaseSync;

  beforeEach(() => {
    const placeholders = (sql: string) =>
      sql
        .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '(unixepoch() * 1000)')
        .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', 'unixepoch()');
    core = new DatabaseSync(':memory:');
    core.exec(
      placeholders(
        readFileSync(resolve(REPO_ROOT, 'migrations/core/d1/001_0_4_0_core_baseline.sql'), 'utf8')
      )
    );
    lookup = new DatabaseSync(':memory:');
    lookup.exec(
      placeholders(
        readFileSync(
          resolve(REPO_ROOT, 'migrations/lookup/d1/001_0_4_0_lookup_baseline.sql'),
          'utf8'
        )
      )
    );
  });

  afterEach(() => {
    core.close();
    lookup.close();
  });

  function outbox(accountId: string, operation: string, status: string) {
    core
      .prepare(
        `INSERT OR IGNORE INTO identity_accounts (
           id, tenant_id, account_type, lifecycle_state, directory_publication_state,
           created_at, updated_at
         ) VALUES (?, 'tenant-a', 'person', 'active', 'active', 1, 1)`
      )
      .run(accountId);
    core
      .prepare(
        `INSERT INTO account_routing_outbox (
           outbox_id, tenant_id, account_id, event_kind, route_generation, route_schema_version,
           hmac_key_generation, payload_json, status, attempt_count, lease_owner,
           lease_expires_at, created_at, updated_at
         ) VALUES (?, 'tenant-a', ?, 'identifier_added', 1, 1, 1, '{}', ?, 0, ?, ?, 1, 1)`
      )
      .run(
        `account-routing:${operation}`,
        accountId,
        status,
        status === 'leased' ? 'owner' : null,
        status === 'leased' ? 100 : null
      );
  }

  const pending = (account: string) =>
    core.prepare(runbook('pending-outbox')).all({ tenant: 'tenant-a', account }) as Array<
      Record<string, unknown>
    >;

  it.each(['prepared', 'pending', 'leased', 'retry', 'blocked'])(
    'finds an unfinished add (%s) of the account, written as account:<user id>',
    (status) => {
      outbox('account:user-a', 'op-1', status);
      expect(pending('account:user-a')).toEqual([
        { outbox_id: 'account-routing:op-1', event_kind: 'identifier_added', status },
      ]);
    }
  );

  it('does not report finished work, other accounts, or the bare user id form', () => {
    outbox('account:user-a', 'op-done', 'succeeded');
    outbox('account:user-a', 'op-dead', 'dead_letter');
    outbox('account:user-b', 'op-b', 'pending');
    expect(pending('account:user-a')).toEqual([]);
    // The outbox stores the account form: the bare user id (the wrong placeholder) matches
    // nothing, which is why the document names the form for every statement.
    outbox('account:user-c', 'op-c', 'pending');
    expect(pending('user-c')).toEqual([]);
    expect(pending('account:user-c')).toHaveLength(1);
  });

  describe('restore-reservation-row', () => {
    const key = {
      bucket: 7,
      tenant: 'tenant-a',
      kind: 'external_subject',
      norm: 1,
      generation: 2,
      digest: 'd'.repeat(64),
    };
    const old = {
      old_account: 'account:a',
      old_state: 'committed',
      old_operation: 'add-1',
      old_lease_expires_at: null,
      old_committed_at: 100,
      old_released_at: null,
      old_created_at: 100,
      old_updated_at: 100,
    };
    const now = {
      now_account: 'account:a',
      now_state: 'released',
      now_operation: 'add-1',
      now_created_at: 100,
      now_updated_at: 500,
    };
    const row = () =>
      lookup.prepare(`SELECT * FROM lookup_identifier_reservations`).get() as Record<
        string,
        unknown
      >;

    beforeEach(() => {
      lookup
        .prepare(
          `INSERT INTO lookup_identifier_reservations (
             virtual_bucket, tenant_id, index_kind, normalization_version,
             hmac_key_generation, identifier_blind_digest, account_id, reservation_state,
             operation_id, committed_at, released_at, created_at, updated_at
           ) VALUES (7, 'tenant-a', 'external_subject', 1, 2, ?, 'account:a', 'released',
                     'add-1', 100, 500, 100, 500)`
        )
        .run(key.digest);
    });

    it('puts the recorded old values back when the row is still as just observed', () => {
      const result = lookup
        .prepare(runbook('restore-reservation-row'))
        .run({ ...key, ...old, ...now });
      expect(Number(result.changes)).toBe(1);
      expect(row()).toMatchObject({
        reservation_state: 'committed',
        released_at: null,
        committed_at: 100,
        updated_at: 100,
      });
    });

    it.each([
      ['its updated_at moved', { now_updated_at: 501 }],
      ['its operation changed', { now_operation: 'add-2' }],
      ['another account holds it', { now_account: 'account:b' }],
      ['it is no longer in the observed state', { now_state: 'committed' }],
    ])('changes nothing when %s', (_name, change) => {
      const before = row();
      const result = lookup
        .prepare(runbook('restore-reservation-row'))
        .run({ ...key, ...old, ...now, ...change });
      expect(Number(result.changes)).toBe(0);
      expect(row()).toEqual(before);
    });
  });
});

describe('lookup directory runbook reindex diagnostics', () => {
  let lookup: DatabaseSync;

  beforeEach(() => {
    lookup = new DatabaseSync(':memory:');
    lookup.exec(
      readFileSync(resolve(REPO_ROOT, 'migrations/lookup/d1/001_0_4_0_lookup_baseline.sql'), 'utf8')
        .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '(unixepoch() * 1000)')
        .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', 'unixepoch()')
    );
  });

  afterEach(() => lookup.close());

  it('shows the error code the failed reindex job left', () => {
    lookup
      .prepare(
        `UPDATE lookup_directory_job_cursors
            SET last_error_code = 'lookup_hmac_reindex_reservation_not_committed',
                last_started_at = 10, updated_at = 11
          WHERE job_class = 'hmac_reindex'`
      )
      .run();
    expect(lookup.prepare(runbook('reindex-job-error')).all()).toEqual([
      {
        job_class: 'hmac_reindex',
        last_error_code: 'lookup_hmac_reindex_reservation_not_committed',
        last_started_at: 10,
        last_completed_at: null,
        updated_at: 11,
      },
    ]);
  });

  const all = (sql: string, params: Record<string, string | number>) => {
    const names = new Set([...sql.matchAll(/:([a-z_]+)/g)].map((match) => match[1]));
    return lookup
      .prepare(sql)
      .all(Object.fromEntries(Object.entries(params).filter(([key]) => names.has(key)))) as Array<
      Record<string, unknown>
    >;
  };

  describe('reindex-batch-reservations', () => {
    const SOURCE = 1;
    const CANDIDATE = 2;
    const insert = (generation: number, digest: string, account: string, state: string) =>
      lookup
        .prepare(
          `INSERT INTO lookup_identifier_reservations (
             virtual_bucket, tenant_id, index_kind, normalization_version, hmac_key_generation,
             identifier_blind_digest, account_id, reservation_state, operation_id,
             lease_expires_at, released_at, created_at, updated_at
           ) VALUES (1, 'tenant-a', 'external_subject', 1, ?, ?, ?, ?, 'op', ?, ?, 1, 50)`
        )
        .run(
          generation,
          digest,
          account,
          state,
          state === 'reserved' ? NOW + 7200 : null,
          state === 'released' ? 5 : null
        );
    const digest = (name: string, generation: number) =>
      (name.charCodeAt(0).toString(16).padStart(2, '0') + String(generation)).padEnd(64, 'f');

    /** One row of the source batch, with the reservations the directory holds for it. */
    function row(
      name: string,
      account: string,
      source: string | null,
      candidate: { state: string; account?: string } | null
    ) {
      if (source) insert(SOURCE, digest(name, SOURCE), account, source);
      if (candidate) {
        insert(CANDIDATE, digest(name, CANDIDATE), candidate.account ?? account, candidate.state);
      }
      return `('${account}', '${digest(name, SOURCE)}', '${digest(name, CANDIDATE)}')`;
    }

    function diagnose(tuples: string[]) {
      const sql = runbook('reindex-batch-reservations').replace(
        "('<account>', '<source digest>', '<candidate digest>')",
        tuples.join(', ')
      );
      return all(sql, {
        tenant: 'tenant-a',
        source_generation: SOURCE,
        candidate_generation: CANDIDATE,
      });
    }
    const verdicts = (rows: Array<Record<string, unknown>>) =>
      Object.fromEntries(rows.map((r) => [r.candidate_digest, r.blocks_with]));

    it('finds the failing row of a batch whose first row succeeded', () => {
      const batch = [
        row('a', 'account:a', 'committed', null),
        row('b', 'account:b', 'committed', { state: 'released' }),
        row('c', 'account:c', 'committed', { state: 'committed' }),
      ];
      const rows = diagnose(batch);
      expect(rows).toHaveLength(3);
      expect(verdicts(rows)).toEqual({
        [digest('a', CANDIDATE)]: 'none (the reindex creates it)',
        [digest('b', CANDIDATE)]: 'reservation_conflict',
        [digest('c', CANDIDATE)]: 'none',
      });
      // The rows that block come first.
      expect(rows[0].candidate_digest).toBe(digest('b', CANDIDATE));
      expect(rows[0]).toMatchObject({ candidate_state: 'released', candidate_holder: 'account:b' });
    });

    it.each<[string, { state: string; account?: string }]>([
      ['reserved by the same account', { state: 'reserved' }],
      ['reserved by another account', { state: 'reserved', account: 'account:z' }],
      ['committed to another account', { state: 'committed', account: 'account:z' }],
      ['releasing', { state: 'releasing' }],
      ['repair_required', { state: 'repair_required' }],
      ['released to another account', { state: 'released', account: 'account:z' }],
    ])('lists a candidate reservation that is %s', (_name, candidate) => {
      const rows = diagnose([row('a', 'account:a', 'committed', candidate)]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        blocks_with: 'reservation_conflict',
        candidate_state: candidate.state,
        candidate_holder: candidate.account ?? 'account:a',
      });
    });

    it('shows a missing candidate reservation as normal and a bad source reservation as the blocker', () => {
      const rows = diagnose([
        row('a', 'account:a', 'committed', null),
        row('b', 'account:b', null, null),
        row('c', 'account:c', 'releasing', null),
        row('d', 'account:d', 'committed', null),
      ]);
      // Another account's source reservation.
      insert(SOURCE, digest('e', SOURCE), 'account:z', 'committed');
      const more = diagnose([
        `('account:e', '${digest('e', SOURCE)}', '${digest('e', CANDIDATE)}')`,
      ]);
      expect(more[0]).toMatchObject({
        blocks_with: 'source_reservation_invalid',
        candidate_state: null,
      });
      expect(verdicts(rows)).toEqual({
        [digest('a', CANDIDATE)]: 'none (the reindex creates it)',
        [digest('b', CANDIDATE)]: 'source_reservation_invalid',
        [digest('c', CANDIDATE)]: 'source_reservation_invalid',
        [digest('d', CANDIDATE)]: 'none (the reindex creates it)',
      });
      expect(rows.find((r) => r.candidate_digest === digest('a', CANDIDATE))).toMatchObject({
        candidate_state: null,
        candidate_holder: null,
      });
    });
  });
});

describe('lookup directory runbook digest script', () => {
  it('prints the digest and bucket createLookupBlindIndex computes', async () => {
    const match = /```js\n(\/\/ Usage: [\s\S]*?)```/.exec(DOCUMENT);
    if (!match) throw new Error('runbook script missing');
    const directory = mkdtempSync(join(tmpdir(), 'runbook-digest-'));
    try {
      const file = join(directory, 'recompute-digest.mjs');
      writeFileSync(file, match[1]);
      const items = [
        { kind: 'email_exact' as const, value: '  User@Example.test ' },
        { kind: 'external_subject' as const, issuer: 'did', subject: 'did:key:z6MkpTHR8VNsB' },
        {
          kind: 'external_subject' as const,
          issuer: 'urn:authrim:passkey:login.example.com',
          subject: 'credential-ä',
        },
      ];
      const output = execFileSync('node', [file], {
        input: items.map((item) => JSON.stringify(item)).join('\n') + '\n',
        env: {
          PATH: process.env.PATH ?? '',
          LOOKUP_HMAC_GENERATION: '2',
          LOOKUP_HMAC_KEY: KEYS[1].secret,
        },
        encoding: 'utf8',
      })
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { generation: number; bucket: number; digest: string });
      expect(output).toHaveLength(items.length);
      for (const [position, item] of items.entries()) {
        const expected = await createLookupBlindIndex(
          item.kind,
          item.kind === 'email_exact' ? item.value : { issuer: item.issuer, subject: item.subject },
          KEYS[1]
        );
        expect(output[position]).toEqual({
          generation: 2,
          bucket: expected.virtualBucket,
          digest: expected.digest,
        });
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
