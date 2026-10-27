import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { AuthrimConfigSchema, createDefaultConfig } from '../core/config.js';
import { WORKER_COMPONENTS } from '../core/naming.js';
import { generateWranglerConfig } from '../core/wrangler.js';
import {
  getSecretNamesForWorker,
  getSecretTargetWorkers,
  SECRET_KEY_FILES,
} from '../core/secrets.js';
import {
  assertDistributedSecretValues,
  findMissingRequiredWorkerSecrets,
  loadDeploySecretsFromKeys,
} from '../core/deploy.js';

const writer = {
  version: 1 as const,
  endpoint: 'https://authority.example.test/replication/v1/rpc',
  credentialId: 'cf-writer',
  pairId: 'pair-a',
  tenantId: 'default',
  deploymentId: 'cf-a',
  epoch: 1,
  generationId: 'install-a',
};
const SECRET = 'AUTHRIM_REPLICATION_WRITER_SECRET';
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

it.each(WORKER_COMPONENTS)(
  'keeps standalone %s free of writer vars and secret upload',
  (component) => {
    const config = createDefaultConfig('standalone');
    config.components.loginUi = false;
    config.components.adminUi = false;
    expect(
      generateWranglerConfig(component, config, { d1: {}, kv: {} }).vars.AUTHRIM_REPLICATION_WRITER
    ).toBeUndefined();
    expect(getSecretNamesForWorker(component)).not.toContain(SECRET);
  }
);

it.each(WORKER_COMPONENTS)(
  'projects the same explicit writer identity and credential binding to %s',
  (component) => {
    const config = AuthrimConfigSchema.parse({
      environment: { prefix: 'pair-test' },
      components: { loginUi: false, adminUi: false },
      features: { samlDrExport: { enabled: true }, replicationWriter: writer },
    });
    const generated = generateWranglerConfig(component, config, { d1: {}, kv: {} });
    expect(JSON.parse(generated.vars.AUTHRIM_REPLICATION_WRITER)).toEqual(writer);
    expect(generated.vars.ENABLE_SAML_DR_EXPORT).toBe('true');
    expect(generated.vars[SECRET]).toBeUndefined();
    expect(getSecretNamesForWorker(component, { replicationWriter: true })).toContain(SECRET);
  }
);

it.each([
  { features: { replicationWriter: writer } },
  { features: { samlDrExport: { enabled: false }, replicationWriter: writer } },
  {
    features: {
      samlDrExport: { enabled: true },
      replicationWriter: { ...writer, secret: 'do-not-inline' },
    },
  },
  {
    tenant: { multiTenant: true },
    features: { samlDrExport: { enabled: true }, replicationWriter: writer },
  },
  {
    tenant: { name: 'another' },
    features: { samlDrExport: { enabled: true }, replicationWriter: writer },
  },
  { features: { samlDrExport: { enabled: true }, replicationWriter: { ...writer, epoch: 0 } } },
])('rejects incomplete, secret-bearing or cross-tenant replication settings', (extra) => {
  expect(
    AuthrimConfigSchema.safeParse({ environment: { prefix: 'pair-test' }, ...extra }).success
  ).toBe(false);
});

it('selects every covered worker, including router and DO host, only when explicitly enabled', () => {
  expect(new Set(getSecretTargetWorkers(undefined, { replicationWriter: true }))).toEqual(
    new Set(WORKER_COMPONENTS)
  );
  expect(getSecretTargetWorkers()).not.toContain('ar-router');
});

it('never loads a preexisting writer key unless replication is explicitly enabled', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'authrim-replication-secret-'));
  directories.push(directory);
  const filename = SECRET_KEY_FILES[SECRET];
  expect(filename).toBe('replication_writer_secret.txt');
  await writeFile(join(directory, 'replication_writer_secret.txt'), `${'a'.repeat(64)}\n`, {
    mode: 0o600,
  });
  expect(await loadDeploySecretsFromKeys(directory, ['ar-router'])).not.toHaveProperty(SECRET);
  expect(
    await loadDeploySecretsFromKeys(directory, ['ar-router'], { replicationWriter: true })
  ).toEqual({ [SECRET]: 'a'.repeat(64) });
});

it('requires the credential on every enabled worker, accepting only existing explicit bindings', async () => {
  const components = ['ar-lib-core', 'ar-control', 'ar-router'] as const;
  expect(
    await findMissingRequiredWorkerSecrets(
      { replicationWriter: true },
      components,
      async () => new Set()
    )
  ).toEqual(components.map((component) => ({ component, secret: SECRET })));
  expect(
    await findMissingRequiredWorkerSecrets(
      { replicationWriter: true, existingComponents: components },
      components,
      async () => new Set([SECRET])
    )
  ).toEqual([]);
  expect(await findMissingRequiredWorkerSecrets({}, components, async () => new Set())).toEqual([]);
  expect(() =>
    assertDistributedSecretValues(
      { replicationWriter: true, secrets: { [SECRET]: 'invalid' } },
      components
    )
  ).toThrow(`deploy_secret_value_invalid:${SECRET}`);
});

it.each(WORKER_COMPONENTS)(
  'allows multi-tenant writer v2 for the complete matching environment on %s',
  (component) => {
    const { tenantId: _tenant, ...rest } = writer;
    const environmentWriter = { ...rest, version: 2, environmentId: 'pair-test' };
    const config = AuthrimConfigSchema.parse({
      environment: { prefix: 'pair-test' },
      tenant: { multiTenant: true },
      components: { loginUi: false, adminUi: false },
      features: { samlDrExport: { enabled: true }, replicationWriter: environmentWriter },
    });
    expect(
      JSON.parse(
        generateWranglerConfig(component, config, { d1: {}, kv: {} }).vars
          .AUTHRIM_REPLICATION_WRITER
      )
    ).toEqual(environmentWriter);
    expect(
      AuthrimConfigSchema.safeParse({ ...config, environment: { prefix: 'other' } }).success
    ).toBe(false);
  }
);
