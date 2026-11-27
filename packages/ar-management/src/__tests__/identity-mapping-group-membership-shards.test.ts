import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KVNamespace } from '@cloudflare/workers-types';
import type { Env } from '@authrim/ar-lib-core';
import { logProducerFixture } from '../../../../test/helpers/log-iceberg-producer-fixture.mjs';
import { IdentityMappingControlPlaneRepository } from '../identity-mapping-control-plane';
import { openCoreStore } from './helpers/core-schema-sqlite';

/**
 * Provisioning rules and lifecycle signals with memberships on the subject's account database:
 * two account databases besides tenant Core (the metadata database, which keeps the rule, the
 * ownership records and the audit).
 */
const close: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  close.splice(0).forEach((f) => f());
});

type Row = Record<string, unknown>;

async function fixture() {
  const f = await logProducerFixture('scheduled', { separateAdmin: true });
  close.push(f.close);
  f.db.exec(
    readFileSync(
      new URL('../../../../migrations/core/d1/015_end_user_groups.sql', import.meta.url),
      'utf8'
    )
  );
  f.db.exec(
    readFileSync(
      new URL(
        '../../../../migrations/core/d1/017_service_group_scim_membership_inputs.sql',
        import.meta.url
      ),
      'utf8'
    )
  );
  f.db.exec(
    `INSERT INTO "groups"(id,tenant_id,group_key,display_name,lifecycle_state,created_at,updated_at)
     VALUES('group','tenant-a','group','Group','active',1,1)`
  );
  const shardA = openCoreStore('tenant-a');
  const shardB = openCoreStore('tenant-a');
  close.push(
    () => shardA.db.close(),
    () => shardB.db.close()
  );
  // Each subject's account (account:<subject>) and the database it is routed to.
  const shards = new Map<string, typeof shardA>([
    ['user-a', shardA],
    ['user-b', shardB],
  ]);
  const puts: string[] = [];
  const failPut = { next: false };
  const cache = {
    put: vi.fn(async (key: string) => {
      if (failPut.next) {
        failPut.next = false;
        throw new Error('cache unavailable');
      }
      puts.push(key);
    }),
    get: vi.fn(async () => null),
    delete: vi.fn(async () => {}),
  } as unknown as KVNamespace;
  const env = { ...(f.env as Env), REBAC_CACHE: cache } as Env;
  const resolver = vi.fn(
    async (_tenantId: string, id: { subjectId?: string | null; accountId?: string | null }) => {
      // The account id decides when given (as the account route does).
      const subjectId = id.accountId ? id.accountId.replace(/^account:/u, '') : id.subjectId;
      const shard = subjectId ? shards.get(subjectId) : undefined;
      return shard && subjectId
        ? { subjectId, accountId: `account:${subjectId}`, account: shard.adapter }
        : null;
    }
  );
  const repo = new IdentityMappingControlPlaneRepository(
    f.adminAdapter,
    () => f.now,
    f.adapter,
    undefined,
    env,
    f.publicationSource,
    null,
    resolver
  );
  const rule = await repo.createProvisioningAssignmentRule('tenant-a', {
    ruleType: 'event',
    targetType: 'group',
    targetId: 'group',
    condition: { eventTypes: ['jit'] },
  });
  const subjectPuts = (subjectId: string) =>
    puts.filter((key) => key === `rbac:v2:subject-version:tenant-a:${subjectId}`).length;
  return {
    ...f,
    repo,
    rule,
    shardA: shardA.db,
    shardB: shardB.db,
    shards,
    subjectPuts,
    failPut,
  };
}

const count = (db: { prepare(sql: string): { get(): unknown } }, sql: string) =>
  (db.prepare(sql).get() as { n: number }).n;
const rows = (db: { prepare(sql: string): { all(): unknown[] } }, sql: string) =>
  db.prepare(sql).all() as Row[];

const signalFor = (membershipId: string) => ({
  sourceType: 'scim',
  sourceId: 'source',
  sourceEventId: 'remote-event',
  signalType: 'scim_group_removed' as const,
  targetType: 'group_membership' as const,
  targetId: membershipId,
  subjectId: 'user-b' as string | undefined,
});

describe('provisioning memberships on account databases', () => {
  it("writes a rule's membership on the subject's account database and its ownership in Core", async () => {
    const f = await fixture();
    await expect(
      f.repo.evaluateProvisioningAssignmentRule('tenant-a', f.rule.id, {
        eventType: 'jit',
        accountId: 'account:user-b',
      })
    ).resolves.toMatchObject({ outcome: 'assigned' });
    const [row] = rows(
      f.shardB,
      'SELECT id, subject_id, assignment_source, source_ref, lifecycle_state FROM group_memberships'
    );
    expect(row).toMatchObject({
      subject_id: 'user-b',
      assignment_source: 'rule',
      source_ref: f.rule.id,
      lifecycle_state: 'active',
    });
    expect(count(f.shardA, 'SELECT count(*) n FROM group_memberships')).toBe(0);
    expect(count(f.db, 'SELECT count(*) n FROM group_memberships')).toBe(0);
    expect(
      rows(
        f.db,
        'SELECT assignment_type, assignment_id, source_id, ownership_policy FROM provisioning_assignment_ownership'
      )
    ).toEqual([
      {
        assignment_type: 'group_membership',
        assignment_id: row?.id,
        source_id: `rule:${f.rule.id}`,
        ownership_policy: 'source_owned',
      },
    ]);
    expect(await f.rows('core.provisioning_assignment_events')).toEqual([
      expect.objectContaining({ rule_id: f.rule.id, outcome: 'assigned' }),
    ]);
    expect(f.subjectPuts('user-b')).toBe(1);
    expect(f.subjectPuts('user-a')).toBe(0);
  });

  it('refuses a subject id that is not the subject of the account id, before any write', async () => {
    const f = await fixture();
    await expect(
      f.repo.evaluateProvisioningAssignmentRule('tenant-a', f.rule.id, {
        eventType: 'jit',
        subjectId: 'user-a',
        accountId: 'account:user-b',
      })
    ).rejects.toMatchObject({ status: 400 });
    expect(count(f.shardA, 'SELECT count(*) n FROM group_memberships')).toBe(0);
    expect(count(f.shardB, 'SELECT count(*) n FROM group_memberships')).toBe(0);
    expect(count(f.db, 'SELECT count(*) n FROM provisioning_assignment_ownership')).toBe(0);
  });

  it('keeps one membership row when a request is retried after its ownership step failed', async () => {
    const f = await fixture();
    const input = { eventType: 'jit', subjectId: 'user-b' } as const;
    f.db.exec(
      "CREATE TRIGGER fail_ownership BEFORE INSERT ON provisioning_assignment_ownership BEGIN SELECT RAISE(ABORT,'ownership failed'); END"
    );
    await expect(
      f.repo.evaluateProvisioningAssignmentRule('tenant-a', f.rule.id, input)
    ).rejects.toThrow('ownership failed');
    // The row the failed request made is taken back, not left granting the group.
    expect(rows(f.shardB, 'SELECT lifecycle_state FROM group_memberships')).toEqual([
      { lifecycle_state: 'revoked' },
    ]);
    f.db.exec('DROP TRIGGER fail_ownership');
    await f.repo.evaluateProvisioningAssignmentRule('tenant-a', f.rule.id, input);
    await f.repo.evaluateProvisioningAssignmentRule('tenant-a', f.rule.id, input);
    const written = rows(f.shardB, 'SELECT id, lifecycle_state FROM group_memberships');
    expect(written.map((row) => row.lifecycle_state)).toEqual(['active']);
    expect(rows(f.db, 'SELECT assignment_id FROM provisioning_assignment_ownership')).toEqual([
      { assignment_id: written[0]?.id },
    ]);
    // Every write of the row (made, taken back, made again, written again) dropped the claims.
    expect(f.subjectPuts('user-b')).toBe(4);
  });

  it('takes back the row when the cache invalidation after the write fails', async () => {
    const f = await fixture();
    f.failPut.next = true;
    await expect(
      f.repo.evaluateProvisioningAssignmentRule('tenant-a', f.rule.id, {
        eventType: 'jit',
        subjectId: 'user-b',
      })
    ).rejects.toThrow('cache unavailable');
    expect(rows(f.shardB, 'SELECT lifecycle_state FROM group_memberships')).toEqual([
      { lifecycle_state: 'revoked' },
    ]);
    expect(count(f.db, 'SELECT count(*) n FROM provisioning_assignment_ownership')).toBe(0);
  });

  it('does not take back a row a later write stamped while this request failed', async () => {
    const f = await fixture();
    vi.spyOn(f.adapter, 'batch').mockImplementationOnce(async () => {
      // Another application wrote the row after this request (a later stamp).
      f.shardB.exec('UPDATE group_memberships SET updated_at = updated_at + 1');
      throw new Error('metadata unavailable');
    });
    await expect(
      f.repo.evaluateProvisioningAssignmentRule('tenant-a', f.rule.id, {
        eventType: 'jit',
        subjectId: 'user-b',
      })
    ).rejects.toThrow('metadata unavailable');
    expect(rows(f.shardB, 'SELECT lifecycle_state FROM group_memberships')).toEqual([
      { lifecycle_state: 'active' },
    ]);
  });

  it('leaves the membership and answers 500 when the commit outcome cannot be read', async () => {
    const f = await fixture();
    const queryOne = f.adapter.queryOne.bind(f.adapter);
    vi.spyOn(f.adapter, 'queryOne').mockImplementation(async (sql, params, options) => {
      if (sql === 'SELECT state FROM log_iceberg_core_publications WHERE id=?')
        throw new Error('metadata read failed');
      return queryOne(sql, params, options);
    });
    await expect(
      f.repo.evaluateProvisioningAssignmentRule('tenant-a', f.rule.id, {
        eventType: 'jit',
        subjectId: 'user-b',
      })
    ).rejects.toMatchObject({ status: 500, code: 'commit_outcome_unknown' });
    expect(rows(f.shardB, 'SELECT lifecycle_state FROM group_memberships')).toEqual([
      { lifecycle_state: 'active' },
    ]);
  });

  it('revokes a membership on its subject database and completes a retried decision', async () => {
    const f = await fixture();
    await f.repo.evaluateProvisioningAssignmentRule('tenant-a', f.rule.id, {
      eventType: 'jit',
      subjectId: 'user-b',
    });
    // The grant the decision will see, a few seconds before the decision.
    const observed = Math.floor(f.now / 1000) - 5;
    f.shardB.exec(`UPDATE group_memberships SET updated_at = ${observed}`);
    const [membership] = rows(f.shardB, 'SELECT id FROM group_memberships');
    f.db.exec("UPDATE provisioning_assignment_ownership SET revoke_policy='auto'");
    const signal = signalFor(String(membership?.id));
    const before = f.subjectPuts('user-b');
    await expect(f.repo.recordExternalLifecycleSignal('tenant-a', signal)).resolves.toMatchObject({
      decision: 'revoke',
    });
    expect(rows(f.shardB, 'SELECT lifecycle_state FROM group_memberships')).toEqual([
      { lifecycle_state: 'revoked' },
    ]);
    const [decision] = rows(
      f.db,
      'SELECT subject_id, account_id, decision, propagation_targets_json FROM external_lifecycle_signal_decisions'
    );
    expect(decision).toMatchObject({
      subject_id: 'user-b',
      account_id: 'account:user-b',
      decision: 'revoke',
    });
    expect(JSON.parse(String(decision?.propagation_targets_json))).toEqual([
      { targetType: 'group_membership', targetId: membership?.id, membershipUpdatedAt: observed },
    ]);
    expect(f.subjectPuts('user-b')).toBe(before + 1);

    // A row the first attempt left as it was (it stopped after the decision committed) is
    // revoked by the retry, resolved from the account the decision names.
    f.shardB.exec(`UPDATE group_memberships SET lifecycle_state='active', updated_at=${observed}`);
    await expect(
      f.repo.recordExternalLifecycleSignal('tenant-a', { ...signal, subjectId: undefined })
    ).resolves.toMatchObject({ decision: 'revoke', idempotent: true });
    expect(rows(f.shardB, 'SELECT lifecycle_state FROM group_memberships')).toEqual([
      { lifecycle_state: 'revoked' },
    ]);
    expect(f.subjectPuts('user-b')).toBe(before + 2);

    // An already revoked row is success, without a note.
    await expect(
      f.repo.recordExternalLifecycleSignal('tenant-a', signal)
    ).resolves.not.toHaveProperty('notes');

    // A replay does not revoke the membership given again after the decision: in the same
    // second as the decision, or later.
    for (const regrantedAt of [Math.floor(f.now / 1000), Math.floor(f.now / 1000) + 3600]) {
      f.shardB.exec(
        `UPDATE group_memberships SET lifecycle_state='active', updated_at=${regrantedAt}`
      );
      await expect(f.repo.recordExternalLifecycleSignal('tenant-a', signal)).resolves.toMatchObject(
        { idempotent: true, notes: ['membership_changed'] }
      );
      expect(rows(f.shardB, 'SELECT lifecycle_state FROM group_memberships')).toEqual([
        { lifecycle_state: 'active' },
      ]);
    }
    expect(count(f.shardA, 'SELECT count(*) n FROM group_memberships')).toBe(0);
  });

  it('fails a retried decision that does not record both its account and its subject', async () => {
    const f = await fixture();
    await f.repo.evaluateProvisioningAssignmentRule('tenant-a', f.rule.id, {
      eventType: 'jit',
      subjectId: 'user-b',
    });
    const [membership] = rows(f.shardB, 'SELECT id FROM group_memberships');
    f.db.exec("UPDATE provisioning_assignment_ownership SET revoke_policy='auto'");
    const signal = signalFor(String(membership?.id));
    await f.repo.recordExternalLifecycleSignal('tenant-a', signal);
    f.db.exec('UPDATE external_lifecycle_signal_decisions SET account_id = NULL');
    await expect(f.repo.recordExternalLifecycleSignal('tenant-a', signal)).rejects.toMatchObject({
      status: 409,
      code: 'lifecycle_decision_incomplete',
    });
  });

  it('fails a retried decision whose account can no longer be reached', async () => {
    const f = await fixture();
    await f.repo.evaluateProvisioningAssignmentRule('tenant-a', f.rule.id, {
      eventType: 'jit',
      subjectId: 'user-b',
    });
    const [membership] = rows(f.shardB, 'SELECT id FROM group_memberships');
    f.db.exec("UPDATE provisioning_assignment_ownership SET revoke_policy='auto'");
    const signal = signalFor(String(membership?.id));
    await f.repo.recordExternalLifecycleSignal('tenant-a', signal);
    f.shards.delete('user-b');
    await expect(f.repo.recordExternalLifecycleSignal('tenant-a', signal)).rejects.toMatchObject({
      status: 409,
      code: 'membership_account_unreachable',
    });
  });

  it('refuses to revoke a membership for a signal that names no subject or another one', async () => {
    const f = await fixture();
    await f.repo.evaluateProvisioningAssignmentRule('tenant-a', f.rule.id, {
      eventType: 'jit',
      subjectId: 'user-a',
    });
    const [membership] = rows(f.shardA, 'SELECT id FROM group_memberships');
    f.db.exec("UPDATE provisioning_assignment_ownership SET revoke_policy='auto'");
    const signal = { ...signalFor(String(membership?.id)), subjectId: undefined };
    await expect(f.repo.recordExternalLifecycleSignal('tenant-a', signal)).rejects.toMatchObject({
      status: 400,
    });
    // A subject id that is not the account's subject.
    await expect(
      f.repo.recordExternalLifecycleSignal('tenant-a', {
        ...signal,
        subjectId: 'user-b',
        accountId: 'account:user-a',
      })
    ).rejects.toMatchObject({ status: 400 });
    // Another subject's database does not hold the row: not found, nothing written.
    await expect(
      f.repo.recordExternalLifecycleSignal('tenant-a', { ...signal, subjectId: 'user-b' })
    ).rejects.toMatchObject({ status: 404 });
    expect(rows(f.shardA, 'SELECT lifecycle_state FROM group_memberships')).toEqual([
      { lifecycle_state: 'active' },
    ]);
    expect(count(f.db, 'SELECT count(*) n FROM external_lifecycle_signal_events')).toBe(0);
  });
});
