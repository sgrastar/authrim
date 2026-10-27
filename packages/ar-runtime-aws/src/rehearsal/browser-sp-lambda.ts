/** Isolated synthetic SP entry. Its role can read only the pinned SP-specific secret. */
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { LambdaContext, LambdaEvent } from 'hono/aws-lambda';
import { isIP } from 'node:net';
import { Pool } from 'pg';
import {
  assertSyntheticBrowserSpConfig,
  createSyntheticBrowserSp,
  type SyntheticBrowserSpConfig,
} from './browser-sp';
import { installSyntheticSpStateDiagnostics } from './browser-sp-diagnostics';
import { PostgresTransientStateStore } from '../storage/postgres-transient-state';
import { createAwsStateStores } from '../storage/create-state-stores';
import { createDynamoStateClient } from '../storage/dynamodb-state';
import {
  normalizeAwsAuthStateConfig,
  dynamoAuthStateTableName,
} from '../storage/auth-state-config';
import {
  assertDynamoAuthStateTable,
  assertDynamoAuthStateSealed,
} from '../import/auth-state-restore';
import type { AwsSelectedAuthStateEvidence } from '../import/selected-auth-state';
import { selectedSyntheticDynamoState } from './selected-auth-state';

export interface SyntheticBrowserSpSecret extends SyntheticBrowserSpConfig {
  formatVersion: 1;
  stateDatabaseUrl?: string;
  authState?: AwsSelectedAuthStateEvidence;
}

/** Also used by the private preparer; pins cannot be selected by the request or secret itself. */
export function parseSyntheticBrowserSpSecret(
  value: unknown,
  expectedOrigin: string,
  expectedDbHost: string,
  expectedAws?: { accountId: string; region: string }
): SyntheticBrowserSpSecret {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const source = value as Record<string, unknown>;
    const keys = [
      'formatVersion',
      'syntheticOnly',
      'environmentName',
      'origin',
      'tenantId',
      ...(source.stateDatabaseUrl === undefined ? [] : ['stateDatabaseUrl']),
      ...(source.authState === undefined ? [] : ['authState']),
      'certificatePem',
      'certificateDerSha256',
    ];
    if (
      Object.keys(source).length !== keys.length ||
      !keys.every((key) => key in source) ||
      source.formatVersion !== 1 ||
      source.origin !== expectedOrigin
    )
      throw new Error();
    const config = source as unknown as SyntheticBrowserSpSecret;
    assertSyntheticBrowserSpConfig(config);
    if (config.authState !== undefined) {
      const selection = config.authState;
      const normalized = normalizeAwsAuthStateConfig(selection.config, expectedAws);
      if (normalized.backend === 'dynamodb') {
        const dynamo = selectedSyntheticDynamoState(selection);
        if (
          !dynamo ||
          config.stateDatabaseUrl !== undefined ||
          dynamo.receipt.source.issuer !== config.origin ||
          dynamo.receipt.tenantId !== config.tenantId ||
          Object.keys(selection).sort().join(',') !== 'config,receipt'
        )
          throw new Error();
        return config;
      }
      if (Object.keys(selection).join(',') !== 'config') throw new Error();
    }
    if (
      typeof config.stateDatabaseUrl !== 'string' ||
      !/^[a-z0-9.-]+\.rds\.amazonaws\.com$/u.test(expectedDbHost)
    )
      throw new Error();
    const url = new URL(config.stateDatabaseUrl);
    if (
      url.protocol !== 'postgresql:' ||
      url.hostname !== expectedDbHost ||
      url.port !== '5432' ||
      decodeURIComponent(url.username) !== 'authrim_dr_browser_state' ||
      url.pathname !== '/authrim_dr_browser_state' ||
      !url.password ||
      url.hash ||
      url.searchParams.get('sslmode') !== 'verify-full' ||
      [...url.searchParams].length !== 1
    )
      throw new Error();
    return config;
  } catch {
    throw new Error('synthetic_browser_sp_configuration_invalid');
  }
}

let client: SecretsManagerClient | undefined;
let initialized: Promise<ReturnType<typeof createSyntheticBrowserSp>> | undefined;

async function initialize(): Promise<ReturnType<typeof createSyntheticBrowserSp>> {
  const origin = process.env.AUTHRIM_AWS_BROWSER_SP_ORIGIN ?? '';
  const arn = process.env.AUTHRIM_AWS_BROWSER_SP_SECRET_ARN ?? '';
  const version = process.env.AUTHRIM_AWS_BROWSER_SP_SECRET_VERSION_ID ?? '';
  const host = process.env.AUTHRIM_AWS_BROWSER_SP_DB_HOST ?? '';
  if (
    process.env.AUTHRIM_AWS_BROWSER_SP_ENABLED !== 'synthetic-only' ||
    process.env.AWS_REGION !== 'ap-northeast-1' ||
    !/^arn:aws:secretsmanager:ap-northeast-1:\d{12}:secret:[A-Za-z0-9/_+=.@-]+$/u.test(arn) ||
    !/^[A-Za-z0-9-]{32,64}$/u.test(version)
  )
    throw new Error();
  const sdk = (client ??= new SecretsManagerClient({
    region: 'ap-northeast-1',
    maxAttempts: 2,
    ignoreConfiguredEndpointUrls: true,
    requestHandler: { connectionTimeout: 3_000, requestTimeout: 10_000 },
  }));
  const secret = await sdk.send(new GetSecretValueCommand({ SecretId: arn, VersionId: version }), {
    abortSignal: AbortSignal.timeout(15_000),
  });
  if (
    secret.ARN !== arn ||
    secret.VersionId !== version ||
    !secret.SecretString ||
    secret.SecretString.length > 64 * 1024
  )
    throw new Error();
  const config = parseSyntheticBrowserSpSecret(
    JSON.parse(secret.SecretString) as unknown,
    origin,
    host,
    { accountId: arn.split(':')[4], region: 'ap-northeast-1' }
  );
  const dynamo = selectedSyntheticDynamoState(config.authState);
  if (dynamo) {
    const stateClient = createDynamoStateClient({ region: dynamo.target.region });
    const markWarm = installSyntheticSpStateDiagnostics(stateClient);
    try {
      await assertDynamoAuthStateTable(stateClient, dynamo.target);
      const ready = () => assertDynamoAuthStateSealed({ ...dynamo, client: stateClient });
      await ready();
      markWarm();
      const { state } = createAwsStateStores({
        backend: 'dynamodb',
        client: stateClient,
        tableName: dynamoAuthStateTableName(dynamo.target),
        namespace: dynamo.target.namespace,
      });
      return createSyntheticBrowserSp({
        config,
        store: {
          async storeChallenge(input) {
            await ready();
            return state.storeChallenge(input);
          },
          async consumeChallenge(input) {
            await ready();
            return state.consumeChallenge(input);
          },
        },
      });
    } catch {
      stateClient.destroy();
      throw new Error('synthetic_browser_sp_initialization_failed');
    }
  }
  const pool = new Pool({
    connectionString: config.stateDatabaseUrl,
    max: 2,
    connectionTimeoutMillis: 5_000,
    query_timeout: 10_000,
  });
  pool.on('error', () => {
    /* Never log connection strings or driver diagnostics. */
  });
  try {
    const result = await pool.query<{ database: string; username: string; ssl: boolean }>(
      `SELECT current_database() AS database, current_user AS username,
        (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS ssl`
    );
    if (
      result.rows.length !== 1 ||
      result.rows[0].database !== 'authrim_dr_browser_state' ||
      result.rows[0].username !== 'authrim_dr_browser_state' ||
      result.rows[0].ssl !== true
    )
      throw new Error();
    const store = new PostgresTransientStateStore({
      query: (sql, values) => pool.query(sql, values),
    });
    return createSyntheticBrowserSp({ config, store });
  } catch {
    await pool.end().catch(() => undefined);
    throw new Error('synthetic_browser_sp_initialization_failed');
  }
}

/** Reject an unexpected API host before reading secrets or connecting to PostgreSQL. */
export async function handler(event: LambdaEvent, context?: LambdaContext) {
  const origin = process.env.AUTHRIM_AWS_BROWSER_SP_ORIGIN ?? '';
  if (
    process.env.AUTHRIM_AWS_BROWSER_SP_ENABLED !== 'synthetic-only' ||
    !/^https:\/\/[a-z0-9]{10}\.execute-api\.ap-northeast-1\.amazonaws\.com$/u.test(origin) ||
    !('version' in event) ||
    event.version !== '2.0' ||
    !('http' in event.requestContext) ||
    event.requestContext.domainName !== origin.slice(8) ||
    event.headers.host !== origin.slice(8) ||
    !isIP(event.requestContext.http.sourceIp)
  )
    return {
      statusCode: 400,
      body: 'untrusted_ingress',
      headers: { 'cache-control': 'no-store' },
      isBase64Encoded: false,
    };
  const pending = (initialized ??= initialize());
  try {
    return await (await pending).handler(event, context);
  } catch {
    if (initialized === pending) initialized = undefined;
    return {
      statusCode: 503,
      body: 'temporarily_unavailable',
      headers: { 'cache-control': 'no-store' },
      isBase64Encoded: false,
    };
  }
}
