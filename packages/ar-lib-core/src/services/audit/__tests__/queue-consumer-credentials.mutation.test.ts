import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  D1EncryptedCredentialSecretBackend,
  R2EncryptedCredentialSecretBackend,
} from '@authrim/ar-lib-logging/keys';
import { processLoggingDeliveryQueue } from '../queue-consumer';
import {
  ROOT_KEY,
  createFakeAdminDb,
  createFakeLogger,
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

    // Updated: this used to pin "unknown profiles are treated as bearer", which sent the
    // credential as a Bearer token to a sink configured for a mode we do not understand and made
    // the fail-closed throw in buildHttpSinkAuthHeaders unreachable. Unknown modes now fail the
    // delivery (retry -> DLQ) and nothing is sent.
    it('fails closed for an explicitly provided unknown profile instead of using bearer', async () => {
      const { fetchMock, message, logger } = await deliver({
        destination: {
          provider_config: JSON.stringify({
            url: 'https://collector.example/logs',
            authProfile: 'mystery',
          }),
          credential_ref: bindingRef('AUTH_UNKNOWN_BINDING'),
        },
        env: { AUTH_UNKNOWN_BINDING: 'mystery-token' },
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(message.retry).toHaveBeenCalledOnce();
      expect(message.ack).not.toHaveBeenCalled();
      expect(loggedError(logger)).toContain('unsupported_http_sink_auth_mode:mystery');
    });

    it('fails closed for an unknown profile without a credential instead of using none', async () => {
      const { fetchMock, message, logger } = await deliver({
        destination: {
          provider_config: JSON.stringify({
            url: 'https://collector.example/logs',
            auth_mode: 'mystery',
          }),
        },
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(message.retry).toHaveBeenCalledOnce();
      expect(loggedError(logger)).toContain('unsupported_http_sink_auth_mode:mystery');
    });

    it('fails closed for an unknown mode carried by the credential JSON', async () => {
      const { fetchMock, message, logger } = await deliver({
        destination: { credential_ref: bindingRef('AUTH_UNKNOWN_CRED_MODE') },
        env: { AUTH_UNKNOWN_CRED_MODE: JSON.stringify({ mode: 'oauth2', value: 'v' }) },
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(message.retry).toHaveBeenCalledOnce();
      expect(loggedError(logger)).toContain('unsupported_http_sink_auth_mode:oauth2');
    });

    it('fails closed for a non-string mode value', async () => {
      const { fetchMock, message, logger } = await deliver({
        destination: {
          provider_config: JSON.stringify({
            url: 'https://collector.example/logs',
            authMode: 5,
          }),
          credential_ref: bindingRef('AUTH_NON_STRING_MODE'),
        },
        env: { AUTH_NON_STRING_MODE: 'tok' },
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(message.retry).toHaveBeenCalledOnce();
      expect(loggedError(logger)).toContain('unsupported_http_sink_auth_mode:5');
    });

    it('only an omitted (or blank) mode defaults: none without a credential, bearer with one', async () => {
      const none = await deliver({
        destination: {
          provider_config: JSON.stringify({ url: 'https://collector.example/logs', authMode: ' ' }),
        },
      });
      expect(none.message.ack).toHaveBeenCalledOnce();
      expect(none.headers?.Authorization).toBeUndefined();

      const bearer = await deliver({
        destination: { credential_ref: bindingRef('AUTH_OMITTED_MODE') },
        env: { AUTH_OMITTED_MODE: 'omitted-token' },
      });
      expect(bearer.headers?.Authorization).toBe('Bearer omitted-token');
    });

    it.each(['bearer', 'api_key', 'custom_headers', 'hmac'])(
      'fails closed for explicit mode %s when no credential is available',
      async (mode) => {
        const { fetchMock, message, logger } = await deliver({
          destination: {
            provider_config: JSON.stringify({
              url: 'https://collector.example/logs',
              authMode: mode,
            }),
            credential_ref: null,
          },
        });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(message.retry).toHaveBeenCalledOnce();
        expect(loggedError(logger)).toContain(`http_sink_auth_credential_missing:${mode}`);
      }
    );

    it('keeps explicit custom_headers working with only non-secret config headers', async () => {
      const { headers, message } = await deliver({
        destination: {
          provider_config: JSON.stringify({
            url: 'https://collector.example/logs',
            authMode: 'custom_headers',
            headers: { 'X-Tenant': 'acme' },
          }),
        },
      });
      expect(headers?.['X-Tenant']).toBe('acme');
      expect(message.ack).toHaveBeenCalledOnce();
    });

    it('does not echo arbitrary invalid mode values into the error', async () => {
      const secretLike = 'sk_live_' + 'x'.repeat(40);
      for (const bad of [secretLike, 'has space', 'bad value!', { a: 1 }]) {
        const { fetchMock, message, logger } = await deliver({
          destination: {
            provider_config: JSON.stringify({
              url: 'https://collector.example/logs',
              authMode: bad,
            }),
            credential_ref: bindingRef('AUTH_ECHO'),
          },
          env: { AUTH_ECHO: 'tok' },
        });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(message.retry).toHaveBeenCalledOnce();
        const logged = loggedError(logger);
        expect(logged).toContain('unsupported_http_sink_auth_mode:invalid');
        expect(logged).not.toContain('sk_live_');
        expect(logged).not.toContain('bad value');
      }
    });

    it('uses only the highest-priority mode key when several coexist', async () => {
      const { headers, message } = await deliver({
        destination: {
          provider_config: JSON.stringify({
            url: 'https://collector.example/logs',
            authProfile: 'bearer',
            auth_mode: 'legacy_stale',
          }),
          credential_ref: bindingRef('AUTH_COEXIST'),
        },
        env: { AUTH_COEXIST: 'coexist-token' },
      });
      expect(headers?.Authorization).toBe('Bearer coexist-token');
      expect(message.ack).toHaveBeenCalledOnce();
    });

    it.each([
      ['empty headers object, no credential', { headers: {} }, undefined],
      ['non-string header values only', { headers: { 'X-A': 1 } }, undefined],
      ['credential without usable headers', {}, JSON.stringify({ headers: 5 })],
      ['non-JSON credential', {}, 'plain-token'],
    ])('fails closed for custom_headers with no usable header (%s)', async (name, extra, cred) => {
      const ref = `AUTH_CH_EMPTY_${name.replace(/\W/g, '_')}`;
      const { fetchMock, message, logger } = await deliver({
        destination: {
          provider_config: JSON.stringify({
            url: 'https://collector.example/logs',
            authMode: 'custom_headers',
            ...extra,
          }),
          credential_ref: cred === undefined ? null : bindingRef(ref),
        },
        env: cred === undefined ? {} : { [ref]: cred },
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(message.retry).toHaveBeenCalledOnce();
      expect(loggedError(logger)).toContain('http_sink_auth_credential_missing:custom_headers');
    });

    it('fails closed for an unknown mode on the delivery fanout (http chunk reference) path', async () => {
      const fetchMock = vi.fn().mockResolvedValue(fetchResponse(200));
      vi.stubGlobal('fetch', fetchMock);
      const logger = createFakeLogger();
      const message = createMessage({
        payload_type: 'delivery_fanout',
        schema_version: 1,
        payload_id: 'qpl_fanout_unknown_mode',
        tenant_key: 'tk_123',
        lane: 'critical',
        created_at: 1779148800000,
        catalog_id: 'chk_1',
        object_key: 'logs/tk_123/archive/audit/chunk.jsonl',
        destination_id: 'dest_1',
        log_type: 'audit',
        plane: 'external_sink',
        record_count: 10,
      });
      await processLoggingDeliveryQueue(
        {
          messages: [message],
          queue: 'LOGGING_DELIVERY_QUEUE',
        } as unknown as MessageBatch<unknown>,
        {
          DB: {} as D1Database,
          DB_PII: {} as D1Database,
          DB_ADMIN: createFakeAdminDb({
            destination: {
              provider_config: JSON.stringify({
                url: 'https://collector.example/chunks',
                authMode: 'mystery',
              }),
            },
          }),
        },
        logger
      );
      expect(fetchMock).not.toHaveBeenCalled();
      expect(message.retry).toHaveBeenCalledOnce();
      expect(message.ack).not.toHaveBeenCalled();
      expect(loggedError(logger)).toContain('unsupported_http_sink_auth_mode:mystery');
    });
  });
});
