import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cleanupWorld,
  seedBindingReconciliation,
  type CleanupWorld,
} from './support/plugin-cleanup-fixtures';

let world: CleanupWorld;

beforeEach(async () => {
  world = await cleanupWorld();
});
afterEach(() => world.database.close());

const REQUEST = {
  tenantId: 'tenant-a',
  pluginId: 'plugin-a',
  reason: 'uninstall',
  requestedById: 'admin-a',
  idempotencyKey: 'key-a',
};
const row = (sql: string) => world.database.prepare(sql).get();

describe('cleanup identifiers and evidence', () => {
  it('derives stable operation and audit identifiers from the request digest', async () => {
    const view = await world.service().request('test', REQUEST);
    expect(view?.operationId).toMatch(/^op_plugin_cleanup_[a-f0-9]{32}$/u);
    const suffix = view?.operationId.slice('op_plugin_cleanup_'.length);
    expect(
      row(
        `SELECT event_id FROM control_audit_events WHERE event_type = 'plugin.resources.cleanup.requested'`
      )
    ).toEqual({ event_id: `audit_plugin_cleanup_${suffix}` });
    const other = await cleanupWorld();
    const second = await other.service().request('test', { ...REQUEST, idempotencyKey: 'key-b' });
    expect(second?.operationId).not.toBe(view?.operationId);
    expect(second?.operationId).toMatch(/^op_plugin_cleanup_[a-f0-9]{32}$/u);
    other.database.close();
  });

  it.each([
    ['a prefix', 'xPRES_D1_AAAAAAAAAAAAAAAAAAAAAAAA'],
    ['a suffix', 'PRES_D1_AAAAAAAAAAAAAAAAAAAAAAAAx'],
    ['lowercase hex', 'PRES_D1_aaaaaaaaaaaaaaaaaaaaaaaa'],
    ['a short hex', 'PRES_D1_AAAAAAAAAAAAAAAAAAAAAAA'],
  ])('rejects a host binding with %s', async (_label, binding) => {
    seedBindingReconciliation(world, { hostBindings: [binding] });
    await expect(world.service().request('test', REQUEST)).rejects.toThrow(
      'control_plugin_cleanup_binding_plan_invalid'
    );
  });

  it.each(['!plugin-a', 'plugin-a!'])('rejects the plugin id %s', async (pluginId) => {
    await expect(world.service().request('test', { ...REQUEST, pluginId })).rejects.toThrow(
      'control_plugin_cleanup_request_invalid'
    );
  });

  async function drained(enabled = true) {
    world.database.exec('DELETE FROM control_plugin_resource_binding_reconciliations');
    const service = world.service(enabled);
    await service.request('test', REQUEST);
    await service.reconcile();
    return service;
  }

  it('records completion evidence under an identifier derived from the operation', async () => {
    const service = await drained();
    world.clients.d1.getD1Database.mockImplementation(async () => {
      throw Object.assign(new Error('not_found'), { status: 404 });
    });
    world.now.value = 1900;
    await service.reconcile();
    const operationId = (
      row('SELECT operation_id FROM control_plugin_resource_cleanup_operations') as {
        operation_id: string;
      }
    ).operation_id;
    expect(
      row(
        `SELECT event_id, actor_type, actor_id, resource_kind, outcome, redacted_payload_json, created_at
           FROM control_audit_events WHERE event_type = 'plugin.resources.cleanup.completed'`
      )
    ).toEqual({
      event_id: `audit_plugin_cleanup_complete_${operationId.slice(-48)}`,
      actor_type: 'worker',
      actor_id: 'ar-control',
      resource_kind: 'plugin_installation',
      outcome: 'succeeded',
      redacted_payload_json: JSON.stringify({ reason: 'uninstall', lifecycleGeneration: 1 }),
      created_at: 1900,
    });
  });

  it('blocks a retryable failure exactly when the two-hour retry budget is spent', async () => {
    const service = await drained();
    world.clients.d1.getD1Database.mockRejectedValue(new Error('provider_down'));
    world.now.value = 1900;
    await service.reconcile();
    expect(
      row("SELECT status FROM control_operations WHERE operation_kind = 'cleanup_plugin_resources'")
    ).toEqual({
      status: 'waiting_retry',
    });
    world.now.value = 1900 + 7200 - 1;
    world.database.exec(
      "UPDATE control_operations SET next_attempt_at = 0 WHERE operation_kind = 'cleanup_plugin_resources'"
    );
    await service.reconcile();
    expect(
      row("SELECT status FROM control_operations WHERE operation_kind = 'cleanup_plugin_resources'")
    ).toEqual({
      status: 'waiting_retry',
    });
    world.now.value = 1900 + 7200;
    world.database.exec(
      "UPDATE control_operations SET next_attempt_at = 0 WHERE operation_kind = 'cleanup_plugin_resources'"
    );
    await service.reconcile();
    expect(
      row(
        "SELECT status, last_error_code FROM control_operations WHERE operation_kind = 'cleanup_plugin_resources'"
      )
    ).toEqual({
      status: 'blocked',
      last_error_code: 'control_plugin_cleanup_provider_failed',
    });
  });

  it('evidences a retry request without storing the caller key', async () => {
    const service = await drained(false);
    world.now.value = 1900;
    await service.reconcile();
    world.now.value = 2000;
    await service.request('test', {
      ...REQUEST,
      requestedById: 'admin-b',
      idempotencyKey: 'secret-key',
    });
    const event = row(
      `SELECT event_id, actor_id, redacted_payload_json, created_at FROM control_audit_events
        WHERE event_type = 'plugin.resources.cleanup.retry_requested'`
    ) as { event_id: string; actor_id: string; redacted_payload_json: string; created_at: number };
    expect(event.event_id).toMatch(/^audit_plugin_cleanup_retry_[a-zA-Z0-9_]{1,32}_[a-f0-9]{16}$/u);
    expect(event.actor_id).toBe('admin-b');
    expect(event.created_at).toBe(2000);
    const payload = JSON.parse(event.redacted_payload_json) as Record<string, string>;
    expect(Object.keys(payload).sort()).toEqual(['idempotencyDigest', 'previousErrorCode']);
    expect(payload.idempotencyDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(payload.previousErrorCode).toBe('control_destructive_operations_disabled');
    expect(event.redacted_payload_json).not.toContain('secret-key');
    expect(event.event_id.endsWith(payload.idempotencyDigest?.slice(0, 16) ?? '?')).toBe(true);
  });
});
