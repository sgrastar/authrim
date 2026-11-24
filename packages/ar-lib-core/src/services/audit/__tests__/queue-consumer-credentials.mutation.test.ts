import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  D1EncryptedCredentialSecretBackend,
  R2EncryptedCredentialSecretBackend,
} from '@authrim/ar-lib-logging/keys';
import { processLoggingDeliveryQueue } from '../queue-consumer';
import {
  ROOT_KEY,
  createFakeAdminDb,
  createMemoryBucket,
  createMessage,
  fetchResponse,
} from './queue-consumer-mutation-helpers';
import { deliver, loggedError } from './queue-consumer-credentials-kit';

describe('queue consumer runtime credential resolution', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe('cfsecret refs', () => {
    it('reads the binding named by the path when the authority is env', async () => {
      const { headers, message } = await deliver({
        destination: { credential_ref: 'cfsecret://env/CRED_ENV_PATH_BINDING#v1' },
        env: { CRED_ENV_PATH_BINDING: 'path-token' },
      });
      expect(headers?.Authorization).toBe('Bearer path-token');
      expect(message.ack).toHaveBeenCalledOnce();
    });

    it('strips every leading slash from the env path', async () => {
      const { headers } = await deliver({
        destination: { credential_ref: 'cfsecret://env//CRED_ENV_SLASH_BINDING' },
        env: { CRED_ENV_SLASH_BINDING: 'slash-token' },
      });
      expect(headers?.Authorization).toBe('Bearer slash-token');
    });

    it('uses the authority as the binding name when it is not env', async () => {
      const { headers } = await deliver({
        destination: { credential_ref: 'cfsecret://CRED_AUTHORITY_BINDING/ignored' },
        env: { CRED_AUTHORITY_BINDING: 'authority-token', ignored: 'wrong' },
      });
      expect(headers?.Authorization).toBe('Bearer authority-token');
    });

    it('falls back to the path when the authority is empty', async () => {
      const { headers } = await deliver({
        destination: { credential_ref: 'cfsecret:///CRED_EMPTY_AUTHORITY_BINDING' },
        env: { CRED_EMPTY_AUTHORITY_BINDING: 'fallback-token' },
      });
      expect(headers?.Authorization).toBe('Bearer fallback-token');
    });

    it.each([
      ['a missing binding', {}],
      ['an empty string binding', { CRED_UNAVAILABLE_BINDING: '' }],
      ['a non-string binding', { CRED_UNAVAILABLE_BINDING: 42 }],
    ])('retries with runtime_credential_cfsecret_unavailable for %s', async (_name, env) => {
      const { fetchMock, message, logger } = await deliver({
        destination: { credential_ref: 'cfsecret://env/CRED_UNAVAILABLE_BINDING' },
        env,
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(message.retry).toHaveBeenCalledOnce();
      expect(message.ack).not.toHaveBeenCalled();
      expect(loggedError(logger)).toContain('runtime_credential_cfsecret_unavailable');
    });

    it('sends no auth header when the destination has no credential ref', async () => {
      const { headers } = await deliver({ destination: { credential_ref: null } });
      expect(headers).toEqual({
        'Content-Type': 'application/json',
        'X-Authrim-Delivery': expect.stringMatching(/^qpl_cred_/) as string,
      });
    });
  });

  describe('credential cache', () => {
    it('serves the cached plaintext for 60 seconds and refreshes afterwards', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const destination = {
        credential_ref: 'cfsecret://env/CRED_CACHE_BINDING',
        credential_version: 7,
      };

      const first = await deliver({ destination, env: { CRED_CACHE_BINDING: 'cache-v1' } });
      expect(first.headers?.Authorization).toBe('Bearer cache-v1');

      vi.setSystemTime(new Date('2026-01-01T00:00:59Z'));
      const cached = await deliver({ destination, env: { CRED_CACHE_BINDING: 'cache-v2' } });
      expect(cached.headers?.Authorization).toBe('Bearer cache-v1');

      vi.setSystemTime(new Date('2026-01-01T00:01:01Z'));
      const refreshed = await deliver({ destination, env: { CRED_CACHE_BINDING: 'cache-v3' } });
      expect(refreshed.headers?.Authorization).toBe('Bearer cache-v3');
    });

    it('keys the cache by credential version', async () => {
      const ref = 'cfsecret://env/CRED_VERSION_BINDING';
      const v1 = await deliver({
        destination: { credential_ref: ref, credential_version: 1 },
        env: { CRED_VERSION_BINDING: 'ver-a' },
      });
      const v2 = await deliver({
        destination: { credential_ref: ref, credential_version: 2 },
        env: { CRED_VERSION_BINDING: 'ver-b' },
      });
      const none = await deliver({
        destination: { credential_ref: ref, credential_version: null },
        env: { CRED_VERSION_BINDING: 'ver-c' },
      });
      expect(v1.headers?.Authorization).toBe('Bearer ver-a');
      expect(v2.headers?.Authorization).toBe('Bearer ver-b');
      expect(none.headers?.Authorization).toBe('Bearer ver-c');
    });
  });

  describe('encrypted secret backends', () => {
    it('fails with root_key_unavailable for r2secret refs without OBJECT_ENCRYPTION_ROOT_KEY', async () => {
      const { logger, message } = await deliver({
        destination: {
          credential_ref: 'r2secret://admin-secrets/destinations/x/credentials/v1.json#v1',
        },
      });
      expect(loggedError(logger)).toContain('runtime_credential_root_key_unavailable');
      expect(message.retry).toHaveBeenCalledOnce();
    });

    it('fails with r2_bucket_unavailable for r2secret refs without SENSITIVE_DETAILS', async () => {
      const { logger } = await deliver({
        destination: {
          credential_ref: 'r2secret://admin-secrets/destinations/x/credentials/v1.json#v1',
        },
        env: { OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY },
      });
      expect(loggedError(logger)).toContain('runtime_credential_r2_bucket_unavailable');
    });

    it('fails with ref_unsupported for refs that map to no backend', async () => {
      const { logger, fetchMock } = await deliver({
        destination: { credential_ref: 'extsecret://vault/path' },
        env: { OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY },
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(loggedError(logger)).toContain('runtime_credential_ref_unsupported');
    });

    it('decrypts r2secret credentials through the admin-secrets bucket', async () => {
      const bucket = createMemoryBucket();
      const backend = new R2EncryptedCredentialSecretBackend({
        bucket: bucket,
        rootKeyHex: ROOT_KEY,
        bucketName: 'admin-secrets',
      });
      const ref = await backend.putSecret({
        destinationId: 'dest_r2_cred',
        version: 1,
        plaintext: 'r2-secret-token',
      });
      const { headers, message } = await deliver({
        destination: { credential_ref: ref, credential_version: 1 },
        env: { OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY, SENSITIVE_DETAILS: bucket },
      });
      expect(headers?.Authorization).toBe('Bearer r2-secret-token');
      expect(message.ack).toHaveBeenCalledOnce();
    });

    it('decrypts d1secret credentials through the admin database', async () => {
      const seeded: unknown[][] = [];
      const seedBackend = new D1EncryptedCredentialSecretBackend({
        store: {
          execute: async (sql: string, params: unknown[] = []) => {
            if (sql.includes('credential_secret_bodies')) seeded.push(params);
            return { rowsAffected: 1 };
          },
          queryOne: async () => null,
        } as never,
        rootKeyHex: ROOT_KEY,
      });
      const ref = await seedBackend.putSecret({
        destinationId: 'dest_d1_cred',
        version: 1,
        plaintext: 'd1-secret-token',
      });
      const [, destinationId, version, envelopeJson] = seeded[0] as [
        string,
        string,
        number,
        string,
      ];
      const adminDb = createFakeAdminDb({
        destination: { credential_ref: ref, credential_version: 1 },
        queryOne: (sql) =>
          sql.includes('credential_secret_bodies')
            ? {
                destination_id: destinationId,
                version,
                envelope_json: envelopeJson,
                metadata: null,
                status: 'active',
              }
            : undefined,
      });
      const fetchMock = vi.fn().mockResolvedValue(fetchResponse(200));
      vi.stubGlobal('fetch', fetchMock);
      const message = createMessage({
        payload_type: 'http_sink_batch',
        schema_version: 1,
        payload_id: 'qpl_d1_cred',
        tenant_key: 'tk_cred',
        lane: 'critical',
        created_at: 1779148800000,
        destination_id: 'dest_d1_cred',
        endpoint_url: 'https://collector.example/logs',
        log_type: 'operational',
        plane: 'external_sink',
        batch_id: 'batch_d1_cred',
        record_count: 1,
      });
      await processLoggingDeliveryQueue(
        { messages: [message] } as unknown as MessageBatch<unknown>,
        {
          DB: {} as D1Database,
          DB_PII: {} as D1Database,
          DB_ADMIN: adminDb,
          OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY,
        }
      );
      const headers = (fetchMock.mock.calls[0]?.[1] as { headers: Record<string, string> }).headers;
      expect(headers.Authorization).toBe('Bearer d1-secret-token');
      expect(message.ack).toHaveBeenCalledOnce();
    });
  });

  describe('auth profile selection', () => {
    const bindingRef = (name: string) => `cfsecret://env/${name}`;

    it('defaults to bearer with the raw plaintext when the credential is not JSON', async () => {
      const { headers } = await deliver({
        destination: { credential_ref: bindingRef('AUTH_RAW_BINDING') },
        env: { AUTH_RAW_BINDING: 'not json' },
      });
      expect(headers?.Authorization).toBe('Bearer not json');
    });

    it('ignores JSON arrays and treats them as raw bearer plaintext', async () => {
      const { headers } = await deliver({
        destination: { credential_ref: bindingRef('AUTH_ARRAY_BINDING') },
        env: { AUTH_ARRAY_BINDING: '["a","b"]' },
      });
      expect(headers?.Authorization).toBe('Bearer ["a","b"]');
    });

    it.each(['token', 'bearerToken', 'bearer_token', 'value'])(
      'reads the bearer token from the JSON credential key %s',
      async (key) => {
        const { headers } = await deliver({
          destination: { credential_ref: bindingRef(`AUTH_BEARER_${key}`) },
          env: { [`AUTH_BEARER_${key}`]: JSON.stringify({ [key]: `  tok-${key}  ` }) },
        });
        expect(headers?.Authorization).toBe(`Bearer tok-${key}`);
      }
    );

    it('prefers the provider config auth profile over the credential mode', async () => {
      const { headers } = await deliver({
        destination: {
          provider_config: JSON.stringify({
            url: 'https://collector.example/logs',
            authMode: 'api_key',
          }),
          credential_ref: bindingRef('AUTH_PRECEDENCE_BINDING'),
        },
        env: { AUTH_PRECEDENCE_BINDING: JSON.stringify({ mode: 'bearer', value: 'v' }) },
      });
      expect(headers?.['X-Api-Key']).toBe('v');
      expect(headers?.Authorization).toBeUndefined();
    });

    it.each(['authProfile', 'auth_profile'])(
      'reads the profile from the credential key %s when the config has none',
      async (key) => {
        const { headers } = await deliver({
          destination: { credential_ref: bindingRef(`AUTH_CRED_PROFILE_${key}`) },
          env: {
            [`AUTH_CRED_PROFILE_${key}`]: JSON.stringify({ [key]: 'api_key', value: 'kk' }),
          },
        });
        expect(headers?.['X-Api-Key']).toBe('kk');
      }
    );

    it('sends no auth header for the none profile even with a credential', async () => {
      const { headers } = await deliver({
        destination: {
          provider_config: JSON.stringify({
            url: 'https://collector.example/logs',
            auth_profile: 'none',
          }),
          credential_ref: bindingRef('AUTH_NONE_BINDING'),
        },
        env: { AUTH_NONE_BINDING: 'unused' },
      });
      expect(headers?.Authorization).toBeUndefined();
      expect(Object.keys(headers ?? {}).sort()).toEqual(['Content-Type', 'X-Authrim-Delivery']);
    });

    it('treats unknown profiles as bearer', async () => {
      const { headers } = await deliver({
        destination: {
          provider_config: JSON.stringify({
            url: 'https://collector.example/logs',
            authProfile: 'mystery',
          }),
          credential_ref: bindingRef('AUTH_UNKNOWN_BINDING'),
        },
        env: { AUTH_UNKNOWN_BINDING: 'mystery-token' },
      });
      expect(headers?.Authorization).toBe('Bearer mystery-token');
    });
  });
});
