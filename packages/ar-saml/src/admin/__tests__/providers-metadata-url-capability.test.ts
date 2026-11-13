/**
 * The SAML admin routes while the platform has `saml_metadata_url` off. What fetches a URL, or
 * stores one for the scheduled poller to fetch, is refused for a tenant administrator (403
 * `capability_disabled`; 503 `temporarily_unavailable` when the switch cannot be read). Pasted
 * metadata, keeping or clearing a stored URL, reads and deletes stay open. A caller with global
 * platform authority is not affected.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_PERMISSIONS } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  stepUp: vi.fn(async (..._args: unknown[]): Promise<Response | null> => null),
  adapter: null as ReturnType<typeof createAdapter> | null,
  audit: vi.fn(async () => undefined),
  safeFetchText: vi.fn(),
  safeFetch: vi.fn(),
  refreshFederationSource: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    requireAdminStepUp: mocks.stepUp,
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.adapter })),
    requireAdminDatabaseAdapter: vi.fn(() => mocks.adapter),
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => mocks.adapter),
    resolveRuntimeIdentityMappingBinding: vi.fn(async () => ({
      fieldMappingSetId: 'saml-sp',
      fieldMappingVersionId: 'version-1',
      destinationProfileId: 'destination-profile-saml',
      destinationProfileIds: ['destination-profile-saml'],
    })),
    loadDestinationProfileConsentDescriptor: vi.fn(async () => ({
      profileId: 'destination-profile-saml',
      profileVersionId: 'destination-profile-saml-v1',
      destinationType: 'saml',
      fields: [{ key: 'mail' }, { key: 'displayName' }, { key: 'eduPersonAffiliation' }],
    })),
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(async () => mocks.adapter),
    createAuditLog: mocks.audit,
    safeFetchText: mocks.safeFetchText,
    safeFetch: mocks.safeFetch,
    getLogger: () => ({
      module: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    }),
  };
});

vi.mock('../metadata-polling', () => ({
  refreshFederationMetadataSource: mocks.refreshFederationSource,
}));

import {
  handleCreateProvider,
  handleDeleteProvider,
  handleGetProvider,
  handleImportMetadata,
  handleListProviders,
  handlePreviewFederationTrustCertificate,
  handlePreviewMetadata,
  handleRefreshFederationMetadataSource,
  handleRefreshMetadata,
  handleStartAggregateBatchCreate,
  handleUpdateProvider,
} from '../providers';

const CAPABILITIES_KEY = 'settings:platform:tenant-capabilities';
const STORED_URL = 'https://metadata.example.test/stored.xml';
const OTHER_URL = 'https://metadata.example.test/other.xml';
const UPDATED_AT = new Date(1_700_000_001_000).toISOString();
const MAPPING = {
  fieldMappingSetId: 'saml-sp',
  destinationFieldPolicies: {
    mail: 'optional',
    displayName: 'optional',
    eduPersonAffiliation: 'optional',
  },
};

function createAdapter() {
  const adapter = {
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn().mockResolvedValue(null),
    execute: vi.fn().mockResolvedValue({ rowsAffected: 1, insertId: undefined }),
    transaction: vi.fn(async (fn: (tx: typeof adapter) => Promise<unknown>) => fn(adapter)),
    batch: vi.fn(),
    isHealthy: vi.fn().mockResolvedValue(true),
    getType: vi.fn(() => 'mock'),
    close: vi.fn(),
  };
  return adapter;
}

function providerRow(config: Record<string, unknown> = {}) {
  return {
    id: 'provider-a',
    name: 'Provider A',
    provider_type: 'saml_sp',
    config_json: JSON.stringify({
      entityId: 'https://sp.example.test',
      acsUrl: 'https://sp.example.test/acs',
      allowedBindings: ['post'],
      identityMapping: MAPPING,
      ...config,
    }),
    enabled: 1,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_001_000,
  };
}

const spMetadata = `<?xml version="1.0"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://sp.example.test">
  <md:SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
      Location="https://sp.example.test/acs" index="0" isDefault="true" />
  </md:SPSSODescriptor>
</md:EntityDescriptor>`;

type Switch = boolean | 'down' | undefined;
const TENANT_ADMIN = { permissions: Object.values(ADMIN_PERMISSIONS) };
const PLATFORM_ADMIN = {
  roles: ['ar_super_admin'],
  globalRoles: ['ar_super_admin'],
  permissions: Object.values(ADMIN_PERMISSIONS),
  globalPermissions: Object.values(ADMIN_PERMISSIONS),
  tenantScope: ['*'],
};

function context(options: {
  switch?: Switch;
  persona?: Record<string, unknown>;
  body?: unknown;
  id?: string;
  params?: Record<string, string>;
  env?: Record<string, unknown>;
}) {
  const values = new Map<string, string>();
  if (typeof options.switch === 'boolean') {
    values.set(
      CAPABILITIES_KEY,
      JSON.stringify({ 'tenant_capabilities.saml_metadata_url': options.switch })
    );
  }
  const settings = {
    get: vi.fn(async (key: string) => {
      if (options.switch === 'down' && key === CAPABILITIES_KEY) throw new Error('kv down');
      return values.get(key) ?? null;
    }),
    put: vi.fn(),
  };
  return {
    env: { SETTINGS: settings, ...(options.env ?? {}) },
    req: {
      json: vi.fn(async () => options.body),
      param: vi.fn(
        (name: string) => options.params?.[name] ?? (name === 'id' ? options.id : undefined)
      ),
      header: vi.fn((name: string) =>
        options.body !== undefined && name.toLowerCase() === 'content-type'
          ? 'application/json'
          : undefined
      ),
    },
    get: vi.fn((name: string) => {
      if (name === 'tenantId') return 'tenant-a';
      if (name === 'adminAuth') return options.persona ?? TENANT_ADMIN;
      return undefined;
    }),
    json: vi.fn(
      (body: unknown, status: number = 200, headers: Record<string, string> = {}) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json', ...headers },
        })
    ),
    executionCtx: { waitUntil: vi.fn() },
  } as never;
}

const refusedBody = async (response: Response) =>
  expect(await response.json()).toMatchObject({
    error: 'capability_disabled',
    capability: 'saml_metadata_url',
  });

const writes = () => mocks.adapter!.execute.mock.calls.length;
/** The bound parameters of the n-th write. */
const writeParams = (n: number): unknown[] => mocks.adapter!.execute.mock.calls[n][1] as unknown[];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.adapter = createAdapter();
  mocks.safeFetchText.mockReset();
  mocks.safeFetch.mockReset();
  mocks.refreshFederationSource.mockReset();
  mocks.safeFetchText.mockResolvedValue(spMetadata);
  mocks.refreshFederationSource.mockResolvedValue({
    changed: false,
    entityCount: 0,
    providersUpdated: 0,
    providersMissing: 0,
    providersFailed: 0,
    verificationStatus: 'skipped',
  });
});

describe('what fetches a metadata URL, while saml_metadata_url is off', () => {
  it('refuses the metadata preview with a URL, and answers the same pasted XML as before', async () => {
    const refused = await handlePreviewMetadata(
      context({ switch: false, body: { metadataUrl: STORED_URL } })
    );
    expect(refused.status).toBe(403);
    await refusedBody(refused);
    expect(mocks.safeFetchText).not.toHaveBeenCalled();

    const pasted = await handlePreviewMetadata(
      context({ switch: false, body: { metadataXml: spMetadata } })
    );
    expect(pasted.status).toBe(200);
  });

  it('refuses a provider create with a metadataUrl, and creates one from pasted XML', async () => {
    const refused = await handleCreateProvider(
      context({
        switch: false,
        body: {
          name: 'P',
          providerType: 'saml_sp',
          metadataUrl: STORED_URL,
          config: { identityMapping: MAPPING },
        },
      })
    );
    expect(refused.status).toBe(403);
    await refusedBody(refused);
    expect(mocks.safeFetchText).not.toHaveBeenCalled();
    expect(writes()).toBe(0);

    const pasted = await handleCreateProvider(
      context({
        switch: false,
        body: {
          name: 'P',
          providerType: 'saml_sp',
          metadataXml: spMetadata,
          config: { identityMapping: MAPPING },
        },
      })
    );
    expect(pasted.status).toBe(201);
    expect(writes()).toBe(1);
    const stored = JSON.parse(String(writeParams(0)[4])) as {
      metadataUrl?: string;
    };
    expect(stored.metadataUrl).toBeUndefined();
  });

  it('refuses a provider create whose config carries a metadataUrl nothing fetched', async () => {
    const body = {
      name: 'P',
      providerType: 'saml_sp',
      config: {
        entityId: 'https://sp.example.test',
        acsUrl: 'https://sp.example.test/acs',
        metadataUrl: STORED_URL,
        identityMapping: MAPPING,
      },
    };
    const refused = await handleCreateProvider(context({ switch: false, body }));
    expect(refused.status).toBe(403);
    expect(writes()).toBe(0);
    const on = await handleCreateProvider(context({ switch: true, body }));
    expect(on.status).toBe(201);
  });

  it('creates a provider from a config without any URL', async () => {
    const response = await handleCreateProvider(
      context({
        switch: false,
        body: {
          name: 'P',
          providerType: 'saml_sp',
          config: {
            entityId: 'https://sp.example.test',
            acsUrl: 'https://sp.example.test/acs',
            identityMapping: MAPPING,
          },
        },
      })
    );
    expect(response.status).toBe(201);
  });

  it('refuses import-metadata with a URL, and imports pasted XML', async () => {
    mocks.adapter!.queryOne.mockResolvedValue(providerRow());
    const refused = await handleImportMetadata(
      context({ switch: false, id: 'provider-a', body: { metadataUrl: STORED_URL } })
    );
    expect(refused.status).toBe(403);
    expect(mocks.safeFetchText).not.toHaveBeenCalled();
    expect(writes()).toBe(0);
    const pasted = await handleImportMetadata(
      context({ switch: false, id: 'provider-a', body: { metadataXml: spMetadata } })
    );
    expect(pasted.status).toBe(200);
  });

  it('refuses refresh-metadata, with a stored URL or a given one, and fetches nothing', async () => {
    mocks.adapter!.queryOne.mockResolvedValue(providerRow({ metadataUrl: STORED_URL }));
    for (const body of [{}, { metadataUrl: OTHER_URL }]) {
      const refused = await handleRefreshMetadata(
        context({ switch: false, id: 'provider-a', body })
      );
      expect(refused.status).toBe(403);
      await refusedBody(refused);
    }
    expect(mocks.safeFetchText).not.toHaveBeenCalled();
    expect(writes()).toBe(0);
  });

  it('refuses the federation source refresh', async () => {
    const refused = await handleRefreshFederationMetadataSource(
      context({ switch: false, id: 'source-1' })
    );
    expect(refused.status).toBe(403);
    await refusedBody(refused);
    expect(mocks.refreshFederationSource).not.toHaveBeenCalled();
  });

  it('refuses the certificate preview for a certificateUrl, but not for a pasted certificate', async () => {
    const refused = await handlePreviewFederationTrustCertificate(
      context({ switch: false, body: { certificateUrl: 'https://metadata.example.test/c.pem' } })
    );
    expect(refused.status).toBe(403);
    expect(mocks.safeFetch).not.toHaveBeenCalled();
    const pasted = await handlePreviewFederationTrustCertificate(
      context({ switch: false, body: { certificate: 'not a certificate' } })
    );
    expect(pasted.status).not.toBe(403);
    expect(await pasted.json()).not.toMatchObject({ error: 'capability_disabled' });
  });

  it('refuses a batch create from a preview that was fetched from a URL', async () => {
    const store = (preview: Record<string, unknown>) => ({
      idFromName: vi.fn(() => ({})),
      get: vi.fn(() => ({
        fetch: vi.fn(async () => new Response(JSON.stringify(preview), { status: 200 })),
      })),
    });
    const body = { entityIds: ['https://sp.example.test'], enabled: true };
    const refused = await handleStartAggregateBatchCreate(
      context({
        switch: false,
        params: { previewId: 'preview-1' },
        body,
        env: {
          SAML_AGGREGATE_METADATA_STORE: store({
            tenantId: 'tenant-a',
            metadataXml: '<x/>',
            metadataUrl: STORED_URL,
            entities: [],
            verification: {},
          }),
        },
      })
    );
    expect(refused.status).toBe(403);
    await refusedBody(refused);
    // A preview made from pasted XML carries no URL: the capability is not asked about it.
    const pasted = await handleStartAggregateBatchCreate(
      context({
        switch: false,
        params: { previewId: 'preview-1' },
        body,
        env: {
          SAML_AGGREGATE_METADATA_STORE: store({
            tenantId: 'tenant-a',
            metadataXml: '<x/>',
            entities: [],
            verification: {},
          }),
        },
      })
    );
    expect(await pasted.json()).not.toMatchObject({ error: 'capability_disabled' });
  });
});

describe('saving a provider with a metadata URL, while saml_metadata_url is off', () => {
  const update = (config: Record<string, unknown>, switchValue: Switch = false, persona?: object) =>
    handleUpdateProvider(
      context({
        switch: switchValue,
        persona: persona as Record<string, unknown> | undefined,
        id: 'provider-a',
        body: { expectedUpdatedAt: UPDATED_AT, config },
      })
    );

  it('refuses a new URL on a provider that had none, and a changed URL', async () => {
    mocks.adapter!.queryOne.mockResolvedValue(providerRow());
    const added = await update({ metadataUrl: STORED_URL });
    expect(added.status).toBe(403);
    await refusedBody(added);
    mocks.adapter!.queryOne.mockResolvedValue(providerRow({ metadataUrl: STORED_URL }));
    const changed = await update({ metadataUrl: OTHER_URL });
    expect(changed.status).toBe(403);
    expect(writes()).toBe(0);
  });

  it('keeps the stored URL when other fields change', async () => {
    mocks.adapter!.queryOne.mockResolvedValue(providerRow({ metadataUrl: STORED_URL }));
    for (const config of [
      { acsUrl: 'https://sp.example.test/new-acs' },
      { acsUrl: 'https://sp.example.test/new-acs', metadataUrl: STORED_URL },
      { metadataRefreshPolicy: { mode: 'manual', intervalSeconds: 3600 } },
    ]) {
      const response = await update(config);
      expect(response.status, JSON.stringify(config)).toBe(200);
    }
    expect(writes()).toBe(3);
  });

  it('lets the URL be cleared', async () => {
    mocks.adapter!.queryOne.mockResolvedValue(providerRow({ metadataUrl: STORED_URL }));
    const response = await update({ metadataUrl: '' });
    expect(response.status).toBe(200);
    const stored = JSON.parse(String(writeParams(0)[1])) as {
      metadataUrl?: string;
    };
    expect(stored.metadataUrl ?? '').toBe('');
  });

  it('answers 503 with Retry-After for a new URL when the switch cannot be read, not for keeping one', async () => {
    mocks.adapter!.queryOne.mockResolvedValue(providerRow({ metadataUrl: STORED_URL }));
    const refused = await update({ metadataUrl: OTHER_URL }, 'down');
    expect(refused.status).toBe(503);
    expect(refused.headers.get('Retry-After')).toBeTruthy();
    expect(await refused.json()).toMatchObject({
      error: 'temporarily_unavailable',
      capability: 'saml_metadata_url',
    });
    const kept = await update({ acsUrl: 'https://sp.example.test/new-acs' }, 'down');
    expect(kept.status).toBe(200);
  });
});

describe('the same requests with the capability on, or for global platform authority', () => {
  it.each([
    ['on', true, TENANT_ADMIN],
    ['at its default', undefined, TENANT_ADMIN],
    ['off, for a platform administrator', false, PLATFORM_ADMIN],
    ['unreadable, for a platform administrator', 'down', PLATFORM_ADMIN],
  ] as const)('are allowed (%s)', async (_name, switchValue, persona) => {
    mocks.adapter!.queryOne.mockResolvedValue(providerRow({ metadataUrl: STORED_URL }));
    const refresh = await handleRefreshMetadata(
      context({ switch: switchValue, persona, id: 'provider-a', body: {} })
    );
    expect(refresh.status).toBe(200);
    const update = await handleUpdateProvider(
      context({
        switch: switchValue,
        persona,
        id: 'provider-a',
        body: { expectedUpdatedAt: UPDATED_AT, config: { metadataUrl: OTHER_URL } },
      })
    );
    expect(update.status).toBe(200);
    const source = await handleRefreshFederationMetadataSource(
      context({ switch: switchValue, persona, id: 'source-1' })
    );
    expect(source.status).toBe(200);
    const preview = await handlePreviewMetadata(
      context({ switch: switchValue, persona, body: { metadataUrl: STORED_URL } })
    );
    expect(preview.status).toBe(200);
  });
});

describe('what stays open while saml_metadata_url is off', () => {
  it('lists, reads and deletes providers', async () => {
    mocks.adapter!.query.mockResolvedValue([providerRow({ metadataUrl: STORED_URL })]);
    mocks.adapter!.queryOne.mockResolvedValue(providerRow({ metadataUrl: STORED_URL }));
    expect((await handleListProviders(context({ switch: false }))).status).toBe(200);
    expect((await handleGetProvider(context({ switch: false, id: 'provider-a' }))).status).toBe(
      200
    );
    const removed = await handleDeleteProvider(context({ switch: false, id: 'provider-a' }));
    expect(removed.status).toBe(200);
  });
});

describe('a metadata URL that is not a string', () => {
  const NON_STRINGS = [
    ['an array', [OTHER_URL]],
    ['an object', { href: OTHER_URL }],
    ['a number', 1],
    ['true', true],
  ] as const;

  it.each(NON_STRINGS)(
    'is refused on create while off (%s), and not judged while on',
    async (_n, value) => {
      const body = {
        name: 'P',
        providerType: 'saml_sp',
        config: {
          entityId: 'https://sp.example.test',
          acsUrl: 'https://sp.example.test/acs',
          metadataUrl: value,
          identityMapping: MAPPING,
        },
      };
      const refused = await handleCreateProvider(context({ switch: false, body }));
      expect(refused.status).toBe(403);
      await refusedBody(refused);
      expect(writes()).toBe(0);
      const on = await handleCreateProvider(context({ switch: true, body }));
      expect(await on.clone().json()).not.toMatchObject({ error: 'capability_disabled' });
    }
  );

  it.each(NON_STRINGS)(
    'is refused on update while off (%s), and not judged while on',
    async (_n, value) => {
      mocks.adapter!.queryOne.mockResolvedValue(providerRow());
      const body = { expectedUpdatedAt: UPDATED_AT, config: { metadataUrl: value } };
      const refused = await handleUpdateProvider(
        context({ switch: false, id: 'provider-a', body })
      );
      expect(refused.status).toBe(403);
      await refusedBody(refused);
      expect(writes()).toBe(0);
      const on = await handleUpdateProvider(context({ switch: true, id: 'provider-a', body }));
      expect(await on.clone().json()).not.toMatchObject({ error: 'capability_disabled' });
    }
  );

  it('is allowed on update only when identical to the stored value', async () => {
    mocks.adapter!.queryOne.mockResolvedValue(providerRow({ metadataUrl: [OTHER_URL] }));
    const same = await handleUpdateProvider(
      context({
        switch: false,
        id: 'provider-a',
        body: { expectedUpdatedAt: UPDATED_AT, config: { metadataUrl: [OTHER_URL] } },
      })
    );
    expect(await same.clone().json()).not.toMatchObject({ error: 'capability_disabled' });
    const changed = await handleUpdateProvider(
      context({
        switch: false,
        id: 'provider-a',
        body: { expectedUpdatedAt: UPDATED_AT, config: { metadataUrl: [STORED_URL] } },
      })
    );
    expect(changed.status).toBe(403);
  });

  it('is refused for a batch create from a preview carrying one, while off', async () => {
    const store = {
      idFromName: vi.fn(() => ({})),
      get: vi.fn(() => ({
        fetch: vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                tenantId: 'tenant-a',
                metadataXml: '<x/>',
                metadataUrl: [STORED_URL],
                entities: [],
                verification: {},
              }),
              { status: 200 }
            )
        ),
      })),
    };
    const refused = await handleStartAggregateBatchCreate(
      context({
        switch: false,
        params: { previewId: 'p' },
        body: { entityIds: ['https://sp.example.test'] },
        env: { SAML_AGGREGATE_METADATA_STORE: store },
      })
    );
    expect(refused.status).toBe(403);
  });
});
