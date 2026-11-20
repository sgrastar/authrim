import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  admin: null as ReturnType<typeof createAdapter> | null,
  core: null as ReturnType<typeof createAdapter> | null,
}));

vi.mock('../../mapping-set-owner', () => ({
  resolveSAMLMappingSetOwner: vi.fn(async (_adapter: unknown, tenantId: string) => tenantId),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => mocks.admin),
    requireAdminDatabaseAdapter: vi.fn(() => mocks.admin),
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.core })),
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(async () => mocks.core),
    getLogger: () => ({
      module: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    }),
  };
});

import {
  getFederationSourceForLogin,
  hasExternalDiscoverySource,
  resolveFederationIdPForLogin,
  searchFederationIdPs,
} from '../providers';
import { handleFederationIdPSearch } from '../../sp/federation-search';

function createAdapter() {
  return {
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn().mockResolvedValue(null),
    execute: vi.fn().mockResolvedValue({ rowsAffected: 1 }),
    transaction: vi.fn(),
    batch: vi.fn(),
    isHealthy: vi.fn().mockResolvedValue(true),
    getType: vi.fn(() => 'mock'),
    close: vi.fn(),
  };
}

const IDP_ENTITY = 'urn:imported:idp';

function idpMetadata() {
  return `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${IDP_ENTITY}">
    <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
      <md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>VEVTVA==</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
      <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example.test/sso" />
    </md:IDPSSODescriptor>
  </md:EntityDescriptor>`;
}

function payload(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    runtimeResolution: { mode: 'automatic', roles: ['saml_idp'], idpFieldMappingSetId: 'set-1' },
    ...overrides,
  });
}

function runtimeRow(overrides: Record<string, unknown> = {}) {
  return {
    trust_source_id: 'fed_1',
    trust_context_snapshot_hash: 'hash-1',
    metadata_document_id: 'doc-1',
    source_url: 'https://metadata.example.test/federation.xml',
    source_display_name: 'Research Federation',
    protocol_payload_json: payload(),
    metadata_xml: idpMetadata(),
    entity_categories_json: null,
    entity_category_support_json: null,
    registration_authority: 'https://federation.example.test',
    valid_until: '2099-01-01T00:00:00Z',
    validated_at: 1_700_000_000_000,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.admin = createAdapter();
  mocks.core = createAdapter();
});

describe('getFederationSourceForLogin', () => {
  it('returns an active, verified, automatic IdP-role source with its selection mode', async () => {
    mocks.admin!.queryOne.mockResolvedValueOnce({
      display_name: 'Research Federation',
      protocol_payload_json: payload({
        idpSelection: { mode: 'external_ds', discoveryServiceUrl: 'https://ds.example.org/WAYF' },
      }),
    });
    const source = await getFederationSourceForLogin({} as never, 'tenant-a', 'fed_1');
    expect(source).toMatchObject({
      id: 'fed_1',
      displayName: 'Research Federation',
      idpSelection: { mode: 'external_ds', discoveryServiceUrl: 'https://ds.example.org/WAYF' },
    });
    const [sql, params] = mocks.admin!.queryOne.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("lifecycle_state = 'active'");
    // A verified, runtime-snapshot document, as runtime resolution itself requires.
    expect(sql).toContain("d.validation_state = 'valid'");
    expect(sql).toContain("d.document_type = 'saml_aggregate_runtime_snapshot'");
    expect(sql).toContain('d.id = s.active_metadata_document_id');
    expect(params).toEqual(['tenant-a', 'fed_1']);
  });

  it.each([
    ['not found', null],
    [
      'inventory only',
      {
        display_name: 'X',
        protocol_payload_json: payload({
          runtimeResolution: { mode: 'inventory_only', roles: [] },
        }),
      },
    ],
    [
      'SP role only',
      {
        display_name: 'X',
        protocol_payload_json: payload({
          runtimeResolution: { mode: 'automatic', roles: ['saml_sp'], spFieldMappingSetId: 's' },
        }),
      },
    ],
    [
      'no mapping set for the IdP role',
      {
        display_name: 'X',
        protocol_payload_json: payload({
          runtimeResolution: { mode: 'automatic', roles: ['saml_idp'] },
        }),
      },
    ],
    [
      'an expired aggregate',
      {
        display_name: 'X',
        protocol_payload_json: payload({ polling: { acceptedValidUntil: '2001-01-01T00:00:00Z' } }),
      },
    ],
  ])('returns null for %s', async (_label, row) => {
    mocks.admin!.queryOne.mockResolvedValueOnce(row);
    expect(await getFederationSourceForLogin({} as never, 'tenant-a', 'fed_1')).toBeNull();
  });

  it('returns null, not an error, when the read fails', async () => {
    mocks.admin!.queryOne.mockRejectedValueOnce(new Error('database unavailable'));
    expect(await getFederationSourceForLogin({} as never, 'tenant-a', 'fed_1')).toBeNull();
  });
});

describe('hasExternalDiscoverySource', () => {
  it('is true only when a servable source sends users to a Discovery Service', async () => {
    mocks.admin!.query.mockResolvedValueOnce([
      { protocol_payload_json: payload() },
      {
        protocol_payload_json: payload({
          idpSelection: { mode: 'external_ds', discoveryServiceUrl: 'https://ds.example.org/WAYF' },
        }),
      },
    ]);
    expect(await hasExternalDiscoverySource({} as never, 'tenant-a')).toBe(true);
    mocks.admin!.query.mockResolvedValueOnce([{ protocol_payload_json: payload() }]);
    expect(await hasExternalDiscoverySource({} as never, 'tenant-a')).toBe(false);
    mocks.admin!.query.mockResolvedValueOnce([
      {
        // A Discovery Service on a source that cannot serve IdPs does not count.
        protocol_payload_json: payload({
          runtimeResolution: { mode: 'inventory_only', roles: [] },
          idpSelection: { mode: 'external_ds', discoveryServiceUrl: 'https://ds.example.org/WAYF' },
        }),
      },
    ]);
    expect(await hasExternalDiscoverySource({} as never, 'tenant-a')).toBe(false);
    mocks.admin!.query.mockRejectedValueOnce(new Error('down'));
    expect(await hasExternalDiscoverySource({} as never, 'tenant-a')).toBe(false);
  });
});

describe('resolveFederationIdPForLogin', () => {
  const resolve = () => resolveFederationIdPForLogin({} as never, 'tenant-a', 'fed_1', IDP_ENTITY);
  // The start resolves the entity in the chosen source, then asks the general resolution (the
  // one the ACS uses) which source it would pick: two reads of each database.
  const serve = (rows: Array<Record<string, unknown>>, general = rows) => {
    mocks.core!.query.mockResolvedValue([]);
    mocks.admin!.query.mockResolvedValueOnce(rows).mockResolvedValueOnce(general);
  };

  it('resolves an entity of this source from its verified snapshot', async () => {
    serve([runtimeRow()]);
    const resolved = await resolve();
    expect(resolved).toMatchObject({
      kind: 'federation',
      config: {
        entityId: IDP_ENTITY,
        identityMapping: { fieldMappingSetId: 'set-1' },
        aggregateImport: { federationTrustProfileId: 'fed_1' },
      },
    });
    // Narrowed to the named source, so another source's copy of the entity is never used.
    const [sql, params] = mocks.admin!.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('AND r.trust_source_id = ?');
    expect(params).toEqual(['tenant-a', IDP_ENTITY, 'saml_idp', 'fed_1']);
  });

  it('refuses an entity that another source would win, so the sign-in could not complete', async () => {
    // fed_2 has the higher priority: the general resolution (the ACS's) picks its copy.
    serve(
      [runtimeRow()],
      [
        runtimeRow({
          trust_source_id: 'fed_2',
          protocol_payload_json: payload({
            runtimeResolution: {
              mode: 'automatic',
              roles: ['saml_idp'],
              idpFieldMappingSetId: 'set-2',
              priority: 10,
            },
          }),
        }),
      ]
    );
    expect(await resolve()).toBeNull();
  });

  it('refuses an entity two sources hold at the same priority (resolution fails closed)', async () => {
    serve([runtimeRow()], [runtimeRow(), runtimeRow({ trust_source_id: 'fed_2' })]);
    expect(await resolve()).toBeNull();
  });

  it('hands an approved explicit provider with the same entityID over, before the federation', async () => {
    mocks.core!.query.mockResolvedValueOnce([
      { id: 'idp-9', config_json: JSON.stringify({ entityId: IDP_ENTITY }) },
    ]);
    expect(await resolve()).toEqual({ kind: 'explicit', providerId: 'idp-9' });
    expect(mocks.admin!.query).not.toHaveBeenCalled();
  });

  it('does not let an unapproved draft stand in for the federation', async () => {
    mocks.core!.query.mockResolvedValue([
      {
        id: 'idp-9',
        config_json: JSON.stringify({ entityId: IDP_ENTITY, trustApproval: { state: 'draft' } }),
      },
    ]);
    mocks.admin!.query.mockResolvedValueOnce([runtimeRow()]).mockResolvedValueOnce([runtimeRow()]);
    expect(await resolve()).toMatchObject({ kind: 'federation' });
  });

  it('refuses when two explicit providers claim the entityID', async () => {
    mocks.core!.query.mockResolvedValueOnce([
      { id: 'idp-1', config_json: JSON.stringify({ entityId: IDP_ENTITY }) },
      { id: 'idp-2', config_json: JSON.stringify({ entityId: IDP_ENTITY }) },
    ]);
    expect(await resolve()).toBeNull();
  });

  it.each([
    ['an entity on the exception list', { exceptions: { excludedEntityIds: [IDP_ENTITY] } }],
    [
      'an entity outside the registration authorities',
      {
        runtimeResolution: {
          mode: 'automatic',
          roles: ['saml_idp'],
          idpFieldMappingSetId: 'set-1',
          registrationAuthorities: ['https://other.example.test'],
        },
      },
    ],
  ])('refuses %s', async (_label, overrides) => {
    mocks.core!.query.mockResolvedValue([]);
    mocks.admin!.query.mockResolvedValue([
      runtimeRow({ protocol_payload_json: payload(overrides) }),
    ]);
    expect(await resolve()).toBeNull();
  });

  it('refuses an entity the source does not hold, an expired one, and a mismatching document', async () => {
    mocks.core!.query.mockResolvedValue([]);
    mocks.admin!.query.mockResolvedValueOnce([]);
    expect(await resolve()).toBeNull();
    mocks.admin!.query.mockResolvedValueOnce([runtimeRow({ valid_until: '2001-01-01T00:00:00Z' })]);
    expect(await resolve()).toBeNull();
    mocks.admin!.query.mockResolvedValueOnce([
      runtimeRow({ metadata_xml: idpMetadata().replace(IDP_ENTITY, 'urn:other:idp') }),
    ]);
    expect(await resolve()).toBeNull();
  });
});

describe('searchFederationIdPs', () => {
  const source = {
    id: 'fed_1',
    displayName: 'Research Federation',
    idpSelection: { mode: 'authrim_search' as const },
    policy: {
      mode: 'automatic' as const,
      roles: ['saml_idp' as const],
      idpFieldMappingSetId: 'set-1',
      excludedEntityIds: ['https://excluded.example.test/idp'],
      registrationAuthorities: ['https://federation.example.test'],
    },
  };
  const row = (entityId: string, displayName: string | null, summary: object) => ({
    entity_id: entityId,
    display_name: displayName,
    summary_json: JSON.stringify(summary),
  });

  it('returns policy-allowed IdPs by name, with an https logo only', async () => {
    mocks.admin!.query.mockResolvedValueOnce([
      row('https://a.example.test/idp', 'Alpha U', {
        registrationAuthority: 'https://federation.example.test',
        logoUrl: 'https://a.example.test/logo.png',
      }),
      row('https://excluded.example.test/idp', 'Excluded U', {
        registrationAuthority: 'https://federation.example.test',
      }),
      row('https://b.example.test/idp', 'Beta U', {
        registrationAuthority: 'https://elsewhere.example.test',
      }),
      row('https://c.example.test/idp', null, {
        registrationAuthority: 'https://federation.example.test',
        logoUrl: 'http://c.example.test/logo.png',
      }),
    ]);
    const result = await searchFederationIdPs({} as never, 'tenant-a', source, { limit: 20 });
    expect(result).toEqual({
      items: [
        {
          entityId: 'https://a.example.test/idp',
          displayName: 'Alpha U',
          logoUrl: 'https://a.example.test/logo.png',
        },
        {
          entityId: 'https://c.example.test/idp',
          displayName: 'https://c.example.test/idp',
          logoUrl: null,
        },
      ],
      truncated: false,
    });
    const [sql, params] = mocks.admin!.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("e.entity_role IN ('saml_idp', 'ambiguous')");
    expect(sql).toContain('s.active_metadata_document_id = e.metadata_document_id');
    expect(sql).toContain("d.validation_state = 'valid'");
    expect(params.slice(0, 2)).toEqual(['tenant-a', 'fed_1']);
  });

  it('escapes the search text and reads in bounded batches', async () => {
    await searchFederationIdPs({} as never, 'tenant-a', source, { q: '50%_off', limit: 50 });
    const [sql, params] = mocks.admin!.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("ESCAPE '\\'");
    expect(params[2]).toBe('%50\\%\\_off%');
    // A batch of 150 from offset 0; a short batch ends the inventory.
    expect(params.slice(-2)).toEqual([150, 0]);
    expect(mocks.admin!.query).toHaveBeenCalledTimes(1);
  });

  it('keeps reading past rows the policy refuses until the page is filled', async () => {
    // The first 150 rows are all refused (not in the registration authority); the allowed IdPs
    // are further on. A single window would answer an empty list.
    const refused = Array.from({ length: 150 }, (_, i) =>
      row(`https://refused-${i}.example.test/idp`, `Refused ${i}`, {
        registrationAuthority: 'https://elsewhere.example.test',
      })
    );
    const allowed = Array.from({ length: 3 }, (_, i) =>
      row(`https://ok-${i}.example.test/idp`, `Ok ${i}`, {
        registrationAuthority: 'https://federation.example.test',
      })
    );
    mocks.admin!.query.mockResolvedValueOnce(refused).mockResolvedValueOnce(allowed);
    const result = await searchFederationIdPs({} as never, 'tenant-a', source, { limit: 20 });
    expect(result?.items.map((item) => item.displayName)).toEqual(['Ok 0', 'Ok 1', 'Ok 2']);
    expect(result?.truncated).toBe(false);
    expect(mocks.admin!.query).toHaveBeenCalledTimes(2);
    expect((mocks.admin!.query.mock.calls[1] as [string, unknown[]])[1].slice(-2)).toEqual([
      150, 150,
    ]);
  });

  it('stops at the bound on the work and says the list is cut', async () => {
    const refused = Array.from({ length: 150 }, (_, i) =>
      row(`https://refused-${i}.example.test/idp`, `Refused ${i}`, {
        registrationAuthority: 'https://elsewhere.example.test',
      })
    );
    mocks.admin!.query.mockResolvedValue(refused);
    const result = await searchFederationIdPs({} as never, 'tenant-a', source, { limit: 20 });
    expect(result).toEqual({ items: [], truncated: true });
    // 1500 rows at most: ten batches.
    expect(mocks.admin!.query).toHaveBeenCalledTimes(10);
  });

  it('marks a result truncated when more than the limit are allowed', async () => {
    const rows = Array.from({ length: 3 }, (_, i) =>
      row(`https://${i}.example.test/idp`, `U${i}`, {
        registrationAuthority: 'https://federation.example.test',
      })
    );
    mocks.admin!.query.mockResolvedValueOnce(rows);
    const result = await searchFederationIdPs({} as never, 'tenant-a', source, { limit: 2 });
    expect(result?.items).toHaveLength(2);
    expect(result?.truncated).toBe(true);
  });

  it('returns null when the read fails', async () => {
    mocks.admin!.query.mockRejectedValueOnce(new Error('down'));
    expect(await searchFederationIdPs({} as never, 'tenant-a', source, { limit: 20 })).toBeNull();
  });
});

describe('handleFederationIdPSearch', () => {
  function context(sourceId: string | undefined, query: Record<string, string> = {}) {
    return {
      env: {},
      req: {
        param: vi.fn((name: string) => (name === 'sourceId' ? sourceId : undefined)),
        query: vi.fn((name: string) => query[name]),
        header: vi.fn(),
      },
      get: vi.fn((key: string) => (key === 'tenantId' ? 'tenant-a' : undefined)),
      json: vi.fn(
        (body: unknown, status: number = 200, headers: Record<string, string> = {}): Response =>
          new Response(JSON.stringify(body), { status, headers })
      ),
    } as unknown as Parameters<typeof handleFederationIdPSearch>[0];
  }

  it('answers 404 for a source id that is not an identifier, without reading anything', async () => {
    const response = await handleFederationIdPSearch(context('bad id/..'));
    expect(response.status).toBe(404);
    expect(mocks.admin!.queryOne).not.toHaveBeenCalled();
  });

  it('answers 404 for a source that sends users to a Discovery Service', async () => {
    mocks.admin!.queryOne.mockResolvedValueOnce({
      display_name: 'Research Federation',
      protocol_payload_json: payload({
        idpSelection: { mode: 'external_ds', discoveryServiceUrl: 'https://ds.example.org/WAYF' },
      }),
    });
    expect((await handleFederationIdPSearch(context('fed_1'))).status).toBe(404);
  });

  it('answers the public subset, cached briefly, with the limit bounded', async () => {
    mocks.admin!.queryOne.mockResolvedValueOnce({
      display_name: 'Research Federation',
      protocol_payload_json: payload(),
    });
    mocks.admin!.query.mockResolvedValueOnce([
      {
        entity_id: 'https://a.example.test/idp',
        display_name: 'Alpha U',
        summary_json: JSON.stringify({
          registrationAuthority: 'https://ra',
          entityCategories: ['x'],
        }),
      },
    ]);
    const response = await handleFederationIdPSearch(context('fed_1', { q: 'alp', limit: '1000' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=60');
    await expect(response.json()).resolves.toEqual({
      sourceId: 'fed_1',
      displayName: 'Research Federation',
      items: [{ entityId: 'https://a.example.test/idp', displayName: 'Alpha U', logoUrl: null }],
      truncated: false,
    });
    // limit=1000 is bounded to 50 (the batch is a fixed 150 rows).
    const [, params] = mocks.admin!.query.mock.calls[0] as [string, unknown[]];
    expect(params.slice(-2)).toEqual([150, 0]);
  });
});
