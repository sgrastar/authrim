import { DsqlSigner } from '@aws-sdk/dsql-signer';
import { Pool, type PoolConfig } from 'pg';

/** Experimental connection settings. Tokens and arbitrary PostgreSQL options are not accepted. */
export interface DsqlConnectionConfig {
  hostname: string;
  region: string;
  user: string;
  maxConnections?: number;
  connectionTimeoutMs?: number;
  queryTimeoutMs?: number;
}

export interface DsqlAuthTokenSigner {
  getDbConnectAuthToken(): Promise<string>;
  getDbConnectAdminAuthToken(): Promise<string>;
}

const CONFIG_KEYS = new Set([
  'hostname',
  'region',
  'user',
  'maxConnections',
  'connectionTimeoutMs',
  'queryTimeoutMs',
]);

export function validateDsqlConnectionConfig(config: DsqlConnectionConfig): void {
  const invalid = () => {
    throw new Error('aurora_dsql_connection_config_invalid');
  };
  if (!config || typeof config !== 'object' || Array.isArray(config)) invalid();
  if (Object.keys(config).some((key) => !CONFIG_KEYS.has(key))) invalid();
  if (
    typeof config.region !== 'string' ||
    !/^[a-z]{2}(?:-[a-z]+)+-\d$/u.test(config.region) ||
    typeof config.hostname !== 'string' ||
    !/^[a-z0-9]{26}\.dsql\.[a-z0-9-]+\.on\.aws$/u.test(config.hostname) ||
    !config.hostname.endsWith(`.dsql.${config.region}.on.aws`) ||
    typeof config.user !== 'string' ||
    !/^[a-z][a-z0-9_]{0,62}$/u.test(config.user)
  )
    invalid();
  for (const [value, max] of [
    [config.maxConnections ?? 4, 16],
    [config.connectionTimeoutMs ?? 5_000, 30_000],
    [config.queryTimeoutMs ?? 10_000, 60_000],
  ]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > max) invalid();
  }
}

/** Fresh IAM authentication on each new physical connection; never embed a token in a URL. */
export function dsqlPoolConfig(
  input: DsqlConnectionConfig,
  signerFactory: (config: { hostname: string; region: string }) => DsqlAuthTokenSigner = (config) =>
    new DsqlSigner(config)
): PoolConfig {
  validateDsqlConnectionConfig(input);
  const config = { ...input };
  const signer = signerFactory({ hostname: config.hostname, region: config.region });
  return {
    host: config.hostname,
    port: 5432,
    database: 'postgres',
    user: config.user,
    password: async () => {
      try {
        const token =
          config.user === 'admin'
            ? await signer.getDbConnectAdminAuthToken()
            : await signer.getDbConnectAuthToken();
        if (typeof token !== 'string' || token.length === 0) throw new Error();
        return token;
      } catch {
        throw new Error('aurora_dsql_authentication_failed');
      }
    },
    ssl: { rejectUnauthorized: true, servername: config.hostname, minVersion: 'TLSv1.2' },
    max: config.maxConnections ?? 4,
    connectionTimeoutMillis: config.connectionTimeoutMs ?? 5_000,
    query_timeout: config.queryTimeoutMs ?? 10_000,
    idleTimeoutMillis: 30_000,
    maxLifetimeSeconds: 1_800,
    keepAlive: true,
    application_name: 'authrim-aurora-dsql-experimental',
  };
}

export function createDsqlPool(config: DsqlConnectionConfig): Pool {
  const pool = new Pool(dsqlPoolConfig(config));
  // pg removes failed idle clients. Consume this event without logging credentials or SQL.
  pool.on('error', () => undefined);
  return pool;
}
