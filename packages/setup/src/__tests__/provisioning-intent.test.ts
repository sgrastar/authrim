import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  beginOrResumeProvisioningIntent,
  calculateProvisioningResourceSpecDigest,
  completeProvisioningIntent,
  loadProvisioningIntent,
  recordProvisionedResource,
  recordProvisioningResourceCreateIssued,
  recordProvisioningResourceCreateRejected,
  recordProvisioningResourceIdentified,
  recordProvisioningKeyId,
} from '../core/provisioning-intent.js';

describe('durable fresh-provisioning intent', () => {
  let root: string;
  const resourceSpec = {
    createD1: true,
    createKV: true,
    createQueues: false,
    createR2: true,
    database: { core: { location: 'wnam' }, pii: { jurisdiction: 'eu' } },
  } as const;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'authrim-provision-intent-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('uses a stable digest regardless of object key order', () => {
    expect(calculateProvisioningResourceSpecDigest({ b: true, a: 'value' })).toBe(
      calculateProvisioningResourceSpecDigest({ a: 'value', b: true })
    );
  });

  it('persists an owner-only intent and resumes the exact same plan', async () => {
    const created = await beginOrResumeProvisioningIntent({
      baseDir: root,
      environment: 'test',
      accountId: 'account-1',
      resourceSpec,
    });
    const resumed = await beginOrResumeProvisioningIntent({
      baseDir: root,
      environment: 'test',
      accountId: 'account-1',
      resourceSpec,
    });

    expect(created.resumed).toBe(false);
    expect(resumed).toEqual({ intent: created.intent, resumed: true });
    const path = join(root, '.authrim', 'test', 'provisioning-intent.json');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, 'utf-8'))).toMatchObject({
      id: created.intent.id,
      accountId: 'account-1',
      environment: 'test',
    });
  });

  it('rejects a provisioning journal that is not exactly mode 0600', async () => {
    await beginOrResumeProvisioningIntent({
      baseDir: root,
      environment: 'test',
      accountId: 'account-1',
      resourceSpec,
    });
    if (process.platform === 'win32') return;

    const path = join(root, '.authrim', 'test', 'provisioning-intent.json');
    await chmod(path, 0o644);
    await expect(loadProvisioningIntent({ baseDir: root, environment: 'test' })).rejects.toThrow(
      'provisioning_intent_permissions_invalid'
    );

    await chmod(path, 0o400);
    await expect(loadProvisioningIntent({ baseDir: root, environment: 'test' })).rejects.toThrow(
      'provisioning_intent_permissions_invalid'
    );
  });

  it('does not follow a symlinked provisioning journal', async () => {
    if (process.platform === 'win32') return;
    const created = await beginOrResumeProvisioningIntent({
      baseDir: root,
      environment: 'test',
      accountId: 'account-1',
      resourceSpec,
    });
    const path = join(root, '.authrim', 'test', 'provisioning-intent.json');
    const outside = join(root, 'outside-provisioning-intent.json');
    await writeFile(outside, `${JSON.stringify(created.intent)}\n`, { mode: 0o600 });
    await rm(path);
    await symlink(outside, path);

    await expect(loadProvisioningIntent({ baseDir: root, environment: 'test' })).rejects.toThrow(
      'invalid_provisioning_intent'
    );
  });

  it('rejects an oversized provisioning journal before parsing it', async () => {
    const directory = join(root, '.authrim', 'test');
    const path = join(directory, 'provisioning-intent.json');
    await mkdir(directory, { recursive: true });
    await writeFile(path, 'x'.repeat(1024 * 1024 + 1), { mode: 0o600 });

    await expect(loadProvisioningIntent({ baseDir: root, environment: 'test' })).rejects.toThrow(
      'invalid_provisioning_intent'
    );
  });

  it('rejects a non-regular provisioning journal', async () => {
    const directory = join(root, '.authrim', 'test');
    const path = join(directory, 'provisioning-intent.json');
    await mkdir(directory, { recursive: true });
    await mkdir(path);

    await expect(loadProvisioningIntent({ baseDir: root, environment: 'test' })).rejects.toThrow(
      'invalid_provisioning_intent'
    );
  });

  it('fails closed when a retry changes Cloudflare account or resource plan', async () => {
    await beginOrResumeProvisioningIntent({
      baseDir: root,
      environment: 'test',
      accountId: 'account-1',
      resourceSpec,
    });

    await expect(
      beginOrResumeProvisioningIntent({
        baseDir: root,
        environment: 'test',
        accountId: 'account-2',
        resourceSpec,
      })
    ).rejects.toThrow('provisioning_intent_account_mismatch');
    await expect(
      beginOrResumeProvisioningIntent({
        baseDir: root,
        environment: 'test',
        accountId: 'account-1',
        resourceSpec: { ...resourceSpec, createQueues: true },
      })
    ).rejects.toThrow('provisioning_intent_resource_spec_mismatch');
  });

  it('pins the generated key and exact provider resource identities across retries', async () => {
    const { intent } = await beginOrResumeProvisioningIntent({
      baseDir: root,
      environment: 'test',
      accountId: 'account-1',
      resourceSpec,
    });
    await recordProvisioningKeyId({
      baseDir: root,
      environment: 'test',
      expectedIntentId: intent.id,
      keyId: 'setup-key-1',
    });
    await recordProvisioningResourceCreateIssued({
      baseDir: root,
      environment: 'test',
      expectedIntentId: intent.id,
      resource: {
        kind: 'd1',
        binding: 'DB',
        name: 'test-authrim-core-db',
      },
    });
    await recordProvisioningResourceIdentified({
      baseDir: root,
      environment: 'test',
      expectedIntentId: intent.id,
      resource: {
        kind: 'd1',
        binding: 'DB',
        name: 'test-authrim-core-db',
        state: 'identified',
        id: 'database-1',
      },
    });
    await recordProvisionedResource({
      baseDir: root,
      environment: 'test',
      expectedIntentId: intent.id,
      resource: {
        kind: 'd1',
        binding: 'DB',
        name: 'test-authrim-core-db',
        state: 'created',
        id: 'database-1',
      },
    });
    await recordProvisionedResource({
      baseDir: root,
      environment: 'test',
      expectedIntentId: intent.id,
      resource: {
        kind: 'd1',
        binding: 'DB',
        name: 'test-authrim-core-db',
        state: 'created',
        id: 'database-1',
      },
    });

    await expect(
      recordProvisioningKeyId({
        baseDir: root,
        environment: 'test',
        expectedIntentId: intent.id,
        keyId: 'setup-key-2',
      })
    ).rejects.toThrow('provisioning_key_id_changed');
    await expect(
      recordProvisionedResource({
        baseDir: root,
        environment: 'test',
        expectedIntentId: intent.id,
        resource: {
          kind: 'd1',
          binding: 'DB',
          name: 'test-authrim-core-db',
          state: 'created',
          id: 'database-2',
        },
      })
    ).rejects.toThrow('provisioning_resource_identity_changed:d1:DB');
    await expect(
      loadProvisioningIntent({ baseDir: root, environment: 'test' })
    ).resolves.toMatchObject({
      keyId: 'setup-key-1',
      resources: {
        'd1:DB': { id: 'database-1' },
      },
    });
  });

  it('requires and preserves an immutable Queue provider ID in every created checkpoint', async () => {
    const { intent } = await beginOrResumeProvisioningIntent({
      baseDir: root,
      environment: 'test',
      accountId: 'account-1',
      resourceSpec,
    });

    await recordProvisioningResourceCreateIssued({
      baseDir: root,
      environment: 'test',
      expectedIntentId: intent.id,
      resource: {
        kind: 'queue',
        binding: 'AUDIT_QUEUE',
        name: 'test-audit-queue',
      },
    });
    await expect(
      recordProvisionedResource({
        baseDir: root,
        environment: 'test',
        expectedIntentId: intent.id,
        resource: {
          kind: 'queue',
          binding: 'AUDIT_QUEUE',
          name: 'test-audit-queue',
          state: 'created',
        },
      })
    ).rejects.toThrow('invalid_provisioning_resource_checkpoint');
    await recordProvisioningResourceIdentified({
      baseDir: root,
      environment: 'test',
      expectedIntentId: intent.id,
      resource: {
        kind: 'queue',
        binding: 'AUDIT_QUEUE',
        name: 'test-audit-queue',
        state: 'identified',
        id: 'opaque-provider-id',
      },
    });
    await recordProvisionedResource({
      baseDir: root,
      environment: 'test',
      expectedIntentId: intent.id,
      resource: {
        kind: 'queue',
        binding: 'AUDIT_QUEUE',
        name: 'test-audit-queue',
        state: 'created',
        id: 'opaque-provider-id',
      },
    });
    await expect(
      recordProvisionedResource({
        baseDir: root,
        environment: 'test',
        expectedIntentId: intent.id,
        resource: {
          kind: 'queue',
          binding: 'AUDIT_QUEUE',
          name: 'test-audit-queue',
          state: 'created',
        },
      })
    ).rejects.toThrow('invalid_provisioning_resource_checkpoint');

    await expect(
      loadProvisioningIntent({ baseDir: root, environment: 'test' })
    ).resolves.toMatchObject({
      resources: {
        'queue:AUDIT_QUEUE': {
          kind: 'queue',
          binding: 'AUDIT_QUEUE',
          name: 'test-audit-queue',
        },
      },
    });
    expect(
      (await loadProvisioningIntent({ baseDir: root, environment: 'test' }))?.resources[
        'queue:AUDIT_QUEUE'
      ]?.id
    ).toBe('opaque-provider-id');
    await expect(
      recordProvisionedResource({
        baseDir: root,
        environment: 'test',
        expectedIntentId: intent.id,
        resource: {
          kind: 'queue',
          binding: 'AUDIT_QUEUE',
          name: 'test-audit-queue',
          state: 'created',
          id: 'different-provider-id',
        },
      })
    ).rejects.toThrow('provisioning_resource_identity_changed:queue:AUDIT_QUEUE');
  });

  it('rejects a persisted created Queue checkpoint whose immutable ID is absent', async () => {
    const { intent } = await beginOrResumeProvisioningIntent({
      baseDir: root,
      environment: 'test',
      accountId: 'account-1',
      resourceSpec,
    });
    const path = join(root, '.authrim', 'test', 'provisioning-intent.json');
    const persisted = JSON.parse(await readFile(path, 'utf-8'));
    persisted.resources['queue:AUDIT_QUEUE'] = {
      kind: 'queue',
      binding: 'AUDIT_QUEUE',
      name: 'test-audit-queue',
      state: 'created',
    };
    persisted.updatedAt = intent.updatedAt;
    await writeFile(path, `${JSON.stringify(persisted, null, 2)}\n`, { mode: 0o600 });

    await expect(loadProvisioningIntent({ baseDir: root, environment: 'test' })).rejects.toThrow(
      'invalid_provisioning_intent'
    );
  });

  it('rejects a persisted created R2 checkpoint without exact generation and marker identity', async () => {
    await beginOrResumeProvisioningIntent({
      baseDir: root,
      environment: 'test',
      accountId: 'account-1',
      resourceSpec,
    });
    const path = join(root, '.authrim', 'test', 'provisioning-intent.json');
    const persisted = JSON.parse(await readFile(path, 'utf-8'));
    persisted.resources['r2:MIGRATION_RELEASES'] = {
      kind: 'r2',
      binding: 'MIGRATION_RELEASES',
      name: 'test-migration-releases',
      state: 'created',
    };
    await writeFile(path, `${JSON.stringify(persisted, null, 2)}\n`, { mode: 0o600 });

    await expect(loadProvisioningIntent({ baseDir: root, environment: 'test' })).rejects.toThrow(
      'invalid_provisioning_intent'
    );
  });

  it.each([
    { kind: 'd1' as const, binding: 'DB', name: 'test-authrim-core-db' },
    { kind: 'kv' as const, binding: 'SETTINGS', name: 'test-SETTINGS' },
  ])('rejects a created $kind checkpoint without its immutable provider ID', async (resource) => {
    const { intent } = await beginOrResumeProvisioningIntent({
      baseDir: root,
      environment: 'test',
      accountId: 'account-1',
      resourceSpec,
    });
    await recordProvisioningResourceCreateIssued({
      baseDir: root,
      environment: 'test',
      expectedIntentId: intent.id,
      resource,
    });

    await expect(
      recordProvisionedResource({
        baseDir: root,
        environment: 'test',
        expectedIntentId: intent.id,
        resource: { ...resource, state: 'created' },
      })
    ).rejects.toThrow('invalid_provisioning_resource_checkpoint');
  });

  it.each([
    { kind: 'd1' as const, binding: 'DB', name: 'test-authrim-core-db' },
    { kind: 'kv' as const, binding: 'SETTINGS', name: 'test-SETTINGS' },
  ])(
    'rejects a persisted created $kind checkpoint without its immutable provider ID',
    async (resource) => {
      await beginOrResumeProvisioningIntent({
        baseDir: root,
        environment: 'test',
        accountId: 'account-1',
        resourceSpec,
      });
      const path = join(root, '.authrim', 'test', 'provisioning-intent.json');
      const persisted = JSON.parse(await readFile(path, 'utf-8'));
      persisted.resources[`${resource.kind}:${resource.binding}`] = {
        ...resource,
        state: 'created',
      };
      await writeFile(path, `${JSON.stringify(persisted, null, 2)}\n`, { mode: 0o600 });

      await expect(loadProvisioningIntent({ baseDir: root, environment: 'test' })).rejects.toThrow(
        'invalid_provisioning_intent'
      );
    }
  );

  it('requires a resource-specific create-issued checkpoint before recording provider success', async () => {
    const { intent } = await beginOrResumeProvisioningIntent({
      baseDir: root,
      environment: 'test',
      accountId: 'account-1',
      resourceSpec,
    });

    await expect(
      recordProvisionedResource({
        baseDir: root,
        environment: 'test',
        expectedIntentId: intent.id,
        resource: {
          kind: 'kv',
          binding: 'SETTINGS',
          name: 'test-SETTINGS',
          state: 'created',
          id: 'namespace-1',
        },
      })
    ).rejects.toThrow('provisioning_resource_create_not_issued:kv:SETTINGS');

    await recordProvisioningResourceCreateIssued({
      baseDir: root,
      environment: 'test',
      expectedIntentId: intent.id,
      resource: {
        kind: 'kv',
        binding: 'SETTINGS',
        name: 'test-SETTINGS',
      },
    });
    await expect(
      loadProvisioningIntent({ baseDir: root, environment: 'test' })
    ).resolves.toMatchObject({
      resources: {
        'kv:SETTINGS': {
          name: 'test-SETTINGS',
          state: 'create_issued',
        },
      },
    });

    await recordProvisioningResourceCreateRejected({
      baseDir: root,
      environment: 'test',
      expectedIntentId: intent.id,
      resource: {
        kind: 'kv',
        binding: 'SETTINGS',
        name: 'test-SETTINGS',
      },
    });
    await expect(
      loadProvisioningIntent({ baseDir: root, environment: 'test' })
    ).resolves.toMatchObject({
      resources: {
        'kv:SETTINGS': {
          state: 'create_rejected',
        },
      },
    });

    await recordProvisioningResourceCreateIssued({
      baseDir: root,
      environment: 'test',
      expectedIntentId: intent.id,
      resource: {
        kind: 'kv',
        binding: 'SETTINGS',
        name: 'test-SETTINGS',
      },
    });
    expect(
      (await loadProvisioningIntent({ baseDir: root, environment: 'test' }))?.resources[
        'kv:SETTINGS'
      ]?.state
    ).toBe('create_issued');
  });

  it('durably transitions create_issued through identified before created', async () => {
    const { intent } = await beginOrResumeProvisioningIntent({
      baseDir: root,
      environment: 'test',
      accountId: 'account-1',
      resourceSpec,
    });
    const identity = {
      kind: 'kv' as const,
      binding: 'SETTINGS',
      name: 'test-SETTINGS',
    };
    await recordProvisioningResourceCreateIssued({
      baseDir: root,
      environment: 'test',
      expectedIntentId: intent.id,
      resource: identity,
    });
    await expect(
      recordProvisionedResource({
        baseDir: root,
        environment: 'test',
        expectedIntentId: intent.id,
        resource: { ...identity, state: 'created', id: 'namespace-exact' },
      })
    ).rejects.toThrow('provisioning_resource_not_identified:kv:SETTINGS');

    await recordProvisioningResourceIdentified({
      baseDir: root,
      environment: 'test',
      expectedIntentId: intent.id,
      resource: { ...identity, state: 'identified', id: 'namespace-exact' },
    });
    await expect(
      recordProvisioningResourceCreateRejected({
        baseDir: root,
        environment: 'test',
        expectedIntentId: intent.id,
        resource: identity,
      })
    ).rejects.toThrow('provisioning_resource_already_created:kv:SETTINGS');
    await recordProvisioningResourceCreateIssued({
      baseDir: root,
      environment: 'test',
      expectedIntentId: intent.id,
      resource: identity,
    });
    expect(
      (await loadProvisioningIntent({ baseDir: root, environment: 'test' }))?.resources[
        'kv:SETTINGS'
      ]
    ).toMatchObject({ state: 'identified', id: 'namespace-exact' });

    await recordProvisionedResource({
      baseDir: root,
      environment: 'test',
      expectedIntentId: intent.id,
      resource: { ...identity, state: 'created', id: 'namespace-exact' },
    });
    expect(
      (await loadProvisioningIntent({ baseDir: root, environment: 'test' }))?.resources[
        'kv:SETTINGS'
      ]
    ).toMatchObject({ state: 'created', id: 'namespace-exact' });
  });

  it('rejects corrupted and checksum-mismatched journals', async () => {
    const directory = join(root, '.authrim', 'test');
    const path = join(directory, 'provisioning-intent.json');
    await mkdir(directory, { recursive: true });
    await writeFile(path, '{', { mode: 0o600 });
    await expect(loadProvisioningIntent({ baseDir: root, environment: 'test' })).rejects.toThrow(
      'invalid_provisioning_intent'
    );

    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        id: '11111111-1111-4111-8111-111111111111',
        environment: 'test',
        accountId: 'account-1',
        resourceSpec,
        resourceSpecDigest: '0'.repeat(64),
        createdAt: '2026-08-31T00:00:00.000Z',
        updatedAt: '2026-08-31T00:00:00.000Z',
        resources: {},
      })
    );
    await expect(loadProvisioningIntent({ baseDir: root, environment: 'test' })).rejects.toThrow(
      'provisioning_intent_digest_mismatch'
    );
  });

  it('removes only the expected attempt after final lock persistence', async () => {
    const { intent } = await beginOrResumeProvisioningIntent({
      baseDir: root,
      environment: 'test',
      accountId: 'account-1',
      resourceSpec,
    });
    await expect(
      completeProvisioningIntent({
        baseDir: root,
        environment: 'test',
        expectedIntentId: '22222222-2222-4222-8222-222222222222',
      })
    ).rejects.toThrow('provisioning_intent_changed_before_completion');

    await completeProvisioningIntent({
      baseDir: root,
      environment: 'test',
      expectedIntentId: intent.id,
    });
    await expect(
      loadProvisioningIntent({ baseDir: root, environment: 'test' })
    ).resolves.toBeNull();
  });
});
