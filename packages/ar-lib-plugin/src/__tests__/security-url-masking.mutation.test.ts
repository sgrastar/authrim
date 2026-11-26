import { describe, expect, it } from 'vitest';
import {
  decryptSecretFields,
  decryptValue,
  deriveEncryptionKey,
  maskSensitiveFieldsRecursive,
  validateExternalUrl,
} from '../core/security';

const LONG_SECRET = 'abcdefghijklmnopqrstuvwxyz';
const MASKED_LONG = 'abcd****wxyz';

describe('validateExternalUrl: length limits', () => {
  it('accepts a URL of exactly maxLength and rejects one longer', () => {
    const base = 'https://example.com/';
    const exact = base + 'a'.repeat(30 - base.length);
    expect(exact).toHaveLength(30);
    expect(validateExternalUrl(exact, { maxLength: 30 }).valid).toBe(true);
    expect(validateExternalUrl(`${exact}a`, { maxLength: 30 })).toEqual({
      valid: false,
      reason: 'too_long',
    });
  });

  it('limits an allowed data URL to 150000 characters', () => {
    const prefix = 'data:image/png;base64,';
    const exact = prefix + 'A'.repeat(150000 - prefix.length);
    const options = { allowDataUrl: true, maxLength: 1_000_000 };
    expect(validateExternalUrl(exact, options)).toEqual({ valid: true, sanitized: exact });
    expect(validateExternalUrl(`${exact}A`, options)).toEqual({
      valid: false,
      reason: 'too_long',
    });
  });

  it('rejects a data URL that is not an image', () => {
    expect(validateExternalUrl('data:text/html,<b>x</b>', { allowDataUrl: true })).toEqual({
      valid: false,
      reason: 'disallowed_scheme',
    });
  });

  it('rejects data URLs unless allowed', () => {
    expect(validateExternalUrl('data:image/png;base64,AAAA')).toEqual({
      valid: false,
      reason: 'disallowed_scheme',
    });
  });

  it('answers a URL that cannot be parsed as invalid_format', () => {
    expect(validateExternalUrl('https://')).toEqual({ valid: false, reason: 'invalid_format' });
  });
});

describe('validateExternalUrl: scheme and private addresses', () => {
  it('allows http only when asked to', () => {
    expect(validateExternalUrl('http://example.com/a')).toEqual({
      valid: false,
      reason: 'disallowed_scheme',
    });
    expect(validateExternalUrl('http://example.com/a', { allowHttp: true })).toEqual({
      valid: true,
      sanitized: 'http://example.com/a',
    });
    expect(validateExternalUrl('ftp://example.com/a', { allowHttp: true }).reason).toBe(
      'disallowed_scheme'
    );
  });

  it('blocks private addresses by default and only then', () => {
    expect(validateExternalUrl('https://10.0.0.1/').reason).toBe('private_ip');
    expect(validateExternalUrl('https://10.0.0.1/', { blockPrivateIps: false }).valid).toBe(true);
  });

  it.each([
    '10.1.2.3',
    '172.16.0.1',
    '172.20.0.1',
    '172.29.0.1',
    '172.31.255.1',
    '192.168.1.1',
    '127.0.0.2',
    '0.1.2.3',
    '169.254.1.1',
  ])('blocks the private IPv4 address %s', (host) => {
    expect(validateExternalUrl(`https://${host}/`)).toEqual({
      valid: false,
      reason: 'private_ip',
    });
  });

  it.each([
    '8.10.8.8',
    '8.172.16.1',
    '172.15.0.1',
    '172.32.0.1',
    '8.192.168.1',
    '1.127.0.2',
    '1.0.0.1',
    '8.169.254.1',
  ])('accepts the public IPv4 address %s', (host) => {
    expect(validateExternalUrl(`https://${host}/`)).toEqual({
      valid: true,
      sanitized: `https://${host}/`,
    });
  });

  it.each(['[fe80::1]', '[fc00::1]', '[fd12:3456::1]'])(
    'blocks the private IPv6 address %s',
    (host) => {
      expect(validateExternalUrl(`https://${host}/`).reason).toBe('private_ip');
    }
  );

  it('accepts https URLs whether or not http is allowed', () => {
    expect(validateExternalUrl('https://example.com/a', { allowHttp: true }).valid).toBe(true);
    expect(validateExternalUrl('https://example.com/a', { allowHttp: false }).valid).toBe(true);
  });

  it('treats the IPv6 loopback as private even when the blocklist is replaced', () => {
    expect(validateExternalUrl('https://[::1]/', { blockedDomains: [] })).toEqual({
      valid: false,
      reason: 'private_ip',
    });
    expect(
      validateExternalUrl('https://[::1]/', { blockedDomains: [], blockPrivateIps: false }).valid
    ).toBe(true);
  });

  it('blocks the IPv6 loopback through the blocklist', () => {
    expect(validateExternalUrl('https://[::1]/').reason).toBe('blocklist');
  });

  it('accepts a public IPv6 address', () => {
    expect(validateExternalUrl('https://[2001:db8::1]/')).toEqual({
      valid: true,
      sanitized: 'https://[2001:db8::1]/',
    });
  });

  it.each(['ffc.example.com', 'ffd.example.com', 'fe80.example.com'])(
    'does not mistake the DNS name %s for an IPv6 address',
    (host) => {
      expect(validateExternalUrl(`https://${host}/`).valid).toBe(true);
    }
  );

  it('blocks metadata hosts and their subdomains', () => {
    expect(validateExternalUrl('https://metadata.google.internal/').reason).toBe('blocklist');
    expect(validateExternalUrl('https://a.metadata.google.internal/').reason).toBe('blocklist');
    expect(validateExternalUrl('https://localhost/').reason).toBe('blocklist');
  });
});

describe('validateExternalUrl: allowed domains', () => {
  it('imposes no restriction without a list or with an empty one', () => {
    expect(validateExternalUrl('https://example.com/').valid).toBe(true);
    expect(validateExternalUrl('https://example.com/', { allowedDomains: [] }).valid).toBe(true);
  });

  it('accepts the domain itself and its subdomains, but not look-alikes', () => {
    const options = { allowedDomains: ['example.com'] };
    expect(validateExternalUrl('https://example.com/x', options).valid).toBe(true);
    expect(validateExternalUrl('https://cdn.example.com/x', options).valid).toBe(true);
    expect(validateExternalUrl('https://notexample.com/x', options)).toEqual({
      valid: false,
      reason: 'disallowed_host',
    });
  });

  it('accepts a host that matches any one of several domains', () => {
    const options = { allowedDomains: ['a.example', 'b.example'] };
    expect(validateExternalUrl('https://b.example/x', options).valid).toBe(true);
    expect(validateExternalUrl('https://c.example/x', options).reason).toBe('disallowed_host');
  });
});

describe('maskSensitiveFieldsRecursive', () => {
  it('masks pattern-matching fields by default', () => {
    expect(maskSensitiveFieldsRecursive({ apiKey: LONG_SECRET, name: LONG_SECRET })).toEqual({
      apiKey: MASKED_LONG,
      name: LONG_SECRET,
    });
  });

  it('does not use patterns when turned off', () => {
    expect(
      maskSensitiveFieldsRecursive({ apiKey: LONG_SECRET }, { usePatternMatching: false })
    ).toEqual({ apiKey: LONG_SECRET });
  });

  it('keeps null and primitives inside arrays, and masks objects inside arrays', () => {
    const config = { list: [null, 'text', 5, { password: LONG_SECRET }] };
    expect(maskSensitiveFieldsRecursive(config)).toEqual({
      list: [null, 'text', 5, { password: MASKED_LONG }],
    });
  });

  it('masks nested objects down to maxDepth, inclusive', () => {
    const config = {
      top: { password: LONG_SECRET },
      deep: { inner: { password: LONG_SECRET } },
    };
    const masked = maskSensitiveFieldsRecursive(config, { maxDepth: 1 });
    expect(masked.top).toEqual({ password: MASKED_LONG });
  });

  it('masks an object inside an array at the depth limit', () => {
    const config = { password: LONG_SECRET, items: [{ password: LONG_SECRET }] };
    expect(maskSensitiveFieldsRecursive(config, { maxDepth: 1 })).toEqual({
      password: MASKED_LONG,
      items: [{ password: MASKED_LONG }],
    });
  });

  it('masks the fields of the object itself when maxDepth is 0', () => {
    expect(maskSensitiveFieldsRecursive({ password: LONG_SECRET }, { maxDepth: 0 })).toEqual({
      password: MASKED_LONG,
    });
  });
});

describe('encrypted value format', () => {
  async function key(): Promise<CryptoKey> {
    return deriveEncryptionKey('k'.repeat(32));
  }

  it.each(['enc:v1:AAAA', 'enc:v1:AAAA:BBBB:CCCC', 'enc:v2:AAAA:BBBB', 'xxx:v1:AAAA:BBBB'])(
    'rejects the malformed value %s',
    async (value) => {
      await expect(decryptValue(value, await key())).rejects.toThrow(
        'Invalid encrypted value format'
      );
    }
  );

  it('leaves the values of a configuration without an _encrypted list as they are', async () => {
    const config = { _encrypted: undefined, apiKey: 'enc:v1:AAAA:BBBB', other: 1 };
    await expect(
      decryptSecretFields(
        config as unknown as Parameters<typeof decryptSecretFields>[0],
        await key()
      )
    ).resolves.toEqual({ apiKey: 'enc:v1:AAAA:BBBB', other: 1 });
  });
});
