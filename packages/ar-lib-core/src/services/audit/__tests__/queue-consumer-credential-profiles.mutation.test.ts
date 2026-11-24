import { afterEach, describe, expect, it, vi } from 'vitest';
import { deliver } from './queue-consumer-credentials-kit';

describe('queue consumer runtime credential resolution', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe('api_key profile', () => {
    const apiKeyConfig = (extra: Record<string, unknown> = {}) =>
      JSON.stringify({ url: 'https://collector.example/logs', authProfile: 'api_key', ...extra });

    it('uses X-Api-Key and the raw plaintext by default', async () => {
      const { headers } = await deliver({
        destination: {
          provider_config: apiKeyConfig(),
          credential_ref: 'cfsecret://env/APIKEY_RAW_BINDING',
        },
        env: { APIKEY_RAW_BINDING: 'raw-key' },
      });
      expect(headers?.['X-Api-Key']).toBe('raw-key');
    });

    it.each(['apiKeyHeader', 'api_key_header', 'headerName'])(
      'reads the header name from provider config key %s',
      async (key) => {
        const { headers } = await deliver({
          destination: {
            provider_config: apiKeyConfig({ [key]: '  X-Cfg-Key  ' }),
            credential_ref: `cfsecret://env/APIKEY_CFG_${key}`,
          },
          env: { [`APIKEY_CFG_${key}`]: 'cfg-key' },
        });
        expect(headers?.['X-Cfg-Key']).toBe('cfg-key');
        expect(headers?.['X-Api-Key']).toBeUndefined();
      }
    );

    it.each(['headerName', 'header_name'])(
      'reads the header name from credential key %s',
      async (key) => {
        const { headers } = await deliver({
          destination: {
            provider_config: apiKeyConfig(),
            credential_ref: `cfsecret://env/APIKEY_CRED_${key}`,
          },
          env: {
            [`APIKEY_CRED_${key}`]: JSON.stringify({ [key]: 'X-Cred-Key', value: 'cred-key' }),
          },
        });
        expect(headers?.['X-Cred-Key']).toBe('cred-key');
      }
    );

    it('prefers the config header name over the credential header name', async () => {
      const { headers } = await deliver({
        destination: {
          provider_config: apiKeyConfig({ apiKeyHeader: 'X-From-Config' }),
          credential_ref: 'cfsecret://env/APIKEY_PREC_BINDING',
        },
        env: {
          APIKEY_PREC_BINDING: JSON.stringify({ headerName: 'X-From-Cred', value: 'k' }),
        },
      });
      expect(headers?.['X-From-Config']).toBe('k');
      expect(headers?.['X-From-Cred']).toBeUndefined();
    });

    it.each(['value', 'apiKey', 'api_key', 'token'])(
      'reads the key from credential key %s',
      async (key) => {
        const { headers } = await deliver({
          destination: {
            provider_config: apiKeyConfig(),
            credential_ref: `cfsecret://env/APIKEY_VAL_${key}`,
          },
          env: { [`APIKEY_VAL_${key}`]: JSON.stringify({ [key]: `key-${key}` }) },
        });
        expect(headers?.['X-Api-Key']).toBe(`key-${key}`);
      }
    );

    it.each([
      ['apiKeyPrefix', 'config'],
      ['api_key_prefix', 'config'],
      ['prefix', 'credential'],
    ])('prepends the prefix from %s (%s)', async (key, source) => {
      const config = source === 'config' ? { [key]: 'Token' } : {};
      const credential =
        source === 'credential' ? { [key]: 'Key', value: 'abc' } : { value: 'abc' };
      const { headers } = await deliver({
        destination: {
          provider_config: apiKeyConfig(config),
          credential_ref: `cfsecret://env/APIKEY_PFX_${key}`,
        },
        env: { [`APIKEY_PFX_${key}`]: JSON.stringify(credential) },
      });
      expect(headers?.['X-Api-Key']).toBe(`${source === 'config' ? 'Token' : 'Key'} abc`);
    });

    it('prefers the config prefix over the credential prefix', async () => {
      const { headers } = await deliver({
        destination: {
          provider_config: apiKeyConfig({ apiKeyPrefix: 'Cfg' }),
          credential_ref: 'cfsecret://env/APIKEY_PFXPREC_BINDING',
        },
        env: { APIKEY_PFXPREC_BINDING: JSON.stringify({ prefix: 'Cred', value: 'abc' }) },
      });
      expect(headers?.['X-Api-Key']).toBe('Cfg abc');
    });
  });

  describe('custom_headers profile', () => {
    const customConfig = (extra: Record<string, unknown> = {}) =>
      JSON.stringify({
        url: 'https://collector.example/logs',
        authProfile: 'custom_headers',
        ...extra,
      });

    it('builds headers from a credential header list, honouring the secret flag', async () => {
      const { headers, adminDb } = await deliver({
        destination: {
          provider_config: customConfig(),
          credential_ref: 'cfsecret://env/CUSTOM_LIST_BINDING',
        },
        env: {
          CUSTOM_LIST_BINDING: JSON.stringify({
            headers: [
              { name: 'X-One', value: '1' },
              { name: 'X-Two', value: '2', secret: false },
              { name: 'X-Bad-Value', value: 3 },
              { name: 9, value: 'x' },
              null,
              'string',
            ],
          }),
        },
      });
      expect(headers?.['X-One']).toBe('1');
      expect(headers?.['X-Two']).toBe('2');
      expect(headers?.['X-Bad-Value']).toBeUndefined();
      const completion = adminDb.execute.mock.calls.find(([sql]) =>
        String(sql).includes("SET status = 'delivered'")
      );
      const metadata = JSON.parse((completion?.[1] as unknown[])[3] as string) as {
        redacted_headers: Record<string, string>;
      };
      expect(metadata.redacted_headers).toEqual({ 'X-One': '[redacted]', 'X-Two': '2' });
    });

    it('treats every string field of an object credential as a secret header', async () => {
      const { headers } = await deliver({
        destination: {
          provider_config: customConfig(),
          credential_ref: 'cfsecret://env/CUSTOM_OBJ_BINDING',
        },
        env: {
          CUSTOM_OBJ_BINDING: JSON.stringify({ 'X-Secret-A': 'a', 'X-Num': 5, 'X-Secret-B': 'b' }),
        },
      });
      expect(headers?.['X-Secret-A']).toBe('a');
      expect(headers?.['X-Secret-B']).toBe('b');
      expect(headers?.['X-Num']).toBeUndefined();
    });

    it('adds non-secret headers from provider config alongside credential headers', async () => {
      const { headers, adminDb } = await deliver({
        destination: {
          provider_config: customConfig({ headers: { 'X-Static': 'static', 'X-Skip': 5 } }),
          credential_ref: 'cfsecret://env/CUSTOM_MIX_BINDING',
        },
        env: { CUSTOM_MIX_BINDING: JSON.stringify({ 'X-Cred': 'cred' }) },
      });
      expect(headers?.['X-Cred']).toBe('cred');
      expect(headers?.['X-Static']).toBe('static');
      expect(headers?.['X-Skip']).toBeUndefined();
      const completion = adminDb.execute.mock.calls.find(([sql]) =>
        String(sql).includes("SET status = 'delivered'")
      );
      const metadata = JSON.parse((completion?.[1] as unknown[])[3] as string) as {
        redacted_headers: Record<string, string>;
      };
      expect(metadata.redacted_headers).toEqual({ 'X-Cred': '[redacted]', 'X-Static': 'static' });
    });

    it('sends only config headers when the credential is not a JSON object', async () => {
      const { headers } = await deliver({
        destination: {
          provider_config: customConfig({ headers: { 'X-Only': 'cfg' } }),
          credential_ref: 'cfsecret://env/CUSTOM_RAW_BINDING',
        },
        env: { CUSTOM_RAW_BINDING: 'plain-text' },
      });
      expect(headers?.['X-Only']).toBe('cfg');
      expect(Object.keys(headers ?? {}).sort()).toEqual([
        'Content-Type',
        'X-Authrim-Delivery',
        'X-Only',
      ]);
    });

    it('does not turn an empty JSON object credential into headers', async () => {
      const { headers } = await deliver({
        destination: {
          provider_config: customConfig(),
          credential_ref: 'cfsecret://env/CUSTOM_EMPTY_BINDING',
        },
        env: { CUSTOM_EMPTY_BINDING: '{}' },
      });
      expect(Object.keys(headers ?? {}).sort()).toEqual(['Content-Type', 'X-Authrim-Delivery']);
    });
  });

  describe('hmac profile', () => {
    const hmacConfig = (extra: Record<string, unknown> = {}) =>
      JSON.stringify({ url: 'https://collector.example/logs', authProfile: 'hmac', ...extra });

    it('signs with the authrim profile by default', async () => {
      const { headers } = await deliver({
        destination: {
          provider_config: hmacConfig(),
          credential_ref: 'cfsecret://env/HMAC_DEFAULT_BINDING',
        },
        env: { HMAC_DEFAULT_BINDING: 'hmac-secret' },
        payloadId: 'qpl_hmac_default',
      });
      expect(headers?.['X-Authrim-Signature-256']).toMatch(/^sha256=[0-9a-f]{64}$/);
      expect(headers?.['X-Authrim-Timestamp']).toMatch(/^\d{10}$/);
      expect(headers?.['X-Authrim-Signature-Version']).toBe('v1');
      expect(headers?.['X-Authrim-Delivery']).toBe('qpl_hmac_default');
    });

    it.each(['secret', 'value', 'token'])(
      'accepts the HMAC secret from credential key %s',
      async (key) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-02-03T04:05:06Z'));
        const destination = (name: string) => ({
          provider_config: hmacConfig(),
          credential_ref: `cfsecret://env/${name}`,
        });
        const viaKey = await deliver({
          destination: destination(`HMAC_KEY_${key}`),
          env: { [`HMAC_KEY_${key}`]: JSON.stringify({ [key]: 'shared-secret' }) },
          payloadId: 'qpl_hmac_same',
        });
        const viaRaw = await deliver({
          destination: destination(`HMAC_KEY_RAW_${key}`),
          env: { [`HMAC_KEY_RAW_${key}`]: 'shared-secret' },
          payloadId: 'qpl_hmac_same',
        });
        const other = await deliver({
          destination: destination(`HMAC_KEY_OTHER_${key}`),
          env: { [`HMAC_KEY_OTHER_${key}`]: JSON.stringify({ [key]: 'different-secret' }) },
          payloadId: 'qpl_hmac_same',
        });
        const sig = (h?: Record<string, string>) => h?.['X-Authrim-Signature-256'];
        expect(sig(viaKey.headers)).toBeDefined();
        expect(sig(viaKey.headers)).toBe(sig(viaRaw.headers));
        expect(sig(other.headers)).not.toBe(sig(viaKey.headers));
      }
    );

    it('applies every signature profile override from the provider config', async () => {
      const { headers } = await deliver({
        destination: {
          provider_config: hmacConfig({
            headerProfile: 'custom',
            signatureHeader: 'X-Sig',
            timestampHeader: 'X-Ts',
            deliveryIdHeader: 'X-Delivery-Id',
            signatureVersionHeader: 'X-Sig-Ver',
            signatureVersion: 'v9',
            timestampFormat: 'iso8601',
            signatureValueFormat: 'hex',
          }),
          credential_ref: 'cfsecret://env/HMAC_PROFILE_BINDING',
        },
        env: { HMAC_PROFILE_BINDING: 'hmac-secret' },
        payloadId: 'qpl_hmac_profile',
      });
      expect(headers?.['X-Sig']).toMatch(/^[0-9a-f]{64}$/);
      expect(headers?.['X-Ts']).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(headers?.['X-Delivery-Id']).toBe('qpl_hmac_profile');
      expect(headers?.['X-Sig-Ver']).toBe('v9');
      expect(headers?.['X-Authrim-Signature-256']).toBeUndefined();
    });

    it('reads snake_case overrides from a nested hmacProfile object', async () => {
      const { headers } = await deliver({
        destination: {
          provider_config: hmacConfig({
            header_profile: 'webhook_legacy',
            hmac_profile: {
              signature_header: 'X-Snake-Sig',
              timestamp_header: 'X-Snake-Ts',
              delivery_id_header: 'X-Snake-Id',
              signature_version_header: 'X-Snake-Ver',
              signature_version: 'v2',
              timestamp_format: 'unix_seconds',
              signature_value_format: 'sha256_hex',
            },
          }),
          credential_ref: 'cfsecret://env/HMAC_SNAKE_BINDING',
        },
        env: { HMAC_SNAKE_BINDING: 'hmac-secret' },
        payloadId: 'qpl_hmac_snake',
      });
      expect(headers?.['X-Snake-Sig']).toBeDefined();
      expect(headers?.['X-Snake-Ts']).toMatch(/^\d{10}$/);
      expect(headers?.['X-Snake-Id']).toBe('qpl_hmac_snake');
      expect(headers?.['X-Snake-Ver']).toBe('v2');
      expect(headers?.['X-Webhook-Signature']).toBeUndefined();
    });

    it('takes the profile name from the hmacProfile object when no header profile is set', async () => {
      const { headers } = await deliver({
        destination: {
          provider_config: hmacConfig({ hmacProfile: { name: 'webhook_legacy' } }),
          credential_ref: 'cfsecret://env/HMAC_NAMED_BINDING',
        },
        env: { HMAC_NAMED_BINDING: 'hmac-secret' },
      });
      expect(headers?.['X-Webhook-Signature']).toBeDefined();
      expect(headers?.['X-Authrim-Signature-256']).toBeUndefined();
    });

    it('ignores unrecognised profile names and formats', async () => {
      const { headers } = await deliver({
        destination: {
          provider_config: hmacConfig({
            headerProfile: 'nonsense',
            timestampFormat: 'epoch_ms',
            signatureValueFormat: 'base64',
          }),
          credential_ref: 'cfsecret://env/HMAC_IGNORED_BINDING',
        },
        env: { HMAC_IGNORED_BINDING: 'hmac-secret' },
      });
      expect(headers?.['X-Authrim-Signature-256']).toBeDefined();
      expect(headers?.['X-Authrim-Timestamp']).toMatch(/^\d{10}$/);
    });
  });
});
