import { existsSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDefaultConfig, type AuthrimConfig } from '../core/config.js';
import { generateAllSecrets, saveKeysToDirectory } from '../core/keys.js';
import { createLockFile, type AuthrimLock } from '../core/lock.js';
import { WORKER_COMPONENTS, type WorkerComponent } from '../core/naming.js';
import { buildResourceIdsFromLock, generateWranglerConfig, toToml } from '../core/wrangler.js';

let fixtureRoot: string;
let generatedKeysDir: string;
let config: AuthrimConfig;
let lock: AuthrimLock;
const generatedWrangler = new Map<WorkerComponent, string>();

function readWrangler(component: string): string {
  const generated = generatedWrangler.get(component as WorkerComponent);
  if (!generated) throw new Error(`Missing generated Wrangler fixture for ${component}`);
  return generated;
}

function section(text: string, name: string): string {
  const start = text.indexOf(name);
  if (start < 0) return '';
  const next = text.slice(start + name.length).search(/\n\[[^[]/u);
  return next < 0 ? text.slice(start) : text.slice(start, start + name.length + next);
}

function bindingNames(text: string, sectionName: string, field: 'binding' | 'name' = 'binding') {
  return [
    ...section(text, sectionName).matchAll(new RegExp(`${field}\\s*=\\s*"([^"]+)"`, 'gu')),
  ].map((match) => match[1]);
}

function vars(text: string): Record<string, string> {
  return Object.fromEntries(
    [...section(text, '[env.test.vars]').matchAll(/^([A-Z0-9_]+)\s*=\s*"([^"]*)"$/gmu)].map(
      (match) => [match[1], match[2]]
    )
  );
}

function expectKeyFile(name: string) {
  const path = join(generatedKeysDir, name);
  expect(existsSync(path), `${name} should exist`).toBe(true);
  expect(statSync(path).size, `${name} should not be empty`).toBeGreaterThan(0);
}

beforeAll(async () => {
  const env = 'test';
  fixtureRoot = await mkdtemp(join(process.cwd(), '.test-generated-logging-contract-'));
  generatedKeysDir = join(fixtureRoot, 'keys');

  config = createDefaultConfig(env);
  config.cloudflare.accountId = 'fixture-account-id';
  config.urls = {
    api: { custom: null, auto: 'https://test-ar-router.workers.dev' },
    loginUi: { custom: null, auto: 'https://test-ar-login-ui.workers.dev', sameAsApi: false },
    adminUi: { custom: null, auto: 'https://test-ar-admin-ui.workers.dev', sameAsApi: false },
  };

  lock = createLockFile(env, {
    d1: [
      { binding: 'DB', name: 'test-authrim-core-db', id: 'db-core-id' },
      { binding: 'DB_PII', name: 'test-authrim-pii-db', id: 'db-pii-id' },
      { binding: 'DB_ADMIN', name: 'test-authrim-admin-db', id: 'db-admin-id' },
      { binding: 'CONTROL_DB', name: 'test-authrim-control-db', id: 'db-control-id' },
      { binding: 'LOOKUP_DB', name: 'test-authrim-lookup-db', id: 'db-lookup-id' },
      {
        binding: 'PLUGIN_RUNNER_DB',
        name: 'test-authrim-plugin-runner-db',
        id: 'db-plugin-runner-id',
      },
      {
        binding: 'TEST_TDB_DEFAULT_BOOTSTRAP_CORE',
        name: 'test-authrim-tenant-default-bootstrap-db',
        id: 'db-tenant-default-id',
      },
      {
        binding: 'TEST_TDB_USERS_BOOTSTRAP_CORE',
        name: 'test-authrim-tenant-users-bootstrap-db',
        id: 'db-tenant-users-id',
      },
      {
        binding: 'TEST_TDB_PII_BOOTSTRAP_PII',
        name: 'test-authrim-tenant-pii-bootstrap-db',
        id: 'db-tenant-pii-id',
      },
    ],
    kv: [
      { binding: 'AUTHRIM_CONFIG', name: 'TEST-AUTHRIM_CONFIG', id: 'kv-config-id' },
      { binding: 'SETTINGS', name: 'TEST-SETTINGS', id: 'kv-settings-id' },
      {
        binding: 'TENANT_RUNTIME_REGISTRY',
        name: 'TEST-TENANT-RUNTIME-REGISTRY',
        id: 'kv-runtime-registry-id',
      },
    ],
    queues: [],
    r2: [
      { binding: 'MIGRATION_RELEASES', name: 'test-migration-releases' },
      { binding: 'PLUGIN_BUNDLES', name: 'test-plugin-bundles' },
      { binding: 'DIAGNOSTIC_LOGS', name: 'test-diagnostic-logs' },
      { binding: 'AUDIT_ARCHIVE', name: 'test-audit-archive' },
      { binding: 'EXPORT_ARTIFACTS', name: 'test-export-artifacts' },
      { binding: 'IMPORT_ARTIFACTS', name: 'test-import-artifacts' },
      { binding: 'PUBLIC_ASSETS', name: 'test-public-assets' },
      { binding: 'SENSITIVE_DETAILS', name: 'test-sensitive-details' },
    ],
  });

  const resourceIds = buildResourceIdsFromLock(lock);
  for (const component of WORKER_COMPONENTS) {
    generatedWrangler.set(
      component,
      toToml(generateWranglerConfig(component, config, resourceIds), env)
    );
  }

  await saveKeysToDirectory(generateAllSecrets('generated-logging-contract'), {
    targetDir: generatedKeysDir,
  });
});

afterAll(async () => {
  generatedWrangler.clear();
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
});

describe('generated environment logging and Control Plane contract', () => {
  it('uses the standard audit profile and provisions the log storage bindings', () => {
    expect(config.profiles?.defaults).toMatchObject({
      audit: 'builtin:audit:standard',
      residency: 'builtin:residency:default',
    });
    expect(config.profiles?.registry?.backend).toBe('kv');
    expect(config.features?.r2?.enabled).toBe(true);

    expect(Object.keys(lock.d1 ?? {}).sort()).toEqual(
      expect.arrayContaining([
        'CONTROL_DB',
        'LOOKUP_DB',
        'TEST_TDB_DEFAULT_BOOTSTRAP_CORE',
        'TEST_TDB_USERS_BOOTSTRAP_CORE',
        'TEST_TDB_PII_BOOTSTRAP_PII',
      ])
    );
    expect(Object.keys(lock.r2 ?? {}).sort()).toEqual(
      expect.arrayContaining([
        'DIAGNOSTIC_LOGS',
        'AUDIT_ARCHIVE',
        'EXPORT_ARTIFACTS',
        'IMPORT_ARTIFACTS',
        'PUBLIC_ASSETS',
        'SENSITIVE_DETAILS',
      ])
    );
    expect(Object.keys(lock.kv ?? {}).sort()).toEqual(
      expect.arrayContaining(['AUTHRIM_CONFIG', 'SETTINGS', 'TENANT_RUNTIME_REGISTRY'])
    );
  });

  it('maps each generated worker to the bindings needed by its log write paths', () => {
    const management = readWrangler('ar-management');
    expect(bindingNames(management, '[[env.test.d1_databases]]')).toEqual(
      expect.arrayContaining(['DB', 'DB_ADMIN', 'DB_PII'])
    );
    expect(bindingNames(management, '[[env.test.r2_buckets]]')).toEqual(
      expect.arrayContaining([
        'DIAGNOSTIC_LOGS',
        'AUDIT_ARCHIVE',
        'EXPORT_ARTIFACTS',
        'IMPORT_ARTIFACTS',
        'PUBLIC_ASSETS',
        'SENSITIVE_DETAILS',
      ])
    );
    expect(bindingNames(management, '[[env.test.send_email]]', 'name')).toEqual([]);
    expect(vars(management)).toMatchObject({
      DEFAULT_AUDIT_PROFILE_ID: 'builtin:audit:standard',
      PROFILE_REGISTRY_BACKEND: 'kv',
    });

    for (const component of ['ar-auth', 'ar-token', 'ar-saml', 'ar-vc', 'ar-async']) {
      expect(bindingNames(readWrangler(component), '[[env.test.r2_buckets]]')).toContain(
        'DIAGNOSTIC_LOGS'
      );
    }

    for (const component of [
      'ar-auth',
      'ar-token',
      'ar-userinfo',
      'ar-discovery',
      'ar-saml',
      'ar-bridge',
      'ar-management',
    ]) {
      expect(vars(readWrangler(component))).toMatchObject({
        DEFAULT_AUDIT_PROFILE_ID: 'builtin:audit:standard',
      });
    }
  });

  it('has key material required for encrypted log detail and cursor signatures', () => {
    expectKeyFile('object_encryption_root_key.txt');
    expectKeyFile('logging_cursor_hmac_secret.txt');
    expectKeyFile('tenant_runtime_registry_signing_private.jwk.json');
    expectKeyFile('tenant_runtime_registry_verify.jwks.json');
  });
});
