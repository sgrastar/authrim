import type {
  AdminDatabaseConnectionWithCredential,
  AdminStorageDestinationWithCredential,
  Env,
} from '@authrim/ar-lib-core';
import {
  D1Adapter,
  decryptValue,
  MysqlAdapter,
  PostgresAdapter,
  safeFetch,
  validateUrlForSSRF,
} from '@authrim/ar-lib-core';

export interface ConnectivityTestResult {
  status: 'ok' | 'error' | 'unsupported';
  provider: string;
  message: string;
  latency_ms: number;
  details?: Record<string, unknown>;
}

type JsonObject = Record<string, unknown>;

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function getConfigString(config: JsonObject, keys: string[]): string | null {
  for (const key of keys) {
    const value = asString(config[key]);
    if (value) {
      return value;
    }
  }
  return null;
}

function getBinding<T>(env: Env, bindingName: string): T | null {
  const value = (env as unknown as Record<string, unknown>)[bindingName];
  return value ? (value as T) : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function finish(
  start: number,
  result: Omit<ConnectivityTestResult, 'latency_ms'>
): ConnectivityTestResult {
  return {
    ...result,
    latency_ms: Date.now() - start,
  };
}

async function parseCredential(
  encrypted: string | null,
  encryptionKey: string | null
): Promise<JsonObject> {
  if (!encrypted) {
    return {};
  }
  if (!encryptionKey) {
    throw new Error('credential_decryption_key_not_configured');
  }
  const decrypted = await decryptValue(encrypted, encryptionKey);
  const raw = decrypted.decrypted;
  if (!raw) {
    return {};
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('credential_json_object_required');
  }
  return parsed as JsonObject;
}

function getCredentialEncryptionKey(env: Env): string | null {
  return (
    env.ADMIN_CREDENTIAL_ENCRYPTION_KEY ||
    env.RP_TOKEN_ENCRYPTION_KEY ||
    env.PII_ENCRYPTION_KEY ||
    null
  );
}

export async function testStorageDestinationConnectivity(
  env: Env,
  destination: AdminStorageDestinationWithCredential
): Promise<ConnectivityTestResult> {
  const start = Date.now();

  try {
    if (destination.status !== 'active') {
      return finish(start, {
        status: 'error',
        provider: destination.provider,
        message: 'Storage destination is disabled.',
      });
    }

    switch (destination.provider) {
      case 'r2':
        return await testR2Destination(env, destination, start);
      case 'aws_s3':
        return await testS3Destination(env, destination, start);
      case 'custom':
        return await testCustomHttpDestination(destination, start);
      default:
        return finish(start, {
          status: 'unsupported',
          provider: destination.provider,
          message: 'Unsupported storage destination provider.',
        });
    }
  } catch (error) {
    return finish(start, {
      status: 'error',
      provider: destination.provider,
      message: errorMessage(error),
    });
  }
}

async function testR2Destination(
  env: Env,
  destination: AdminStorageDestinationWithCredential,
  start: number
): Promise<ConnectivityTestResult> {
  const bindingName = getConfigString(destination.config, [
    'bindingRef',
    'binding',
    'bindingName',
    'bucket_binding',
    'bucketBinding',
  ]);
  if (!bindingName) {
    return finish(start, {
      status: 'error',
      provider: destination.provider,
      message: 'R2 destination config requires a bucket binding name.',
    });
  }

  const bucket = getBinding<R2Bucket>(env, bindingName);
  if (!bucket || typeof bucket.put !== 'function') {
    return finish(start, {
      status: 'error',
      provider: destination.provider,
      message: `R2 binding "${bindingName}" was not found.`,
    });
  }

  const prefix =
    getConfigString(destination.config, ['prefix', 'path_prefix', 'pathPrefix']) || 'authrim';
  const key = `${prefix.replace(/^\/+|\/+$/g, '')}/connectivity-test/${destination.id}-${Date.now()}.txt`;
  await bucket.put(key, 'authrim connectivity test');
  const object = await bucket.head(key);
  await bucket.delete(key);

  return finish(start, {
    status: object ? 'ok' : 'error',
    provider: destination.provider,
    message: object ? 'R2 write/head/delete probe succeeded.' : 'R2 probe object was not visible.',
    details: { binding: bindingName },
  });
}

async function testS3Destination(
  env: Env,
  destination: AdminStorageDestinationWithCredential,
  start: number
): Promise<ConnectivityTestResult> {
  const credential = await parseCredential(
    destination.credential_encrypted,
    getCredentialEncryptionKey(env)
  );
  const bucket = getConfigString(destination.config, ['bucket', 'bucketName']);
  const region = getConfigString(destination.config, ['region']) || 'us-east-1';
  const accessKeyId = getConfigString(credential, [
    'accessKeyId',
    'access_key_id',
    'aws_access_key_id',
  ]);
  const secretAccessKey = getConfigString(credential, [
    'secretAccessKey',
    'secret_access_key',
    'aws_secret_access_key',
  ]);
  const sessionToken = getConfigString(credential, [
    'sessionToken',
    'session_token',
    'aws_session_token',
  ]);

  if (!bucket || !accessKeyId || !secretAccessKey) {
    return finish(start, {
      status: 'error',
      provider: destination.provider,
      message: 'AWS S3 test requires bucket, accessKeyId, and secretAccessKey.',
    });
  }

  const endpoint =
    getConfigString(destination.config, ['endpoint', 'endpointUrl']) ||
    `https://${bucket}.s3.${region}.amazonaws.com`;
  const prefix =
    getConfigString(destination.config, ['prefix', 'path_prefix', 'pathPrefix']) || 'authrim';
  const key = `${prefix.replace(/^\/+|\/+$/g, '')}/connectivity-test/${destination.id}-${Date.now()}.txt`;
  const validation = validateUrlForSSRF(endpoint);
  if (!validation.valid || !validation.parsedUrl) {
    return finish(start, {
      status: 'error',
      provider: destination.provider,
      message: validation.error || 'S3 endpoint URL is not allowed.',
    });
  }
  if (validation.parsedUrl.protocol !== 'https:') {
    return finish(start, {
      status: 'error',
      provider: destination.provider,
      message: 'S3 endpoint URL must use HTTPS.',
    });
  }
  const url = validation.parsedUrl;
  const pathPrefix = url.pathname.replace(/^\/+|\/+$/g, '');
  url.pathname = `/${[pathPrefix, key].filter(Boolean).map(encodeS3PathPart).join('/')}`;

  const body = 'authrim connectivity test';
  const putResponse = await signedS3Fetch(url, {
    method: 'PUT',
    region,
    accessKeyId,
    secretAccessKey,
    sessionToken,
    body,
  });
  if (!putResponse.ok) {
    return finish(start, {
      status: 'error',
      provider: destination.provider,
      message: `S3 PUT probe failed with HTTP ${putResponse.status}.`,
    });
  }

  const deleteResponse = await signedS3Fetch(url, {
    method: 'DELETE',
    region,
    accessKeyId,
    secretAccessKey,
    sessionToken,
  });

  return finish(start, {
    status: deleteResponse.ok ? 'ok' : 'error',
    provider: destination.provider,
    message: deleteResponse.ok
      ? 'S3 put/delete probe succeeded.'
      : `S3 DELETE probe failed with HTTP ${deleteResponse.status}.`,
    details: { bucket, region },
  });
}

function encodeS3PathPart(part: string): string {
  return part
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

async function testCustomHttpDestination(
  destination: AdminStorageDestinationWithCredential,
  start: number
): Promise<ConnectivityTestResult> {
  const testUrl = getConfigString(destination.config, [
    'test_url',
    'testUrl',
    'health_url',
    'healthUrl',
  ]);
  if (!testUrl) {
    return finish(start, {
      status: 'unsupported',
      provider: destination.provider,
      message: 'Custom storage destinations require testUrl or healthUrl for connectivity tests.',
    });
  }

  const validation = validateUrlForSSRF(testUrl);
  if (!validation.valid || !validation.parsedUrl) {
    return finish(start, {
      status: 'error',
      provider: destination.provider,
      message: validation.error || 'Custom HTTP health URL is not allowed.',
    });
  }

  const response = await safeFetch(validation.parsedUrl.toString(), {
    method: 'HEAD',
    redirect: 'manual',
    requireHttps: false,
    timeoutMs: 5000,
    maxResponseSize: 0,
  });
  return finish(start, {
    status: response.ok ? 'ok' : 'error',
    provider: destination.provider,
    message: response.ok
      ? 'Custom HTTP health probe succeeded.'
      : `Custom HTTP health probe failed with HTTP ${response.status}.`,
  });
}

interface S3SignInput {
  method: 'PUT' | 'DELETE';
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string | null;
  body?: string;
}

async function signedS3Fetch(url: URL, input: S3SignInput): Promise<Response> {
  const body = input.body ?? '';
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = await sha256Hex(body);
  const host = url.host;
  const headers: Record<string, string> = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (input.sessionToken) {
    headers['x-amz-security-token'] = input.sessionToken;
  }

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${headers[name]}\n`).join('');
  const canonicalRequest = [
    input.method,
    url.pathname,
    url.searchParams.toString(),
    canonicalHeaders,
    signedHeaderNames.join(';'),
    payloadHash,
  ].join('\n');
  const credentialScope = `${dateStamp}/${input.region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n');
  const signingKey = await getAwsSigningKey(input.secretAccessKey, dateStamp, input.region, 's3');
  const signature = await hmacHex(signingKey, stringToSign);
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaderNames.join(';')}, Signature=${signature}`;

  return safeFetch(url.toString(), {
    method: input.method,
    headers,
    body: input.method === 'PUT' ? body : undefined,
    redirect: 'manual',
    timeoutMs: 10000,
    maxResponseSize: 64 * 1024,
  });
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}

async function hmacBytes(key: ArrayBuffer | Uint8Array, value: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(value));
}

async function hmacHex(key: ArrayBuffer | Uint8Array, value: string): Promise<string> {
  return bytesToHex(new Uint8Array(await hmacBytes(key, value)));
}

async function getAwsSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string
): Promise<ArrayBuffer> {
  const kDate = await hmacBytes(new TextEncoder().encode(`AWS4${secretAccessKey}`), dateStamp);
  const kRegion = await hmacBytes(kDate, region);
  const kService = await hmacBytes(kRegion, service);
  return hmacBytes(kService, 'aws4_request');
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function testDatabaseConnectionConnectivity(
  env: Env,
  connection: AdminDatabaseConnectionWithCredential
): Promise<ConnectivityTestResult> {
  const start = Date.now();

  try {
    if (connection.status !== 'active') {
      return finish(start, {
        status: 'error',
        provider: connection.provider,
        message: 'Database connection is disabled.',
      });
    }

    switch (connection.provider) {
      case 'd1':
        return await testD1Connection(env, connection, start);
      case 'hyperdrive':
      case 'postgres':
      case 'mysql':
        return await testSqlConnection(env, connection, start);
      case 'custom':
        return finish(start, {
          status: 'unsupported',
          provider: connection.provider,
          message: 'Custom database connectivity tests require a provider adapter.',
        });
      default:
        return finish(start, {
          status: 'unsupported',
          provider: connection.provider,
          message: 'Unsupported database connection provider.',
        });
    }
  } catch (error) {
    return finish(start, {
      status: 'error',
      provider: connection.provider,
      message: errorMessage(error),
    });
  }
}

async function testD1Connection(
  env: Env,
  connection: AdminDatabaseConnectionWithCredential,
  start: number
): Promise<ConnectivityTestResult> {
  const bindingName = getConfigString(connection.config, [
    'bindingRef',
    'binding',
    'bindingName',
    'database_binding',
  ]);
  if (!bindingName) {
    return finish(start, {
      status: 'error',
      provider: connection.provider,
      message: 'D1 connection config requires a binding name.',
    });
  }
  const d1 = getBinding<D1Database>(env, bindingName);
  if (!d1 || typeof d1.prepare !== 'function') {
    return finish(start, {
      status: 'error',
      provider: connection.provider,
      message: `D1 binding "${bindingName}" was not found.`,
    });
  }
  const adapter = new D1Adapter({ db: d1, partition: 'admin-connectivity-test' });
  const health = await adapter.isHealthy();
  await adapter.close();
  return finish(start, {
    status: health.healthy ? 'ok' : 'error',
    provider: connection.provider,
    message: health.healthy ? 'D1 SELECT 1 probe succeeded.' : health.error || 'D1 probe failed.',
    details: { binding: bindingName },
  });
}

async function testSqlConnection(
  env: Env,
  connection: AdminDatabaseConnectionWithCredential,
  start: number
): Promise<ConnectivityTestResult> {
  const credential = await parseCredential(
    connection.credential_encrypted,
    getCredentialEncryptionKey(env)
  );
  const bindingName = getConfigString(connection.config, [
    'bindingRef',
    'binding',
    'bindingName',
    'hyperdrive_binding',
  ]);
  const hyperdrive = bindingName ? getBinding<Hyperdrive>(env, bindingName) : null;
  const connectionString =
    getConfigString(credential, ['connectionString', 'connection_string', 'url']) ||
    getConfigString(connection.config, ['connectionString', 'connection_string', 'url']) ||
    hyperdrive?.connectionString ||
    null;

  if (!hyperdrive && !connectionString) {
    return finish(start, {
      status: 'error',
      provider: connection.provider,
      message: 'SQL connection test requires a Hyperdrive binding or connection string credential.',
    });
  }

  const dialect =
    connection.provider === 'hyperdrive'
      ? getConfigString(connection.config, ['dialect', 'driver', 'database_type']) || 'postgres'
      : connection.provider;
  const adapter =
    dialect === 'mysql'
      ? new MysqlAdapter({
          hyperdrive: hyperdrive ?? undefined,
          connectionString: connectionString ?? undefined,
        })
      : new PostgresAdapter({
          hyperdrive: hyperdrive ?? undefined,
          connectionString: connectionString ?? undefined,
        });
  const health = await adapter.isHealthy();
  await adapter.close();

  return finish(start, {
    status: health.healthy ? 'ok' : 'error',
    provider: connection.provider,
    message: health.healthy ? 'SQL SELECT 1 probe succeeded.' : health.error || 'SQL probe failed.',
    details: { binding: bindingName, dialect },
  });
}
