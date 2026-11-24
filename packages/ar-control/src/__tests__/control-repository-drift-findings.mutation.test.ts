import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { D1ControlRepository } from '../repository';
import { controlDatabase, d1Over, dropTriggers } from './support/sqlite-d1';

const ENV = 'env-test';
let database: DatabaseSync;
let repository: D1ControlRepository;

beforeEach(() => {
  database = controlDatabase();
  dropTriggers(database);
  repository = new D1ControlRepository(d1Over(database));
  database.exec(`
    INSERT INTO control_environments (
      environment_id, environment_name, issuer, lifecycle_state, created_at, updated_at
    ) VALUES ('${ENV}', 'test', 'urn:authrim:control:${ENV}', 'active', 1, 1)`);
});

const findings = () =>
  database
    .prepare(
      `SELECT finding_id, worker_script_name, severity, redacted_details_json, review_state,
              first_observed_at, last_observed_at, resolved_at, notification_state, notified_at
         FROM control_worker_inventory_drift_findings ORDER BY worker_script_name`
    )
    .all();

function finding(
  name: string,
  overrides: Partial<{
    severity: string;
    review: string;
    notification: string;
    first: number;
    last: number;
    env: string;
  }> = {}
): void {
  const review = overrides.review ?? 'unreviewed';
  database
    .prepare(
      `INSERT INTO control_worker_inventory_drift_findings (
         finding_id, environment_id, worker_script_name, finding_kind, severity, review_state,
         first_observed_at, last_observed_at, resolved_at, notification_state
       ) VALUES (?, ?, ?, 'actual_only', ?, ?, ?, ?, ?, ?)`
    )
    .run(
      `f-${name}`,
      overrides.env ?? ENV,
      name,
      overrides.severity ?? 'warning',
      review,
      overrides.first ?? 10,
      overrides.last ?? Math.max(overrides.first ?? 10, 10),
      review === 'resolved' ? 99 : null,
      overrides.notification ?? (review === 'resolved' ? 'resolved' : 'pending')
    );
}

describe('desired worker names', () => {
  it('lists active workers of the environment in name order', async () => {
    database.exec(`
      INSERT INTO control_operations (
        operation_id, environment_id, operation_kind, idempotency_key, status,
        requested_by_type, attempt_count, created_at, updated_at
      ) VALUES ('seed', '${ENV}', 'provision_shard', 'seed', 'running', 'setup', 1, 1, 1)`);
    for (const [name, status, env] of [
      ['worker-b', 'active', ENV],
      ['worker-a', 'active', ENV],
      ['worker-c', 'disabled', ENV],
      ['worker-z', 'active', 'other'],
    ] as const) {
      database
        .prepare(
          `INSERT INTO control_desired_worker_inventory (
             environment_id, worker_script_name, package_name, deployment_target,
             capability_manifest_digest, source_manifest_path, source_manifest_hash,
             generated_artifact_hash, source_kind, source_reference, registered_by_operation_id,
             registered_by, registered_at, status
           ) VALUES (?, ?, 'pkg', ?, ?1, 'p', ?1, ?1, 'core_manifest', 'r', 'seed', 'setup', 1, ?)`.replace(
            /\?1/gu,
            `'${'a'.repeat(64)}'`
          )
        )
        .run(env, name, name, status);
    }
    await expect(repository.listActiveDesiredWorkerNames(ENV)).resolves.toEqual([
      'worker-a',
      'worker-b',
    ]);
  });
});

describe('actual-only worker findings', () => {
  it('records nothing for an empty list', async () => {
    await repository.recordActualOnlyWorkerFindings(ENV, [], 100);
    expect(findings()).toEqual([]);
    expect(database.prepare('SELECT COUNT(*) AS n FROM control_audit_events').get()).toEqual({
      n: 0,
    });
  });

  it('records each distinct script once with an audit event', async () => {
    await repository.recordActualOnlyWorkerFindings(ENV, ['worker-b', 'worker-a', 'worker-b'], 100);
    expect(findings()).toEqual([
      {
        finding_id: 'drift:env-test:actual_only:worker-a',
        worker_script_name: 'worker-a',
        severity: 'warning',
        redacted_details_json: JSON.stringify({ source: 'cloudflare_workers_list' }),
        review_state: 'unreviewed',
        first_observed_at: 100,
        last_observed_at: 100,
        resolved_at: null,
        notification_state: 'pending',
        notified_at: null,
      },
      {
        finding_id: 'drift:env-test:actual_only:worker-b',
        worker_script_name: 'worker-b',
        severity: 'warning',
        redacted_details_json: JSON.stringify({ source: 'cloudflare_workers_list' }),
        review_state: 'unreviewed',
        first_observed_at: 100,
        last_observed_at: 100,
        resolved_at: null,
        notification_state: 'pending',
        notified_at: null,
      },
    ]);
    expect(
      database
        .prepare(
          `SELECT event_id, event_type, actor_type, resource_kind, resource_id, outcome,
                  redacted_payload_json, created_at FROM control_audit_events ORDER BY resource_id`
        )
        .all()
    ).toEqual(
      ['worker-a', 'worker-b'].map((name) => ({
        event_id: `audit:drift:env-test:actual_only:${name}:100`,
        event_type: 'control.worker_inventory.actual_only',
        actor_type: 'reconciler',
        resource_kind: 'worker_script',
        resource_id: name,
        outcome: 'blocked',
        redacted_payload_json: JSON.stringify({ finding_kind: 'actual_only', severity: 'warning' }),
        created_at: 100,
      }))
    );
  });

  it('keeps the review state and first sighting of a standing finding and skips a second audit', async () => {
    await repository.recordActualOnlyWorkerFindings(ENV, ['worker-a'], 100);
    database.exec(
      "UPDATE control_worker_inventory_drift_findings SET review_state = 'reviewed', notification_state = 'acknowledged', notified_at = 100"
    );
    await repository.recordActualOnlyWorkerFindings(ENV, ['worker-a'], 200);
    expect(findings()).toEqual([
      expect.objectContaining({
        review_state: 'reviewed',
        notification_state: 'acknowledged',
        first_observed_at: 100,
        last_observed_at: 200,
        notified_at: 100,
        resolved_at: null,
      }),
    ]);
    expect(database.prepare('SELECT COUNT(*) AS n FROM control_audit_events').get()).toEqual({
      n: 1,
    });
  });

  it('reopens a resolved finding as a fresh sighting', async () => {
    finding('worker-a', { review: 'resolved', first: 10, last: 50 });
    database.exec('UPDATE control_worker_inventory_drift_findings SET notified_at = 20');
    await repository.recordActualOnlyWorkerFindings(ENV, ['worker-a'], 300);
    expect(findings()).toEqual([
      expect.objectContaining({
        review_state: 'unreviewed',
        first_observed_at: 300,
        last_observed_at: 300,
        resolved_at: null,
        notification_state: 'pending',
        notified_at: null,
      }),
    ]);
    expect(database.prepare('SELECT COUNT(*) AS n FROM control_audit_events').get()).toEqual({
      n: 1,
    });
  });

  it('resolves only findings that are no longer actual-only', async () => {
    finding('worker-a');
    finding('worker-b');
    finding('worker-c', { review: 'reviewed', notification: 'acknowledged' });
    finding('worker-d', { env: 'other' });
    await repository.resolveMissingActualOnlyWorkerFindings(ENV, ['worker-b', 'worker-b'], 500);
    expect(
      database
        .prepare(
          `SELECT worker_script_name, review_state, notification_state, resolved_at
             FROM control_worker_inventory_drift_findings ORDER BY environment_id, worker_script_name`
        )
        .all()
    ).toEqual([
      {
        worker_script_name: 'worker-a',
        review_state: 'resolved',
        notification_state: 'resolved',
        resolved_at: 500,
      },
      {
        worker_script_name: 'worker-b',
        review_state: 'unreviewed',
        notification_state: 'pending',
        resolved_at: null,
      },
      {
        worker_script_name: 'worker-c',
        review_state: 'resolved',
        notification_state: 'resolved',
        resolved_at: 500,
      },
      {
        worker_script_name: 'worker-d',
        review_state: 'unreviewed',
        notification_state: 'pending',
        resolved_at: null,
      },
    ]);
    await repository.resolveMissingActualOnlyWorkerFindings(ENV, [], 600);
    expect(
      database
        .prepare(
          "SELECT resolved_at FROM control_worker_inventory_drift_findings WHERE worker_script_name = 'worker-b'"
        )
        .get()
    ).toEqual({ resolved_at: 600 });
    expect(
      database
        .prepare(
          "SELECT resolved_at FROM control_worker_inventory_drift_findings WHERE worker_script_name = 'worker-a'"
        )
        .get()
    ).toEqual({ resolved_at: 500 });
  });
});

describe('drift finding listings', () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY])('rejects the limit %s', async (limit) => {
    await expect(repository.listPendingWorkerInventoryDriftFindings(ENV, limit)).rejects.toThrow(
      'invalid_worker_inventory_drift_limit'
    );
    await expect(repository.listWorkerInventoryDriftFindings(ENV, limit)).rejects.toThrow(
      'invalid_worker_inventory_drift_limit'
    );
  });

  it('lists pending findings critical first, then oldest, within the clamped limit', async () => {
    finding('w1', { first: 30 });
    finding('w2', { first: 10 });
    finding('w3', { first: 20, severity: 'critical' });
    finding('w4', { first: 5, notification: 'acknowledged' });
    finding('w5', { first: 1, env: 'other' });
    const names = async (limit: number) =>
      (await repository.listPendingWorkerInventoryDriftFindings(ENV, limit)).map(
        (entry) => entry.worker_script_name
      );
    expect(await names(10)).toEqual(['w3', 'w2', 'w1']);
    expect(await names(0)).toEqual(['w3']);
    expect(await names(-4)).toEqual(['w3']);
    expect(await names(2.9)).toEqual(['w3', 'w2']);
    expect(await names(1000)).toEqual(['w3', 'w2', 'w1']);
    const first = (await repository.listPendingWorkerInventoryDriftFindings(ENV, 1))[0];
    expect(first).toEqual({
      finding_id: 'f-w3',
      environment_id: ENV,
      worker_script_name: 'w3',
      finding_kind: 'actual_only',
      severity: 'critical',
      review_state: 'unreviewed',
      notification_state: 'pending',
      first_observed_at: 20,
      last_observed_at: 20,
      resolved_at: null,
      notified_at: null,
    });
  });

  it('caps the pending listing at one hundred findings', async () => {
    for (let index = 0; index < 101; index += 1) finding(`w${String(index).padStart(3, '0')}`);
    expect(await repository.listPendingWorkerInventoryDriftFindings(ENV, 500)).toHaveLength(100);
    expect(await repository.listWorkerInventoryDriftFindings(ENV, 500)).toHaveLength(100);
  });

  it('lists unresolved findings with unreviewed ones first', async () => {
    finding('w1', { review: 'reviewed', first: 1 });
    finding('w2', { first: 30 });
    finding('w3', { first: 20 });
    finding('w4', { review: 'resolved', first: 2 });
    finding('w5', { review: 'dismissed', first: 3 });
    finding('w6', { first: 20 });
    finding('w7', { env: 'other' });
    const names = async (limit: number) =>
      (await repository.listWorkerInventoryDriftFindings(ENV, limit)).map(
        (entry) => entry.worker_script_name
      );
    expect(await names(10)).toEqual(['w3', 'w6', 'w2', 'w1', 'w5']);
    expect(await names(0)).toEqual(['w3']);
    expect(await names(2.9)).toEqual(['w3', 'w6']);
  });
});

describe('drift finding review and acknowledgement', () => {
  const review = (patch: Record<string, unknown> = {}) =>
    repository.reviewWorkerInventoryDriftFinding(
      ENV,
      {
        findingId: 'f-w1',
        disposition: 'reviewed',
        reviewedBy: 'admin-1',
        idempotencyKey: 'key-1',
        ...patch,
      },
      700
    );

  it('moves an unresolved finding to the requested review state and audits it', async () => {
    finding('w1');
    await expect(review()).resolves.toMatchObject({ finding_id: 'f-w1', review_state: 'reviewed' });
    expect(
      database
        .prepare(
          `SELECT event_id, event_type, actor_type, actor_id, resource_kind, resource_id, outcome,
                  redacted_payload_json, created_at FROM control_audit_events`
        )
        .get()
    ).toEqual({
      event_id: 'audit:drift-review:env-test:f-w1:reviewed:key-1',
      event_type: 'control.worker_inventory.reviewed',
      actor_type: 'admin',
      actor_id: 'admin-1',
      resource_kind: 'worker_script',
      resource_id: 'w1',
      outcome: 'succeeded',
      redacted_payload_json: JSON.stringify({ finding_id: 'f-w1', disposition: 'reviewed' }),
      created_at: 700,
    });
    await expect(
      review({ disposition: 'dismissed', idempotencyKey: 'key-2' })
    ).resolves.toMatchObject({
      review_state: 'dismissed',
    });
    await expect(
      review({ disposition: 'dismissed', idempotencyKey: 'key-2' })
    ).resolves.toMatchObject({
      review_state: 'dismissed',
    });
    expect(database.prepare('SELECT COUNT(*) AS n FROM control_audit_events').get()).toEqual({
      n: 2,
    });
  });

  it('refuses to review a resolved or unknown finding in another environment', async () => {
    finding('w1', { review: 'resolved' });
    await expect(review()).rejects.toThrow('control_worker_inventory_drift_review_conflict');
    finding('w2', { env: 'other' });
    await expect(review({ findingId: 'f-w2' })).rejects.toThrow(
      'control_worker_inventory_drift_review_conflict'
    );
    await expect(review({ findingId: 'missing' })).rejects.toThrow(
      'control_worker_inventory_drift_review_conflict'
    );
  });

  it('acknowledges pending notifications of unresolved findings only', async () => {
    finding('w1');
    finding('w2');
    finding('w3', { review: 'resolved' });
    finding('w4', { notification: 'acknowledged' });
    finding('w5', { env: 'other' });
    await repository.acknowledgeWorkerInventoryDriftNotifications(ENV, [], 800);
    expect(
      database
        .prepare(
          'SELECT COUNT(*) AS n FROM control_worker_inventory_drift_findings WHERE notified_at IS NOT NULL'
        )
        .get()
    ).toEqual({ n: 0 });
    await repository.acknowledgeWorkerInventoryDriftNotifications(
      ENV,
      ['f-w2', 'f-w1', 'f-w1', 'f-w3', 'f-w4', 'f-w5'],
      800
    );
    expect(
      database
        .prepare(
          `SELECT worker_script_name, notification_state, notified_at
             FROM control_worker_inventory_drift_findings ORDER BY worker_script_name`
        )
        .all()
    ).toEqual([
      { worker_script_name: 'w1', notification_state: 'acknowledged', notified_at: 800 },
      { worker_script_name: 'w2', notification_state: 'acknowledged', notified_at: 800 },
      { worker_script_name: 'w3', notification_state: 'resolved', notified_at: null },
      { worker_script_name: 'w4', notification_state: 'acknowledged', notified_at: null },
      { worker_script_name: 'w5', notification_state: 'pending', notified_at: null },
    ]);
  });
});
