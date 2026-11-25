import { describe, expect, it, vi } from 'vitest';
import {
  backupWorld,
  configuration,
  restoreOperationId,
  seedSourceInstallation,
  TARGET_KEY,
  type BackupWorld,
} from './helpers/backup-world';
import { digest, seedInstallation } from './helpers/dynamic-plugin-seed';

const INVALID = /^plugin_dynamic_backup_input_invalid$/u;
const target = () => backupWorld('target', TARGET_KEY);
const restore = (world: BackupWorld, value: unknown, now = () => 30) =>
  world.service(now).restore(value);
const request = (over: Record<string, unknown> = {}) => ({
  operationId: 'restore-a',
  configuration: configuration(),
  ...over,
});
const withConfiguration = (over: Record<string, unknown>) =>
  request({ configuration: { ...configuration(), ...over } });
const installationRows = (world: BackupWorld) =>
  world.database.prepare('SELECT * FROM plugin_runner_installations').all();

describe('restore input', () => {
  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'x'],
    ['an extra key', { ...request(), extra: 1 }],
    ['no configuration', { operationId: 'restore-a' }],
    ['no operation id', { configuration: configuration() }],
    ['a numeric operation id', request({ operationId: 5 })],
    ['an unsafe operation id', request({ operationId: '-x' })],
    ['an empty operation id', request({ operationId: '' })],
  ])('rejects %s', async (_label, value) => {
    const world = target();
    await expect(restore(world, value)).rejects.toThrow(INVALID);
    expect(world.calls).toEqual([]);
  });
  it.each([
    ['null', null],
    ['an array', []],
    ['an extra key', { ...configuration(), extra: 1 }],
    ['a missing key', { ...configuration(), resources: undefined }],
    ['another contract version', configuration({ contractVersion: 2 as never })],
    ['a numeric tenant', configuration({ tenantId: 5 as never })],
    ['an unsafe tenant', configuration({ tenantId: '-a' })],
    ['a numeric source installation', configuration({ sourceInstallationId: 5 as never })],
    ['an unsafe source installation', configuration({ sourceInstallationId: ' ' })],
    ['an unsafe plugin', configuration({ pluginId: 'Plugin' })],
    ['a numeric plugin', configuration({ pluginId: 5 as never })],
    ['a short digest', configuration({ versionDigest: 'a'.repeat(63) })],
    ['an uppercase digest', configuration({ versionDigest: 'A'.repeat(64) })],
    ['a digest with a suffix', configuration({ versionDigest: `${'a'.repeat(64)}0` })],
    ['a numeric digest', configuration({ versionDigest: 5 as never })],
    ['a non-boolean enabled flag', configuration({ enabled: 'true' as never })],
    ['null credentials', configuration({ credentials: null as never })],
    ['array credentials', configuration({ credentials: [] as never })],
    ['string credentials', configuration({ credentials: 'x' as never })],
    ['an unsafe credential key', configuration({ credentials: { '1a': 'v' } })],
    ['an empty credential', configuration({ credentials: { apiKey: '' } })],
    ['a numeric credential', configuration({ credentials: { apiKey: 5 as never } })],
    ['an oversized credential', configuration({ credentials: { apiKey: 'x'.repeat(8_193) } })],
    [
      'seventeen credentials',
      configuration({
        credentials: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, 'v'])),
      }),
    ],
    ['non-array resources', configuration({ resources: {} as never })],
    [
      'seventeen resources',
      configuration({
        resources: Array.from({ length: 17 }, (_, i) => ({
          logicalResourceId: `r${i}`,
          binding: `B${i}`,
          kind: 'd1',
          access: 'read_only',
        })) as never,
      }),
    ],
    ['a null resource', configuration({ resources: [null] as never })],
    ['an array resource', configuration({ resources: [[]] as never })],
    [
      'a resource with an extra key',
      configuration({
        resources: [
          { logicalResourceId: 'a', binding: 'A', kind: 'd1', access: 'read_only', x: 1 },
        ] as never,
      }),
    ],
    [
      'an unsafe logical id',
      configuration({
        resources: [
          { logicalResourceId: 'A', binding: 'A', kind: 'd1', access: 'read_only' },
        ] as never,
      }),
    ],
    [
      'a lowercase binding',
      configuration({
        resources: [
          { logicalResourceId: 'a', binding: 'a', kind: 'd1', access: 'read_only' },
        ] as never,
      }),
    ],
    [
      'an unknown kind',
      configuration({
        resources: [
          { logicalResourceId: 'a', binding: 'A', kind: 'queue', access: 'read_only' },
        ] as never,
      }),
    ],
    [
      'an unknown access',
      configuration({
        resources: [{ logicalResourceId: 'a', binding: 'A', kind: 'd1', access: 'admin' }] as never,
      }),
    ],
    [
      'duplicate logical ids',
      configuration({
        resources: [
          { logicalResourceId: 'a', binding: 'A', kind: 'd1', access: 'read_only' },
          { logicalResourceId: 'a', binding: 'B', kind: 'd1', access: 'read_only' },
        ] as never,
      }),
    ],
    [
      'duplicate bindings',
      configuration({
        resources: [
          { logicalResourceId: 'a', binding: 'A', kind: 'd1', access: 'read_only' },
          { logicalResourceId: 'b', binding: 'A', kind: 'd1', access: 'read_only' },
        ] as never,
      }),
    ],
    ['non-array scopes', configuration({ mutationScopes: {} as never })],
    ['an unknown scope', configuration({ mutationScopes: ['account.metadata.read'] as never })],
    ['a numeric scope', configuration({ mutationScopes: [5] as never })],
    [
      'duplicate scopes',
      configuration({
        mutationScopes: ['account.metadata.write', 'account.metadata.write'] as never,
      }),
    ],
  ])('rejects a configuration with %s', async (_label, config) => {
    const world = target();
    await expect(
      restore(world, { operationId: 'restore-a', configuration: config })
    ).rejects.toThrow(INVALID);
    expect(world.calls).toEqual([]);
  });
  it('accepts sixteen credentials and a credential of exactly 8192 characters at the contract level', async () => {
    const world = target();
    await expect(
      restore(
        world,
        withConfiguration({
          credentials: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, 'v'])),
        })
      )
    ).rejects.toThrow(/^plugin_dynamic_credentials_policy_mismatch$/u);
    await expect(
      restore(world, withConfiguration({ credentials: { apiKey: 'x'.repeat(8_192) } }))
    ).resolves.toMatchObject({ state: 'disabled' });
  });
});

describe('restore preconditions', () => {
  it('refuses a plugin that is not approved in the target', async () => {
    const world = target();
    world.database.exec("UPDATE plugin_runner_dynamic_worker_manifests SET state = 'staging'");
    await expect(restore(world, request())).rejects.toThrow(
      /^plugin_dynamic_backup_version_mismatch$/u
    );
    expect(installationRows(world)).toEqual([]);
  });
  it('refuses another release than the target runs', async () => {
    const world = target();
    await expect(restore(world, withConfiguration({ versionDigest: digest('9') }))).rejects.toThrow(
      /^plugin_dynamic_backup_version_mismatch$/u
    );
  });
  it('refuses a blocked target', async () => {
    const world = target();
    await seedInstallation(world.database, { state: 'blocked', environmentId: 'target' });
    await expect(restore(world, request())).rejects.toThrow(
      /^plugin_dynamic_backup_target_blocked$/u
    );
  });
  it('requires resources to exist in the target exactly as backed up', async () => {
    const world = target();
    const resource = {
      logicalResourceId: 'state',
      binding: 'PLUGIN_STATE',
      kind: 'd1' as const,
      access: 'read_write' as const,
    };
    await expect(restore(world, withConfiguration({ resources: [resource] }))).rejects.toThrow(
      /^plugin_dynamic_backup_resources_required$/u
    );
    const id = await seedInstallation(world.database, { environmentId: 'target' });
    world.database
      .prepare(
        `INSERT INTO plugin_runner_dynamic_worker_resources (installation_id, tenant_id, plugin_id, logical_resource_id, logical_binding_name, host_binding_ref, resource_kind, access_mode, ownership_fingerprint, control_operation_id, state, updated_at) VALUES (?, 'tenant-a', 'plugin-a', 'state', 'PLUGIN_STATE', ?, 'd1', 'read_only', ?, 'op', 'active', 1)`
      )
      .run(id, `PRES_D1_${'A'.repeat(24)}`, 'a'.repeat(64));
    await expect(restore(world, withConfiguration({ resources: [resource] }))).rejects.toThrow(
      /^plugin_dynamic_backup_resources_required$/u
    );
    await expect(
      restore(world, withConfiguration({ resources: [{ ...resource, access: 'read_only' }] }))
    ).resolves.toMatchObject({ installationId: id });
  });
  it('refuses a resource row that belongs to another tenant or plugin', async () => {
    for (const patch of [{ tenant_id: 'tenant-b' }, { plugin_id: 'plugin-b' }]) {
      const world = backupWorld('target', TARGET_KEY, {
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
      await expect(restore(world, request())).rejects.toThrow(INVALID);
    }
  });
  it('rejects more than sixteen resource, credential or scope rows in the target', async () => {
    for (const marker of [
      'plugin_runner_dynamic_worker_resources',
      'encrypted_value',
      'mutation_scope',
    ]) {
      const world = backupWorld('target', TARGET_KEY, {
        intercept: (call) =>
          call.kind === 'all' && call.sql.includes(marker) && !call.sql.includes('credential_slots')
            ? {
                value: {
                  success: true,
                  results: Array.from({ length: 17 }, () => ({})),
                  meta: {},
                },
              }
            : undefined,
      });
      await seedInstallation(world.database, { environmentId: 'target' });
      await expect(restore(world, request())).rejects.toThrow(INVALID);
    }
  });
});

describe('restore of credentials', () => {
  const withSecret = (extra: Record<string, unknown> = {}) =>
    withConfiguration({ credentials: { apiKey: 'source-secret' }, ...extra });
  it('creates the installation and stores the credentials under a derived operation id', async () => {
    const world = target();
    const result = await restore(world, withSecret());
    expect(result).toEqual({
      installationId: expect.any(String) as unknown,
      state: 'disabled',
      configVersion: 2,
    });
    expect(
      world.database
        .prepare(
          'SELECT operation_id, state, target_config_version FROM plugin_runner_config_mutations'
        )
        .all()
    ).toEqual([
      { operation_id: restoreOperationId('restore-a'), state: 'applied', target_config_version: 2 },
    ]);
    expect(installationRows(world)).toHaveLength(1);
  });
  it('derives a different operation id for every part of the request', () => {
    const base = restoreOperationId('restore-a');
    expect(restoreOperationId('restore-b')).not.toBe(base);
    expect(restoreOperationId('restore-a', 'tenant-b')).not.toBe(base);
    expect(restoreOperationId('restore-a', 'tenant-a', 'plugin-b')).not.toBe(base);
    expect(restoreOperationId('restore-a', 'tenant-a', 'plugin-a', digest('2'))).not.toBe(base);
  });
  it('is idempotent when the same credentials are already present', async () => {
    const world = target();
    await restore(world, withSecret());
    await expect(restore(world, withSecret())).resolves.toMatchObject({
      state: 'disabled',
      configVersion: 2,
    });
    expect(
      world.database.prepare('SELECT COUNT(*) AS n FROM plugin_runner_config_mutations').get()
    ).toEqual({ n: 1 });
  });
  it('refuses to overwrite different credentials', async () => {
    const world = target();
    await restore(world, withSecret());
    await expect(
      restore(world, withConfiguration({ credentials: { apiKey: 'another-secret' } }))
    ).rejects.toThrow(/^plugin_dynamic_backup_target_conflict$/u);
  });
  it('refuses a backup with fewer credentials than the target holds', async () => {
    const world = target();
    await restore(world, withSecret());
    await expect(restore(world, request())).rejects.toThrow(
      /^plugin_dynamic_backup_target_conflict$/u
    );
  });
  it('writes nothing for a backup without credentials', async () => {
    const world = target();
    await expect(restore(world, request())).resolves.toMatchObject({
      state: 'disabled',
      configVersion: 1,
    });
    expect(
      world.database.prepare('SELECT COUNT(*) AS n FROM plugin_runner_encrypted_configs').get()
    ).toEqual({ n: 0 });
  });
  it('refuses credentials the target policy does not declare', async () => {
    const world = target();
    await expect(
      restore(world, withConfiguration({ credentials: { apiKey: 'a', unknown: 'b' } }))
    ).rejects.toThrow(/^plugin_dynamic_credentials_policy_mismatch$/u);
  });
});

describe('restore of scopes, enablement and verification', () => {
  it('enables the installation when the backup was enabled', async () => {
    const world = target();
    await expect(
      restore(world, withConfiguration({ enabled: true, credentials: { apiKey: 'source-secret' } }))
    ).resolves.toMatchObject({ state: 'enabled', configVersion: 2 });
  });
  it('restores an approved mutation scope as enabled with the clock', async () => {
    const world = target();
    await restore(
      world,
      withConfiguration({
        credentials: { apiKey: 'source-secret' },
        mutationScopes: ['account.metadata.write'],
      }),
      () => 77
    );
    expect(
      world.database
        .prepare(
          'SELECT mutation_scope, state, updated_at FROM plugin_runner_installation_mutation_scopes'
        )
        .all()
    ).toEqual([{ mutation_scope: 'account.metadata.write', state: 'enabled', updated_at: 77 }]);
  });
  it('refuses a scope the target has not approved', async () => {
    const world = target();
    world.database.exec('DELETE FROM plugin_runner_approved_mutation_scopes');
    await expect(
      restore(
        world,
        withConfiguration({
          credentials: { apiKey: 'source-secret' },
          mutationScopes: ['account.metadata.write'],
        })
      )
    ).rejects.toThrow(/^plugin_dynamic_backup_scope_unapproved$/u);
  });
  it('refuses different scopes than the target already holds, but keeps matching ones', async () => {
    const world = target();
    const config = withConfiguration({
      credentials: { apiKey: 'source-secret' },
      mutationScopes: ['account.metadata.write'],
    });
    await restore(world, config);
    await expect(restore(world, config)).resolves.toMatchObject({ state: 'disabled' });
    await expect(
      restore(world, withConfiguration({ credentials: { apiKey: 'source-secret' } }))
    ).rejects.toThrow(/^plugin_dynamic_backup_target_conflict$/u);
  });
  it.each([0, -1, 1.5, Number.NaN])(
    'refuses to stamp a scope with the clock value %s',
    async (bad) => {
      let corrupted = false;
      const world = backupWorld('target', TARGET_KEY, {
        intercept: (call) => {
          if (
            call.kind === 'all' &&
            call.sql.includes('FROM plugin_runner_installation_mutation_scopes')
          ) {
            corrupted = true;
          }
          return undefined;
        },
      });
      await expect(
        restore(
          world,
          withConfiguration({
            credentials: { apiKey: 'source-secret' },
            mutationScopes: ['account.metadata.write'],
          }),
          () => (corrupted ? bad : 30)
        )
      ).rejects.toThrow(INVALID);
      expect(
        world.database
          .prepare('SELECT COUNT(*) AS n FROM plugin_runner_installation_mutation_scopes')
          .get()
      ).toEqual({ n: 0 });
    }
  );
  it('fails when the restored state does not verify', async () => {
    let reads = 0;
    const world = backupWorld('target', TARGET_KEY, {
      intercept: (call) => {
        if (call.kind === 'all' && call.sql.includes('encryption_key_id, encrypted_value')) {
          reads += 1;
          if (reads === 2) return { value: { success: true, results: [], meta: {} } };
        }
        return undefined;
      },
    });
    await expect(
      restore(world, withConfiguration({ credentials: { apiKey: 'source-secret' } }))
    ).rejects.toThrow(/^plugin_dynamic_backup_verification_failed$/u);
  });
});

describe('verify', () => {
  const verify = (world: BackupWorld, value: unknown) => world.service().verify(value);
  it.each([
    ['null', null],
    ['an array', []],
    ['an extra key', { configuration: configuration(), extra: 1 }],
    ['no configuration', {}],
    ['a malformed configuration', { configuration: { contractVersion: 1 } }],
  ])('rejects %s', async (_label, value) => {
    const world = target();
    await expect(verify(world, value)).rejects.toThrow(INVALID);
  });
  async function restored() {
    const source = backupWorld();
    await seedSourceInstallation(source, { enabled: true, scope: true });
    const exported = await source.service().export({ tenantId: 'tenant-a', pluginId: 'plugin-a' });
    if (!exported) throw new Error('missing export');
    const world = target();
    await restore(world, { operationId: 'restore-a', configuration: exported });
    return { world, exported };
  }
  it('confirms a faithful restore and detects every kind of drift', async () => {
    const { world, exported } = await restored();
    await expect(verify(world, { configuration: exported })).resolves.toBe(true);
    await expect(verify(world, { configuration: { ...exported, enabled: false } })).resolves.toBe(
      false
    );
    await expect(
      verify(world, { configuration: { ...exported, credentials: { apiKey: 'other' } } })
    ).resolves.toBe(false);
    await expect(verify(world, { configuration: { ...exported, credentials: {} } })).resolves.toBe(
      false
    );
    await expect(
      verify(world, { configuration: { ...exported, mutationScopes: [] } })
    ).resolves.toBe(false);
    await expect(
      verify(world, {
        configuration: {
          ...exported,
          resources: [{ logicalResourceId: 'a', binding: 'A', kind: 'd1', access: 'read_only' }],
        },
      })
    ).resolves.toBe(false);
  });
  it('reports an absent installation as not matching', async () => {
    const world = target();
    await expect(verify(world, { configuration: configuration() })).resolves.toBe(false);
    await expect(verify(world, { configuration: configuration({ enabled: true }) })).resolves.toBe(
      false
    );
  });
  it('matches a disabled installation only against a disabled backup', async () => {
    const world = target();
    await restore(world, request());
    await expect(verify(world, { configuration: configuration() })).resolves.toBe(true);
    await expect(verify(world, { configuration: configuration({ enabled: true }) })).resolves.toBe(
      false
    );
  });
  it('is read-only', async () => {
    const world = target();
    await verify(world, { configuration: configuration() });
    expect(world.calls.filter((c) => c.kind === 'run' || c.kind === 'batch')).toEqual([]);
  });
});

describe('contract and clock edges', () => {
  const resource = (index: number, kind = 'd1') => ({
    logicalResourceId: `res${String(index).padStart(2, '0')}`,
    binding: `BIND${String(index).padStart(2, '0')}`,
    kind,
    access: 'read_only',
  });
  it('accepts exactly sixteen resources and every resource kind at the contract level', async () => {
    const world = target();
    await expect(
      restore(
        world,
        withConfiguration({ resources: Array.from({ length: 16 }, (_, i) => resource(i)) })
      )
    ).rejects.toThrow(/^plugin_dynamic_backup_resources_required$/u);
    for (const kind of ['d1', 'kv_namespace', 'r2_bucket']) {
      await expect(
        restore(world, withConfiguration({ resources: [resource(1, kind)] as never }))
      ).rejects.toThrow(/^plugin_dynamic_backup_resources_required$/u);
    }
  });
  it('stamps restored scopes with the smallest clock value and with the default clock', async () => {
    const world = target();
    await restore(
      world,
      withConfiguration({
        credentials: { apiKey: 'source-secret' },
        mutationScopes: ['account.metadata.write'],
      }),
      () => 1
    );
    expect(
      world.database
        .prepare('SELECT updated_at FROM plugin_runner_installation_mutation_scopes')
        .all()
    ).toEqual([{ updated_at: 1 }]);
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_444_900);
    try {
      const fresh = target();
      await new (await import('../tenant-backup')).DynamicPluginTenantBackupService(
        fresh.env
      ).restore({
        operationId: 'restore-a',
        configuration: configuration({
          credentials: { apiKey: 'source-secret' },
          mutationScopes: ['account.metadata.write'],
        }),
      });
      expect(
        fresh.database
          .prepare('SELECT updated_at FROM plugin_runner_installation_mutation_scopes')
          .all()
      ).toEqual([{ updated_at: 1_700_000_444 }]);
    } finally {
      vi.useRealTimers();
    }
  });
});
