import { describe, expect, it } from 'vitest';
import {
  backupWorld,
  seedSourceInstallation,
  SOURCE_KEY,
  type BackupWorld,
} from './helpers/backup-world';
import { seedInstallation, seedPlugin, VERSION_1, VERSION_2 } from './helpers/dynamic-plugin-seed';
import { DynamicPluginTenantBackupService } from '../tenant-backup';

const query = { tenantId: 'tenant-a', pluginId: 'plugin-a' };
const INVALID = /^plugin_dynamic_backup_input_invalid$/u;

function resourceRow(
  world: BackupWorld,
  installationId: string,
  over: Record<string, string> = {}
) {
  world.database
    .prepare(
      `INSERT INTO plugin_runner_dynamic_worker_resources (
         installation_id, tenant_id, plugin_id, logical_resource_id, logical_binding_name,
         host_binding_ref, resource_kind, access_mode, ownership_fingerprint,
         control_operation_id, state, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'op-1', 'active', 1)`
    )
    .run(
      installationId,
      over.tenant ?? 'tenant-a',
      over.plugin ?? 'plugin-a',
      over.logical ?? 'state',
      over.binding ?? 'PLUGIN_STATE',
      over.host ?? `PRES_D1_${'A'.repeat(24)}`,
      over.kind ?? 'd1',
      over.access ?? 'read_write',
      'a'.repeat(64)
    );
}

describe('export input', () => {
  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'x'],
    ['an extra key', { ...query, extra: 1 }],
    ['a missing key', { tenantId: 'tenant-a' }],
    ['a numeric tenant', { ...query, tenantId: 5 }],
    ['an unsafe tenant', { ...query, tenantId: '-a' }],
    ['a numeric plugin', { ...query, pluginId: 5 }],
    ['an unsafe plugin', { ...query, pluginId: 'Plugin' }],
  ])('rejects %s', async (_label, input) => {
    const world = backupWorld();
    await expect(world.service().export(input)).rejects.toThrow(INVALID);
    expect(world.calls).toEqual([]);
  });
  it('needs the D1 sessions API', async () => {
    const world = backupWorld('source', SOURCE_KEY, { withoutSession: true });
    await expect(world.service().export(query)).rejects.toThrow(
      /^plugin_dynamic_installation_d1_session_required$/u
    );
  });
});

describe('export', () => {
  it('answers null for a tenant that never configured the plugin', async () => {
    const world = backupWorld();
    await expect(world.service().export(query)).resolves.toBeNull();
  });
  it('refuses a blocked installation', async () => {
    const world = backupWorld();
    await seedInstallation(world.database, { state: 'blocked', environmentId: 'source' });
    await expect(world.service().export(query)).rejects.toThrow(
      /^plugin_dynamic_backup_source_blocked$/u
    );
  });
  it('refuses when the plugin is no longer approved', async () => {
    const world = backupWorld();
    await seedSourceInstallation(world);
    world.database.exec("UPDATE plugin_runner_dynamic_worker_manifests SET state = 'revoked'");
    await expect(world.service().export(query)).rejects.toThrow(
      /^plugin_dynamic_backup_version_unavailable$/u
    );
  });
  it('exports a disabled installation with its decrypted credentials', async () => {
    const world = backupWorld();
    const installationId = await seedSourceInstallation(world);
    await expect(world.service().export(query)).resolves.toEqual({
      tenantId: 'tenant-a',
      sourceInstallationId: installationId,
      pluginId: 'plugin-a',
      versionDigest: VERSION_1,
      contractVersion: 1,
      enabled: false,
      credentials: { apiKey: 'source-secret' },
      resources: [],
      mutationScopes: [],
    });
  });
  it('exports an enabled installation with scopes and resources', async () => {
    const world = backupWorld();
    const installationId = await seedSourceInstallation(world, { enabled: true, scope: true });
    resourceRow(world, installationId);
    resourceRow(world, installationId, {
      logical: 'cache',
      binding: 'PLUGIN_CACHE',
      host: `PRES_KV_${'B'.repeat(24)}`,
      kind: 'kv_namespace',
      access: 'read_only',
    });
    await expect(world.service().export(query)).resolves.toMatchObject({
      enabled: true,
      mutationScopes: ['account.metadata.write'],
      resources: [
        {
          logicalResourceId: 'cache',
          binding: 'PLUGIN_CACHE',
          kind: 'kv_namespace',
          access: 'read_only',
        },
        { logicalResourceId: 'state', binding: 'PLUGIN_STATE', kind: 'd1', access: 'read_write' },
      ],
    });
  });
  it('reports the pinned release rather than the newest approved one', async () => {
    const world = backupWorld();
    await seedSourceInstallation(world, { enabled: true });
    seedPlugin(world.database, {
      version: VERSION_2,
      slots: [{ configKey: 'apiKey', required: true }],
    });
    await expect(world.service().export(query)).resolves.toMatchObject({
      versionDigest: VERSION_1,
    });
  });
  it('falls back to the approved release for an installation without a pin', async () => {
    const world = backupWorld();
    await seedSourceInstallation(world);
    seedPlugin(world.database, {
      version: VERSION_2,
      slots: [{ configKey: 'apiKey', required: true }],
    });
    await expect(world.service().export(query)).resolves.toMatchObject({
      versionDigest: VERSION_2,
    });
  });
  it('only exports scopes that are enabled', async () => {
    const world = backupWorld();
    const installationId = await seedSourceInstallation(world, { scope: true });
    world.database.exec(
      `UPDATE plugin_runner_installation_mutation_scopes SET state = 'disabled' WHERE installation_id = '${installationId}'`
    );
    await expect(world.service().export(query)).resolves.toMatchObject({ mutationScopes: [] });
  });
  it('decrypts credentials written under a previous key', async () => {
    const world = backupWorld(
      'source',
      'new-plugin-runner-encryption-key-value-1',
      {},
      {
        PLUGIN_ENCRYPTION_ACTIVE_KEY_ID: 'v2',
        PLUGIN_ENCRYPTION_KEY_PREVIOUS: SOURCE_KEY,
        PLUGIN_ENCRYPTION_PREVIOUS_KEY_ID: 'v1',
      }
    );
    await seedSourceInstallation(world, { key: SOURCE_KEY });
    await expect(world.service().export(query)).resolves.toMatchObject({
      credentials: { apiKey: 'source-secret' },
    });
  });
  it('fails when a credential was written under an unknown key id', async () => {
    const world = backupWorld();
    await seedSourceInstallation(world);
    world.database.exec("UPDATE plugin_runner_encrypted_configs SET encryption_key_id = 'v9'");
    await expect(world.service().export(query)).rejects.toThrow(
      /^plugin_encryption_key_unavailable$/u
    );
  });
  it('fails when a credential cannot be decrypted for this tenant', async () => {
    const world = backupWorld();
    await seedSourceInstallation(world);
    await expect(
      new DynamicPluginTenantBackupService(
        { ...world.env, PLUGIN_ENCRYPTION_KEY: 'other-plugin-runner-encryption-key-value' },
        () => 20
      ).export(query)
    ).rejects.toThrow();
  });
  it('binds the reads to the installation and its config version', async () => {
    const world = backupWorld();
    const installationId = await seedSourceInstallation(world, { scope: true });
    await world.service().export(query);
    const reads = world.calls.filter((c) => c.kind === 'all');
    expect(
      reads.find(
        (c) =>
          c.sql.includes('plugin_runner_encrypted_configs') && c.sql.includes('encrypted_value')
      )?.values
    ).toEqual([installationId, 2]);
    expect(
      reads.find((c) => c.sql.includes('plugin_runner_dynamic_worker_resources'))?.values
    ).toEqual([installationId]);
    expect(reads.find((c) => c.sql.includes('mutation_scope'))?.values).toEqual([installationId]);
  });

  describe('storage answers that break the bounds', () => {
    const tooMany = (marker: string, count: number, row: (i: number) => unknown) => ({
      intercept: (call: { kind: string; sql: string }) =>
        call.kind === 'all' && call.sql.includes(marker)
          ? {
              value: {
                success: true,
                results: Array.from({ length: count }, (_, i) => row(i)),
                meta: {},
              },
            }
          : undefined,
    });
    const credentialRow = (i: number) => ({
      config_key: `k${i}`,
      config_version: 2,
      encryption_key_id: 'v1',
      encrypted_value: 'enc:v1:x',
    });
    it('rejects seventeen credential rows', async () => {
      const world = backupWorld(
        'source',
        SOURCE_KEY,
        tooMany('encrypted_value', 17, credentialRow)
      );
      await seedSourceInstallation(world);
      await expect(world.service().export(query)).rejects.toThrow(INVALID);
    });
    it('rejects seventeen resource rows', async () => {
      const world = backupWorld(
        'source',
        SOURCE_KEY,
        tooMany('plugin_runner_dynamic_worker_resources', 17, () => ({}))
      );
      await seedSourceInstallation(world);
      await expect(world.service().export(query)).rejects.toThrow(INVALID);
    });
    it('rejects seventeen scope rows', async () => {
      const world = backupWorld(
        'source',
        SOURCE_KEY,
        tooMany('mutation_scope', 17, () => ({ mutation_scope: 'account.metadata.write' }))
      );
      await seedSourceInstallation(world);
      await expect(world.service().export(query)).rejects.toThrow(INVALID);
    });
    it('rejects a credential row with an unsafe key or version', async () => {
      for (const patch of [
        { config_key: '1bad' },
        { config_version: 0 },
        { config_version: 'x' },
      ]) {
        const world = backupWorld('source', SOURCE_KEY, {
          intercept: (call) =>
            call.kind === 'all' && call.sql.includes('encrypted_value')
              ? {
                  value: {
                    success: true,
                    results: [{ ...credentialRow(0), ...patch }],
                    meta: {},
                  },
                }
              : undefined,
        });
        await seedSourceInstallation(world);
        await expect(world.service().export(query)).rejects.toThrow(INVALID);
      }
    });
    it('rejects a resource row of another tenant or plugin', async () => {
      for (const patch of [{ tenant_id: 'tenant-b' }, { plugin_id: 'plugin-b' }]) {
        const world = backupWorld('source', SOURCE_KEY, {
          intercept: (call) =>
            call.kind === 'all' && call.sql.includes('plugin_runner_dynamic_worker_resources')
              ? {
                  value: {
                    success: true,
                    results: [
                      {
                        tenant_id: 'tenant-a',
                        plugin_id: 'plugin-a',
                        logical_resource_id: 'state',
                        logical_binding_name: 'PLUGIN_STATE',
                        resource_kind: 'd1',
                        access_mode: 'read_write',
                        ...patch,
                      },
                    ],
                    meta: {},
                  },
                }
              : undefined,
        });
        await seedSourceInstallation(world);
        await expect(world.service().export(query)).rejects.toThrow(INVALID);
      }
    });
    it('rejects an exported shape the portable contract would not accept', async () => {
      const world = backupWorld('source', SOURCE_KEY, {
        intercept: (call) =>
          call.kind === 'all' && call.sql.includes('plugin_runner_dynamic_worker_resources')
            ? {
                value: {
                  success: true,
                  results: [
                    {
                      tenant_id: 'tenant-a',
                      plugin_id: 'plugin-a',
                      logical_resource_id: 'state',
                      logical_binding_name: 'lowercase',
                      resource_kind: 'd1',
                      access_mode: 'read_write',
                    },
                  ],
                  meta: {},
                },
              }
            : undefined,
      });
      await seedSourceInstallation(world);
      await expect(world.service().export(query)).rejects.toThrow(INVALID);
    });
  });
});
