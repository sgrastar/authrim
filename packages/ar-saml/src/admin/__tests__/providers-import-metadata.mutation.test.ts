/**
 * handleImportMetadata: request guards, what an import keeps of the stored connection, the
 * aggregate/entityID refusals, optimistic concurrency and the audit record.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bodyOf,
  createAdapter,
  dig,
  harnessContext,
  parseJson,
  providerRow,
} from './helpers/provider-handler-harness';

vi.mock('../../mapping-set-owner', () => ({
  resolveSAMLMappingSetOwner: vi.fn(async (_adapter: unknown, tenantId: string) => tenantId),
}));

const mocks = vi.hoisted(() => ({
  stepUp: vi.fn(async (..._args: unknown[]): Promise<Response | null> => null),
  adapter: null as ReturnType<typeof createAdapter> | null,
  audit: vi.fn(async (..._args: unknown[]) => undefined),
  safeFetchText: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    requireAdminStepUp: mocks.stepUp,
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.adapter })),
    requireAdminDatabaseAdapter: vi.fn(() => mocks.adapter),
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => mocks.adapter),
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(async () => mocks.adapter),
    createAuditLog: mocks.audit,
    safeFetchText: mocks.safeFetchText,
    tenantCapabilityRefusal: vi.fn(async () => null),
    listEnvironmentTenantDefaultStores: vi.fn(async () => [{ tenantId: 'tenant-a' }]),
    bumpAuthenticationMethodsCacheRevision: vi.fn(async () => undefined),
    getLogger: () => ({
      module: () => ({
        error: mocks.logError,
        warn: mocks.logWarn,
        info: vi.fn(),
        debug: vi.fn(),
      }),
    }),
  };
});

vi.mock('../metadata-polling', () => ({ refreshFederationMetadataSource: vi.fn() }));

import { handleImportMetadata } from '../providers';

const MD = 'xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"';
const DS = 'xmlns:ds="http://www.w3.org/2000/09/xmldsig#"';
const PROTO = 'protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"';
const POST = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST';
const UPDATED_AT = 1_700_000_001_000;
const EXPECTED = new Date(UPDATED_AT).toISOString();

function idpMetadata(entityId = 'https://idp.example.test'): string {
  return `<md:EntityDescriptor ${MD} ${DS} entityID="${entityId}"><md:IDPSSODescriptor ${PROTO}><md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>VEVTVA==</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor><md:SingleSignOnService Binding="${POST}" Location="https://idp.example.test/new-sso"/></md:IDPSSODescriptor></md:EntityDescriptor>`;
}

function spMetadata(entityId = 'https://sp.example.test'): string {
  return `<md:EntityDescriptor ${MD} entityID="${entityId}"><md:SPSSODescriptor ${PROTO}><md:AssertionConsumerService Binding="${POST}" Location="https://sp.example.test/new-acs" index="0" isDefault="true"/></md:SPSSODescriptor></md:EntityDescriptor>`;
}

const aggregate = (inner: string) =>
  `<md:EntitiesDescriptor ${MD} ${DS} ID="_agg">${inner.replace(/ xmlns:md="[^"]*"| xmlns:ds="[^"]*"/g, '')}</md:EntitiesDescriptor>`;

function idpRow(config: Record<string, unknown> = {}, enabled = 0) {
  return providerRow({
    provider_type: 'saml_idp',
    enabled,
    updated_at: UPDATED_AT,
    config_json: JSON.stringify({
      entityId: 'https://idp.example.test',
      ssoUrl: 'https://idp.example.test/old-sso',
      certificate: 'OLD',
      nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
      attributeMapping: { mail: 'email' },
      ...config,
    }),
  });
}

function adapter() {
  if (!mocks.adapter) throw new Error('adapter not initialised');
  return mocks.adapter;
}

function importMetadata(body: Record<string, unknown>, permissions?: string[]) {
  return handleImportMetadata(
    harnessContext({
      id: 'provider-a',
      body: { expectedUpdatedAt: EXPECTED, ...body },
      permissions,
    })
  );
}

function written(): unknown {
  return parseJson(String((adapter().execute.mock.calls[0]?.[1] as unknown[])[0]));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.adapter = createAdapter();
  mocks.safeFetchText.mockReset();
  adapter().queryOne.mockResolvedValue(idpRow());
});

describe('guards', () => {
  it('refuses a caller without the import permission', async () => {
    expect((await importMetadata({ metadataXml: idpMetadata() }, [])).status).toBe(403);
    expect(adapter().queryOne).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown provider', async () => {
    adapter().queryOne.mockResolvedValue(null);

    expect((await importMetadata({ metadataXml: idpMetadata() })).status).toBe(404);
  });

  it('requires expectedUpdatedAt and rejects a stale one', async () => {
    const missing = await handleImportMetadata(
      harnessContext({ id: 'provider-a', body: { metadataXml: idpMetadata() } })
    );
    const stale = await importMetadata({
      metadataXml: idpMetadata(),
      expectedUpdatedAt: new Date(1).toISOString(),
    });

    expect([missing.status, stale.status]).toEqual([400, 409]);
    expect(adapter().execute).not.toHaveBeenCalled();
  });

  it('requires metadata XML or a URL', async () => {
    expect((await importMetadata({})).status).toBe(400);
  });
});

describe('a successful import', () => {
  it('replaces the endpoint and certificate but keeps the local mapping and NameID choice', async () => {
    const response = await importMetadata({ metadataXml: idpMetadata() });

    expect(response.status).toBe(200);
    const stored = written();
    expect(dig(stored, 'ssoUrl')).toBe('https://idp.example.test/new-sso');
    expect(dig(stored, 'attributeMapping')).toEqual({ mail: 'email' });
    expect(dig(stored, 'nameIdFormat')).toBe(
      'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent'
    );
    expect(dig(stored, 'metadataXml')).toBe(idpMetadata());
    expect(dig(stored, 'metadataRefreshStatus', 'diff', 'changed')).toBe(true);
    expect(dig(stored, 'metadataLastFetched')).toEqual(expect.any(Number));
    const body = await bodyOf<unknown>(response);
    expect(dig(body, 'success')).toBe(true);
    expect(dig(body, 'providerType')).toBe('saml_idp');
    expect(dig(body, 'enabled')).toBe(false);
  });

  it('lets a chosen SAML profile reset the NameID format to the metadata one', async () => {
    adapter().queryOne.mockResolvedValue(
      providerRow({
        provider_type: 'saml_sp',
        enabled: 0,
        updated_at: UPDATED_AT,
        config_json: JSON.stringify({
          entityId: 'https://sp.example.test',
          acsUrl: 'https://sp.example.test/old-acs',
          nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
          signResponses: false,
          signAssertions: true,
          authnRequestSignaturePolicy: 'required',
        }),
      })
    );

    await importMetadata({ metadataXml: spMetadata() });
    const kept = written();
    adapter().execute.mockClear();
    await importMetadata({ metadataXml: spMetadata(), samlProfile: 'legacy' });
    const reset = written();

    expect(dig(kept, 'acsUrl')).toBe('https://sp.example.test/new-acs');
    expect(dig(kept, 'nameIdFormat')).toBe('urn:oasis:names:tc:SAML:2.0:nameid-format:persistent');
    expect(dig(kept, 'signResponses')).toBe(false);
    expect(dig(kept, 'signAssertions')).toBe(true);
    expect(dig(kept, 'authnRequestSignaturePolicy')).toBe('required');
    expect(dig(reset, 'nameIdFormat')).not.toBe(
      'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent'
    );
  });

  it('keeps the enabled state of a connection and guards the UPDATE with the row version', async () => {
    adapter().queryOne.mockResolvedValue(idpRow({}, 1));

    const response = await importMetadata({ metadataXml: idpMetadata() });

    expect(response.status).toBe(200);
    const parameters = adapter().execute.mock.calls[0]?.[1] as unknown[];
    expect(parameters[1]).toBe(1);
    expect(parameters.slice(3)).toEqual(['provider-a', 'tenant-a', UPDATED_AT]);
    expect(parameters[2]).toBeGreaterThan(UPDATED_AT);
  });

  it('records the import in the audit trail', async () => {
    await importMetadata({ metadataXml: idpMetadata() });

    const entry = mocks.audit.mock.calls
      .map((call) => call[1] as Record<string, unknown>)
      .find((item) => item.action === 'saml.provider.metadata_imported');
    expect(entry).toMatchObject({
      resource: 'saml_idp',
      resourceId: 'provider-a',
      severity: 'info',
    });
    expect(parseJson(String(entry?.metadata))).toMatchObject({
      metadata_url_present: false,
      changed: true,
    });
  });

  it('answers 409 when the row changed before the UPDATE', async () => {
    adapter().execute.mockResolvedValue({ rowsAffected: 0 });

    expect((await importMetadata({ metadataXml: idpMetadata() })).status).toBe(409);
  });

  it('refuses when the step-up refuses, writing nothing', async () => {
    adapter().queryOne.mockResolvedValue(idpRow({}, 1));
    mocks.stepUp.mockResolvedValueOnce(new Response('step-up', { status: 428 }));

    expect((await importMetadata({ metadataXml: idpMetadata() })).status).toBe(428);
    expect(adapter().execute).not.toHaveBeenCalled();
  });
});

describe('refusals', () => {
  async function validationMessage(body: Record<string, unknown>) {
    const response = await importMetadata(body);
    const text = await bodyOf<unknown>(response);
    return { status: response.status, message: String(dig(text, 'error_description')) };
  }

  it('refuses aggregate metadata for a connection that was imported from an aggregate', async () => {
    adapter().queryOne.mockResolvedValue(
      idpRow({ aggregateImport: { aggregateEntityId: 'https://idp.example.test' } })
    );

    expect(await validationMessage({ metadataXml: aggregate(idpMetadata()) })).toEqual({
      status: 400,
      message:
        'Aggregate metadata must be previewed first and imported by selecting EntityDescriptor entries.',
    });
    expect(adapter().execute).not.toHaveBeenCalled();
  });

  it('unwraps a single-entity aggregate but refuses a changed entityID inside it', async () => {
    const ok = await importMetadata({ metadataXml: aggregate(idpMetadata()) });
    adapter().execute.mockClear();
    const changed = await validationMessage({
      metadataXml: aggregate(idpMetadata('https://other.example.test')),
    });

    expect(ok.status).toBe(200);
    expect(changed).toEqual({
      status: 400,
      message: 'Metadata entityID changed and requires explicit manual approval.',
    });
  });

  it('refuses metadata that is not valid SAML metadata, naming the problem', async () => {
    expect(await validationMessage({ metadataXml: '<not-metadata/>' })).toMatchObject({
      status: 400,
      message: 'Invalid metadata: missing EntityDescriptor',
    });
    expect(mocks.logWarn).toHaveBeenCalledWith(
      'Import metadata validation failed',
      { providerId: 'provider-a' },
      expect.any(Error)
    );
  });

  it('refuses metadata for the other role', async () => {
    const result = await validationMessage({ metadataXml: spMetadata() });

    expect(result.status).toBe(400);
    expect(result.message).toContain('Service Provider');
  });

  it('answers 500 and audits a failure for an unexpected error', async () => {
    adapter().execute.mockRejectedValue(new Error('disk full'));

    const response = await importMetadata({ metadataXml: idpMetadata() });

    expect(response.status).toBe(500);
    expect(mocks.logError).toHaveBeenCalledWith(
      'Import metadata error',
      { providerId: 'provider-a' },
      expect.any(Error)
    );
  });
});
