import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  ResourceNotFoundException,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { createAwsSamlRuntime } from '../http-runtime';
import {
  restoreOfflineAwsSamlTenant,
  type RestoreOfflineAwsSamlTenantInput,
} from '../import/restore-offline';
import { canonicalRestoreJson } from '../import/restore-evidence';
import type { AwsRestoreActivationEvidence } from '../import/restore-coordinator';
import { createAwsSdkAssetReader, type AwsAssetReader } from '../startup/aws-assets';
import {
  parseAwsSamlDeploymentSecrets,
  type AwsSamlDeploymentSecrets,
  type AwsS3ObjectPin,
} from '../startup/deployment-config';
import { loadActivatedAwsSamlTenant } from '../startup/load-activated-tenant';
import { runSyntheticAwsAuthenticationRehearsal } from './authentication-rehearsal';
import { prepareBrowserSp } from './prepare-browser-sp';
import { readBrowserRehearsalSnapshot } from './browser-rehearsal-snapshot';
import {
  countMaintenanceRows,
  DATABASE_FAMILIES,
  initializeMaintenanceDatabases,
  inspectMaintenanceTargets,
  loadMaintenanceMigrations,
  maintenanceDatabaseUrl,
  withMaintenanceLock,
  type DatabaseFamily,
  type MaintenanceDatabase,
} from './database';

const HASH = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const MAX_ASSET_BYTES = 256 * 1024 * 1024;
export interface MaintenanceConfiguration {
  region: string;
  host: string;
  port: number;
  masterSecretArn: string;
  configSecretArn: string;
  configSecretVersionId: string;
  runtimeSecretArn: string;
  browserSpSecretArn?: string;
  initializationId: string;
  databasePrefix: string;
  bucket: string;
  bucketOwner: string;
  assetPrefix: string;
  fixtureKey: string;
  fixtureVersionId: string;
  fixtureSha256: string;
}
interface MaintenanceFixture {
  formatVersion: 1;
  manifest: { source: { tenantId: string; issuer: string } };
  backup: Omit<RestoreOfflineAwsSamlTenantInput['backup'], 'partPaths' | 'passphrase'> & {
    parts: AwsS3ObjectPin[];
  };
  supplement: AwsS3ObjectPin;
  restoreId: string;
  core: { targetId: string; bindingRefs: string[] };
  pii: { targetId: string; bindingRefs: string[] };
  environmentName: string;
  spEntityIds: string[];
  allocationScope: 'shared_pool' | 'tenant_exclusive';
}
function invalid(): never {
  throw new Error('aws_maintenance_configuration_invalid');
}
function exactKeys(value: object, keys: string[]) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== keys.sort().join(',')
  )
    invalid();
}
export function parseMaintenanceConfiguration(
  environment: Readonly<Record<string, string | undefined>>
): MaintenanceConfiguration {
  const read = (key: string) => environment[`AUTHRIM_AWS_${key}`] || invalid();
  const value: MaintenanceConfiguration = {
    region: environment.AWS_REGION || invalid(),
    host: read('DB_HOST'),
    port: Number(read('DB_PORT')),
    masterSecretArn: read('MASTER_SECRET_ARN'),
    configSecretArn: read('JOB_CONFIG_SECRET_ARN'),
    configSecretVersionId: read('JOB_CONFIG_SECRET_VERSION_ID'),
    runtimeSecretArn: read('RUNTIME_SECRET_ARN'),
    ...(environment.AUTHRIM_AWS_BROWSER_SP_SECRET_ARN
      ? { browserSpSecretArn: environment.AUTHRIM_AWS_BROWSER_SP_SECRET_ARN }
      : {}),
    initializationId: read('INITIALIZATION_ID'),
    databasePrefix: read('DATABASE_PREFIX'),
    bucket: read('ASSETS_BUCKET'),
    bucketOwner: read('BUCKET_OWNER'),
    assetPrefix: read('ASSET_PREFIX'),
    fixtureKey: read('FIXTURE_KEY'),
    fixtureVersionId: read('FIXTURE_VERSION_ID'),
    fixtureSha256: read('FIXTURE_SHA256'),
  };
  if (
    !/^[a-z]{2}-[a-z]+-\d$/u.test(value.region) ||
    !/^\d{12}$/u.test(value.bucketOwner) ||
    !/^[a-z][a-z0-9_]{0,49}$/u.test(value.databasePrefix) ||
    !UUID.test(value.initializationId) ||
    !/^[a-z0-9.-]+\.rds\.amazonaws\.com$/u.test(value.host) ||
    value.port !== 5432 ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(value.bucket) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_./-]*\/$/u.test(value.assetPrefix) ||
    value.assetPrefix.includes('..') ||
    !value.fixtureKey.startsWith(value.assetPrefix) ||
    value.fixtureKey.includes('..') ||
    !HASH.test(value.fixtureSha256) ||
    !value.fixtureVersionId ||
    value.fixtureVersionId === 'null' ||
    !/^[A-Za-z0-9-]{32,64}$/u.test(value.configSecretVersionId) ||
    environment.NODE_EXTRA_CA_CERTS !== '/var/task/certs/rds-ca.pem'
  )
    invalid();
  const prefix = `arn:aws:secretsmanager:${value.region}:${value.bucketOwner}:secret:`;
  const arns = [value.masterSecretArn, value.configSecretArn, value.runtimeSecretArn];
  if (new Set(arns).size !== 3 || arns.some((arn) => !arn.startsWith(prefix) || arn.length > 2048))
    invalid();
  if (
    value.browserSpSecretArn &&
    (!value.browserSpSecretArn.startsWith(prefix) ||
      value.browserSpSecretArn.length > 2048 ||
      arns.includes(value.browserSpSecretArn) ||
      value.databasePrefix !== 'authrim_dr_browser' ||
      value.region !== 'ap-northeast-1')
  )
    invalid();
  return value;
}
export function parseMaintenanceAction(event: unknown): {
  action: 'initialize' | 'restore' | 'verify' | 'authenticate' | 'prepare-browser-sp';
  evidence?: AwsRestoreActivationEvidence;
} {
  if (!event || typeof event !== 'object' || Array.isArray(event)) invalid();
  const input = event as { action?: unknown; evidence?: AwsRestoreActivationEvidence };
  if (
    !['initialize', 'restore', 'verify', 'authenticate', 'prepare-browser-sp'].includes(
      String(input.action)
    )
  )
    invalid();
  const requiresEvidence = ['verify', 'authenticate', 'prepare-browser-sp'].includes(
    String(input.action)
  );
  exactKeys(input, requiresEvidence ? ['action', 'evidence'] : ['action']);
  if (requiresEvidence && (!input.evidence || typeof input.evidence !== 'object')) invalid();
  return input as {
    action: 'initialize' | 'restore' | 'verify' | 'authenticate' | 'prepare-browser-sp';
    evidence?: AwsRestoreActivationEvidence;
  };
}

async function assetBytes(
  reader: AwsAssetReader,
  config: MaintenanceConfiguration,
  pin: Omit<AwsS3ObjectPin, 'size'> & { size?: number },
  maxBytes: number
): Promise<Uint8Array> {
  if (
    !pin.key.startsWith(config.assetPrefix) ||
    pin.key.includes('..') ||
    !pin.versionId ||
    pin.versionId === 'null' ||
    !HASH.test(pin.sha256) ||
    maxBytes < 1 ||
    maxBytes > MAX_ASSET_BYTES
  )
    invalid();
  const object = await reader.getObject({
    bucket: config.bucket,
    owner: config.bucketOwner,
    key: pin.key,
    versionId: pin.versionId,
    signal: AbortSignal.timeout(120_000),
  });
  try {
    if (
      object.versionId !== pin.versionId ||
      !Number.isSafeInteger(object.size) ||
      (object.size ?? 0) < 1 ||
      (object.size ?? 0) > maxBytes ||
      (pin.size !== undefined && pin.size !== object.size)
    )
      invalid();
    const chunks: Uint8Array[] = [];
    let length = 0;
    const hash = createHash('sha256');
    for await (const chunk of object.body) {
      length += chunk.byteLength;
      if (length > maxBytes || length > (object.size ?? 0)) invalid();
      chunks.push(chunk);
      hash.update(chunk);
    }
    if (length !== object.size || hash.digest('hex') !== pin.sha256) invalid();
    const combined = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return combined;
  } finally {
    object.close();
  }
}
function parseFixture(raw: Uint8Array): MaintenanceFixture {
  const fixture = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(raw)
  ) as MaintenanceFixture;
  if (
    fixture.formatVersion !== 1 ||
    !fixture.manifest?.source?.tenantId ||
    !fixture.manifest.source.issuer ||
    !UUID.test(fixture.restoreId) ||
    !UUID.test(fixture.core?.targetId) ||
    !UUID.test(fixture.pii?.targetId) ||
    fixture.core.targetId === fixture.pii.targetId ||
    !Array.isArray(fixture.backup?.parts) ||
    fixture.backup.parts.length < 1 ||
    fixture.backup.parts.length > 128 ||
    !fixture.supplement ||
    !Array.isArray(fixture.spEntityIds) ||
    !fixture.environmentName ||
    !['shared_pool', 'tenant_exclusive'].includes(fixture.allocationScope)
  )
    invalid();
  const pins = [...fixture.backup.parts, fixture.supplement];
  if (
    pins.some((pin) => !Number.isSafeInteger(pin.size) || pin.size < 1) ||
    pins.reduce((sum, pin) => sum + pin.size, 0) > MAX_ASSET_BYTES
  )
    invalid();
  return fixture;
}
function databases(
  config: MaintenanceConfiguration,
  secret: AwsSamlDeploymentSecrets
): Record<DatabaseFamily, MaintenanceDatabase> {
  const urls = {
    core: secret.coreDatabaseUrl,
    pii: secret.piiDatabaseUrl,
    state: secret.stateDatabaseUrl,
  };
  return Object.fromEntries(
    DATABASE_FAMILIES.map((family) => {
      const name = `${config.databasePrefix}_${family}`;
      const url = new URL(urls[family]);
      if (
        url.hostname !== config.host ||
        Number(url.port) !== config.port ||
        url.pathname !== `/${name}` ||
        decodeURIComponent(url.username) !== name ||
        !/^[A-Za-z0-9_-]{43}$/u.test(decodeURIComponent(url.password))
      )
        invalid();
      return [
        family,
        {
          name,
          user: name,
          password: decodeURIComponent(url.password),
          connectionString: urls[family],
        },
      ];
    })
  ) as Record<DatabaseFamily, MaintenanceDatabase>;
}
const sdkConfiguration = () => ({
  region: process.env.AWS_REGION,
  maxAttempts: 2,
  ignoreConfiguredEndpointUrls: true,
  requestHandler: { connectionTimeout: 3_000, requestTimeout: 30_000 },
});
let secretClient: SecretsManagerClient | undefined;
let assetReader: AwsAssetReader | undefined;

/** Manual-only private maintenance entry. It accepts no SQL, URLs, credentials or database names. */
export async function handler(event: unknown) {
  let stage = 'validate';
  let directory: string | undefined;
  try {
    const action = parseMaintenanceAction(event);
    const config = parseMaintenanceConfiguration(process.env);
    if (action.action === 'prepare-browser-sp' && !config.browserSpSecretArn) invalid();
    // Fail before any secret/database access if the reviewed CA file was omitted from the ZIP.
    if (!(await readFile('/var/task/certs/rds-ca.pem', 'utf8')).includes('BEGIN CERTIFICATE'))
      invalid();
    const secrets = (secretClient ??= new SecretsManagerClient(sdkConfiguration()));
    const reader = (assetReader ??= createAwsSdkAssetReader(config.region));
    const getSecret = async (arn: string, versionId?: string) => {
      const response = await secrets.send(
        new GetSecretValueCommand({ SecretId: arn, ...(versionId ? { VersionId: versionId } : {}) })
      );
      if (
        response.ARN !== arn ||
        !response.SecretString ||
        (versionId && response.VersionId !== versionId)
      )
        invalid();
      return response.SecretString;
    };
    stage = 'read_fixture';
    const fixture = parseFixture(
      await assetBytes(
        reader,
        config,
        {
          key: config.fixtureKey,
          versionId: config.fixtureVersionId,
          sha256: config.fixtureSha256,
        },
        2 * 1024 * 1024
      )
    );
    stage = 'read_master';
    const master = JSON.parse(await getSecret(config.masterSecretArn)) as {
      username: string;
      password: string;
      host?: string;
      port?: number;
      engine?: string;
    };
    if (
      (master.host && master.host !== config.host) ||
      (master.port && master.port !== config.port) ||
      (master.engine && master.engine !== 'postgres') ||
      typeof master.username !== 'string' ||
      typeof master.password !== 'string'
    )
      invalid();
    const masterUrl = maintenanceDatabaseUrl({
      host: config.host,
      port: config.port,
      database: 'postgres',
      username: master.username,
      password: master.password,
    });
    stage = 'connect_master';
    return await withMaintenanceLock(masterUrl, config.initializationId, async (admin) => {
      let runtime: AwsSamlDeploymentSecrets;
      stage = 'read_runtime_secret';
      try {
        runtime = parseAwsSamlDeploymentSecrets(
          await getSecret(config.runtimeSecretArn, config.initializationId),
          fixture.manifest.source.tenantId
        );
      } catch (error) {
        if (!(error instanceof ResourceNotFoundException) || action.action !== 'initialize')
          throw error;
        // Never replace an existing current secret or adopt pre-existing databases silently.
        const current = JSON.parse(await getSecret(config.runtimeSecretArn)) as object;
        exactKeys(current, ['formatVersion', 'uninitialized']);
        if (
          (current as { formatVersion: unknown }).formatVersion !== 1 ||
          (current as { uninitialized: unknown }).uninitialized !== true
        )
          invalid();
        const targets = await inspectMaintenanceTargets(
          admin,
          DATABASE_FAMILIES.map((family) => `${config.databasePrefix}_${family}`)
        );
        if (targets.databases.length || targets.roles.length) invalid();
        const seed = JSON.parse(
          await getSecret(config.configSecretArn, config.configSecretVersionId)
        ) as {
          backupPassphrase: string;
          awsFlowRuntimeHmacSecret: string;
          awsLookupReadKeys: AwsSamlDeploymentSecrets['lookupReadKeys'];
        };
        const urls = Object.fromEntries(
          DATABASE_FAMILIES.map((family) => [
            family,
            maintenanceDatabaseUrl({
              host: config.host,
              port: config.port,
              database: `${config.databasePrefix}_${family}`,
              username: `${config.databasePrefix}_${family}`,
              password: btoa(String.fromCharCode(...randomBytes(32)))
                .replaceAll('+', '-')
                .replaceAll('/', '_')
                .replaceAll('=', ''),
            }),
          ])
        );
        runtime = parseAwsSamlDeploymentSecrets(
          JSON.stringify({
            formatVersion: 1,
            tenantId: fixture.manifest.source.tenantId,
            backupPassphrase: seed.backupPassphrase,
            coreDatabaseUrl: urls.core,
            piiDatabaseUrl: urls.pii,
            stateDatabaseUrl: urls.state,
            flowHmacSecret: seed.awsFlowRuntimeHmacSecret,
            lookupReadKeys: seed.awsLookupReadKeys,
          }),
          fixture.manifest.source.tenantId
        );
        stage = 'persist_credentials';
        const saved = await secrets.send(
          new PutSecretValueCommand({
            SecretId: config.runtimeSecretArn,
            ClientRequestToken: config.initializationId,
            SecretString: canonicalRestoreJson(runtime),
          })
        );
        if (saved.ARN !== config.runtimeSecretArn || saved.VersionId !== config.initializationId)
          invalid();
      }
      const targets = databases(config, runtime);
      if (action.action === 'initialize') {
        stage = 'initialize_databases';
        const migrations = Object.fromEntries(
          await Promise.all(
            DATABASE_FAMILIES.map(async (family) => [
              family,
              await loadMaintenanceMigrations(family),
            ])
          )
        ) as Record<DatabaseFamily, Awaited<ReturnType<typeof loadMaintenanceMigrations>>>;
        const schema = await initializeMaintenanceDatabases({
          master: admin,
          initializationId: config.initializationId,
          databases: targets,
          migrations,
        });
        return {
          status: 'initialized',
          initializationId: config.initializationId,
          runtimeSecretVersionId: config.initializationId,
          schema,
        };
      }
      stage = 'download_backup';
      directory = await mkdtemp(join(tmpdir(), 'authrim-maintenance-'));
      const partPaths: string[] = [];
      for (const [index, pin] of fixture.backup.parts.entries()) {
        const path = join(directory, `part-${index}.bin`);
        await writeFile(path, await assetBytes(reader, config, pin, pin.size), {
          mode: 0o600,
          flag: 'wx',
        });
        partPaths.push(path);
      }
      const supplementPath = join(directory, 'supplement.json');
      await writeFile(
        supplementPath,
        await assetBytes(reader, config, fixture.supplement, fixture.supplement.size),
        { mode: 0o600, flag: 'wx' }
      );
      const { parts: _parts, ...backup } = fixture.backup;
      const input: RestoreOfflineAwsSamlTenantInput = {
        backup: { ...backup, partPaths, passphrase: runtime.backupPassphrase },
        supplement: { path: supplementPath, expectedSha256: fixture.supplement.sha256 },
        restoreId: fixture.restoreId,
        core: { ...fixture.core, connectionString: runtime.coreDatabaseUrl },
        pii: { ...fixture.pii, connectionString: runtime.piiDatabaseUrl },
        state: { connectionString: runtime.stateDatabaseUrl, initializeEmptySchema: false },
        environmentName: fixture.environmentName,
        spEntityIds: fixture.spEntityIds,
        allocationScope: fixture.allocationScope,
        awsFlowRuntimeHmacSecret: runtime.flowHmacSecret,
        awsLookupReadKeys: runtime.lookupReadKeys,
      };
      stage = action.action === 'restore' ? 'restore' : 'verify';
      let evidence: AwsRestoreActivationEvidence;
      if (action.action === 'restore') {
        const restored = await restoreOfflineAwsSamlTenant(input);
        try {
          await restored.runtime.assertReady();
          evidence = restored.evidence;
        } finally {
          await restored.close();
        }
      } else {
        if (!action.evidence || action.evidence.restoreId !== fixture.restoreId) invalid();
        evidence = action.evidence;
      }
      if (action.action === 'authenticate') {
        stage = 'authenticate';
        const authentication = await runSyntheticAwsAuthenticationRehearsal({
          load: () => loadActivatedAwsSamlTenant({ ...input, evidence }),
          databases: targets,
          fixture,
          seed: JSON.parse(await getSecret(config.configSecretArn, config.configSecretVersionId)),
        });
        return {
          status: 'authenticated',
          evidence,
          runtimeSecretVersionId: config.initializationId,
          authentication,
          rowCounts: await countMaintenanceRows(targets, fixture.manifest.source.tenantId),
        };
      }
      stage = 'cold_reload';
      const loaded = await loadActivatedAwsSamlTenant({ ...input, evidence });
      try {
        await loaded.runtime.assertReady();
        const app = createAwsSamlRuntime({ tenants: [loaded.runtime] });
        if (action.action === 'prepare-browser-sp') {
          stage = 'prepare_browser_sp';
          const secretArn = config.browserSpSecretArn || invalid();
          const prepared = await prepareBrowserSp({
            onStage: (substage) => {
              stage = `prepare_browser_sp_${substage}`;
            },
            databasePrefix: config.databasePrefix,
            environmentName: fixture.environmentName,
            tenantId: fixture.manifest.source.tenantId,
            issuer: fixture.manifest.source.issuer,
            spEntityIds: fixture.spEntityIds,
            host: config.host,
            stateDatabaseUrl: runtime.stateDatabaseUrl,
            seed: JSON.parse(await getSecret(config.configSecretArn, config.configSecretVersionId)),
            metadata: async () =>
              app.app.request(`${fixture.manifest.source.issuer}/saml/idp/metadata`, undefined, {
                requestContext: { http: { sourceIp: '203.0.113.8' } },
              }),
            currentSecret: () => getSecret(secretArn),
            saveSecret: async (value) => {
              const saved = await secrets.send(
                new PutSecretValueCommand({
                  SecretId: secretArn,
                  ClientRequestToken: config.initializationId,
                  SecretString: value,
                })
              );
              if (saved.ARN !== secretArn || saved.VersionId !== config.initializationId) invalid();
            },
          });
          return {
            status: 'browser-sp-prepared',
            ...prepared,
            browserSpSecretVersionId: config.initializationId,
          };
        }
        const response = await app.app.request(`${fixture.manifest.source.issuer}/health/ready`);
        if (response.status !== 200) throw new Error('aws_maintenance_readiness_failed');
        const rowCounts = await countMaintenanceRows(targets, fixture.manifest.source.tenantId);
        return {
          status: action.action === 'restore' ? 'restored' : 'verified',
          evidence,
          runtimeSecretVersionId: config.initializationId,
          readinessStatus: response.status,
          coldReloadVerified: true,
          rowCounts,
          ...(fixture.environmentName === 'aws-browser-rehearsal' &&
          config.databasePrefix === 'authrim_dr_browser'
            ? { browserSnapshot: await readBrowserRehearsalSnapshot(targets) }
            : {}),
        };
      } finally {
        await loaded.close();
      }
    });
  } catch (error) {
    // Raw SDK/SQL messages may contain secret material; never log, wrap or return those errors.
    if (
      stage === 'authenticate' &&
      error instanceof Error &&
      /^aws_synthetic_authentication_rehearsal_failed:[a-z_0-9-]{1,40}(?::[a-z_0-9-]{1,40})?$/u.test(
        error.message
      )
    ) {
      throw new Error(
        `aws_database_maintenance_failed:authenticate:${error.message.split(':').slice(1).join(':')}`
      );
    }
    throw new Error(`aws_database_maintenance_failed:${stage}`);
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
