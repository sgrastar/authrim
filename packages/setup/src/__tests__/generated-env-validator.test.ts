import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultConfig } from '../core/config.js';
import { createLockFile } from '../core/lock.js';
import { getEnvironmentPaths } from '../core/paths.js';
import { WORKER_COMPONENTS } from '../core/naming.js';
import {
  buildResourceIdsFromLock,
  generateWranglerConfig,
  toToml,
} from '../core/wrangler.js';
import { validateGeneratedEnvironment } from '../core/generated-env-validator.js';

const tempDirs: string[] = [];

async function createFixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), 'authrim-generated-env-'));
  tempDirs.push(root);
  return root;
}

async function writeGeneratedEnvironment(
  root: string,
  options?: { externalStorageDefault?: boolean; withHyperdriveReferences?: boolean }
) {
  const env = 'portable';
  const config = createDefaultConfig(env);
  config.urls = {
    api: { custom: null, auto: 'https://portable-ar-router.workers.dev' },
    loginUi: { custom: null, auto: 'https://portable-ar-login-ui.workers.dev', sameAsApi: false },
    adminUi: { custom: null, auto: 'https://portable-ar-admin-ui.workers.dev', sameAsApi: false },
  };
  if (options?.externalStorageDefault) {
    config.profiles.defaults.storage = 'builtin:storage:external-postgres';
  }
  if (options?.withHyperdriveReferences) {
    config.profiles.references.hyperdrive = {
      'core-primary': {
        binding: 'HYPERDRIVE_CORE_PRIMARY',
        id: 'hyperdrive-core-id',
        driver: 'postgres',
      },
      'pii-primary': {
        binding: 'HYPERDRIVE_PII_PRIMARY',
        id: 'hyperdrive-pii-id',
        driver: 'postgres',
      },
    };
  }

  const envPaths = getEnvironmentPaths({ baseDir: root, env });
  await mkdir(envPaths.root, { recursive: true });
  await mkdir(envPaths.wrangler, { recursive: true });

  const lock = createLockFile(env, {
    d1: [
      { binding: 'DB', name: `${env}-authrim-core-db`, id: 'db-core-id' },
      { binding: 'DB_PII', name: `${env}-authrim-pii-db`, id: 'db-pii-id' },
      { binding: 'DB_ADMIN', name: `${env}-authrim-admin-db`, id: 'db-admin-id' },
    ],
    kv: [
      { binding: 'CLIENTS_CACHE', name: `${env.toUpperCase()}-CLIENTS_CACHE`, id: 'kv-clients' },
      { binding: 'INITIAL_ACCESS_TOKENS', name: `${env.toUpperCase()}-INITIAL_ACCESS_TOKENS`, id: 'kv-iat' },
      { binding: 'SETTINGS', name: `${env.toUpperCase()}-SETTINGS`, id: 'kv-settings' },
      { binding: 'REBAC_CACHE', name: `${env.toUpperCase()}-REBAC_CACHE`, id: 'kv-rebac' },
      { binding: 'USER_CACHE', name: `${env.toUpperCase()}-USER_CACHE`, id: 'kv-user' },
      { binding: 'AUTHRIM_CONFIG', name: `${env.toUpperCase()}-AUTHRIM_CONFIG`, id: 'kv-config' },
      { binding: 'STATE_STORE', name: `${env.toUpperCase()}-STATE_STORE`, id: 'kv-state' },
      { binding: 'CONSENT_CACHE', name: `${env.toUpperCase()}-CONSENT_CACHE`, id: 'kv-consent' },
    ],
    queues: [],
    r2: [
      { binding: 'IMPORT_ARTIFACTS', name: `${env}-import-artifacts` },
      { binding: 'EXPORT_ARTIFACTS', name: `${env}-export-artifacts` },
      { binding: 'SENSITIVE_DETAILS', name: `${env}-sensitive-details` },
    ],
  });

  await writeFile(envPaths.config, JSON.stringify(config, null, 2), 'utf-8');
  await writeFile(envPaths.lock, JSON.stringify(lock, null, 2), 'utf-8');

  const resourceIds = buildResourceIdsFromLock(lock);
  for (const component of WORKER_COMPONENTS) {
    const packageDir = join(root, 'packages', component);
    await mkdir(packageDir, { recursive: true });
    const toml = toToml(generateWranglerConfig(component, config, resourceIds), env);
    await writeFile(join(packageDir, 'wrangler.toml'), toml, 'utf-8');
  }

  for (const component of WORKER_COMPONENTS) {
    const toml = toToml(generateWranglerConfig(component, config, resourceIds), env);
    await writeFile(join(envPaths.wrangler, `${component}.toml`), toml, 'utf-8');
  }

  return { root, env };
}

describe('validateGeneratedEnvironment', () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map(async (dir) => {
        await import('node:fs/promises').then(({ rm }) => rm(dir, { recursive: true, force: true }));
      })
    );
  });

  it('passes a standard D1-backed generated environment', async () => {
    const { root, env } = await writeGeneratedEnvironment(await createFixtureRoot());

    const result = await validateGeneratedEnvironment({ baseDir: root, env });

    expect(result.ok).toBe(true);
    expect(result.checks.every((check) => check.status !== 'fail')).toBe(true);
  });

  it('fails when the active storage default requires unsupported external primary bindings', async () => {
    const { root, env } = await writeGeneratedEnvironment(await createFixtureRoot(), {
      externalStorageDefault: true,
    });

    const result = await validateGeneratedEnvironment({ baseDir: root, env });

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'active-profile-compatibility')?.details).toEqual(
      expect.arrayContaining([
        expect.stringContaining('builtin:storage:external-postgres'),
      ])
    );
  });

  it('passes when the active external storage default is backed by configured Hyperdrive references', async () => {
    const { root, env } = await writeGeneratedEnvironment(await createFixtureRoot(), {
      externalStorageDefault: true,
      withHyperdriveReferences: true,
    });

    const result = await validateGeneratedEnvironment({ baseDir: root, env });

    expect(result.ok).toBe(true);
    expect(result.checks.every((check) => check.status !== 'fail')).toBe(true);
  });
});
