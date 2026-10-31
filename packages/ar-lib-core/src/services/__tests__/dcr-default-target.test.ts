import { describe, it, expect, vi } from 'vitest';
import {
  DCR_DEFAULT_TARGET_MAX_LENGTH,
  dcrDefaultAudienceProblem,
  dcrDefaultResourceProblem,
  dcrDefaultTargetProblem,
  dcrReservedTargetProblem,
  grantsUseDefaultTarget,
  resolveDcrDefaultTarget,
  tenantIssuerUrls,
} from '../dcr-default-target';

const ISSUER = 'https://acme.example.com';

function kv(documents: Record<string, string>, failOn?: string): KVNamespace {
  return {
    get: vi.fn(async (key: string) => {
      if (failOn && key.includes(failOn)) throw new Error('KV unavailable');
      return documents[key] ?? null;
    }),
    put: vi.fn(async () => undefined),
    delete: vi.fn(),
    list: vi.fn(),
    getWithMetadata: vi.fn(),
  } as unknown as KVNamespace;
}

describe('dcrDefaultResourceProblem (RFC 8707 section 2)', () => {
  it.each([
    '',
    'https://api.example.com',
    'https://api.example.com/v1/',
    'https://api.example.com:8443/v1?x=1',
    'http://localhost',
    'http://localhost:3000/api',
    'http://127.0.0.1:8080/api',
    'http://[::1]:8080/api',
  ])('accepts %j', (value) => {
    expect(dcrDefaultResourceProblem(value)).toBeNull();
  });

  it.each([
    ['api.example.com/v1', 'absolute URI'],
    ['/v1', 'absolute URI'],
    ['urn:example:api', 'https'],
    ['https://api.example.com/v1#section', 'fragment'],
    ['https://api.example.com/v1#', 'fragment'],
    ['http://api.example.com', 'https'],
    ['http://localhost.example.com', 'https'],
    ['ftp://api.example.com', 'https'],
    ['javascript:alert(1)', 'https'],
    ['https://api.example.com/a b', 'spaces'],
    [' https://api.example.com', 'spaces'],
    ['https://api.example.com\n', 'spaces'],
    ['https://api.example.com/\u0000', 'control'],
    [42, 'string'],
    [null, 'string'],
    [undefined, 'string'],
  ])('refuses %j', (value, mentions) => {
    expect(dcrDefaultResourceProblem(value)).toContain(mentions);
  });
});

describe('the length limit', () => {
  const resource = (length: number) =>
    `https://a.example/${'a'.repeat(length - 'https://a.example/'.length)}`;

  it('allows exactly 2048 characters and refuses one more', () => {
    expect(dcrDefaultResourceProblem(resource(DCR_DEFAULT_TARGET_MAX_LENGTH))).toBeNull();
    expect(dcrDefaultResourceProblem(resource(DCR_DEFAULT_TARGET_MAX_LENGTH + 1))).toContain(
      'at most 2048'
    );
    expect(dcrDefaultAudienceProblem('a'.repeat(DCR_DEFAULT_TARGET_MAX_LENGTH))).toBeNull();
    expect(dcrDefaultAudienceProblem('a'.repeat(DCR_DEFAULT_TARGET_MAX_LENGTH + 1))).toContain(
      'at most 2048'
    );
  });
});

describe('dcrDefaultAudienceProblem', () => {
  it.each(['', 'urn:example:api', 'https://api.example.com', 'orders-api'])(
    'accepts %j',
    (value) => {
      expect(dcrDefaultAudienceProblem(value)).toBeNull();
    }
  );

  it.each([
    ['two words', 'spaces'],
    [' leading', 'spaces'],
    ['trailing ', 'spaces'],
    ['tab\there', 'control'],
    ['line\nbreak', 'control'],
    ['nul\u0000', 'control'],
    ['del\u007f', 'control'],
    [1, 'string'],
    [{}, 'string'],
  ])('refuses %j', (value, mentions) => {
    expect(dcrDefaultAudienceProblem(value)).toContain(mentions);
  });
});

describe('dcrReservedTargetProblem', () => {
  it.each([
    ISSUER,
    `${ISSUER}/`,
    `${ISSUER}//`,
    `${ISSUER}/userinfo`,
    `${ISSUER}/userinfo/`,
    'https://ACME.example.com',
    'https://acme.example.com:443/',
    'https://acme.example.com:443/userinfo',
  ])('refuses %s as the tenant issuer or its userinfo URL', (value) => {
    expect(dcrReservedTargetProblem('dcr.default_audience', value, [ISSUER])).toContain(
      'dcr.default_audience must not be this tenant'
    );
    expect(dcrReservedTargetProblem('dcr.default_resource', value, [ISSUER])).toContain(
      'dcr.default_resource must not be this tenant'
    );
  });

  it.each([
    `${ISSUER}/api`,
    `${ISSUER}/userinfo/extra`,
    'https://acme.example.com.evil.example',
    'https://other.example.com',
    'http://acme.example.com',
    'urn:example:api',
    'acme',
    '',
  ])('allows %j', (value) => {
    expect(dcrReservedTargetProblem('dcr.default_audience', value, [ISSUER])).toBeNull();
  });

  it('checks every issuer the tenant answers on, and ignores empty ones', () => {
    const issuers = ['', ISSUER, 'https://login.acme.test'];
    expect(
      dcrReservedTargetProblem('dcr.default_resource', 'https://login.acme.test/userinfo', issuers)
    ).not.toBeNull();
    expect(dcrReservedTargetProblem('dcr.default_resource', 'https://', [''])).toBeNull();
  });

  it('refuses nothing without an issuer to compare with', () => {
    expect(dcrDefaultTargetProblem('dcr.default_audience', ISSUER)).toBeNull();
  });

  it('is applied after the format checks', () => {
    expect(dcrDefaultTargetProblem('dcr.default_resource', `${ISSUER}#x`, [ISSUER])).toContain(
      'fragment'
    );
    expect(dcrDefaultTargetProblem('dcr.default_resource', ISSUER, [ISSUER])).toContain(
      'issuer URL'
    );
  });
});

describe('tenantIssuerUrls with a failing custom domain lookup', () => {
  it('throws: the issuers are unknown', async () => {
    const failing = {
      prepare: () => ({
        bind() {
          return this;
        },
        first: async () => {
          throw new Error('D1 unavailable');
        },
      }),
    };
    await expect(
      tenantIssuerUrls(
        { BASE_DOMAIN: 'example.com', AUTHRIM_CONFIG: kv({}) } as never,
        'acme',
        [],
        {
          tenantCoreDb: failing as never,
        }
      )
    ).rejects.toThrow();
  });
});

describe('tenantIssuerUrls', () => {
  it('holds the configured issuer, the one the caller knows and the primary custom domain', async () => {
    const urls = await tenantIssuerUrls(
      { BASE_DOMAIN: 'example.com', AUTHRIM_CONFIG: kv({}) } as never,
      'acme',
      ['https://custom.example.org', ''],
      // The lookup succeeds and finds no custom domain.
      {
        tenantCoreDb: {
          prepare: () => ({
            bind() {
              return this;
            },
            first: async () => null,
          }),
        } as never,
      }
    );
    expect(urls).toContain('https://acme.example.com');
    expect(urls).toContain('https://custom.example.org');
    expect(urls).not.toContain('');
  });
});

describe('resolveDcrDefaultTarget', () => {
  const doc = (value: Record<string, unknown>) => ({
    'settings:tenant:acme:dcr': JSON.stringify(value),
  });
  const resolve = (env: Record<string, unknown>) =>
    resolveDcrDefaultTarget(env as never, 'acme', [ISSUER]);

  it('is empty when nothing is set', async () => {
    await expect(resolve({ SETTINGS: kv({}) })).resolves.toEqual({ ignored: [] });
  });

  it('is empty without any settings store', async () => {
    await expect(resolve({})).resolves.toEqual({ ignored: [] });
  });

  it('reads the tenant document', async () => {
    const target = await resolve({
      SETTINGS: kv(
        doc({
          'dcr.default_audience': 'urn:example:api',
          'dcr.default_resource': 'https://a.example/',
        })
      ),
    });
    expect(target).toEqual({
      audience: 'urn:example:api',
      resource: 'https://a.example/',
      ignored: [],
    });
  });

  it('reads the environment variables, below the tenant document', async () => {
    const env = {
      DCR_DEFAULT_AUDIENCE: 'urn:env',
      DCR_DEFAULT_RESOURCE: 'https://env.example/',
    };
    await expect(resolve({ ...env, SETTINGS: kv({}) })).resolves.toMatchObject({
      audience: 'urn:env',
      resource: 'https://env.example/',
    });
    await expect(
      resolve({ ...env, SETTINGS: kv(doc({ 'dcr.default_audience': 'urn:doc' })) })
    ).resolves.toMatchObject({ audience: 'urn:doc', resource: 'https://env.example/' });
  });

  it('ignores an invalid value on its own, and says why', async () => {
    const target = await resolve({
      SETTINGS: kv(
        doc({
          'dcr.default_audience': 'urn:example:api',
          'dcr.default_resource': 'http://insecure.example/',
        })
      ),
    });
    expect(target.audience).toBe('urn:example:api');
    expect(target.resource).toBeUndefined();
    expect(target.ignored).toEqual([
      { key: 'dcr.default_resource', problem: expect.stringContaining('https') },
    ]);
  });

  it('ignores the issuer and its userinfo URL', async () => {
    const target = await resolve({
      SETTINGS: kv(
        doc({ 'dcr.default_audience': ISSUER, 'dcr.default_resource': `${ISSUER}/userinfo` })
      ),
    });
    expect(target.audience).toBeUndefined();
    expect(target.resource).toBeUndefined();
    expect(target.ignored.map((entry) => entry.key)).toEqual([
      'dcr.default_audience',
      'dcr.default_resource',
    ]);
  });

  it('does not read the retired client.default_* keys', async () => {
    await expect(
      resolve({
        CLIENT_DEFAULT_AUDIENCE: 'urn:old',
        SETTINGS: kv(
          doc({ 'client.default_audience': 'urn:old', 'client.default_resource': 'https://a/' })
        ),
      })
    ).resolves.toEqual({ ignored: [] });
  });

  it('THROWS when the document exists but cannot be read', async () => {
    await expect(resolve({ SETTINGS: kv({}, ':dcr') })).rejects.toThrow();
  });

  it.each(['{not json', '[1,2]', '"text"'])('THROWS when the document is %s', async (text) => {
    await expect(resolve({ SETTINGS: kv({ 'settings:tenant:acme:dcr': text }) })).rejects.toThrow();
  });
});

describe('grantsUseDefaultTarget', () => {
  it.each([
    ['client_credentials'],
    ['urn:openid:params:grant-type:ciba'],
    ['urn:ietf:params:oauth:grant-type:device_code'],
    ['urn:ietf:params:oauth:grant-type:token-exchange'],
  ])('is true for %s', (grant) => {
    expect(grantsUseDefaultTarget([grant])).toBe(true);
    expect(grantsUseDefaultTarget(['implicit', grant])).toBe(true);
  });

  it.each([
    [['authorization_code']],
    [['implicit']],
    [['refresh_token']],
    [['implicit', 'refresh_token']],
    [['urn:ietf:params:oauth:grant-type:jwt-bearer']],
    [[]],
  ])('is false for %j', (grants) => {
    expect(grantsUseDefaultTarget(grants)).toBe(false);
  });
});

describe('the spellings of an issuer', () => {
  it.each([
    'https://ACME.EXAMPLE.COM',
    'HTTPS://acme.example.com:443',
    'https://acme.example.com/',
    'https://acme.example.com/userinfo/',
    'https://ACME.example.com:443/userinfo',
  ])('%s is reserved', (value) => {
    expect(dcrReservedTargetProblem('dcr.default_audience', value, [ISSUER])).not.toBeNull();
  });

  it('matches an internationalised host with its punycode form, in any case', () => {
    const issuer = 'https://xn--bcher-kva.example';
    for (const value of [
      'https://bücher.example',
      'https://BÜCHER.example/userinfo',
      'https://XN--BCHER-KVA.example/',
    ]) {
      expect(
        dcrReservedTargetProblem('dcr.default_resource', value, [issuer]),
        value
      ).not.toBeNull();
    }
    expect(
      dcrReservedTargetProblem('dcr.default_resource', 'https://bücher.example', [
        'https://acme.example',
      ])
    ).toBeNull();
  });

  it('matches percent-encodings whatever their case', () => {
    const issuer = 'https://acme.example.com/t%2fone';
    expect(
      dcrReservedTargetProblem(
        'dcr.default_resource',
        'https://acme.example.com/t%2Fone/userinfo',
        [issuer]
      )
    ).not.toBeNull();
    expect(
      dcrReservedTargetProblem('dcr.default_resource', 'https://acme.example.com/t%2Ftwo', [issuer])
    ).toBeNull();
  });
});

describe('resolveDcrDefaultTarget reads the document fresh', () => {
  it('sees a change or a clear of the same binding at once', async () => {
    const documents: Record<string, string> = {
      'settings:tenant:acme:dcr': JSON.stringify({ 'dcr.default_audience': 'urn:first' }),
    };
    const env = { SETTINGS: kv(documents) };
    const read = () => resolveDcrDefaultTarget(env as never, 'acme', [ISSUER]);

    await expect(read()).resolves.toMatchObject({ audience: 'urn:first' });
    documents['settings:tenant:acme:dcr'] = JSON.stringify({
      'dcr.default_audience': 'urn:second',
    });
    await expect(read()).resolves.toMatchObject({ audience: 'urn:second' });
    delete documents['settings:tenant:acme:dcr'];
    await expect(read()).resolves.toEqual({ ignored: [] });
  });
});
