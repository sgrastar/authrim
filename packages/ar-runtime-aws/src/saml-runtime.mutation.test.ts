/* eslint-disable @typescript-eslint/no-non-null-assertion -- fakes and deliberately malformed inputs are intentionally untyped */
import { generateKeyPairSync, X509Certificate } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuthRuntimePorts } from '@authrim/ar-lib-core/types/auth-runtime-ports';
import type { SAMLRuntimeImportedSPRelease } from '@authrim/ar-lib-core/types/saml-runtime-ports';
import { generateSelfSignedCertificate } from '../../ar-saml/src/common/key-utils';
import {
  createSAMLRuntimePorts,
  createSAMLTransientStateKV,
  type CreateSAMLRuntimePortsInput,
} from './saml-runtime';
import type { TransientStateStore } from './storage/state-ports';

async function material(modulusLength = 2048) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicJWK = publicKey.export({ format: 'jwk' });
  const certificate = await generateSelfSignedCertificate(publicJWK, privateKeyPem);
  return { privateKeyPem, publicJWK, certificate };
}
type Material = Awaited<ReturnType<typeof material>>;
let primary: Material;
let other: Material;
let large: Material;
beforeAll(async () => {
  primary = await material();
  other = await material();
  large = await material(3072);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const REF = 'tenant:alpha:saml:idp:signing';
const SP = 'https://sp.example.test/idp';
const key = (m: Material, over: Record<string, unknown> = {}) => ({
  keyRef: REF,
  kid: 'key-1',
  privateKeyPem: m.privateKeyPem,
  publicJWK: m.publicJWK,
  certificate: m.certificate,
  ...over,
});
const secret = (over: Record<string, unknown> = {}) => ({
  tenantId: 'alpha',
  secretRef: 'tenant:alpha:saml:pairwise-nameid',
  active: { kid: 'salt-1', value: 'imported', createdAt: 1234 },
  updatedAt: 1234,
  ...over,
});
const release = (
  over: Partial<SAMLRuntimeImportedSPRelease> = {}
): SAMLRuntimeImportedSPRelease => ({
  tenantId: 'alpha',
  entityId: SP,
  sourceSelector: null,
  sourceBindingRef: {
    activationId: 'a',
    fieldMappingSetId: 's',
    fieldMappingVersionId: 'v',
    mappingSnapshotHash: 'h',
    destinationProfileId: 'p',
    destinationProfileVersionId: 'pv',
  },
  binding: {},
  destinationProfile: {
    profileId: 'p',
    profileVersionId: 'pv',
    destinationType: 'saml',
    fields: [],
  },
  ...over,
});
function fakeState() {
  return {
    createSamlRequest: vi.fn(async () => true),
    readSamlRequest: vi.fn(async () => null),
    updateSamlRequest: vi.fn(async () => null),
    completeSamlRequest: vi.fn(async () => null),
    putKey: vi.fn(async () => undefined),
    getKey: vi.fn(async () => 'stored'),
    deleteKey: vi.fn(async () => true),
  };
}
const sessions = (
  session: unknown = {
    id: 'session-1',
    tenantId: 'alpha',
    userId: 'user-1',
    createdAt: 1234,
    data: { amr: ['passkey'] },
  }
) => {
  const getSessionRpc = vi.fn(async () => session);
  const forSession = vi.fn(() => ({ getSessionRpc }));
  return {
    getSessionRpc,
    forSession,
    port: { forSession } as unknown as AuthRuntimePorts['sessions'],
  };
};
function input(over: Partial<CreateSAMLRuntimePortsInput> = {}) {
  const auth = sessions();
  const state = fakeState();
  const value: CreateSAMLRuntimePortsInput = {
    state: state as unknown as TransientStateStore,
    authSessions: auth.port,
    signingBundles: [{ tenantId: 'alpha', keys: [key(primary)] }],
    secrets: [secret()],
    serviceProviders: [{ tenantId: 'alpha', entityIds: [SP] }],
    serviceProviderReleases: [release()],
    ...over,
  };
  return { value, auth, state };
}
const build = (over: Partial<CreateSAMLRuntimePortsInput> = {}) =>
  createSAMLRuntimePorts(input(over).value);
const fails = (over: Partial<CreateSAMLRuntimePortsInput>, message: string) =>
  expect(() => build(over)).toThrow(new Error(message));

describe('SAML runtime composition validation (mutation hardening)', () => {
  it('rejects malformed tenant ids and untenanted references with exact messages', () => {
    for (const tenantId of ['Alpha', '-alpha', 'alpha-', 'al_pha', 'al pha', '']) {
      fails(
        {
          signingBundles: [{ tenantId, keys: [key(primary, { keyRef: `tenant:${tenantId}:k` })] }],
        },
        'Invalid SAML runtime tenant ID'
      );
    }
    for (const keyRef of [
      'tenant:alpha:',
      'tenant:beta:k',
      'alpha',
      '',
      ' tenant:alpha:k',
      'Tenant:alpha:k',
    ])
      fails(
        { signingBundles: [{ tenantId: 'alpha', keys: [key(primary, { keyRef })] }] },
        'SAML runtime reference must be tenant-scoped'
      );
    expect(() =>
      build({
        signingBundles: [{ tenantId: 'alpha', keys: [key(primary, { keyRef: 'tenant:alpha:x' })] }],
      })
    ).not.toThrow();
    fails(
      { secrets: [secret({ secretRef: 'tenant:beta:s' })] },
      'SAML runtime reference must be tenant-scoped'
    );
    fails(
      { secrets: [secret({ secretRef: 'tenant:alpha:' })] },
      'SAML runtime reference must be tenant-scoped'
    );
  });

  it('requires complete bundles without duplicates', () => {
    fails({ signingBundles: [] }, 'SAML runtime signing bundle required');
    fails(
      { signingBundles: [{ tenantId: 'alpha', keys: [] }] },
      'SAML runtime signing bundle is incomplete or duplicated'
    );
    fails(
      {
        signingBundles: [
          { tenantId: 'alpha', keys: [key(primary)] },
          { tenantId: 'alpha', keys: [key(primary, { keyRef: 'tenant:alpha:other' })] },
        ],
      },
      'SAML runtime signing bundle is incomplete or duplicated'
    );
    fails(
      { signingBundles: [{ tenantId: 'alpha', keys: [key(primary), key(primary)] }] },
      'Duplicate SAML runtime signing key'
    );
    fails({ secrets: [secret(), secret()] }, 'Duplicate SAML runtime secret');
    fails({ secrets: [] }, 'SAML runtime pairwise NameID secret is unavailable');
    fails(
      { secrets: [secret({ secretRef: 'tenant:alpha:saml:other' })] },
      'SAML runtime pairwise NameID secret is unavailable'
    );
  });

  it('requires complete signing keys', () => {
    for (const patch of [{ kid: '' }, { privateKeyPem: '' }, { certificate: '' }])
      fails(
        { signingBundles: [{ tenantId: 'alpha', keys: [key(primary, patch)] }] },
        'SAML runtime signing key is incomplete'
      );
  });

  it('requires an RSA key of at least 2048 bits', () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    const weak = generateKeyPairSync('rsa', { modulusLength: 1024 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    for (const privateKeyPem of [ec, weak])
      fails(
        { signingBundles: [{ tenantId: 'alpha', keys: [key(primary, { privateKeyPem })] }] },
        'SAML runtime signing key must be RSA with at least 2048 bits'
      );
  });

  it('requires the private key, certificate and JWK to agree', () => {
    fails(
      {
        signingBundles: [
          { tenantId: 'alpha', keys: [key(primary, { certificate: other.certificate })] },
        ],
      },
      'SAML runtime private key and certificate do not match'
    );
    // a certificate for a key of a different size is a mismatch, not a comparison error
    fails(
      {
        signingBundles: [
          { tenantId: 'alpha', keys: [key(primary, { certificate: large.certificate })] },
        ],
      },
      'SAML runtime private key and certificate do not match'
    );
    fails(
      {
        signingBundles: [
          { tenantId: 'alpha', keys: [key(primary, { publicJWK: other.publicJWK })] },
        ],
      },
      'SAML runtime public JWK and certificate do not match'
    );
    fails(
      {
        signingBundles: [
          { tenantId: 'alpha', keys: [key(primary, { publicJWK: large.publicJWK })] },
        ],
      },
      'SAML runtime public JWK and certificate do not match'
    );
    // the JWK is optional
    expect(() =>
      build({
        signingBundles: [{ tenantId: 'alpha', keys: [key(primary, { publicJWK: undefined })] }],
      })
    ).not.toThrow();
  });

  it('checks the certificate thumbprint in any common spelling', () => {
    const fingerprint = new X509Certificate(primary.certificate).fingerprint256;
    for (const thumb of [
      fingerprint,
      fingerprint.replaceAll(':', '').toLowerCase(),
      fingerprint.replaceAll(':', '').toUpperCase(),
    ])
      expect(() =>
        build({
          signingBundles: [
            { tenantId: 'alpha', keys: [key(primary, { certificateSha256Thumbprint: thumb })] },
          ],
        })
      ).not.toThrow();
    fails(
      {
        signingBundles: [
          {
            tenantId: 'alpha',
            keys: [key(primary, { certificateSha256Thumbprint: '00'.repeat(32) })],
          },
        ],
      },
      'SAML runtime certificate thumbprint does not match'
    );
    // an empty thumbprint is treated as absent
    expect(() =>
      build({
        signingBundles: [
          { tenantId: 'alpha', keys: [key(primary, { certificateSha256Thumbprint: '' })] },
        ],
      })
    ).not.toThrow();
  });

  it('validates imported secrets and copies them defensively', async () => {
    const incomplete = [
      { active: { kid: '', value: 'v', createdAt: 1 } },
      { active: { kid: 'k', value: '', createdAt: 1 } },
      { active: { kid: 'k', value: 'v', createdAt: 0 } },
      { active: { kid: 'k', value: 'v', createdAt: -1 } },
      { active: { kid: 'k', value: 'v', createdAt: 1.5 } },
      { active: { kid: 'k', value: 'v', createdAt: Number.MAX_SAFE_INTEGER + 1 } },
      { previous: { kid: '', value: 'v', createdAt: 1 } },
      { previous: { kid: 'k', value: '', createdAt: 1 } },
      { previous: { kid: 'k', value: 'v', createdAt: 0 } },
    ];
    for (const patch of incomplete)
      fails({ secrets: [secret(patch)] }, 'SAML runtime secret is incomplete');
    for (const updatedAt of [0, -1, 1.5, Number.NaN])
      fails({ secrets: [secret({ updatedAt })] }, 'SAML runtime secret update time is invalid');
    const withPrevious: ReturnType<typeof secret> & {
      previous?: { kid: string; value: string; createdAt: number };
    } = secret({ previous: { kid: 'salt-0', value: 'old', createdAt: 1000 } });
    const ports = build({ secrets: [withPrevious] });
    withPrevious.active.value = 'mutated';
    withPrevious.previous!.value = 'mutated';
    expect(
      await ports.signing.getSecret({
        tenantId: 'alpha',
        secretRef: 'tenant:alpha:saml:pairwise-nameid',
      })
    ).toEqual({
      secretRef: 'tenant:alpha:saml:pairwise-nameid',
      active: { kid: 'salt-1', value: 'imported', createdAt: 1234 },
      previous: { kid: 'salt-0', value: 'old', createdAt: 1000 },
      updatedAt: 1234,
    });
    const single = build();
    const returned = await single.signing.getSecret({
      tenantId: 'alpha',
      secretRef: 'tenant:alpha:saml:pairwise-nameid',
    });
    expect(returned).toEqual({
      secretRef: 'tenant:alpha:saml:pairwise-nameid',
      active: { kid: 'salt-1', value: 'imported', createdAt: 1234 },
      updatedAt: 1234,
    });
    expect('previous' in returned).toBe(false);
    returned.active.value = 'changed by caller';
    expect(
      (
        await single.signing.getSecret({
          tenantId: 'alpha',
          secretRef: 'tenant:alpha:saml:pairwise-nameid',
        })
      ).active.value
    ).toBe('imported');
    await expect(
      single.signing.getSecret({ tenantId: 'alpha', secretRef: 'tenant:alpha:saml:missing' })
    ).rejects.toThrow(new Error('SAML runtime secret is unavailable'));
    await expect(
      single.signing.getSecret({ tenantId: 'beta', secretRef: 'tenant:alpha:saml:pairwise-nameid' })
    ).rejects.toThrow(new Error('SAML runtime reference must be tenant-scoped'));
  });

  it('validates the service provider inventory and releases', () => {
    const invalidInventory = 'SAML runtime service provider inventory is invalid';
    fails({ serviceProviders: [{ tenantId: 'unknown', entityIds: [SP] }] }, invalidInventory);
    fails({ serviceProviders: [{ tenantId: 'alpha', entityIds: [] }] }, invalidInventory);
    fails(
      {
        serviceProviders: [
          { tenantId: 'alpha', entityIds: [SP] },
          { tenantId: 'alpha', entityIds: [SP] },
        ],
      },
      invalidInventory
    );
    fails({ serviceProviders: [] }, 'SAML runtime service provider inventory is incomplete');
    const invalidEntity = 'SAML runtime service provider entity ID is invalid';
    for (const entityId of [
      '',
      '   ',
      '\t',
      'a'.repeat(2049),
      'has\u0000nul',
      'has\nnewline',
      'has\u001funit',
      'has\u007fdel',
    ])
      fails({ serviceProviders: [{ tenantId: 'alpha', entityIds: [entityId] }] }, invalidEntity);
    fails({ serviceProviders: [{ tenantId: 'alpha', entityIds: [SP, SP] }] }, invalidEntity);
    for (const entityId of [
      'a'.repeat(2048),
      'has space',
      'has~tilde',
      'has\u0080high',
      ' padded ',
    ]) {
      expect(
        () =>
          build({
            serviceProviders: [{ tenantId: 'alpha', entityIds: [entityId] }],
            serviceProviderReleases: [release({ entityId })],
          }),
        entityId.slice(0, 20)
      ).not.toThrow();
    }
    const invalidRelease = 'SAML runtime imported release inventory is invalid';
    fails({ serviceProviderReleases: [release(), release()] }, invalidRelease);
    fails(
      { serviceProviderReleases: [release({ entityId: 'https://other.example.test' })] },
      invalidRelease
    );
    fails({ serviceProviderReleases: [release({ tenantId: 'beta' })] }, invalidRelease);
    fails({ serviceProviderReleases: [] }, 'SAML runtime imported release inventory is incomplete');
    fails(
      {
        serviceProviders: [{ tenantId: 'alpha', entityIds: [SP, 'https://second.example.test'] }],
        serviceProviderReleases: [release()],
      },
      'SAML runtime imported release inventory is incomplete'
    );
  });
});

describe('SAML runtime ports behaviour (mutation hardening)', () => {
  it('answers service provider questions precisely', () => {
    const { serviceProviders } = build();
    expect(serviceProviders.isAllowed({ tenantId: 'alpha', entityId: SP })).toBe(true);
    expect(serviceProviders.isAllowed({ tenantId: 'alpha', entityId: `${SP}/` })).toBe(false);
    expect(serviceProviders.isAllowed({ tenantId: 'beta', entityId: SP })).toBe(false);
    expect(serviceProviders.getRelease({ tenantId: 'alpha', entityId: SP })).toEqual(release());
    expect(serviceProviders.getRelease({ tenantId: 'alpha', entityId: 'x' })).toBeNull();
    expect(serviceProviders.getRelease({ tenantId: 'beta', entityId: SP })).toBeNull();
  });

  it('delegates protocol request state without alteration', async () => {
    const { value, state } = input();
    const ports = createSAMLRuntimePorts(value);
    const request = { tenantId: 'alpha', requestId: 'r' } as never;
    await expect(ports.requests.create(request)).resolves.toBe(true);
    await ports.requests.read(request);
    await ports.requests.update(request);
    await ports.requests.complete(request);
    expect(state.createSamlRequest).toHaveBeenCalledWith(request);
    expect(state.readSamlRequest).toHaveBeenCalledWith(request);
    expect(state.updateSamlRequest).toHaveBeenCalledWith(request);
    expect(state.completeSamlRequest).toHaveBeenCalledWith(request);
  });

  it('reads sessions through the auth runtime and verifies their binding', async () => {
    const request = { tenantId: 'alpha', sessionId: 'session-1' } as never;
    const ok = sessions();
    const ports = build({ authSessions: ok.port });
    expect(await ports.sessions.get(request)).toEqual({
      userId: 'user-1',
      createdAt: 1234,
      data: { amr: ['passkey'] },
    });
    expect(ok.forSession).toHaveBeenCalledWith(request);
    expect(ok.getSessionRpc).toHaveBeenCalledWith('session-1');
    expect(await build({ authSessions: sessions(null).port }).sessions.get(request)).toBeNull();
    const base = { id: 'session-1', tenantId: 'alpha', userId: 'user-1', createdAt: 1, data: {} };
    for (const patch of [
      { id: 'other' },
      { tenantId: 'beta' },
      { userId: '' },
      { userId: undefined },
    ])
      await expect(
        build({ authSessions: sessions({ ...base, ...patch }).port }).sessions.get(request)
      ).rejects.toThrow(new Error('SAML runtime session binding invalid'));
  });

  it('serves signing keys for the default or an explicit reference, within certificate validity', async () => {
    const certificate = new X509Certificate(primary.certificate);
    const notBefore = Date.parse(certificate.validFrom);
    const notAfter = Date.parse(certificate.validTo);
    const ports = build({
      signingBundles: [
        {
          tenantId: 'alpha',
          keys: [key(primary), key(other, { keyRef: 'tenant:alpha:saml:idp:next', kid: 'key-2' })],
        },
      ],
    });
    const spy = vi.spyOn(Date, 'now');
    try {
      spy.mockReturnValue(notBefore);
      expect(await ports.signing.getKey({ tenantId: 'alpha' })).toEqual({
        kid: 'key-1',
        privateKeyPem: primary.privateKeyPem,
        publicKeyPem: certificate.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        certificate: primary.certificate,
      });
      spy.mockReturnValue(notAfter);
      expect((await ports.signing.getKey({ tenantId: 'alpha', keyRef: REF })).kid).toBe('key-1');
      expect(
        (await ports.signing.getKey({ tenantId: 'alpha', keyRef: 'tenant:alpha:saml:idp:next' }))
          .kid
      ).toBe('key-2');
      for (const now of [notBefore - 1, notAfter + 1]) {
        spy.mockReturnValue(now);
        await expect(ports.signing.getKey({ tenantId: 'alpha' })).rejects.toThrow(
          new Error('SAML runtime signing certificate is not currently valid')
        );
      }
    } finally {
      spy.mockRestore();
    }
    await expect(
      ports.signing.getKey({ tenantId: 'alpha', keyRef: 'tenant:alpha:saml:idp:missing' })
    ).rejects.toThrow(new Error('SAML runtime signing key is unavailable'));
    await expect(ports.signing.getKey({ tenantId: 'beta' })).rejects.toThrow(
      new Error('SAML runtime signing key is unavailable')
    );
    await expect(
      ports.signing.getKey({ tenantId: 'alpha', keyRef: 'tenant:beta:k' })
    ).rejects.toThrow(new Error('SAML runtime reference must be tenant-scoped'));
  });
});

describe('SAML transient state KV adapter (mutation hardening)', () => {
  const state = () => fakeState();
  const kvFor = (s: ReturnType<typeof fakeState>) =>
    createSAMLTransientStateKV(s as unknown as TransientStateStore);
  const KEY = 'saml:session:tenant:alpha:abc';

  it('derives the tenant from the key and forwards operations', async () => {
    const s = state();
    const kv = kvFor(s);
    expect(await kv.get(KEY)).toBe('stored');
    expect(s.getKey).toHaveBeenCalledWith({ tenantId: 'alpha', key: KEY });
    await kv.put(KEY, 'value', { expirationTtl: 30 });
    expect(s.putKey).toHaveBeenCalledWith({
      tenantId: 'alpha',
      key: KEY,
      value: 'value',
      ttlMs: 30_000,
    });
    await kv.delete(KEY);
    expect(s.deleteKey).toHaveBeenCalledWith({ tenantId: 'alpha', key: KEY });
    await kv.get('saml:name-id:tenant:a1-b2:x');
    expect(s.getKey).toHaveBeenLastCalledWith({
      tenantId: 'a1-b2',
      key: 'saml:name-id:tenant:a1-b2:x',
    });
  });

  it('rejects keys that are not tenant-scoped', async () => {
    const kv = kvFor(state());
    for (const key of [
      'foo',
      'saml:session:tenant:alpha',
      'xsaml:session:tenant:alpha:abc',
      'saml:Session:tenant:alpha:abc',
      'saml::tenant:alpha:abc',
      'saml:session:tenant:Alpha:abc',
      'saml:session:tenant::abc',
      'saml:session:tenant:alpha',
    ]) {
      await expect(kv.get(key), key).rejects.toThrow(
        new Error('SAML transient key must be tenant-scoped')
      );
      await expect(kv.delete(key), key).rejects.toThrow(
        new Error('SAML transient key must be tenant-scoped')
      );
      await expect(kv.put(key, 'v', { expirationTtl: 5 }), key).rejects.toThrow(
        new Error('SAML transient key must be tenant-scoped')
      );
    }
    await expect(kv.get('saml:session:tenant:-a:abc')).rejects.toThrow(
      new Error('Invalid SAML runtime tenant ID')
    );
    await expect(kv.get('saml:session:tenant:a-:abc')).rejects.toThrow(
      new Error('Invalid SAML runtime tenant ID')
    );
  });

  it('requires an explicit positive integer TTL for writes', async () => {
    const s = state();
    const kv = kvFor(s);
    for (const options of [
      undefined,
      {},
      { expirationTtl: 0 },
      { expirationTtl: -1 },
      { expirationTtl: 1.5 },
      { expirationTtl: Number.NaN },
      { expirationTtl: Infinity },
    ])
      await expect(kv.put(KEY, 'v', options as never), JSON.stringify(options)).rejects.toThrow(
        new Error('SAML transient state requires a positive expirationTtl')
      );
    expect(s.putKey).not.toHaveBeenCalled();
    await kv.put(KEY, 'v', { expirationTtl: 1 });
    expect(s.putKey).toHaveBeenCalledWith({ tenantId: 'alpha', key: KEY, value: 'v', ttlMs: 1000 });
  });
});
