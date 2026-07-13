import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  decrypt: vi.fn(),
  safeFetch: vi.fn(),
  validateUrl: vi.fn(),
  d1Health: vi.fn(),
  d1Close: vi.fn(),
  postgresHealth: vi.fn(),
  postgresClose: vi.fn(),
  mysqlHealth: vi.fn(),
  mysqlClose: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    decryptValue: mocks.decrypt,
    safeFetch: mocks.safeFetch,
    validateUrlForSSRF: mocks.validateUrl,
    D1Adapter: vi.fn(function () {
      return { isHealthy: mocks.d1Health, close: mocks.d1Close };
    }),
    PostgresAdapter: vi.fn(function () {
      return { isHealthy: mocks.postgresHealth, close: mocks.postgresClose };
    }),
    MysqlAdapter: vi.fn(function () {
      return { isHealthy: mocks.mysqlHealth, close: mocks.mysqlClose };
    }),
  };
});

import {
  testDatabaseConnectionConnectivity,
  testStorageDestinationConnectivity,
} from '../routes/admin-management/connectivity-tests';

function destination(provider: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 'destination-1',
    provider,
    status: 'active',
    config: {},
    credential_encrypted: null,
    ...overrides,
  } as never;
}

function connection(provider: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 'connection-1',
    provider,
    status: 'active',
    config: {},
    credential_encrypted: null,
    ...overrides,
  } as never;
}

describe('admin connectivity probes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.decrypt.mockReset();
    mocks.safeFetch.mockReset();
    mocks.validateUrl.mockReset();
    mocks.d1Health.mockReset();
    mocks.postgresHealth.mockReset();
    mocks.mysqlHealth.mockReset();
    mocks.decrypt.mockResolvedValue({ decrypted: '{}' });
    mocks.safeFetch.mockResolvedValue(new Response(null, { status: 200 }));
    mocks.validateUrl.mockImplementation((value: string) => {
      try {
        const parsedUrl = new URL(value);
        return { valid: true, parsedUrl };
      } catch {
        return { valid: false, error: 'invalid URL' };
      }
    });
    mocks.d1Health.mockResolvedValue({ healthy: true });
    mocks.postgresHealth.mockResolvedValue({ healthy: true });
    mocks.mysqlHealth.mockResolvedValue({ healthy: true });
    mocks.d1Close.mockResolvedValue(undefined);
    mocks.postgresClose.mockResolvedValue(undefined);
    mocks.mysqlClose.mockResolvedValue(undefined);
  });

  it.each([['r2'], ['aws_s3'], ['custom']])(
    'does not probe disabled %s storage destination',
    async (provider) => {
      const result = await testStorageDestinationConnectivity(
        {} as never,
        destination(provider, { status: 'disabled' })
      );
      expect(result).toMatchObject({
        status: 'error',
        message: 'Storage destination is disabled.',
      });
    }
  );

  it('returns unsupported for unknown storage provider', async () => {
    await expect(
      testStorageDestinationConnectivity({} as never, destination('ftp'))
    ).resolves.toMatchObject({
      status: 'unsupported',
      provider: 'ftp',
    });
  });

  it.each([{}, { bindingRef: 'MISSING' }])('validates R2 binding %#', async (config) => {
    const result = await testStorageDestinationConnectivity(
      {} as never,
      destination('r2', { config })
    );
    expect(result.status).toBe('error');
  });

  it.each([true, false])('runs R2 write/head/delete probe (visible=%s)', async (visible) => {
    const bucket = {
      put: vi.fn().mockResolvedValue(undefined),
      head: vi.fn().mockResolvedValue(visible ? { size: 1 } : null),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const result = await testStorageDestinationConnectivity(
      { ARCHIVE: bucket } as never,
      destination('r2', { config: { bindingName: 'ARCHIVE', pathPrefix: '/logs/' } })
    );
    expect(result.status).toBe(visible ? 'ok' : 'error');
    expect(bucket.put).toHaveBeenCalledWith(
      expect.stringMatching(/^logs\/connectivity-test\/destination-1-/),
      'authrim connectivity test'
    );
    expect(bucket.delete).toHaveBeenCalled();
  });

  it('converts R2 exceptions to sanitized error results', async () => {
    const bucket = { put: vi.fn().mockRejectedValue(new Error('R2 unavailable')) };
    await expect(
      testStorageDestinationConnectivity(
        { ARCHIVE: bucket } as never,
        destination('r2', { config: { binding: 'ARCHIVE' } })
      )
    ).resolves.toMatchObject({ status: 'error', message: 'R2 unavailable' });
  });

  it.each([
    [null, {}, 'credential_decryption_key_not_configured'],
    ['encrypted', {}, 'credential_decryption_key_not_configured'],
  ])('requires decryptable S3 credentials %#', async (encrypted, env, expected) => {
    const result = await testStorageDestinationConnectivity(
      env as never,
      destination('aws_s3', { credential_encrypted: encrypted, config: { bucket: 'bucket' } })
    );
    expect(result.message).toContain(encrypted ? expected : 'requires bucket');
  });

  it.each([
    ['', 'AWS S3 test requires'],
    ['null', 'credential_json_object_required'],
    ['[]', 'credential_json_object_required'],
    ['{', 'JSON'],
  ])('rejects malformed S3 credential payload %s', async (raw, message) => {
    mocks.decrypt.mockResolvedValueOnce({ decrypted: raw });
    const result = await testStorageDestinationConnectivity(
      { ADMIN_CREDENTIAL_ENCRYPTION_KEY: 'key' } as never,
      destination('aws_s3', { credential_encrypted: 'encrypted', config: { bucket: 'bucket' } })
    );
    expect(result.message).toContain(message);
  });

  it('rejects S3 endpoint denied by SSRF validation or non-HTTPS scheme', async () => {
    mocks.decrypt.mockResolvedValue({
      decrypted: JSON.stringify({ access_key_id: 'access', secret_access_key: 'secret' }),
    });
    mocks.validateUrl.mockReturnValueOnce({ valid: false, error: 'private address denied' });
    await expect(
      testStorageDestinationConnectivity(
        { RP_TOKEN_ENCRYPTION_KEY: 'key' } as never,
        destination('aws_s3', {
          credential_encrypted: 'encrypted',
          config: { bucketName: 'bucket', endpointUrl: 'https://localhost' },
        })
      )
    ).resolves.toMatchObject({ status: 'error', message: 'private address denied' });

    await expect(
      testStorageDestinationConnectivity(
        { PII_ENCRYPTION_KEY: 'key' } as never,
        destination('aws_s3', {
          credential_encrypted: 'encrypted',
          config: { bucket: 'bucket', endpoint: 'http://example.com' },
        })
      )
    ).resolves.toMatchObject({ status: 'error', message: 'S3 endpoint URL must use HTTPS.' });
  });

  it.each([
    [403, 200, 'error', 'PUT probe failed'],
    [200, 500, 'error', 'DELETE probe failed'],
    [200, 204, 'ok', 'put/delete probe succeeded'],
  ])('runs signed S3 probe PUT=%s DELETE=%s', async (putStatus, deleteStatus, status, message) => {
    mocks.decrypt.mockResolvedValueOnce({
      decrypted: JSON.stringify({
        aws_access_key_id: 'access',
        aws_secret_access_key: 'secret',
        aws_session_token: 'session',
      }),
    });
    mocks.safeFetch
      .mockResolvedValueOnce(new Response(null, { status: putStatus }))
      .mockResolvedValueOnce(new Response(null, { status: deleteStatus }));
    const result = await testStorageDestinationConnectivity(
      { ADMIN_CREDENTIAL_ENCRYPTION_KEY: 'key' } as never,
      destination('aws_s3', {
        credential_encrypted: 'encrypted',
        config: { bucket: 'bucket', region: 'ap-northeast-1', prefix: '/audit logs/' },
      })
    );
    expect(result).toMatchObject({ status, message: expect.stringContaining(message) });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(mocks.safeFetch.mock.calls[0][1]).toMatchObject({
      method: 'PUT',
      headers: expect.objectContaining({
        authorization: expect.stringContaining('AWS4-HMAC-SHA256'),
      }),
    });
  });

  it.each([{}, { testUrl: 'not-a-url' }])(
    'validates custom HTTP destination %#',
    async (config) => {
      const result = await testStorageDestinationConnectivity(
        {} as never,
        destination('custom', { config })
      );
      expect(['unsupported', 'error']).toContain(result.status);
    }
  );

  it.each([200, 503])('runs custom HTTP HEAD health probe status=%s', async (status) => {
    mocks.safeFetch.mockResolvedValueOnce(new Response(null, { status }));
    const result = await testStorageDestinationConnectivity(
      {} as never,
      destination('custom', { config: { health_url: 'http://example.com/health' } })
    );
    expect(result.status).toBe(status === 200 ? 'ok' : 'error');
    expect(mocks.safeFetch).toHaveBeenCalledWith(
      'http://example.com/health',
      expect.objectContaining({ method: 'HEAD', timeoutMs: 5000, redirect: 'manual' })
    );
  });

  it.each(['d1', 'hyperdrive', 'postgres', 'mysql', 'custom'])(
    'does not probe disabled %s database',
    async (provider) => {
      await expect(
        testDatabaseConnectionConnectivity(
          {} as never,
          connection(provider, { status: 'disabled' })
        )
      ).resolves.toMatchObject({ status: 'error', message: 'Database connection is disabled.' });
    }
  );

  it.each(['custom', 'unknown'])(
    'returns unsupported for %s database provider',
    async (provider) => {
      await expect(
        testDatabaseConnectionConnectivity({} as never, connection(provider))
      ).resolves.toMatchObject({
        status: 'unsupported',
        provider,
      });
    }
  );

  it.each([{}, { binding: 'MISSING' }])('validates D1 binding %#', async (config) => {
    const result = await testDatabaseConnectionConnectivity(
      {} as never,
      connection('d1', { config })
    );
    expect(result.status).toBe('error');
  });

  it.each([
    [{ healthy: true }, 'ok'],
    [{ healthy: false, error: 'query failed' }, 'error'],
    [{ healthy: false }, 'error'],
  ])('runs D1 health probe %#', async (health, status) => {
    mocks.d1Health.mockResolvedValueOnce(health);
    const result = await testDatabaseConnectionConnectivity(
      { DB_TEST: { prepare: vi.fn() } } as never,
      connection('d1', { config: { database_binding: 'DB_TEST' } })
    );
    expect(result.status).toBe(status);
    expect(mocks.d1Close).toHaveBeenCalled();
  });

  it.each([
    ['postgres', {}, null],
    ['mysql', {}, null],
    ['hyperdrive', {}, null],
  ])('requires SQL connection material for %s', async (provider, config, credential_encrypted) => {
    const result = await testDatabaseConnectionConnectivity(
      {} as never,
      connection(provider, { config, credential_encrypted })
    );
    expect(result.status).toBe('error');
  });

  it.each([
    ['postgres', { connectionString: 'postgres://example/db' }, 'postgres', 'ok'],
    ['mysql', { connection_string: 'mysql://example/db' }, 'mysql', 'ok'],
    ['hyperdrive', { bindingRef: 'HD', dialect: 'mysql' }, 'mysql', 'error'],
    ['hyperdrive', { bindingRef: 'HD' }, 'postgres', 'ok'],
  ])('runs %s SQL probe using %s dialect', async (provider, config, dialect, status) => {
    mocks.mysqlHealth.mockResolvedValueOnce(
      status === 'ok' ? { healthy: true } : { healthy: false, error: 'connection refused' }
    );
    const env = { HD: { connectionString: 'postgres://hyperdrive/db' } } as never;
    const result = await testDatabaseConnectionConnectivity(env, connection(provider, { config }));
    expect(result).toMatchObject({ status, details: { dialect } });
    expect(dialect === 'mysql' ? mocks.mysqlClose : mocks.postgresClose).toHaveBeenCalled();
  });

  it('decrypts SQL connection string credential using configured key precedence', async () => {
    mocks.decrypt.mockResolvedValueOnce({ decrypted: '{"url":"postgres://secret/db"}' });
    const result = await testDatabaseConnectionConnectivity(
      { ADMIN_CREDENTIAL_ENCRYPTION_KEY: 'admin-key', RP_TOKEN_ENCRYPTION_KEY: 'rp-key' } as never,
      connection('postgres', { credential_encrypted: 'encrypted' })
    );
    expect(result.status).toBe('ok');
    expect(mocks.decrypt).toHaveBeenCalledWith('encrypted', 'admin-key');
    expect(JSON.stringify(result)).not.toContain('postgres://secret');
  });

  it('converts adapter exceptions to error results without throwing', async () => {
    mocks.postgresHealth.mockRejectedValueOnce('network failure');
    await expect(
      testDatabaseConnectionConnectivity(
        {} as never,
        connection('postgres', { config: { url: 'postgres://example/db' } })
      )
    ).resolves.toMatchObject({ status: 'error', message: 'network failure' });
  });
});
