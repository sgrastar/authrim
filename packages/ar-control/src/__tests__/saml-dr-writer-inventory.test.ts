import { describe, expect, it, vi } from 'vitest';
import type {
  CloudflareWorkerBinding,
  CloudflareWorkerDeployment,
  CloudflareWorkerVersionDetail,
} from '@authrim/ar-lib-core/control-plane';
import {
  SAML_DR_WRITER_COMPONENTS,
  samlDrWriterContractDigest,
  samlDrWriterSurfaces,
  type SamlDrWriterComponent,
  type SamlDrWriterProbe,
} from '@authrim/ar-lib-core/services/tenant-portability/saml-dr-writer-contract';
import {
  verifySamlDrSourceWriterInventory,
  verifyEnvironmentSamlDrWriterInventory,
} from '../saml-dr-writer-inventory';

function fixture() {
  const versions = new Map<string, CloudflareWorkerVersionDetail>();
  const deployments = new Map<string, CloudflareWorkerDeployment[]>();
  const scripts = SAML_DR_WRITER_COMPONENTS.map((component) => ({ id: `test-${component}` }));
  for (const component of SAML_DR_WRITER_COMPONENTS) {
    const workerName = `test-${component}`;
    const bindings: CloudflareWorkerBinding[] = [
      { type: 'plain_text', name: 'ENABLE_SAML_DR_EXPORT', text: 'true' },
      { type: 'plain_text', name: 'AUTHRIM_ENVIRONMENT_NAME', text: 'test' },
      { type: 'plain_text', name: 'AUTHRIM_WORKER_SCRIPT_NAME', text: workerName },
      { type: 'version_metadata', name: 'CONTROL_SMOKE_VERSION' },
      { type: 'd1', name: component === 'ar-control' ? 'CONTROL_DB' : 'DB', id: 'shared-database' },
    ];
    if (component === 'ar-control') {
      for (const target of SAML_DR_WRITER_COMPONENTS)
        bindings.push({
          type: 'service',
          name: `SMOKE_${target.replaceAll('-', '_').toUpperCase()}`,
          service: `test-${target}`,
          entrypoint: 'RuntimeSmokeEntrypoint',
          props: {
            caller: 'ar-control',
            audience: 'authrim-runtime-smoke-v1',
            environmentId: 'test',
            targetWorker: `test-${target}`,
          },
        });
    } else
      bindings.push({
        type: 'service',
        name: 'SAML_DR_MUTATION_CONTROL',
        service: 'test-ar-control',
        entrypoint: 'SamlDrMutationEntrypoint',
        props: {
          caller: component,
          audience: 'authrim-saml-dr-mutation-v1',
          environmentId: 'test',
        },
      });
    versions.set(workerName, { id: `${component}-v1`, resources: { bindings } });
    deployments.set(workerName, [
      {
        id: `${component}-d1`,
        created_on: '2026-10-26T00:00:00Z',
        source: 'api',
        strategy: 'percentage',
        versions: [{ percentage: 100, version_id: `${component}-v1` }],
      },
    ]);
  }
  const api = {
    listWorkerScriptsForInventory: vi.fn(async () => scripts),
    listWorkerDeployments: vi.fn(async (worker: string) => deployments.get(worker) ?? []),
    getWorkerVersion: vi.fn(async (worker: string) => versions.get(worker)!),
  };
  const probeWorker = vi.fn(
    async (component: SamlDrWriterComponent): Promise<SamlDrWriterProbe> => ({
      formatVersion: 1,
      environmentId: 'test',
      workerName: `test-${component}`,
      component,
      versionId: versions.get(`test-${component}`)!.id!,
      contractDigest: await samlDrWriterContractDigest(component),
      surfaces: samlDrWriterSurfaces(component),
    })
  );
  const input = {
    api,
    accountId: 'a'.repeat(32),
    environmentId: 'test',
    tenantId: 'tenant-a',
    probeWorker,
  };
  const bindings = (component: SamlDrWriterComponent) =>
    versions.get(`test-${component}`)!.resources.bindings!;
  return { input, api, versions, deployments, scripts, probeWorker, bindings };
}

describe('authoritative SAML DR source writer inventory', () => {
  it('pins all15 installed components and hashes configuration without returning plaintext secrets', async () => {
    const f = fixture();
    f.bindings('ar-auth').push({
      type: 'plain_text',
      name: 'PRIVATE_SETTING',
      text: 'do-not-persist-this',
    });
    const first = await verifySamlDrSourceWriterInventory(f.input);
    expect(first.workers).toHaveLength(15);
    expect(first.protectedResources).toEqual(['d1:shared-database']);
    expect(first.inventoryDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(first)).not.toContain('do-not-persist-this');
    expect(f.probeWorker).toHaveBeenCalledTimes(15);
    f.bindings('ar-auth').reverse();
    await expect(
      verifySamlDrSourceWriterInventory({ ...f.input, expectedReceipt: first })
    ).resolves.toEqual(first);
  });
  it('rejects an unrecognized holder outside the environment name prefix', async () => {
    const f = fixture();
    f.scripts.push({ id: 'unrelated-maintenance' });
    f.versions.set('unrelated-maintenance', {
      id: 'other-v1',
      resources: { bindings: [{ type: 'd1', name: 'ANY_NAME', id: 'shared-database' }] },
    });
    f.deployments.set('unrelated-maintenance', [
      {
        id: 'other-d1',
        created_on: '2026-10-26T00:00:00Z',
        source: 'api',
        strategy: 'percentage',
        versions: [{ percentage: 100, version_id: 'other-v1' }],
      },
    ]);
    await expect(verifySamlDrSourceWriterInventory(f.input)).rejects.toThrow(
      'saml_dr_writer_inventory_unexplained_holder'
    );
    expect(f.probeWorker).not.toHaveBeenCalled();
  });
  it('includes unrelated isolated Workers in the immutable receipt without trusting their names', async () => {
    const f = fixture();
    f.scripts.push({ id: 'unrelated-maintenance' });
    f.versions.set('unrelated-maintenance', {
      id: 'other-v1',
      resources: { bindings: [{ type: 'd1', name: 'DB', id: 'unrelated-db' }] },
    });
    f.deployments.set('unrelated-maintenance', [
      {
        id: 'other-d1',
        created_on: '2026-10-26T00:00:00Z',
        source: 'api',
        strategy: 'percentage',
        versions: [{ percentage: 100, version_id: 'other-v1' }],
      },
    ]);
    const receipt = await verifySamlDrSourceWriterInventory(f.input);
    expect(receipt.workers).toHaveLength(16);
    expect(receipt.protectedResources).not.toContain('d1:unrelated-db');
  });
  it('refuses the newest split deployment instead of accepting an older100% version', async () => {
    const f = fixture();
    f.deployments.get('test-ar-auth')!.unshift({
      id: 'split',
      created_on: '2026-10-26T00:01:00Z',
      source: 'api',
      strategy: 'percentage',
      versions: [
        { percentage: 90, version_id: 'ar-auth-v1' },
        { percentage: 10, version_id: 'ar-auth-v2' },
      ],
    });
    await expect(verifySamlDrSourceWriterInventory(f.input)).rejects.toThrow(
      'saml_dr_writer_inventory_deployment_not_pinned'
    );
  });
  it('refuses a missing required component rather than shrinking expected coverage', async () => {
    const f = fixture();
    f.scripts.pop();
    await expect(verifySamlDrSourceWriterInventory(f.input)).rejects.toThrow(
      'saml_dr_writer_inventory_component_missing'
    );
  });
  it('refuses version details that do not identify the deployed immutable version', async () => {
    const f = fixture();
    f.versions.get('test-ar-auth')!.id = 'other';
    await expect(verifySamlDrSourceWriterInventory(f.input)).rejects.toThrow(
      'saml_dr_writer_inventory_version_mismatch'
    );
  });
  it.each([
    'flag',
    'environment',
    'admission-service',
    'admission-props',
    'smoke-service',
    'metadata',
    'local-database',
  ])('rejects incorrect actual %s configuration', async (kind) => {
    const f = fixture();
    if (kind === 'flag')
      f.bindings('ar-auth').find((x) => x.name === 'ENABLE_SAML_DR_EXPORT')!.text = 'false';
    if (kind === 'environment')
      f.bindings('ar-auth').find((x) => x.name === 'AUTHRIM_ENVIRONMENT_NAME')!.text = 'other';
    if (kind === 'admission-service')
      f.bindings('ar-auth').find((x) => x.name === 'SAML_DR_MUTATION_CONTROL')!.service =
        'other-control';
    if (kind === 'admission-props')
      f.bindings('ar-auth').find((x) => x.name === 'SAML_DR_MUTATION_CONTROL')!.props = {
        caller: 'ar-management',
      };
    if (kind === 'smoke-service')
      f.bindings('ar-control').find((x) => x.name === 'SMOKE_AR_AUTH')!.service = 'old-auth';
    if (kind === 'metadata')
      f.bindings('ar-auth').find((x) => x.name === 'CONTROL_SMOKE_VERSION')!.type = 'plain_text';
    if (kind === 'local-database')
      f.bindings('ar-control').find((x) => x.name === 'CONTROL_DB')!.name = 'OTHER_DB';
    await expect(verifySamlDrSourceWriterInventory(f.input)).rejects.toThrow(
      'saml_dr_writer_inventory_'
    );
  });
  it.each(['versionId', 'contractDigest', 'environmentId', 'surfaces'] as const)(
    'rejects contradictory runtime probe %s',
    async (field) => {
      const f = fixture();
      const original = f.probeWorker.getMockImplementation()!;
      f.probeWorker.mockImplementation(async (component) => ({
        ...(await original(component)),
        [field]: field === 'surfaces' ? [] : 'wrong',
      }));
      await expect(verifySamlDrSourceWriterInventory(f.input)).rejects.toThrow(
        'saml_dr_writer_inventory_probe_mismatch'
      );
    }
  );
  it('fails the after-capture recheck when a valid new version replaced the previous one', async () => {
    const f = fixture();
    const expectedReceipt = await verifySamlDrSourceWriterInventory(f.input);
    f.versions.get('test-ar-auth')!.id = 'ar-auth-v2';
    f.deployments.get('test-ar-auth')![0].versions[0].version_id = 'ar-auth-v2';
    await expect(
      verifySamlDrSourceWriterInventory({ ...f.input, expectedReceipt })
    ).rejects.toThrow('saml_dr_writer_inventory_changed');
  });
  it('detects a new account script appearing during verification', async () => {
    const f = fixture();
    f.api.listWorkerScriptsForInventory
      .mockResolvedValueOnce(f.scripts)
      .mockResolvedValueOnce([...f.scripts, { id: 'new-script' }]);
    await expect(verifySamlDrSourceWriterInventory(f.input)).rejects.toThrow(
      'saml_dr_writer_inventory_changed'
    );
  });
  it('detects deployment changes while runtime probes are executing', async () => {
    const f = fixture();
    const original = f.probeWorker.getMockImplementation()!;
    f.probeWorker.mockImplementation(async (component) => {
      const probe = await original(component);
      if (component === 'ar-auth')
        f.deployments.get('test-ar-auth')![0].id = 'changed-during-probe';
      return probe;
    });
    await expect(verifySamlDrSourceWriterInventory(f.input)).rejects.toThrow(
      'saml_dr_writer_inventory_changed'
    );
  });
  it('rejects duplicate binding names and incomplete resource identities', async () => {
    const f = fixture();
    f.bindings('ar-auth').push({ type: 'kv_namespace', name: 'DB', namespace_id: 'namespace' });
    await expect(verifySamlDrSourceWriterInventory(f.input)).rejects.toThrow(
      'saml_dr_writer_inventory_binding_invalid'
    );
    const g = fixture();
    g.bindings('ar-auth').push({
      type: 'durable_object_namespace',
      name: 'DO',
      class_name: 'KeyManager',
    });
    await expect(verifySamlDrSourceWriterInventory(g.input)).rejects.toThrow(
      'saml_dr_writer_inventory_binding_invalid'
    );
  });
  it('does not create provider clients for a disabled environment', () => {
    expect(() =>
      verifyEnvironmentSamlDrWriterInventory({ ENABLE_SAML_DR_EXPORT: 'false' } as never, {
        tenantId: 'tenant-a',
      })
    ).toThrow('saml_dr_writer_inventory_unavailable');
  });
});

it('rejects a source DO owned by an unrecognized script without its own self-binding', async () => {
  const f = fixture();
  f.bindings('ar-auth').push({
    type: 'durable_object_namespace',
    name: 'KEY_MANAGER',
    namespace_id: 'keys-namespace',
    class_name: 'KeyManager',
    script_name: 'unrecognized-key-owner',
  });
  await expect(verifySamlDrSourceWriterInventory(f.input)).rejects.toThrow(
    'saml_dr_writer_inventory_durable_object_owner_unverified'
  );
});
it('accepts only an audited DO class on a known immutable owner version', async () => {
  const f = fixture();
  f.bindings('ar-auth').push({
    type: 'durable_object_namespace',
    name: 'KEY_MANAGER',
    namespace_id: 'keys-namespace',
    class_name: 'KeyManager',
    script_name: 'test-ar-lib-core',
  });
  await expect(verifySamlDrSourceWriterInventory(f.input)).resolves.toMatchObject({
    protectedResources: ['d1:shared-database', 'do:keys-namespace'],
  });
  f.bindings('ar-auth').find((binding) => binding.name === 'KEY_MANAGER')!.class_name =
    'NewUnreviewedStore';
  await expect(verifySamlDrSourceWriterInventory(f.input)).rejects.toThrow(
    'saml_dr_writer_inventory_durable_object_owner_unverified'
  );
});

it.each(['inherit', 'dispatch_namespace', 'unknown_future_store'])(
  'rejects unresolved or unsupported binding capability %s',
  async (type) => {
    const f = fixture();
    f.bindings('ar-auth').push({ type, name: 'UNKNOWN' });
    await expect(verifySamlDrSourceWriterInventory(f.input)).rejects.toThrow(
      'saml_dr_writer_inventory_binding_type_unsupported'
    );
  }
);
it('does not equate a Hyperdrive identity with an authoritative external database writer inventory', async () => {
  const f = fixture();
  f.bindings('ar-auth').push({ type: 'hyperdrive', name: 'EXTERNAL_DB', id: 'hyperdrive-id' });
  await expect(verifySamlDrSourceWriterInventory(f.input)).rejects.toThrow(
    'saml_dr_writer_inventory_external_source_unsupported'
  );
});

it('requires identical environment writer config and secret presence on every deployed holder', async () => {
  const f = fixture();
  const writer = {
    version: 2 as const,
    endpoint: 'https://authority.example.test/replication/v1/rpc',
    credentialId: 'writer',
    pairId: 'pair-a',
    environmentId: 'test',
    deploymentId: 'cf-a',
    epoch: 1,
    generationId: 'initial',
  };
  for (const component of SAML_DR_WRITER_COMPONENTS)
    f.bindings(component).push(
      { type: 'plain_text', name: 'AUTHRIM_REPLICATION_WRITER', text: JSON.stringify(writer) },
      { type: 'secret_text', name: 'AUTHRIM_REPLICATION_WRITER_SECRET' }
    );
  await expect(
    verifySamlDrSourceWriterInventory({ ...f.input, replicationWriter: writer })
  ).resolves.toHaveProperty('inventoryDigest');
  const bindings = f.bindings('ar-auth');
  bindings.splice(
    bindings.findIndex((b) => b.name === 'AUTHRIM_REPLICATION_WRITER_SECRET'),
    1
  );
  await expect(
    verifySamlDrSourceWriterInventory({ ...f.input, replicationWriter: writer })
  ).rejects.toThrow('replication_secret_missing');
  bindings.push({ type: 'secret_text', name: 'AUTHRIM_REPLICATION_WRITER_SECRET' });
  const binding = bindings.find((b) => b.name === 'AUTHRIM_REPLICATION_WRITER');
  if (!binding) throw new Error('fixture binding missing');
  binding.text = JSON.stringify({
    ...writer,
    environmentId: 'other',
  });
  await expect(
    verifySamlDrSourceWriterInventory({ ...f.input, replicationWriter: writer })
  ).rejects.toThrow('replication_configuration_mismatch');
});
