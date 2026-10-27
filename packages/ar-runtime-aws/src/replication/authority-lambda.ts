import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { Hono } from 'hono';
import { handle } from 'hono/aws-lambda';
import { Pool, type PoolConfig } from 'pg';
import { REPLICATION_RPC_PATH } from '@authrim/ar-lib-core/services/deployment-replication/transport';
import { assertAwsDatabaseTlsUrl } from '../startup/deployment-config';
import { PostgresEnvironmentAuthority } from './environment-authority-postgres';
import { PostgresDeploymentAuthority } from './authority-postgres';
import { PostgresReplicationGenerationCatalog } from './generation-catalog';
import {
  createReplicationAuthorityHttp,
  type ReplicationAuthorityCredential,
} from './authority-http';

interface AuthoritySecret {
  formatVersion: 1;
  databaseUrl: string;
  credentials: readonly ReplicationAuthorityCredential[];
}

interface AuthorityLocation {
  region: string;
  arn: string;
  versionId: string;
}

type AuthorityPool = Pick<Pool, 'connect' | 'query' | 'end' | 'on'>;

interface AuthorityDependencies {
  environment: Readonly<Record<string, string | undefined>>;
  readSecret?: (
    location: AuthorityLocation,
    signal: AbortSignal
  ) => Promise<{
    arn?: string;
    versionId?: string;
    value?: string;
  }>;
  createPool?: (config: PoolConfig) => AuthorityPool;
}

function locationFor(environment: AuthorityDependencies['environment']): AuthorityLocation {
  const region = environment.AWS_REGION;
  const account = environment.AUTHRIM_REPLICATION_AUTHORITY_ACCOUNT_ID;
  const arn = environment.AUTHRIM_REPLICATION_AUTHORITY_SECRET_ARN;
  const versionId = environment.AUTHRIM_REPLICATION_AUTHORITY_SECRET_VERSION_ID;
  const parsed =
    typeof arn === 'string'
      ? /^arn:(aws|aws-us-gov|aws-cn):secretsmanager:([a-z0-9-]+):(\d{12}):secret:([A-Za-z0-9/_+=.@-]+)$/u.exec(
          arn
        )
      : null;
  if (
    typeof region !== 'string' ||
    !/^[a-z]{2}(?:-[a-z]+)+-\d$/u.test(region) ||
    !parsed ||
    parsed[2] !== region ||
    parsed[3] !== account ||
    typeof versionId !== 'string' ||
    !/^[A-Za-z0-9-]{32,64}$/u.test(versionId)
  )
    throw new Error('replication_authority_configuration_invalid');
  return { region, arn: parsed[0], versionId };
}

function parseSecret(raw: string | undefined): AuthoritySecret {
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).byteLength > 65_536)
    throw new Error('replication_authority_configuration_invalid');
  const value = JSON.parse(raw) as AuthoritySecret;
  if (
    !value ||
    Object.keys(value).sort().join(',') !== 'credentials,databaseUrl,formatVersion' ||
    value.formatVersion !== 1 ||
    !Array.isArray(value.credentials as unknown) ||
    value.credentials.length < 1 ||
    value.credentials.length > 128
  )
    throw new Error('replication_authority_configuration_invalid');
  assertAwsDatabaseTlsUrl(value.databaseUrl);
  for (const credential of value.credentials) {
    if (
      !credential ||
      Object.keys(credential).sort().join(',') !==
        (credential.environmentId !== undefined
          ? credential.role === 'writer'
            ? 'credentialId,deploymentId,environmentId,pairId,role,secret'
            : 'credentialId,environmentId,pairId,role,secret'
          : credential.role === 'writer'
            ? 'credentialId,deploymentId,pairId,role,secret,tenantId'
            : 'credentialId,pairId,role,secret,tenantId')
    )
      throw new Error('replication_authority_configuration_invalid');
  }
  return value;
}

const unavailable = () =>
  Response.json(
    { error: 'replication_authority_unavailable' },
    { status: 503, headers: { 'Cache-Control': 'no-store' } }
  );

/** Schema initialization is an explicit operator action; this service never creates tables. */
export function createReplicationAuthorityRuntime(input: AuthorityDependencies) {
  const environment = { ...input.environment };
  let secretClient: SecretsManagerClient | undefined;
  let pool: AuthorityPool | undefined;
  let loading: Promise<(request: Request) => Promise<Response>> | undefined;
  const load = async () => {
    const location = locationFor(environment);
    const readSecret =
      input.readSecret ??
      (async (pin: AuthorityLocation, signal: AbortSignal) => {
        secretClient ??= new SecretsManagerClient({
          region: pin.region,
          maxAttempts: 2,
          ignoreConfiguredEndpointUrls: true,
          requestHandler: { connectionTimeout: 3_000, requestTimeout: 10_000 },
        });
        const result = await secretClient.send(
          new GetSecretValueCommand({ SecretId: pin.arn, VersionId: pin.versionId }),
          { abortSignal: signal }
        );
        return { arn: result.ARN, versionId: result.VersionId, value: result.SecretString };
      });
    const secret = await readSecret(location, AbortSignal.timeout(15_000));
    if (secret.arn !== location.arn || secret.versionId !== location.versionId)
      throw new Error('replication_authority_configuration_invalid');
    const configuration = parseSecret(secret.value);
    const selected = (input.createPool ?? ((options) => new Pool(options)))({
      connectionString: configuration.databaseUrl,
      max: 4,
      connectionTimeoutMillis: 5_000,
      query_timeout: 10_000,
      statement_timeout: 10_000,
      idle_in_transaction_session_timeout: 10_000,
      idleTimeoutMillis: 30_000,
      allowExitOnIdle: true,
    });
    // pg reports idle socket failures through this event. Per-request failures are sanitized below.
    selected.on('error', () => undefined);
    try {
      const http = createReplicationAuthorityHttp({
        authority: new PostgresDeploymentAuthority(selected),
        environmentAuthority: new PostgresEnvironmentAuthority(selected),
        catalog: new PostgresReplicationGenerationCatalog(selected),
        credentials: configuration.credentials,
      });
      pool = selected;
      return http;
    } catch (error) {
      await selected.end().catch(() => undefined);
      throw error;
    }
  };
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (request.method !== 'POST' || url.pathname !== REPLICATION_RPC_PATH || url.search)
        return Response.json(
          { error: 'not_found' },
          { status: 404, headers: { 'Cache-Control': 'no-store' } }
        );
      try {
        loading ??= load().catch((error: unknown) => {
          loading = undefined;
          throw error;
        });
        return await (
          await loading
        )(request);
      } catch {
        return unavailable();
      }
    },
    async close(): Promise<void> {
      await loading?.catch(() => undefined);
      await pool?.end();
      pool = undefined;
      loading = undefined;
      secretClient?.destroy();
      secretClient = undefined;
    },
  };
}

const runtime = createReplicationAuthorityRuntime({ environment: process.env });
const app = new Hono();
app.all('*', (context) => runtime.fetch(context.req.raw));
export const handler = handle(app);
