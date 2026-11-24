import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { D1ControlRepository } from '../repository';
import { controlDatabase, d1Over, dropTriggers } from './support/sqlite-d1';

const ENV = 'env-test';
const OP = 'op-1';
const ACTOR = 'admin-1';

interface AuditRow {
  environment_id: string;
  operation_id: string;
  actor_id: string;
  resource_id: string;
  redacted_payload_json: string;
}

interface Flow {
  name: string;
  eventKey: string;
  resource: string;
  payload: string;
  conflict: string;
  absent: string;
  operationStatus: string | null;
  run: (repository: D1ControlRepository) => Promise<unknown>;
}

const flows: Flow[] = [
  {
    name: 'step retry',
    eventKey: 'operator-retry',
    resource: 'create_d1',
    payload: JSON.stringify({
      step_key: 'create_d1',
      reason_code: 'operator_retry',
      idempotency_key: 'k1',
      before: { operation_status: 'blocked', step_status: 'blocked' },
      after: { operation_status: 'running', step_status: 'running' },
    }),
    conflict: 'control_operation_retry_conflict',
    absent: 'control_operation_retry_not_retryable',
    operationStatus: 'running',
    run: (repository) =>
      repository.retryProvisioningOperationStep(
        {
          operationId: OP,
          stepKey: 'create_d1',
          requestedById: ACTOR,
          reasonCode: 'operator_retry',
          idempotencyKey: 'k1',
        },
        ENV,
        500
      ),
  },
  {
    name: 'cancellation',
    eventKey: 'operator-cancel',
    resource: OP,
    payload: JSON.stringify({
      reason_code: 'operator_cancel',
      idempotency_key: 'k1',
      before: { operation_status: 'blocked' },
      after: { operation_status: 'canceled' },
      retained_resources: true,
    }),
    conflict: 'control_operation_cancel_conflict',
    absent: 'control_operation_cancel_not_allowed',
    operationStatus: 'canceled',
    run: (repository) =>
      repository.cancelProvisioningOperation(
        {
          operationId: OP,
          requestedById: ACTOR,
          reasonCode: 'operator_cancel',
          idempotencyKey: 'k1',
        },
        ENV,
        500
      ),
  },
  {
    name: 'settings restore',
    eventKey: 'operator-restore-settings',
    resource: OP,
    payload: JSON.stringify({
      reason_code: 'operator_restore_previous_settings',
      idempotency_key: 'k1',
      before: { operation_status: 'blocked', binding_state: 'blocked' },
      after: { operation_status: 'running', binding_state: 'rollback_required' },
      provider_mutation: 'deferred_to_reconciler',
    }),
    conflict: 'control_operation_restore_conflict',
    absent: 'control_operation_restore_not_allowed',
    operationStatus: 'running',
    run: (repository) =>
      repository.restoreProvisioningOperationPreviousSettings(
        {
          operationId: OP,
          requestedById: ACTOR,
          reasonCode: 'operator_restore_previous_settings',
          idempotencyKey: 'k1',
        },
        ENV,
        500
      ),
  },
];

const releaseFlow: Flow = {
  name: 'release target retry',
  eventKey: 'release-target-retry',
  resource: 'target-1',
  payload: JSON.stringify({
    target_id: 'target-1',
    reason_code: 'operator_retry_release_target',
    idempotency_key: 'k1',
    before: { operation_status: 'blocked', target_state: 'blocked' },
    after: { operation_status: 'running', target_state: 'queued' },
  }),
  conflict: 'control_release_rollout_retry_conflict',
  absent: 'control_release_rollout_retry_not_retryable',
  operationStatus: null,
  run: (repository) =>
    repository.retryReleaseMigrationRolloutTarget(
      {
        operationId: OP,
        targetId: 'target-1',
        requestedById: ACTOR,
        reasonCode: 'operator_retry_release_target',
        idempotencyKey: 'k1',
      },
      ENV,
      500
    ),
};

let database: DatabaseSync;

beforeEach(() => {
  database = controlDatabase();
  dropTriggers(database);
  database.exec(`
    INSERT INTO control_environments (
      environment_id, environment_name, issuer, lifecycle_state, created_at, updated_at
    ) VALUES ('${ENV}', 'test', 'urn:authrim:control:${ENV}', 'active', 1, 1)`);
});

function seedOperation(status: string): void {
  database
    .prepare(
      `INSERT INTO control_operations (
         operation_id, environment_id, operation_kind, idempotency_key, status, requested_by_type,
         attempt_count, created_at, completed_at, updated_at
       ) VALUES (?, ?, 'provision_shard', 'seed', ?, 'admin', 1, 1, ?, 1)`
    )
    .run(OP, ENV, status, status === 'canceled' ? 1 : null);
}

/** Serves scripted rows for the idempotency audit reads and leaves every other query untouched. */
function scripted(reads: (AuditRow | 'real')[]): D1ControlRepository {
  const real = d1Over(database);
  let index = 0;
  const wrapped = {
    prepare(sql: string) {
      const statement = real.prepare(sql);
      if (
        !/SELECT environment_id, operation_id, actor_id, resource_id, redacted_payload_json\s+FROM control_audit_events/u.test(
          sql
        )
      ) {
        return statement;
      }
      return {
        bind(...values: unknown[]) {
          const bound = statement.bind(...values);
          return {
            first: async () => {
              const next = reads[index++] ?? 'real';
              return next === 'real' ? bound.first() : next;
            },
          };
        },
      };
    },
    batch: (statements: Parameters<D1Database['batch']>[0]) => real.batch(statements),
  } as unknown as D1Database;
  return new D1ControlRepository(wrapped);
}

function row(flow: Flow, patch: Partial<AuditRow> = {}): AuditRow {
  return {
    environment_id: ENV,
    operation_id: OP,
    actor_id: ACTOR,
    resource_id: flow.resource,
    redacted_payload_json: flow.payload,
    ...patch,
  };
}

const mismatches = (flow: Flow): [string, Partial<AuditRow>][] => [
  ['environment', { environment_id: 'other' }],
  ['operation', { operation_id: 'other' }],
  ['actor', { actor_id: 'other' }],
  ['resource', { resource_id: 'other' }],
  ['payload', { redacted_payload_json: `${flow.payload} ` }],
];

describe.each([...flows, releaseFlow])('idempotent operator audit for $name', (flow) => {
  describe('an event recorded by an earlier request', () => {
    it.each(mismatches(flow))('conflicts when the %s differs', async (_label, patch) => {
      await expect(flow.run(scripted([row(flow, patch)]))).rejects.toThrow(flow.conflict);
    });

    it('replays the current state when every field matches', async () => {
      if (flow === releaseFlow) {
        await expect(flow.run(scripted([row(flow)]))).resolves.toMatchObject({ phase: 'idle' });
        return;
      }
      seedOperation('blocked');
      await expect(flow.run(scripted([row(flow)]))).resolves.toMatchObject({
        operationId: OP,
        status: 'blocked',
      });
    });

    it('conflicts when the matching event has no operation to replay', async () => {
      if (flow === releaseFlow) return;
      await expect(flow.run(scripted([row(flow)]))).rejects.toThrow(flow.conflict);
    });
  });

  describe('an event read back after the guarded batch', () => {
    it.each(mismatches(flow))('conflicts when the %s differs', async (_label, patch) => {
      seedOperation(flow.operationStatus ?? 'running');
      const outcome = flow.run(scripted(['real', row(flow, patch)]));
      await expect(outcome).rejects.toThrow(flow === releaseFlow ? flow.absent : flow.conflict);
    });

    it('reports the action as unavailable when no event was recorded', async () => {
      seedOperation('running');
      await expect(flow.run(scripted(['real', 'real']))).rejects.toThrow(flow.absent);
    });

    it('returns the operation when the event matches and the operation reached the target status', async () => {
      if (flow.operationStatus === null) {
        await expect(flow.run(scripted(['real', row(flow)]))).resolves.toMatchObject({
          phase: 'idle',
        });
        return;
      }
      seedOperation(flow.operationStatus);
      await expect(flow.run(scripted(['real', row(flow)]))).resolves.toMatchObject({
        operationId: OP,
        status: flow.operationStatus,
      });
    });

    it('conflicts when the matching event leaves the operation in another status', async () => {
      if (flow.operationStatus === null) return;
      seedOperation('blocked');
      await expect(flow.run(scripted(['real', row(flow)]))).rejects.toThrow(flow.conflict);
    });

    it('conflicts when the matching event has no operation', async () => {
      if (flow.operationStatus === null) return;
      await expect(flow.run(scripted(['real', row(flow)]))).rejects.toThrow(flow.conflict);
    });
  });
});
