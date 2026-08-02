import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const generatedEnvDir = resolve(repoRoot, '.authrim/test');
const generatedKeysDir = resolve(repoRoot, '.authrim-keys/test');
const generatedEnvAvailable =
  existsSync(resolve(generatedEnvDir, 'config.json')) &&
  existsSync(resolve(generatedEnvDir, 'lock.json')) &&
  existsSync(resolve(generatedEnvDir, 'wrangler/ar-management.toml')) &&
  existsSync(resolve(generatedEnvDir, 'wrangler/ar-plugin-runner.toml')) &&
  existsSync(generatedKeysDir);

interface GeneratedConfig {
  features?: {
    queue?: { enabled?: boolean };
    r2?: { enabled?: boolean };
    email?: { provider?: string };
  };
  profiles?: {
    defaults?: {
      storage?: string;
      audit?: string;
      residency?: string;
    };
    registry?: { backend?: string };
  };
}

interface GeneratedLock {
  d1?: Record<string, { name?: string; id?: string }>;
  r2?: Record<string, { name?: string }>;
  kv?: Record<string, { name?: string; id?: string }>;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

function readWrangler(component: string): string {
  return readFileSync(resolve(generatedEnvDir, `wrangler/${component}.toml`), 'utf-8');
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
  const path = resolve(generatedKeysDir, name);
  expect(existsSync(path), `${name} should exist`).toBe(true);
  expect(statSync(path).size, `${name} should not be empty`).toBeGreaterThan(0);
}

const describeGenerated = generatedEnvAvailable ? describe : describe.skip;

describeGenerated('generated test environment logging/storage contract', () => {
  it('uses the standard audit profile and provisions the log storage bindings', () => {
    const config = readJson<GeneratedConfig>(resolve(generatedEnvDir, 'config.json'));
    const lock = readJson<GeneratedLock>(resolve(generatedEnvDir, 'lock.json'));

    expect(config.profiles?.defaults).toMatchObject({
      storage: 'builtin:storage:tenant-d1',
      audit: 'builtin:audit:standard',
      residency: 'builtin:residency:default',
    });
    expect(config.profiles?.registry?.backend).toBe('kv');
    expect(config.features?.r2?.enabled).toBe(true);

    expect(Object.keys(lock.d1 ?? {}).sort()).toEqual(
      expect.arrayContaining(['DB', 'DB_ADMIN', 'DB_PII'])
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
      DEFAULT_STORAGE_PROFILE_ID: 'builtin:storage:tenant-d1',
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
        DEFAULT_STORAGE_PROFILE_ID: 'builtin:storage:tenant-d1',
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
