import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PluginDynamicWorkerDesiredStateService } from '../plugin-dynamic-worker-desired-state';
import { dropTriggers } from './support/sqlite-d1';
import {
  STATE_RESOURCE,
  aggregate,
  d1,
  seededDatabase,
  withStateResource,
} from './support/plugin-dynamic-fixtures';

type Json = Record<string, unknown>;
const INPUT = { tenantId: 'tenant-a', pluginId: 'plugin-a', enabled: true };
let database: DatabaseSync;
let service: PluginDynamicWorkerDesiredStateService;

beforeEach(() => {
  database = seededDatabase();
  service = new PluginDynamicWorkerDesiredStateService(d1(database), () => 1_800_000_000);
});
afterEach(() => database.close());

function mutateAggregate(mutate: (value: Json) => void, resources?: unknown[]): void {
  const value = JSON.parse(aggregate(undefined, resources)) as Json;
  mutate(value);
  database
    .prepare(
      `UPDATE control_external_capability_sources SET aggregate_json = ? WHERE source_id = 'plugin-a'`
    )
    .run(JSON.stringify(value));
}
const policy = (value: Json) => value.pluginPolicy as Json;
const worker = (value: Json) => (value.workers as Json[])[0];
const workerBindings = (value: Json) => worker(value).bindings as Json[];

describe('desired state request validation', () => {
  it.each([
    ['null', null],
    ['an array', []],
    ['a missing flag', { tenantId: 'tenant-a', pluginId: 'plugin-a' }],
    ['an extra key', { ...INPUT, extra: 1 }],
    ['a text flag', { ...INPUT, enabled: 'true' }],
    ['a non-array selection list', { ...INPUT, resourceSelections: {} }],
  ])('rejects %s', async (_label, input) => {
    await expect(service.plan('test', input)).rejects.toThrow(
      /^control_plugin_desired_state_invalid$/u
    );
  });

  it('rejects unsafe identifiers', async () => {
    await expect(service.plan('a b', INPUT)).rejects.toThrow(
      /^control_plugin_environment_invalid$/u
    );
    await expect(service.plan('test', { ...INPUT, tenantId: 'a b' })).rejects.toThrow(
      /^control_plugin_tenant_invalid$/u
    );
    await expect(service.plan('test', { ...INPUT, pluginId: '' })).rejects.toThrow(
      /^control_plugin_id_invalid$/u
    );
  });

  const selection = {
    logicalResourceId: 'plugin-state',
    mode: 'existing',
    providerResourceId: 'db-1',
    providerName: 'db-name',
  };
  it.each([
    ['a non-object entry', [null]],
    ['an array entry', [[]]],
    [
      'a missing key',
      [{ logicalResourceId: 'plugin-state', mode: 'existing', providerResourceId: 'x' }],
    ],
    ['an extra key', [{ ...selection, extra: 1 }]],
    ['an unsafe logical id', [{ ...selection, logicalResourceId: 'Plugin State' }]],
    ['a numeric logical id', [{ ...selection, logicalResourceId: 1 }]],
    ['a managed mode', [{ ...selection, mode: 'managed' }]],
    ['a duplicate entry', [selection, selection]],
    ['an unsafe provider id', [{ ...selection, providerResourceId: 'a b' }]],
    ['an unsafe provider name', [{ ...selection, providerName: '' }]],
  ])('rejects a selection with %s', async (_label, resourceSelections) => {
    await expect(service.plan('test', { ...INPUT, resourceSelections })).rejects.toThrow(
      /^control_plugin_resource_selection_invalid$/u
    );
  });

  it('rejects a selection for an undeclared resource', async () => {
    await expect(
      service.plan('test', { ...INPUT, resourceSelections: [selection] })
    ).rejects.toThrow(/^control_plugin_resource_selection_unknown$/u);
  });

  it('forbids selecting an existing resource unless the manifest allows it', async () => {
    withStateResource(database, [
      { ...STATE_RESOURCE, provisioning: { defaultMode: 'managed', allowExisting: false } },
    ]);
    await expect(
      service.plan('test', { ...INPUT, resourceSelections: [selection] })
    ).rejects.toThrow(/^control_plugin_existing_resource_forbidden$/u);
  });

  it('sorts the declared resources by logical id', async () => {
    withStateResource(database, [
      {
        ...STATE_RESOURCE,
        logicalResourceId: 'zeta',
        binding: 'ZETA',
        migrationStream: 'plugin/plugin-a/z',
      },
      STATE_RESOURCE,
    ]);
    const plan = await service.plan('test', INPUT);
    expect(plan.resources.map((resource) => resource.logicalResourceId)).toEqual([
      'plugin-state',
      'zeta',
    ]);
  });
});

describe('manifest availability', () => {
  it.each([
    ['an unknown plugin', { ...INPUT, pluginId: 'plugin-z' }, null],
    ['a flagged manifest', INPUT, 'flagged'],
    ['a rejected manifest', INPUT, 'rejected'],
  ])('is unavailable for %s', async (_label, input, review) => {
    if (review) {
      database.exec(
        `UPDATE control_external_capability_sources SET review_state = '${review}', reviewed_by = 'reviewer', reviewed_at = 1`
      );
    }
    await expect(service.plan('test', input)).rejects.toThrow(
      /^control_plugin_manifest_unavailable$/u
    );
  });

  it('still plans a disabled installation of a flagged or inactive manifest', async () => {
    database.exec(
      "UPDATE control_external_capability_sources SET review_state = 'flagged', reviewed_by = 'reviewer', reviewed_at = 1, status = 'disabled'"
    );
    await expect(service.plan('test', { ...INPUT, enabled: false })).resolves.toMatchObject({
      enabled: false,
    });
    await expect(service.plan('test', INPUT)).rejects.toThrow(
      /^control_plugin_manifest_unavailable$/u
    );
  });
});

describe('manifest aggregate validation', () => {
  it.each<[string, (value: Json) => void, string]>([
    [
      'another source kind',
      (value) => (value.sourceKind = 'core_manifest'),
      'control_plugin_manifest_invalid',
    ],
    [
      'another source id',
      (value) => (value.sourceId = 'plugin-b'),
      'control_plugin_manifest_invalid',
    ],
    ['a missing policy', (value) => delete value.pluginPolicy, 'control_plugin_manifest_invalid'],
    ['an array policy', (value) => (value.pluginPolicy = []), 'control_plugin_manifest_invalid'],
    [
      'another backend',
      (value) => (policy(value).backend = 'worker'),
      'control_plugin_manifest_invalid',
    ],
    [
      'another resource scope',
      (value) => (policy(value).resourceScope = 'global'),
      'control_plugin_manifest_invalid',
    ],
    ['no workers', (value) => (value.workers = []), 'control_plugin_manifest_invalid'],
    [
      'two workers',
      (value) => (value.workers = [worker(value), worker(value)]),
      'control_plugin_manifest_invalid',
    ],
    ['a text worker list', (value) => (value.workers = 'x'), 'control_plugin_manifest_invalid'],
    ['a null worker', (value) => (value.workers = [null]), 'control_plugin_manifest_invalid'],
    ['an array worker', (value) => (value.workers = [[]]), 'control_plugin_manifest_invalid'],
    [
      'another worker reference',
      (value) => (worker(value).workerReference = 'plugin:b'),
      'control_plugin_manifest_invalid',
    ],
    [
      'a script name',
      (value) => (worker(value).scriptName = 'script'),
      'control_plugin_manifest_invalid',
    ],
    [
      'a non-array binding list',
      (value) => (worker(value).bindings = {}),
      'control_plugin_manifest_invalid',
    ],
    [
      'sixty-five worker bindings',
      (value) => (worker(value).bindings = Array.from({ length: 65 }, () => ({}))),
      'control_plugin_manifest_invalid',
    ],
    [
      'a null binding',
      (value) => (worker(value).bindings = [null]),
      'control_plugin_manifest_binding_invalid',
    ],
    [
      'a lowercase binding name',
      (value) => (workerBindings(value)[0].name = 'tenant_profile'),
      'control_plugin_manifest_binding_invalid',
    ],
    [
      'another binding kind',
      (value) => (workerBindings(value)[0].kind = 'd1'),
      'control_plugin_manifest_binding_invalid',
    ],
    [
      'another binding scope',
      (value) => (workerBindings(value)[0].scope = 'global'),
      'control_plugin_manifest_binding_invalid',
    ],
    [
      'a binding reason',
      (value) => (workerBindings(value)[0].reason = 'why'),
      'control_plugin_manifest_binding_invalid',
    ],
    [
      'a raw data binding',
      (value) => (workerBindings(value)[0].name = 'DB'),
      'control_plugin_manifest_binding_invalid',
    ],
    [
      'a Cloudflare token binding',
      (value) => (workerBindings(value)[0].name = 'CLOUDFLARE_D1_API_TOKEN'),
      'control_plugin_manifest_binding_invalid',
    ],
    [
      'a duplicate binding',
      (value) => (worker(value).bindings = [workerBindings(value)[0], workerBindings(value)[0]]),
      'control_plugin_manifest_binding_invalid',
    ],
    [
      'another interface',
      (value) => (workerBindings(value)[0].capability = 'unknown.v1'),
      'control_plugin_manifest_binding_invalid',
    ],
    [
      'host interfaces that differ',
      (value) => (policy(value).hostInterfaces = []),
      'control_plugin_manifest_binding_mismatch',
    ],
    [
      'a missing mutation scope',
      (value) => (policy(value).capabilities = [{ mutationScopes: [] }]),
      'control_plugin_manifest_binding_invalid',
    ],
    [
      'missing capabilities',
      (value) => delete policy(value).capabilities,
      'control_plugin_manifest_binding_invalid',
    ],
    [
      'a null capability',
      (value) => (policy(value).capabilities = [null]),
      'control_plugin_manifest_binding_invalid',
    ],
    [
      'non-array mutation scopes',
      (value) => (policy(value).capabilities = [{ mutationScopes: 'account.metadata.write' }]),
      'control_plugin_manifest_binding_invalid',
    ],
  ])('rejects a manifest with %s', async (_label, mutate, code) => {
    mutateAggregate(mutate);
    await expect(service.plan('test', INPUT)).rejects.toThrow(new RegExp(`^${code}$`, 'u'));
  });

  it('rejects an aggregate that is not an object', async () => {
    database.exec("UPDATE control_external_capability_sources SET aggregate_json = '[]'");
    await expect(service.plan('test', INPUT)).rejects.toThrow(/^control_plugin_manifest_invalid$/u);
  });

  it('accepts exactly sixty-four worker bindings', async () => {
    const names = Array.from({ length: 64 }, (_, index) => `BINDING_${index}`);
    const interfaceId = 'authrim.account_metadata.v1';
    mutateAggregate((value) => {
      worker(value).bindings = names.map((name) => ({
        name,
        kind: 'plugin_interface',
        capability: interfaceId,
        scope: 'tenant',
        reason: null,
      }));
      policy(value).hostInterfaces = names.map((name) => ({
        name,
        interface: interfaceId,
        scope: 'tenant',
      }));
    });
    database.exec('DELETE FROM control_external_capability_bindings');
    for (const name of names) {
      database
        .prepare(
          `INSERT INTO control_external_capability_bindings (
             environment_id, source_kind, source_id, worker_reference, worker_script_name,
             binding_name, binding_kind, capability, capability_scope, reason, updated_at
           ) VALUES ('test', 'plugin_manifest', 'plugin-a', 'plugin:plugin-a', NULL, ?,
                     'plugin_interface', ?, 'tenant', NULL, 1)`
        )
        .run(name, interfaceId);
    }
    const plan = await service.plan('test', INPUT);
    expect(plan.bindings).toHaveLength(64);
  });

  it.each<[string, (row: Json) => void]>([
    ['another worker reference', (row) => (row.worker_reference = 'plugin:b')],
    ['another scope', (row) => (row.capability_scope = 'platform')],
  ])('rejects a registered binding with %s', async (_label, mutate) => {
    const row: Json = {
      worker_reference: 'plugin:plugin-a',
      binding_kind: 'plugin_interface',
      capability_scope: 'tenant',
    };
    mutate(row);
    database
      .prepare(
        `UPDATE control_external_capability_bindings
            SET worker_reference = ?, binding_kind = ?, capability_scope = ?`
      )
      .run(String(row.worker_reference), String(row.binding_kind), String(row.capability_scope));
    await expect(service.plan('test', INPUT)).rejects.toThrow(
      /^control_plugin_manifest_binding_invalid$/u
    );
  });

  it.each<[string, (resource: Json) => void]>([
    ['another schema version', (resource) => (resource.schemaVersion = 2)],
    ['an unsafe logical id', (resource) => (resource.logicalResourceId = 'State')],
    ['a lowercase binding', (resource) => (resource.binding = 'plugin_state')],
    ['a raw data binding name', (resource) => (resource.binding = 'DB')],
    ['a token binding name', (resource) => (resource.binding = 'CF_API_TOKEN')],
    ['an unknown kind', (resource) => (resource.kind = 'queue')],
    ['another scope', (resource) => (resource.scope = 'global')],
    ['an unknown access', (resource) => (resource.access = 'admin')],
    [
      'another default mode',
      (resource) => (resource.provisioning = { defaultMode: 'existing', allowExisting: true }),
    ],
    [
      'a text allow-existing flag',
      (resource) => (resource.provisioning = { defaultMode: 'managed', allowExisting: 'yes' }),
    ],
    [
      'an extra provisioning key',
      (resource) =>
        (resource.provisioning = { defaultMode: 'managed', allowExisting: true, extra: 1 }),
    ],
    ['a d1 without a migration stream', (resource) => (resource.migrationStream = null)],
    ['an unsafe migration stream', (resource) => (resource.migrationStream = 'A B')],
    [
      'a kv with a migration stream',
      (resource) => (
        (resource.kind = 'kv_namespace'),
        (resource.migrationStream = 'plugin/plugin-a/state')
      ),
    ],
    ['an extra key', (resource) => (resource.extra = 1)],
  ])('rejects a resource with %s', async (_label, mutate) => {
    const resource = { ...STATE_RESOURCE } as Json;
    mutate(resource);
    mutateAggregate(() => undefined, [resource]);
    await expect(service.plan('test', INPUT)).rejects.toThrow(
      /^control_plugin_manifest_resource_invalid$/u
    );
  });

  it('rejects duplicate resource logical ids and bindings', async () => {
    mutateAggregate(() => undefined, [STATE_RESOURCE, { ...STATE_RESOURCE, binding: 'OTHER' }]);
    await expect(service.plan('test', INPUT)).rejects.toThrow(
      /^control_plugin_manifest_resource_invalid$/u
    );
    mutateAggregate(
      () => undefined,
      [STATE_RESOURCE, { ...STATE_RESOURCE, logicalResourceId: 'other' }]
    );
    await expect(service.plan('test', INPUT)).rejects.toThrow(
      /^control_plugin_manifest_resource_invalid$/u
    );
  });

  it('accepts a kv resource with a null migration stream and sixteen resources', async () => {
    const resources = Array.from({ length: 16 }, (_, index) => ({
      ...STATE_RESOURCE,
      logicalResourceId: `kv-${index}`,
      binding: `KV_${index}`,
      kind: 'kv_namespace',
      migrationStream: null,
    }));
    mutateAggregate(() => undefined, resources);
    const plan = await service.plan('test', INPUT);
    expect(plan.resources).toHaveLength(16);
    expect(plan.resources.every((resource) => resource.migrationStream === null)).toBe(true);
    mutateAggregate(
      () => undefined,
      [...resources, { ...resources[0], logicalResourceId: 'kv-16', binding: 'KV_16' }]
    );
    await expect(service.plan('test', INPUT)).rejects.toThrow(
      /^control_plugin_manifest_resource_invalid$/u
    );
    mutateAggregate((value) => (policy(value).resources = {}));
    await expect(service.plan('test', INPUT)).rejects.toThrow(
      /^control_plugin_manifest_resource_invalid$/u
    );
  });
});

describe('observed state sync validation', () => {
  const observed = {
    installationId: 'installation-1',
    tenantId: 'tenant-a',
    pluginId: 'plugin-a',
    state: 'enabled',
    configVersion: 1,
    pinnedVersionDigest: 'a'.repeat(64),
    resourceSelections: [],
  };

  it.each([
    ['null', null],
    [
      'a missing key',
      Object.fromEntries(Object.entries(observed).filter(([key]) => key !== 'resourceSelections')),
    ],
    ['an extra key', { ...observed, extra: 1 }],
    ['an unknown state', { ...observed, state: 'paused' }],
    ['a zero version', { ...observed, configVersion: 0 }],
    ['a fractional version', { ...observed, configVersion: 1.5 }],
    ['a version above the signed maximum', { ...observed, configVersion: 2_147_483_648 }],
    ['a short digest', { ...observed, pinnedVersionDigest: 'abc' }],
    ['a numeric digest', { ...observed, pinnedVersionDigest: 5 }],
    ['an enabled state without a digest', { ...observed, pinnedVersionDigest: null }],
  ])('rejects %s', async (_label, input) => {
    await expect(service.sync('test', input)).rejects.toThrow(
      /^control_plugin_observed_state_invalid$/u
    );
  });

  it('accepts the maximum version and a disabled state without a digest', async () => {
    const plan = await service.plan('test', INPUT);
    await expect(
      service.sync('test', {
        ...observed,
        installationId: plan.installationId,
        state: 'disabled',
        pinnedVersionDigest: null,
        configVersion: 2_147_483_647,
      })
    ).resolves.toMatchObject({ state: 'disabled', configVersion: 2_147_483_647 });
  });

  it('rejects unsafe observed identifiers', async () => {
    await expect(service.sync('test', { ...observed, installationId: 'a b' })).rejects.toThrow(
      /^control_plugin_installation_invalid$/u
    );
    await expect(service.sync('test', { ...observed, tenantId: '' })).rejects.toThrow(
      /^control_plugin_tenant_invalid$/u
    );
    await expect(service.sync('test', { ...observed, pluginId: '' })).rejects.toThrow(
      /^control_plugin_id_invalid$/u
    );
  });

  it('rejects an installation id that does not match the derived installation', async () => {
    await expect(service.sync('test', observed)).rejects.toThrow(
      /^control_plugin_installation_mismatch$/u
    );
  });

  it('refuses an enabled sync while a declared resource is not active', async () => {
    withStateResource(database);
    const plan = await service.plan('test', INPUT);
    await expect(
      service.sync('test', { ...observed, installationId: plan.installationId })
    ).rejects.toThrow(/^control_plugin_resources_not_ready$/u);
  });
});

describe('getPreparation', () => {
  it('is null for a disabled or resource-less installation', async () => {
    await expect(service.getPreparation('test', { ...INPUT, enabled: false })).resolves.toBeNull();
    await expect(service.getPreparation('test', INPUT)).resolves.toBeNull();
  });

  it('is null when a declared resource was never prepared', async () => {
    withStateResource(database);
    await expect(service.getPreparation('test', INPUT)).resolves.toBeNull();
  });

  it('follows a prepared installation through readiness and cleanup', async () => {
    withStateResource(database);
    const prepared = await service.prepare('test', INPUT);
    dropTriggers(database);
    await expect(service.getPreparation('test', INPUT)).resolves.toMatchObject({
      operationId: prepared.operationId,
      readiness: 'pending',
    });
    database.exec("UPDATE control_plugin_desired_resources SET status = 'failed'");
    await expect(service.getPreparation('test', INPUT)).resolves.toMatchObject({
      readiness: 'blocked',
    });
    database.exec("UPDATE control_plugin_desired_resources SET status = 'active'");
    await expect(service.getPreparation('test', INPUT)).resolves.toMatchObject({
      readiness: 'ready',
    });
  });

  it('rejects stored resources that no longer match the manifest', async () => {
    withStateResource(database);
    await service.prepare('test', INPUT);
    database.exec(
      "UPDATE control_plugin_desired_resources SET desired_spec_json = json_set(desired_spec_json, '$.access', 'read_only')"
    );
    await expect(service.getPreparation('test', INPUT)).rejects.toThrow(
      /^control_plugin_resource_immutable$/u
    );
  });
});
