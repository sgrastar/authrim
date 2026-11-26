/**
 * Runtime resolution of stored SAML provider configurations (getSPConfig, getIdPConfig,
 * getIdPConfigByEntityId, listSPConfigs, listIdPConfigs): which rows are honoured, which are
 * refused, and what is returned. An explicit provider is authoritative for its entityID.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import { createAdapter } from './helpers/provider-handler-harness';

vi.mock('../../mapping-set-owner', () => ({
  resolveSAMLMappingSetOwner: vi.fn(async (_adapter: unknown, tenantId: string) => tenantId),
}));

const mocks = vi.hoisted(() => ({
  core: null as ReturnType<typeof createAdapter> | null,
  dedicated: null as ReturnType<typeof createAdapter> | null,
  warn: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(async () => mocks.core),
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => mocks.dedicated),
    createLogger: () => ({
      module: () => ({ warn: mocks.warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    }),
    getLogger: () => ({
      module: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    }),
  };
});

import {
  getIdPConfig,
  getIdPConfigByEntityId,
  getSPConfig,
  listIdPConfigs,
  listSPConfigs,
} from '../providers';

const ENTITY = 'https://partner.example.test';
const env = {} as Env;

function spRow(config: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    config_json: JSON.stringify({ entityId: ENTITY, acsUrl: 'https://p/acs', ...config }),
    enabled: 1,
    name: 'Partner SP',
    ...extra,
  };
}

function idpRow(config: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    config_json: JSON.stringify({ entityId: ENTITY, ssoUrl: 'https://p/sso', ...config }),
    enabled: 1,
    ...extra,
  };
}

function core() {
  if (!mocks.core) throw new Error('core adapter not initialised');
  return mocks.core;
}

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.parse('2026-06-01T12:00:00Z'));
  vi.clearAllMocks();
  mocks.core = createAdapter();
  mocks.dedicated = createAdapter();
});

describe('getSPConfig', () => {
  it('queries the tenant SP rows and returns an enabled, approved match with safe defaults', async () => {
    core().query.mockResolvedValue([spRow({ displayName: 'Stored name' })]);

    const config = await getSPConfig(env, 'tenant-a', ENTITY);

    expect(core().query.mock.calls[0]?.[1]).toEqual(['tenant-a']);
    expect(config).toMatchObject({
      entityId: ENTITY,
      signAssertions: false,
      signResponses: true,
      displayName: 'Partner SP',
    });
    expect(config?.metadataRefreshPolicy).toBeDefined();
  });

  it('keeps explicit signing choices and omits a displayName when the row has no name', async () => {
    core().query.mockResolvedValue([
      spRow({ signAssertions: true, signResponses: false, displayName: 'Stored' }, { name: '' }),
    ]);

    const config = await getSPConfig(env, 'tenant-a', ENTITY);

    expect(config?.signAssertions).toBe(true);
    expect(config?.signResponses).toBe(false);
    expect(config).not.toHaveProperty('displayName');
  });

  it.each([
    ['a disabled row', spRow({}, { enabled: 0 })],
    ['a draft awaiting approval', spRow({ trustApproval: { state: 'draft' } })],
    ['another entityID', spRow({ entityId: 'https://other.example.test' })],
    ['a row without an entityID', spRow({ entityId: '' })],
  ])('does not resolve %s', async (_label, row) => {
    core().query.mockResolvedValue([row]);

    expect(await getSPConfig(env, 'tenant-a', ENTITY)).toBeNull();
  });

  it('accepts the enabled flag as a numeric string', async () => {
    core().query.mockResolvedValue([spRow({}, { enabled: '1' })]);

    expect(await getSPConfig(env, 'tenant-a', ENTITY)).not.toBeNull();
  });

  it('does not resolve an empty entityID', async () => {
    core().query.mockResolvedValue([spRow({ entityId: '' })]);

    expect(await getSPConfig(env, 'tenant-a', '')).toBeNull();
  });

  it('denies resolution when several approved rows claim the entityID', async () => {
    core().query.mockResolvedValue([spRow({}), spRow({ acsUrl: 'https://p/other' })]);

    expect(await getSPConfig(env, 'tenant-a', ENTITY)).toBeNull();
    expect(mocks.warn).toHaveBeenCalledWith('Ambiguous explicit SAML provider resolution denied', {
      tenantId: 'tenant-a',
      entityId: ENTITY,
      role: 'saml_sp',
      candidateCount: 2,
    });
  });

  it('ignores a draft duplicate when resolving ambiguity', async () => {
    core().query.mockResolvedValue([spRow({ trustApproval: { state: 'draft' } }), spRow({})]);

    expect(await getSPConfig(env, 'tenant-a', ENTITY)).not.toBeNull();
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it('consults the runtime port allow-list and never falls back to a federation under it', async () => {
    const isAllowed = vi.fn(() => false);
    const ported = { SAML_RUNTIME_PORTS: { serviceProviders: { isAllowed } } } as unknown as Env;

    expect(await getSPConfig(ported, 'tenant-a', ENTITY)).toBeNull();
    expect(isAllowed).toHaveBeenCalledWith({ tenantId: 'tenant-a', entityId: ENTITY });
    expect(core().query).not.toHaveBeenCalled();

    isAllowed.mockReturnValue(true);
    core().query.mockResolvedValue([]);
    expect(await getSPConfig(ported, 'tenant-a', ENTITY)).toBeNull();
    expect(mocks.dedicated?.query).not.toHaveBeenCalled();
    core().query.mockResolvedValue([spRow({})]);
    expect(await getSPConfig(ported, 'tenant-a', ENTITY)).not.toBeNull();
  });
});

describe('trust usability of an explicit provider', () => {
  const resolvers = [
    ['getSPConfig', async () => getSPConfig(env, 'tenant-a', ENTITY), spRow] as const,
    [
      'getIdPConfigByEntityId',
      async () => getIdPConfigByEntityId(env, 'tenant-a', ENTITY),
      idpRow,
    ] as const,
  ];

  describe.each(resolvers)('%s', (_name, resolve, row) => {
    it.each([
      ['an expired source state', { metadataRefreshPolicy: { sourceState: 'expired' } }],
      ['a metadata-sync suspension', { metadataRefreshPolicy: { suspendedByMetadataSync: true } }],
      [
        'a past critical-field validUntil',
        { metadataCriticalFields: { validUntil: '2020-01-01T00:00:00Z' } },
      ],
      [
        'a past refresh-status validUntil',
        { metadataRefreshStatus: { current: { validUntil: '2020-01-01T00:00:00Z' } } },
      ],
      [
        'a past accepted validUntil',
        { metadataRefreshPolicy: { acceptedValidUntil: '2020-01-01T00:00:00Z' } },
      ],
      ['an unparsable validUntil', { metadataCriticalFields: { validUntil: 'soon' } }],
      [
        'one past value among several future ones',
        {
          metadataCriticalFields: { validUntil: '2099-01-01T00:00:00Z' },
          metadataRefreshPolicy: { acceptedValidUntil: '2020-01-01T00:00:00Z' },
        },
      ],
      [
        'stored metadata XML that has expired',
        {
          metadataXml:
            '<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="x" validUntil="2020-01-01T00:00:00Z"/>',
        },
      ],
      ['stored metadata XML that cannot be analysed', { metadataXml: '<broken' }],
    ])('refuses %s', async (_label, config) => {
      core().query.mockResolvedValue([row(config)]);

      expect(await resolve()).toBeNull();
    });

    it.each([
      ['no validity information', {}],
      ['a future validUntil', { metadataCriticalFields: { validUntil: '2099-01-01T00:00:00Z' } }],
      [
        'stored metadata XML valid far into the future',
        {
          metadataXml:
            '<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="x" validUntil="2099-01-01T00:00:00Z"/>',
        },
      ],
      [
        'a healthy source state',
        { metadataRefreshPolicy: { sourceState: 'healthy', suspendedByMetadataSync: false } },
      ],
    ])('accepts %s', async (_label, config) => {
      core().query.mockResolvedValue([row(config)]);

      expect(await resolve()).not.toBeNull();
    });
  });
});

describe('federation-linked explicit providers', () => {
  const linked = (hash?: string) => ({
    aggregateImport: {
      aggregateEntityId: ENTITY,
      federationTrustProfileId: 'source-1',
      verification: { trustProfileId: 'source-1', trustContextSnapshotHash: hash },
      importedAt: 1,
    },
  });

  it('requires the verified snapshot hash to match the active source', async () => {
    core().query.mockResolvedValue([idpRow(linked('hash-1'))]);
    mocks.dedicated?.queryOne.mockResolvedValue({ id: 'source-1', snapshot_hash: 'hash-1' });

    expect(await getIdPConfigByEntityId(env, 'tenant-a', ENTITY)).not.toBeNull();
    expect(mocks.dedicated?.queryOne.mock.calls[0]?.[1]).toEqual(['tenant-a', 'source-1']);
  });

  it.each([
    ['a changed trust context', { id: 'source-1', snapshot_hash: 'hash-2' }],
    ['a source that is no longer active', null],
  ])('refuses %s', async (_label, source) => {
    core().query.mockResolvedValue([idpRow(linked('hash-1'))]);
    mocks.dedicated?.queryOne.mockResolvedValue(source);

    expect(await getIdPConfigByEntityId(env, 'tenant-a', ENTITY)).toBeNull();
  });

  it('refuses a link that never recorded a verified snapshot hash, without asking the database', async () => {
    core().query.mockResolvedValue([idpRow(linked(undefined))]);

    expect(await getIdPConfigByEntityId(env, 'tenant-a', ENTITY)).toBeNull();
    expect(mocks.dedicated?.queryOne).not.toHaveBeenCalled();
  });

  it('fails closed when the source lookup throws', async () => {
    core().query.mockResolvedValue([idpRow(linked('hash-1'))]);
    mocks.dedicated?.queryOne.mockRejectedValue(new Error('db down'));

    expect(await getIdPConfigByEntityId(env, 'tenant-a', ENTITY)).toBeNull();
  });

  it('applies the same check to an SP', async () => {
    core().query.mockResolvedValue([spRow(linked('hash-1'))]);
    mocks.dedicated?.queryOne.mockResolvedValue({ id: 'source-1', snapshot_hash: 'other' });

    expect(await getSPConfig(env, 'tenant-a', ENTITY)).toBeNull();
  });
});

describe('getIdPConfigByEntityId', () => {
  it('returns the stored configuration unchanged for a unique enabled approved match', async () => {
    core().query.mockResolvedValue([idpRow({ certificate: 'CERT' })]);

    const config = await getIdPConfigByEntityId(env, 'tenant-a', ENTITY);

    expect(config).toEqual({ entityId: ENTITY, ssoUrl: 'https://p/sso', certificate: 'CERT' });
    expect(core().query.mock.calls[0]?.[1]).toEqual(['tenant-a']);
  });

  it.each([
    ['a disabled row', idpRow({}, { enabled: 0 })],
    ['a row whose enabled flag is not numeric 1', idpRow({}, { enabled: '1' })],
    ['a draft awaiting approval', idpRow({ trustApproval: { state: 'draft' } })],
    ['another entityID', idpRow({ entityId: 'https://other.example.test' })],
  ])('does not resolve %s, and does not fall back to a federation', async (_label, row) => {
    core().query.mockResolvedValue([row]);

    expect(await getIdPConfigByEntityId(env, 'tenant-a', ENTITY)).toBeNull();
  });

  it('denies resolution when several approved rows claim the entityID', async () => {
    core().query.mockResolvedValue([idpRow({}), idpRow({ ssoUrl: 'https://p/other' })]);

    expect(await getIdPConfigByEntityId(env, 'tenant-a', ENTITY)).toBeNull();
    expect(mocks.warn).toHaveBeenCalledWith(
      'Ambiguous explicit SAML provider resolution denied',
      expect.objectContaining({ role: 'saml_idp', candidateCount: 2 })
    );
  });

  it('does not resolve an empty entityID', async () => {
    core().query.mockResolvedValue([idpRow({ entityId: '' })]);

    expect(await getIdPConfigByEntityId(env, 'tenant-a', '')).toBeNull();
  });

  it('fails closed with a warning when the federation directory cannot be read', async () => {
    core().query.mockResolvedValue([]);
    mocks.dedicated?.query.mockRejectedValue(new Error('directory down'));

    expect(await getIdPConfigByEntityId(env, 'tenant-a', ENTITY)).toBeNull();
    expect(mocks.warn).toHaveBeenCalledWith(
      'Federation runtime directory lookup failed closed',
      { tenantId: 'tenant-a', entityId: ENTITY, role: 'saml_idp' },
      expect.any(Error)
    );
  });
});

describe('getIdPConfig', () => {
  it('looks the provider up by id within the tenant and enabled rows', async () => {
    core().queryOne.mockResolvedValue({ config_json: JSON.stringify({ entityId: ENTITY }) });

    expect(await getIdPConfig(env, 'tenant-a', 'provider-1')).toEqual({ entityId: ENTITY });
    expect(core().queryOne.mock.calls[0]?.[1]).toEqual(['provider-1', 'tenant-a']);
    expect(String(core().queryOne.mock.calls[0]?.[0])).toContain('enabled = 1');
  });

  it('returns null for an unknown provider and for one whose trust is no longer usable', async () => {
    expect(await getIdPConfig(env, 'tenant-a', 'missing')).toBeNull();

    core().queryOne.mockResolvedValue({
      config_json: JSON.stringify({
        entityId: ENTITY,
        metadataRefreshPolicy: { sourceState: 'expired' },
      }),
    });
    expect(await getIdPConfig(env, 'tenant-a', 'provider-1')).toBeNull();
  });

  it('returns null for a federation-linked provider whose source changed', async () => {
    core().queryOne.mockResolvedValue({
      config_json: JSON.stringify({
        entityId: ENTITY,
        aggregateImport: {
          verification: { trustProfileId: 's', trustContextSnapshotHash: 'old' },
        },
      }),
    });
    mocks.dedicated?.queryOne.mockResolvedValue({ id: 's', snapshot_hash: 'new' });

    expect(await getIdPConfig(env, 'tenant-a', 'provider-1')).toBeNull();
  });
});

describe('listSPConfigs / listIdPConfigs', () => {
  it('lists id, name and entityID of enabled providers whose trust is usable', async () => {
    core().query.mockResolvedValue([
      { id: 'a', name: 'A', config_json: JSON.stringify({ entityId: 'https://a' }) },
      {
        id: 'b',
        name: 'B',
        config_json: JSON.stringify({
          entityId: 'https://b',
          metadataRefreshPolicy: { suspendedByMetadataSync: true },
        }),
      },
      {
        id: 'c',
        name: 'C',
        config_json: JSON.stringify({
          entityId: 'https://c',
          metadataCriticalFields: { validUntil: '2020-01-01T00:00:00Z' },
        }),
      },
    ]);

    const expected = [{ id: 'a', name: 'A', entityId: 'https://a' }];
    expect(await listSPConfigs(env, 'tenant-a')).toEqual(expected);
    expect(await listIdPConfigs(env, 'tenant-a')).toEqual(expected);
    expect(String(core().query.mock.calls[0]?.[0])).toContain("provider_type = 'saml_sp'");
    expect(String(core().query.mock.calls[1]?.[0])).toContain("provider_type = 'saml_idp'");
    expect(core().query.mock.calls[0]?.[1]).toEqual(['tenant-a']);
  });
});
