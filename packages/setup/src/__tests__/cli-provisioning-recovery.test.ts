import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildProvisioningResourceSpec,
  reconcileCanonicalProvisioningConfigAfterLock,
  resumeInterruptedProvisioningFromConfig,
  resumeInterruptedProvisioningForEnvironment,
  resolveProvisioningKeysBaseDir,
} from '../cli/commands/init.js';
import { createDefaultConfig, parseConfig, type AuthrimConfig } from '../core/config.js';
import { createLockFile, saveLockFile } from '../core/lock.js';
import { getEnvironmentPaths } from '../core/paths.js';
import {
  beginOrResumeProvisioningIntent,
  recordProvisioningKeyId,
} from '../core/provisioning-intent.js';

describe('CLI interrupted provisioning recovery', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'authrim-cli-provisioning-recovery-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('preserves the key base pinned by an existing provisioning intent', () => {
    const pinnedBaseDir = join(root, 'original-working-directory');
    expect(
      resolveProvisioningKeysBaseDir({
        environment: 'recovery',
        secretsPath: join(pinnedBaseDir, '.authrim-keys', 'recovery') + '/',
        resuming: true,
        currentWorkingDirectory: join(root, 'different-working-directory'),
      })
    ).toBe(pinnedBaseDir);
  });

  it('rejects a non-canonical key path when resuming but uses cwd for a new intent', () => {
    const currentWorkingDirectory = join(root, 'current-working-directory');
    expect(() =>
      resolveProvisioningKeysBaseDir({
        environment: 'recovery',
        secretsPath: join(root, '.authrim-keys', 'another-environment') + '/',
        resuming: true,
        currentWorkingDirectory,
      })
    ).toThrow('external_keys_config_path_mismatch');
    expect(
      resolveProvisioningKeysBaseDir({
        environment: 'recovery',
        secretsPath: './keys/',
        resuming: false,
        currentWorkingDirectory,
      })
    ).toBe(currentWorkingDirectory);
  });

  it('routes canonical config without a lock and journal-backed states into recovery', async () => {
    const config = createDefaultConfig('recovery');
    config.cloudflare = { accountId: 'account-1' };
    config.keys = {
      ...config.keys,
      secretsPath: join(root, '.authrim-keys', 'recovery') + '/',
      includeSecrets: false,
      storageType: 'external',
    };
    const paths = getEnvironmentPaths({ baseDir: root, env: 'recovery' });
    await mkdir(paths.root, { recursive: true });
    await writeFile(paths.config, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    const handleConfig = vi.fn(async () => undefined);

    await expect(
      resumeInterruptedProvisioningForEnvironment({
        baseDir: root,
        environment: 'recovery',
        handleConfig,
      })
    ).resolves.toBe(true);
    expect(handleConfig).toHaveBeenCalledOnce();
    handleConfig.mockClear();

    await beginOrResumeProvisioningIntent({
      baseDir: root,
      environment: 'recovery',
      accountId: 'account-1',
      resourceSpec: buildProvisioningResourceSpec(config),
    });
    await expect(
      resumeInterruptedProvisioningForEnvironment({
        baseDir: root,
        environment: 'recovery',
        handleConfig,
      })
    ).resolves.toBe(true);
    expect(handleConfig).toHaveBeenCalledOnce();
    expect(handleConfig).toHaveBeenCalledWith(paths.config);

    await saveLockFile(createLockFile('recovery', { d1: [], kv: [], queues: [], r2: [] }), {
      baseDir: root,
      env: 'recovery',
    });
    handleConfig.mockClear();
    await expect(
      resumeInterruptedProvisioningForEnvironment({
        baseDir: root,
        environment: 'recovery',
        handleConfig,
      })
    ).resolves.toBe(true);
    expect(handleConfig).toHaveBeenCalledOnce();
    expect(handleConfig).toHaveBeenCalledWith(paths.config);
  });

  it('runs lock-plus-journal recovery so executeSetup can finalize an interrupted lock publish', async () => {
    const config = createDefaultConfig('recovery');
    config.cloudflare = { accountId: 'account-1' };
    const paths = getEnvironmentPaths({ baseDir: root, env: 'recovery' });
    await mkdir(paths.root, { recursive: true });
    await writeFile(paths.config, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await beginOrResumeProvisioningIntent({
      baseDir: root,
      environment: 'recovery',
      accountId: 'account-1',
      resourceSpec: buildProvisioningResourceSpec(config),
    });
    await saveLockFile(createLockFile('recovery', { d1: [], kv: [], queues: [], r2: [] }), {
      baseDir: root,
      env: 'recovery',
    });
    const runProvisioning = vi.fn(async () => undefined);

    await expect(
      resumeInterruptedProvisioningFromConfig({
        config,
        configPath: paths.config,
        runProvisioning,
      })
    ).resolves.toBe(true);
    expect(runProvisioning).toHaveBeenCalledOnce();
    expect(runProvisioning).toHaveBeenCalledWith(config, root);
  });

  it('routes a provisioning-only lock without a journal so executeSetup can recover a lost success acknowledgement', async () => {
    const config = createDefaultConfig('recovery');
    config.cloudflare = { accountId: 'account-1' };
    const paths = getEnvironmentPaths({ baseDir: root, env: 'recovery' });
    await mkdir(paths.root, { recursive: true });
    await writeFile(paths.config, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await saveLockFile(createLockFile('recovery', { d1: [], kv: [], queues: [], r2: [] }), {
      baseDir: root,
      env: 'recovery',
    });
    const runProvisioning = vi.fn(async () => undefined);

    await expect(
      resumeInterruptedProvisioningFromConfig({
        config,
        configPath: paths.config,
        runProvisioning,
      })
    ).resolves.toBe(true);
    expect(runProvisioning).toHaveBeenCalledOnce();
    expect(runProvisioning).toHaveBeenCalledWith(config, root);
  });

  it('does not route an activated environment without a provisioning journal into init recovery', async () => {
    const config = createDefaultConfig('recovery');
    config.cloudflare = { accountId: 'account-1' };
    const paths = getEnvironmentPaths({ baseDir: root, env: 'recovery' });
    await mkdir(paths.root, { recursive: true });
    await writeFile(paths.config, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    const lock = createLockFile('recovery', { d1: [], kv: [], queues: [], r2: [] });
    lock.productVersion = '0.4.0';
    await saveLockFile(lock, { baseDir: root, env: 'recovery' });
    const runProvisioning = vi.fn(async () => undefined);

    await expect(
      resumeInterruptedProvisioningFromConfig({
        config,
        configPath: paths.config,
        runProvisioning,
      })
    ).resolves.toBe(false);
    expect(runProvisioning).not.toHaveBeenCalled();
  });

  it('verifies the live R2 ownership marker before finalizing an interrupted journal', async () => {
    const source = await readFile(new URL('../cli/commands/init.ts', import.meta.url), 'utf-8');
    const completion = source.slice(
      source.indexOf('async function hasCompleteProvisioningArtifacts('),
      source.indexOf(
        '\nexport ',
        source.indexOf('async function hasCompleteProvisioningArtifacts(')
      )
    );

    expect(completion).toContain('await assertR2BucketOwnershipForUse({');
    expect(completion).toContain('environment: input.environment');
    expect(completion).toContain('binding: resource.binding');
  });

  it('resumes executeSetup from canonical config when no lock or journal was published', async () => {
    const config = createDefaultConfig('recovery');
    config.cloudflare = { accountId: 'account-1' };
    const paths = getEnvironmentPaths({ baseDir: root, env: 'recovery' });
    await mkdir(paths.root, { recursive: true });
    await writeFile(paths.config, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    const runProvisioning = vi.fn(async () => undefined);

    await expect(
      resumeInterruptedProvisioningFromConfig({
        config,
        configPath: paths.config,
        runProvisioning,
      })
    ).resolves.toBe(true);
    expect(runProvisioning).toHaveBeenCalledWith(config, root);
  });

  it('resumes the journal-aware provisioning path after config is saved but before lock', async () => {
    const initialConfig = createDefaultConfig('recovery');
    initialConfig.cloudflare = { accountId: 'account-1' };
    initialConfig.keys = {
      ...initialConfig.keys,
      secretsPath: join(root, '.authrim-keys', 'recovery') + '/',
      includeSecrets: false,
      storageType: 'external',
    };
    const attempt = await beginOrResumeProvisioningIntent({
      baseDir: root,
      environment: 'recovery',
      accountId: 'account-1',
      resourceSpec: buildProvisioningResourceSpec(initialConfig),
    });

    // This mirrors the durable state after executeSetup saves config and then stops before its
    // final lock: generated key metadata is present in config and pinned in the journal.
    const persistedConfig: AuthrimConfig = {
      ...initialConfig,
      keys: {
        keyId: 'recovery-key-1',
        publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: 'public-value' },
        secretsPath: initialConfig.keys.secretsPath,
        includeSecrets: false,
        storageType: 'external',
      },
    };
    await recordProvisioningKeyId({
      baseDir: root,
      environment: 'recovery',
      expectedIntentId: attempt.intent.id,
      keyId: persistedConfig.keys.keyId!,
    });
    const paths = getEnvironmentPaths({ baseDir: root, env: 'recovery' });
    await writeFile(paths.config, `${JSON.stringify(persistedConfig, null, 2)}\n`, {
      mode: 0o600,
    });
    const loadedConfig = parseConfig(JSON.parse(await readFile(paths.config, 'utf-8')));

    const runProvisioning = vi.fn(async () => undefined);
    await expect(
      resumeInterruptedProvisioningFromConfig({
        config: loadedConfig,
        configPath: paths.config,
        runProvisioning,
      })
    ).resolves.toBe(true);
    expect(runProvisioning).toHaveBeenCalledOnce();
    expect(runProvisioning).toHaveBeenCalledWith(loadedConfig, root);
  });

  it('fails closed before invoking provisioning when persisted config changes the pinned plan', async () => {
    const initialConfig = createDefaultConfig('recovery');
    initialConfig.cloudflare = { accountId: 'account-1' };
    await beginOrResumeProvisioningIntent({
      baseDir: root,
      environment: 'recovery',
      accountId: 'account-1',
      resourceSpec: buildProvisioningResourceSpec(initialConfig),
    });
    const changedConfig: AuthrimConfig = {
      ...initialConfig,
      database: {
        ...initialConfig.database,
        core: { location: 'weur', jurisdiction: 'none' },
      },
    };
    const paths = getEnvironmentPaths({ baseDir: root, env: 'recovery' });
    await writeFile(paths.config, `${JSON.stringify(changedConfig, null, 2)}\n`, { mode: 0o600 });
    const runProvisioning = vi.fn(async () => undefined);

    await expect(
      resumeInterruptedProvisioningFromConfig({
        config: changedConfig,
        configPath: paths.config,
        runProvisioning,
      })
    ).rejects.toThrow('provisioning_intent_resource_spec_mismatch');
    expect(runProvisioning).not.toHaveBeenCalled();
  });

  it('adopts the canonical config re-read under the lock instead of a stale config-only snapshot', () => {
    const staleConfig = createDefaultConfig('recovery');
    staleConfig.cloudflare = { accountId: 'account-1' };
    staleConfig.controlPlane = {
      ...staleConfig.controlPlane,
      automaticProvisioning: false,
    };
    const persistedConfig = parseConfig(
      JSON.parse(
        JSON.stringify({
          ...staleConfig,
          controlPlane: {
            ...staleConfig.controlPlane,
            automaticProvisioning: true,
          },
        })
      )
    );

    const reconciled = reconcileCanonicalProvisioningConfigAfterLock({
      environment: 'recovery',
      authenticatedAccountId: 'account-1',
      persistedConfig,
      intent: null,
    });

    expect(reconciled).toBe(persistedConfig);
    expect(reconciled.controlPlane?.automaticProvisioning).toBe(true);
    expect(staleConfig.controlPlane?.automaticProvisioning).not.toBe(true);
  });

  it('rejects a concurrent canonical plan change when a provisioning intent pins the plan', async () => {
    const initialConfig = createDefaultConfig('recovery');
    initialConfig.cloudflare = { accountId: 'account-1' };
    const attempt = await beginOrResumeProvisioningIntent({
      baseDir: root,
      environment: 'recovery',
      accountId: 'account-1',
      resourceSpec: buildProvisioningResourceSpec(initialConfig),
    });
    const changedConfig = parseConfig(
      JSON.parse(
        JSON.stringify({
          ...initialConfig,
          database: {
            ...initialConfig.database,
            core: { location: 'weur', jurisdiction: 'none' },
          },
        })
      )
    );

    expect(() =>
      reconcileCanonicalProvisioningConfigAfterLock({
        environment: 'recovery',
        authenticatedAccountId: 'account-1',
        persistedConfig: changedConfig,
        intent: attempt.intent,
      })
    ).toThrow('provisioning_intent_resource_spec_mismatch_after_operation_lock');
  });

  it('re-reads canonical recovery config only after both operation locks are held', async () => {
    const source = await readFile(new URL('../cli/commands/init.ts', import.meta.url), 'utf-8');
    const executeSetup = source.slice(source.indexOf('async function executeSetup('));
    const environmentLock = executeSetup.indexOf(
      'await acquireEnvironmentOperationForEnvironment({'
    );
    const deployConfigLock = executeSetup.indexOf(
      'deployConfigLock = await acquireDeployConfigLock'
    );
    const canonicalRead = executeSetup.indexOf(
      "await readFile(canonicalConfigPath, 'utf-8')",
      deployConfigLock
    );
    const resourceSpec = executeSetup.indexOf('const resourceSpec = buildProvisioningResourceSpec');

    expect(environmentLock).toBeGreaterThanOrEqual(0);
    expect(deployConfigLock).toBeGreaterThan(environmentLock);
    expect(canonicalRead).toBeGreaterThan(deployConfigLock);
    expect(resourceSpec).toBeGreaterThan(canonicalRead);
  });

  it('persists the provisioning intent before config, local secrets, and remote mutation', async () => {
    const source = await readFile(new URL('../cli/commands/init.ts', import.meta.url), 'utf-8');
    const executeSetup = source.slice(source.indexOf('async function executeSetup('));
    const completedRecoveryBranch = executeSetup.indexOf('if (complete) {');
    const completedRecoveryPromotion = executeSetup.indexOf(
      'await promotePendingEmailSecrets({',
      completedRecoveryBranch
    );
    const completedRecoveryJournalRemoval = executeSetup.indexOf(
      'await completeProvisioningIntent({',
      completedRecoveryBranch
    );
    const firstConfigWrite = executeSetup.indexOf(
      'await persistProvisioningConfig(config, envPaths.config);'
    );
    const firstIntentWrite = executeSetup.indexOf(
      'provisioningAttempt ??= await beginOrResumeProvisioningIntent({'
    );
    const emailSecretWrite = executeSetup.lastIndexOf(
      'await stagePendingEmailSecrets({',
      firstConfigWrite
    );
    const generatedKeyWrite = executeSetup.indexOf('await saveKeysToDirectory(');
    const emailSecretPromotion = executeSetup.indexOf(
      'await promotePendingEmailSecrets({',
      generatedKeyWrite
    );
    const secondConfigWrite = executeSetup.indexOf(
      'await persistProvisioningConfig(config, envPaths.config);',
      firstConfigWrite + 1
    );
    const remoteProvisioning = executeSetup.indexOf(
      'provisionedResources = await provisionResources({'
    );

    expect(firstConfigWrite).toBeGreaterThanOrEqual(0);
    expect(completedRecoveryPromotion).toBeGreaterThan(completedRecoveryBranch);
    expect(completedRecoveryJournalRemoval).toBeGreaterThan(completedRecoveryPromotion);
    expect(firstIntentWrite).toBeGreaterThan(emailSecretWrite);
    expect(firstConfigWrite).toBeGreaterThan(firstIntentWrite);
    expect(generatedKeyWrite).toBeGreaterThan(firstConfigWrite);
    expect(emailSecretPromotion).toBeGreaterThan(generatedKeyWrite);
    expect(secondConfigWrite).toBeGreaterThan(emailSecretPromotion);
    expect(remoteProvisioning).toBeGreaterThan(secondConfigWrite);
    expect(executeSetup).not.toContain('email_from.txt');
  });
});
