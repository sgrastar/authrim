/**
 * extractUserInfo: the Field Mapping Set resolution request, the source values built from an
 * assertion, and how mapped values land on the user (profile, name, email, custom claims).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env, SAMLAssertion, SAMLIdPConfig } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  binding: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
  execute: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ status: 'ok', values: [] })),
  evaluateInbound: vi.fn(
    async (..._args: unknown[]): Promise<unknown> => ({
      profile: {},
      customClaims: {},
    })
  ),
  customEntries: vi.fn(async (..._args: unknown[]): Promise<unknown[]> => []),
  adminAdapter: { marker: 'admin' },
  coreAdapter: { marker: 'core' },
  requireAdmin: vi.fn((..._args: unknown[]): unknown => ({ marker: 'admin' })),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    requireAdminDatabaseAdapter: mocks.requireAdmin,
    resolveRuntimeIdentityMappingBinding: mocks.binding,
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(async () => mocks.coreAdapter),
    getLogger: () => ({
      module: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    }),
  };
});
vi.mock('@authrim/ar-lib-core/services/mapping-hash', () => ({
  executeTenantMapping: mocks.execute,
}));
vi.mock('@authrim/ar-lib-core/services/inbound-identity-mapping', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@authrim/ar-lib-core/services/inbound-identity-mapping')>();
  return { ...actual, evaluateInboundMapping: mocks.evaluateInbound };
});
vi.mock(
  '@authrim/ar-lib-core/services/identity-mapping-runtime-resolver',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@authrim/ar-lib-core/services/identity-mapping-runtime-resolver')
      >();
    return { ...actual, loadCustomClaimSchemaCatalogEntries: mocks.customEntries };
  }
);

import { extractUserInfo } from '../acs';

const env = {} as Env;

function assertion(overrides: Partial<SAMLAssertion> = {}): SAMLAssertion {
  return {
    id: '_a',
    issueInstant: '2026-01-01T00:00:00Z',
    issuer: 'https://idp.example.com',
    subject: {
      nameId: 'user@example.com',
      nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    },
    attributeStatement: [
      {
        name: 'urn:oid:0.9.2342.19200300.100.1.3',
        friendlyName: 'mail',
        nameFormat: 'urn:oasis:names:tc:SAML:2.0:attrname-format:uri',
        values: ['user@example.com', 'second@example.com'],
      },
      { name: 'plain', values: ['x'] },
    ],
    ...overrides,
  } as unknown as SAMLAssertion;
}

function idp(overrides: Record<string, unknown> = {}): SAMLIdPConfig {
  return {
    entityId: 'https://idp.example.com',
    identityMapping: { fieldMappingSetId: 'set-1', fieldMappingVersionId: 'version-1' },
    ...overrides,
  } as unknown as SAMLIdPConfig;
}

const BINDING = {
  catalog: { identity: { id: 'catalog' }, entries: [] },
  graphRules: [{ id: 'rule' }],
  edges: [{ id: 'edge' }],
  transforms: [{ id: 'step' }],
  validationRules: [{ id: 'validation' }],
  fieldMappingSet: { id: 'set' },
};

const mapped = (namespace: string, path: string, value: unknown) => ({
  value,
  sourceRef: { side: 'source', namespace, path },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.binding.mockResolvedValue(BINDING);
  mocks.execute.mockResolvedValue({ status: 'ok', values: [] });
});

describe('mapping set resolution', () => {
  it('requires a configured Field Mapping Set', async () => {
    await expect(
      extractUserInfo(env, 'tenant-a', 'https://sp', assertion(), idp({ identityMapping: {} }))
    ).rejects.toThrow('SAML IdP Field Mapping Set is required');
    await expect(
      extractUserInfo(
        env,
        'tenant-a',
        'https://sp',
        assertion(),
        idp({ identityMapping: undefined })
      )
    ).rejects.toThrow('SAML IdP Field Mapping Set is required');
    expect(mocks.binding).not.toHaveBeenCalled();
  });

  it('resolves the binding for the IdP partner with the exact request', async () => {
    await extractUserInfo(env, 'tenant-a', 'https://sp', assertion(), idp());

    expect(mocks.requireAdmin).toHaveBeenCalledWith(env, 'saml-sp-identity-mapping');
    expect(mocks.binding).toHaveBeenCalledWith(
      { marker: 'admin' },
      {
        tenantId: 'tenant-a',
        protocol: 'saml',
        role: 'sp',
        fieldMappingSetId: 'set-1',
        fieldMappingVersionId: 'version-1',
        localEntityId: 'https://sp',
        partnerEntityId: 'https://idp.example.com',
      }
    );
  });

  it('refuses a set that is not active', async () => {
    mocks.binding.mockResolvedValue(null);

    await expect(
      extractUserInfo(env, 'tenant-a', 'https://sp', assertion(), idp())
    ).rejects.toThrow('SAML IdP Field Mapping Set is not active');
  });

  it('reports the failure codes of a mapping that failed', async () => {
    mocks.execute.mockResolvedValue({
      status: 'failed',
      reasons: [{ code: 'required_missing' }, { code: 'invalid_value' }],
    });

    await expect(
      extractUserInfo(env, 'tenant-a', 'https://sp', assertion(), idp())
    ).rejects.toThrow('SAML IdP Field Mapping Set failed: required_missing, invalid_value');
  });
});

describe('source values and the mapping run', () => {
  it('maps the subject and every attribute by name and friendly name', async () => {
    await extractUserInfo(env, 'tenant-a', 'https://sp', assertion(), idp());

    const input = mocks.execute.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(mocks.execute.mock.calls[0]?.[1]).toBe('tenant-a');
    expect(input).toMatchObject({
      catalog: BINDING.catalog,
      graphRules: BINDING.graphRules,
      edges: BINDING.edges,
      transforms: BINDING.transforms,
      validationRules: BINDING.validationRules,
      fieldMappingSet: BINDING.fieldMappingSet,
      runtimeContext: {
        tenantId: 'tenant-a',
        localEntityId: 'https://sp',
        partnerEntityId: 'https://idp.example.com',
        protocol: 'saml',
        role: 'sp',
      },
    });
    const sources = input.sourceValues as Array<{
      value: unknown;
      sourceRef: { namespace: string; path: string };
      metadata: Record<string, unknown>;
    }>;
    expect(sources.map((s) => [s.sourceRef.namespace, s.sourceRef.path])).toEqual([
      ['saml.subject', 'nameId'],
      ['saml.subject', 'nameIdFormat'],
      ['saml.attribute', 'urn:oid:0.9.2342.19200300.100.1.3'],
      ['saml.attribute', 'mail'],
      ['saml.attribute', 'plain'],
    ]);
    expect(sources[0]).toMatchObject({
      value: 'user@example.com',
      sourceRef: { side: 'source' },
      metadata: { sourceType: 'saml' },
    });
    expect(sources[1]?.value).toBe('urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress');
    expect(sources[2]?.metadata).toEqual({
      sourceType: 'saml',
      samlAttributeName: 'urn:oid:0.9.2342.19200300.100.1.3',
      samlNameFormat: 'urn:oasis:names:tc:SAML:2.0:attrname-format:uri',
    });
    expect(sources[3]?.metadata).toEqual(sources[2]?.metadata);
    expect(sources[3]?.value).toBe(sources[2]?.value);
  });

  it('works for an assertion without attributes', async () => {
    const info = await extractUserInfo(
      env,
      'tenant-a',
      'https://sp',
      assertion({ attributeStatement: undefined }),
      idp()
    );

    expect(info.attributes).toEqual({});
    const sources = (mocks.execute.mock.calls[0]?.[2] as { sourceValues: unknown[] }).sourceValues;
    expect(sources).toHaveLength(2);
  });

  it('keeps the raw attributes under both their name and friendly name', async () => {
    const info = await extractUserInfo(env, 'tenant-a', 'https://sp', assertion(), idp());

    expect(info.attributes).toEqual({
      'urn:oid:0.9.2342.19200300.100.1.3': ['user@example.com', 'second@example.com'],
      mail: ['user@example.com', 'second@example.com'],
      plain: ['x'],
    });
    expect(info.nameId).toBe('user@example.com');
    expect(info.nameIdFormat).toBe('urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress');
  });

  it('hands the validation step the first scalar of each value, last writer winning', async () => {
    await extractUserInfo(env, 'tenant-a', 'https://sp', assertion(), idp());

    const resolve = (
      mocks.execute.mock.calls[0]?.[2] as {
        resolveValidationValues: (values: unknown[]) => unknown;
      }
    ).resolveValidationValues;
    const out = resolve([
      mapped('saml.attribute', 'a', ['first', 'second']),
      mapped('saml.attribute', 'b', 5),
      mapped('saml.attribute', 'c', true),
      mapped('saml.attribute', 'd', { nested: 1 }),
      mapped('saml.attribute', 'e', null),
      mapped('saml.attribute', 'f', undefined),
      mapped('saml.attribute', 'a', 'override'),
    ]) as Array<{ value: unknown; sourceRef: { path: string } }>;

    expect(out.map((v) => [v.sourceRef.path, v.value])).toEqual([
      ['a', 'override'],
      ['b', '5'],
      ['c', 'true'],
    ]);
  });
});

describe('mapped values', () => {
  async function userFrom(values: unknown[]) {
    mocks.execute.mockResolvedValue({ status: 'ok', values });
    return extractUserInfo(env, 'tenant-a', 'https://sp', assertion(), idp());
  }

  it('sets email and name, and mirrors display_name into the custom claims', async () => {
    const info = await userFrom([
      mapped('authrim.profile', 'email', ['mapped@example.com']),
      mapped('authrim.profile', 'name', 'Full Name'),
    ]);

    expect(info.email).toBe('mapped@example.com');
    expect(info.name).toBe('Full Name');
    expect(info.profile).toEqual({ name: 'Full Name' });
    expect(info.customClaims).toEqual({});

    const display = await userFrom([mapped('authrim.custom_claims', 'display_name', 'Shown')]);
    expect(display.name).toBe('Shown');
    expect(display.customClaims).toEqual({ display_name: 'Shown' });
  });

  it('records standard profile claims under their claim names', async () => {
    const info = await userFrom([
      mapped('authrim.profile', 'given_name', 'Given'),
      mapped('authrim.profile', 'family_name', 'Family'),
      mapped('authrim.profile', 'picture_url', 'https://pic'),
      mapped('authrim.profile', 'locale', 'ja'),
      mapped('authrim.profile', 'preferred_username', 'pref'),
      mapped('authrim.profile', 'email_verified', true),
      mapped('authrim.profile', 'nickname', 'nick'),
    ]);

    expect(info.profile).toEqual({
      given_name: 'Given',
      family_name: 'Family',
      picture: 'https://pic',
      locale: 'ja',
      nickname: 'nick',
    });
    expect(info.customClaims).toEqual({
      given_name: 'Given',
      family_name: 'Family',
      picture_url: 'https://pic',
      locale: 'ja',
      preferred_username: 'pref',
      email_verified: 'true',
    });
  });

  it('does not treat a profile path of another namespace as a profile claim', async () => {
    const info = await userFrom([mapped('other.ns', 'given_name', 'Given')]);

    expect(info.profile).toEqual({});
    expect(info.customClaims).toEqual({});
  });

  it('ignores prototype-like profile paths', async () => {
    const info = await userFrom([
      mapped('authrim.profile', 'constructor', 'x'),
      mapped('authrim.profile', 'toString', 'x'),
    ]);

    expect(info.profile).toEqual({});
  });

  it.each(['authrim.custom_claims', 'custom_claims', 'authrim.custom_fields', 'custom_fields'])(
    'stores values of namespace %s as custom claims',
    async (namespace) => {
      const info = await userFrom([mapped(namespace, 'dept', 'physics')]);

      expect(info.customClaims).toEqual({ dept: 'physics' });
    }
  );

  it('stores values whose path carries the custom claim prefix', async () => {
    const info = await userFrom([
      mapped('x', 'custom_claims.group', 'g1'),
      mapped('x', 'custom_fields.team.lead', 't1'),
      mapped('x', 'custom_claimsish', 'no'),
    ]);

    expect(info.customClaims).toEqual({ group: 'g1', 'team.lead': 't1' });
  });

  it('skips values without a usable scalar', async () => {
    const info = await userFrom([
      mapped('authrim.profile', 'email', null),
      mapped('authrim.profile', 'name', []),
      mapped('authrim.profile', 'given_name', { a: 1 }),
      mapped('authrim.custom_claims', 'k', undefined),
      mapped('authrim.custom_claims', 'n', 0),
    ]);

    expect(info.email).toBeUndefined();
    expect(info.name).toBeUndefined();
    expect(info.customClaims).toEqual({ n: '0' });
  });
});

describe('connection-v1 incoming mapping', () => {
  const v1Binding = { ...BINDING, activationScope: { inboundContract: 'connection-v1' } };

  it('evaluates the inbound mapping and takes its profile and custom claims', async () => {
    mocks.binding.mockResolvedValue(v1Binding);
    mocks.evaluateInbound.mockResolvedValue({
      profile: { email: 'v1@example.com', name: 'V One' },
      customClaims: { k: 'v' },
    });

    const info = await extractUserInfo(env, 'tenant-a', 'https://sp', assertion(), idp());

    expect(info).toMatchObject({
      email: 'v1@example.com',
      name: 'V One',
      profile: { email: 'v1@example.com', name: 'V One' },
      customClaims: { k: 'v' },
    });
    expect(mocks.execute).not.toHaveBeenCalled();
    const request = mocks.evaluateInbound.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(request).toMatchObject({
      env,
      tenantId: 'tenant-a',
      protocol: 'saml',
      binding: v1Binding,
    });
    expect(mocks.customEntries).toHaveBeenCalledWith(mocks.coreAdapter, 'tenant-a');
  });

  it('refuses a configured contract the activation does not carry', async () => {
    await expect(
      extractUserInfo(
        env,
        'tenant-a',
        'https://sp',
        assertion(),
        idp({
          identityMapping: { fieldMappingSetId: 'set-1', inboundContract: 'connection-v1' },
        })
      )
    ).rejects.toThrow('SAML IdP incoming mapping contract is invalid');
    expect(mocks.evaluateInbound).not.toHaveBeenCalled();
  });
});
