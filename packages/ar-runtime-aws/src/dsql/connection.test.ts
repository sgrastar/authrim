import { describe, expect, it, vi } from 'vitest';
import {
  dsqlPoolConfig,
  validateDsqlConnectionConfig,
  type DsqlConnectionConfig,
} from './connection';

const config: DsqlConnectionConfig = {
  hostname: 'abcdefghijklmnopqrstuv1234.dsql.ap-northeast-1.on.aws',
  region: 'ap-northeast-1',
  user: 'authrim_probe',
};

function signer() {
  return {
    getDbConnectAuthToken: vi.fn().mockResolvedValue('short-lived-token'),
    getDbConnectAdminAuthToken: vi.fn().mockResolvedValue('short-lived-admin-token'),
  };
}

describe('DSQL connection isolation', () => {
  it('pins postgres, TLS peer verification and bounded connection lifetime', () => {
    const tokenSigner = signer();
    const pool = dsqlPoolConfig(config, () => tokenSigner);
    expect(pool).toMatchObject({
      host: config.hostname,
      port: 5432,
      database: 'postgres',
      user: 'authrim_probe',
      ssl: { rejectUnauthorized: true, servername: config.hostname, minVersion: 'TLSv1.2' },
      max: 4,
      connectionTimeoutMillis: 5_000,
      query_timeout: 10_000,
      maxLifetimeSeconds: 1_800,
    });
    expect(pool).not.toHaveProperty('connectionString');
    expect(tokenSigner.getDbConnectAuthToken).not.toHaveBeenCalled();
  });

  it('refreshes the IAM token for every new connection without enabling admin implicitly', async () => {
    const tokenSigner = signer();
    tokenSigner.getDbConnectAuthToken
      .mockResolvedValueOnce('first-token')
      .mockResolvedValueOnce('second-token');
    const pool = dsqlPoolConfig(config, () => tokenSigner);
    const password = pool.password as () => Promise<string>;
    await expect(password()).resolves.toBe('first-token');
    await expect(password()).resolves.toBe('second-token');
    expect(tokenSigner.getDbConnectAdminAuthToken).not.toHaveBeenCalled();
  });

  it('uses the admin token only for the explicitly configured admin user', async () => {
    const tokenSigner = signer();
    const pool = dsqlPoolConfig({ ...config, user: 'admin' }, () => tokenSigner);
    await expect((pool.password as () => Promise<string>)()).resolves.toBe(
      'short-lived-admin-token'
    );
    expect(tokenSigner.getDbConnectAuthToken).not.toHaveBeenCalled();
  });

  it('does not expose credentials or SDK errors from token generation', async () => {
    const tokenSigner = signer();
    tokenSigner.getDbConnectAuthToken.mockRejectedValue(
      new Error('credential=secret token=do-not-print')
    );
    const pool = dsqlPoolConfig(config, () => tokenSigner);
    const result = await (pool.password as () => Promise<string>)().catch((error: Error) => error);
    expect(result).toEqual(new Error('aurora_dsql_authentication_failed'));
    expect(result).not.toHaveProperty('cause');
  });

  it.each([
    { hostname: 'db.example.test' },
    { hostname: `${config.hostname}.attacker.example` },
    { hostname: `https://${config.hostname}` },
    { hostname: `${config.hostname}:5432` },
    { region: 'us-east-1' },
    { user: 'admin; DROP TABLE users' },
    { user: '' },
    { maxConnections: 0 },
    { maxConnections: 17 },
    { maxConnections: NaN },
    { connectionTimeoutMs: 30_001 },
    { queryTimeoutMs: -1 },
    { connectionString: 'postgresql://user:password@host/postgres' },
    { password: 'static-password' },
    { ssl: false },
    { database: 'different' },
  ])('rejects unsupported or unsafe settings: %j', (override) => {
    expect(() => validateDsqlConnectionConfig({ ...config, ...override })).toThrow(
      'aurora_dsql_connection_config_invalid'
    );
  });
});
