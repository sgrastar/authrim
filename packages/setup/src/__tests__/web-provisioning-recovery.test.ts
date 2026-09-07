import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultConfig, AuthrimConfigSchema } from '../core/config.js';
import {
  beginOrResumeProvisioningIntent,
  calculateProvisioningResourceSpecDigest,
  hasExactProvisioningResourceIdentity,
} from '../core/provisioning-intent.js';
import {
  buildWebProvisioningResourceSpec,
  loadWebProvisioningConfig,
  normalizeWebProvisioningConfigForIntent,
  resolveWebDeploymentKeysDir,
} from '../web/api.js';
import { getEnvironmentPaths } from '../core/paths.js';

describe('Web interrupted provisioning recovery', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'authrim-web-provisioning-recovery-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('pins resolved Workers URLs before the intent and resumes from persisted config', async () => {
    const initial = createDefaultConfig('recovery');
    initial.cloudflare = { accountId: 'account-1' };
    const normalized = normalizeWebProvisioningConfigForIntent({
      config: initial,
      environment: 'recovery',
      workersSubdomain: 'account-subdomain',
      now: '2026-08-31T00:00:00.000Z',
    });
    const initialSpec = buildWebProvisioningResourceSpec(normalized);
    const created = await beginOrResumeProvisioningIntent({
      baseDir: root,
      environment: 'recovery',
      accountId: 'account-1',
      resourceSpec: initialSpec,
    });

    const persisted = AuthrimConfigSchema.parse(JSON.parse(JSON.stringify(normalized)));
    const persistedSpec = buildWebProvisioningResourceSpec(persisted);
    const resumed = await beginOrResumeProvisioningIntent({
      baseDir: root,
      environment: 'recovery',
      accountId: 'account-1',
      resourceSpec: persistedSpec,
    });

    expect(normalized.urls.api.auto).toBe(
      'https://recovery-ar-router.account-subdomain.workers.dev'
    );
    expect(calculateProvisioningResourceSpecDigest(persistedSpec)).toBe(
      calculateProvisioningResourceSpecDigest(initialSpec)
    );
    expect(resumed).toEqual({ intent: created.intent, resumed: true });
  });

  it('recovers the pinned config when interruption occurs before config publication', async () => {
    const initial = createDefaultConfig('recovery');
    initial.cloudflare = { accountId: 'account-1' };
    initial.features.queue.enabled = true;
    const normalized = normalizeWebProvisioningConfigForIntent({
      config: initial,
      environment: 'recovery',
      workersSubdomain: 'account-subdomain',
      now: '2026-08-31T00:00:00.000Z',
    });
    const created = await beginOrResumeProvisioningIntent({
      baseDir: root,
      environment: 'recovery',
      accountId: 'account-1',
      resourceSpec: buildWebProvisioningResourceSpec(normalized),
    });

    const recovered = await loadWebProvisioningConfig({
      baseDir: root,
      environment: 'recovery',
      intent: created.intent,
    });

    expect(recovered.features.queue.enabled).toBe(true);
    expect(recovered.urls.api.auto).toBe(
      'https://recovery-ar-router.account-subdomain.workers.dev'
    );
    expect(buildWebProvisioningResourceSpec(recovered)).toEqual(
      buildWebProvisioningResourceSpec(normalized)
    );
  });

  it('rejects a stale durable config in favor of the exact journal-pinned plan', async () => {
    const initial = createDefaultConfig('recovery');
    initial.cloudflare = { accountId: 'account-1' };
    const created = await beginOrResumeProvisioningIntent({
      baseDir: root,
      environment: 'recovery',
      accountId: 'account-1',
      resourceSpec: buildWebProvisioningResourceSpec(initial),
    });
    const persisted = AuthrimConfigSchema.parse({
      ...initial,
      tenant: { ...initial.tenant, displayName: 'Persisted tenant' },
    });
    const paths = getEnvironmentPaths({ baseDir: root, env: 'recovery' });
    await writeFile(paths.config, `${JSON.stringify(persisted)}\n`, 'utf-8');

    const recovered = await loadWebProvisioningConfig({
      baseDir: root,
      environment: 'recovery',
      intent: created.intent,
    });

    expect(recovered.tenant.displayName).toBe(initial.tenant.displayName);
    expect(buildWebProvisioningResourceSpec(recovered)).toEqual(created.intent.resourceSpec);
  });

  it('publishes the intent before normalized config and any remote resource mutation', async () => {
    const source = await readFile(new URL('../web/api.ts', import.meta.url), 'utf-8');
    const provisioning = source.slice(source.indexOf("api.post('/provision'"));
    const collisionCheck = provisioning.indexOf(
      'const remoteEnvironments = await detectEnvironments('
    );
    const intentWrite = provisioning.indexOf(
      'provisioningAttempt ??= await beginOrResumeProvisioningIntent({'
    );
    const configWrite = provisioning.indexOf('await writePrivateFileAtomically(envPaths.config,');
    const remoteProvisioning = provisioning.indexOf('const resources = await provisionResources({');
    const capacityCheck = provisioning.indexOf('await assertLocalDeploymentCapacity({');

    expect(collisionCheck).toBeGreaterThanOrEqual(0);
    expect(capacityCheck).toBeGreaterThanOrEqual(0);
    expect(capacityCheck).toBeLessThan(collisionCheck);
    expect(intentWrite).toBeGreaterThan(collisionCheck);
    expect(configWrite).toBeGreaterThan(intentWrite);
    expect(remoteProvisioning).toBeGreaterThan(configWrite);
  });

  it('uses the external key path pinned by config across working directories', () => {
    const provisionDirectory = join(root, 'provision-cwd');
    const deployDirectory = join(root, 'deploy-cwd');
    const config = createDefaultConfig('recovery');
    config.keys = {
      ...config.keys,
      storageType: 'external',
      secretsPath: join(provisionDirectory, '.authrim-keys', 'recovery') + '/',
    };

    expect(resolveWebDeploymentKeysDir(deployDirectory, 'recovery', config)).toBe(
      join(provisionDirectory, '.authrim-keys', 'recovery')
    );
  });

  it('promotes staged email secrets before finalizing an already-complete journal', async () => {
    const source = await readFile(new URL('../web/api.ts', import.meta.url), 'utf-8');
    const provisioning = source.slice(source.indexOf('const generatedKeys ='));
    const promotion = provisioning.indexOf('await promotePendingEmailSecrets({');
    const completedBranch = provisioning.indexOf('await hasCompleteProvisioningArtifacts({');
    const journalRemoval = provisioning.indexOf(
      'await completeProvisioningIntent({',
      completedBranch
    );

    expect(promotion).toBeGreaterThanOrEqual(0);
    expect(completedBranch).toBeGreaterThan(promotion);
    expect(journalRemoval).toBeGreaterThan(completedBranch);
  });

  it('verifies the live R2 ownership marker before finalizing an interrupted journal', async () => {
    const source = await readFile(new URL('../web/api.ts', import.meta.url), 'utf-8');
    const completionStart = source.indexOf('async function hasCompleteProvisioningArtifacts(');
    const completion = source.slice(
      completionStart,
      source.indexOf('\nfunction ', completionStart)
    );

    expect(completion).toContain('await assertR2BucketOwnershipForUse({');
    expect(completion).toContain('environment: input.environment');
    expect(completion).toContain('binding: resource.binding');
  });

  it('requires the same immutable Queue ID in the intent, lock, and remote inventory', () => {
    const base = {
      kind: 'queue' as const,
      binding: 'AUDIT_QUEUE',
      expectedName: 'recovery-audit-queue',
      lock: { name: 'recovery-audit-queue', id: 'queue-recorded' },
      checkpoint: {
        kind: 'queue' as const,
        binding: 'AUDIT_QUEUE',
        name: 'recovery-audit-queue',
        state: 'created' as const,
        id: 'queue-recorded',
      },
      requireCheckpoint: true,
    };

    expect(
      hasExactProvisioningResourceIdentity({
        ...base,
        remote: { name: 'recovery-audit-queue', id: 'queue-recorded' },
      })
    ).toBe(true);
    expect(
      hasExactProvisioningResourceIdentity({
        ...base,
        remote: { name: 'recovery-audit-queue' },
      })
    ).toBe(false);
    expect(
      hasExactProvisioningResourceIdentity({
        ...base,
        remote: { name: 'recovery-audit-queue', id: 'queue-replacement' },
      })
    ).toBe(false);
    expect(
      hasExactProvisioningResourceIdentity({
        ...base,
        checkpoint: { ...base.checkpoint, id: undefined },
      })
    ).toBe(false);
  });
});
