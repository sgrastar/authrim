/**
 * handleRefreshMetadata: how fetch, validity, entityID and concurrency failures are classified,
 * persisted on the provider and reported.
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
  errors: [] as Array<{ code: string; options: unknown }>,
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
    createErrorResponse: (c: never, code: string, options?: unknown) => {
      mocks.errors.push({ code, options });
      return (actual.createErrorResponse as (...args: unknown[]) => unknown)(c, code, options);
    },
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

import { handleRefreshMetadata } from '../providers';

const MD = 'xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"';
const DS = 'xmlns:ds="http://www.w3.org/2000/09/xmldsig#"';
const PROTO = 'protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"';
const POST = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST';
const URL = 'https://idp.example.test/metadata.xml';
const UPDATED_AT = 1_700_000_001_000;

function metadata(entityId = 'https://idp.example.test', validUntil?: string): string {
  const until = validUntil ? ` validUntil="${validUntil}"` : '';
  return `<md:EntityDescriptor ${MD} ${DS} entityID="${entityId}"${until}><md:IDPSSODescriptor ${PROTO}><md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>VEVTVA==</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor><md:SingleSignOnService Binding="${POST}" Location="https://idp.example.test/sso"/></md:IDPSSODescriptor></md:EntityDescriptor>`;
}

function idpRow(config: Record<string, unknown> = {}, enabled = 1) {
  return providerRow({
    provider_type: 'saml_idp',
    enabled,
    updated_at: UPDATED_AT,
    config_json: JSON.stringify({
      entityId: 'https://idp.example.test',
      ssoUrl: 'https://idp.example.test/sso',
      certificate: 'CERT',
      metadataUrl: URL,
      metadataRefreshPolicy: { mode: 'automatic', intervalSeconds: 3600 },
      ...config,
    }),
  });
}

function adapter() {
  if (!mocks.adapter) throw new Error('adapter not initialised');
  return mocks.adapter;
}

function refresh(body?: Record<string, unknown>, permissions?: string[]) {
  return handleRefreshMetadata(harnessContext({ id: 'provider-a', body: body ?? {}, permissions }));
}

/** The config_json written by the n-th UPDATE. */
function written(n = 0): unknown {
  return parseJson(String((adapter().execute.mock.calls[n]?.[1] as unknown[])[0]));
}

function auditEntry(action: string): Record<string, unknown> | undefined {
  return mocks.audit.mock.calls
    .map((call) => call[1] as Record<string, unknown>)
    .find((entry) => entry.action === action);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.errors.length = 0;
  mocks.adapter = createAdapter();
  mocks.safeFetchText.mockReset();
  adapter().queryOne.mockResolvedValue(idpRow());
});

describe('fetch failures', () => {
  it('records metadata_fetch_failed on the stored URL and answers 400', async () => {
    mocks.safeFetchText.mockRejectedValue(new Error('network'));

    const response = await refresh();

    expect(response.status).toBe(400);
    expect(dig(written(), 'metadataRefreshPolicy')).toMatchObject({
      sourceState: 'error',
      lastErrorCode: 'metadata_fetch_failed',
      consecutiveFailures: 1,
    });
    const parameters = adapter().execute.mock.calls[0]?.[1] as unknown[];
    expect(parameters.slice(2)).toEqual(['provider-a', 'tenant-a', UPDATED_AT]);
    expect(parameters[1]).toBeGreaterThan(UPDATED_AT);
  });

  it('records nothing for a failed fetch from a URL that was never adopted', async () => {
    mocks.safeFetchText.mockRejectedValue(new Error('network'));

    const response = await refresh({ metadataUrl: 'https://other.example.test/metadata.xml' });

    expect(response.status).toBe(400);
    expect(adapter().execute).not.toHaveBeenCalled();
  });

  it('refuses a URL change without the update permission before fetching', async () => {
    const response = await refresh({ metadataUrl: 'https://other.example.test/metadata.xml' }, [
      'admin:saml:providers:metadata:refresh',
    ]);

    expect(response.status).toBe(403);
    expect(mocks.safeFetchText).not.toHaveBeenCalled();
  });

  it('answers 400 without retrying when persisting the fetch failure loses the version race', async () => {
    mocks.safeFetchText.mockRejectedValue(new Error('network'));
    adapter().execute.mockResolvedValue({ rowsAffected: 0 });

    const response = await refresh();

    expect(response.status).toBe(400);
    expect(adapter().execute).toHaveBeenCalledTimes(1);
  });
});

describe('metadata validation failures', () => {
  it('flags an entityID change as pending manual approval', async () => {
    mocks.safeFetchText.mockResolvedValue(metadata('https://evil.example.test'));

    const response = await refresh();

    expect(response.status).toBe(400);
    expect(dig(written(), 'metadataRefreshPolicy')).toMatchObject({
      sourceState: 'identity_change_pending',
      lastErrorCode: 'entity_id_change_pending',
    });
    expect(auditEntry('saml.provider.metadata_refreshed')).toMatchObject({
      resource: 'saml_provider',
      resourceId: 'provider-a',
      severity: 'warning',
    });
    expect(mocks.logWarn).toHaveBeenCalledWith(
      'Refresh metadata validation failed',
      { providerId: 'provider-a' },
      expect.any(Error)
    );
  });

  it('classifies other validation failures as metadata_validation_failed', async () => {
    mocks.safeFetchText.mockResolvedValue('<not-metadata/>');

    const response = await refresh();

    expect(response.status).toBe(400);
    expect(dig(written(), 'metadataRefreshPolicy')).toMatchObject({
      sourceState: 'error',
      lastErrorCode: 'metadata_validation_failed',
    });
  });

  it('requires aggregate metadata for an aggregate-linked provider', async () => {
    adapter().queryOne.mockResolvedValue(
      idpRow({ aggregateImport: { aggregateEntityId: 'https://idp.example.test' } })
    );
    mocks.safeFetchText.mockResolvedValue(metadata());

    const response = await refresh();

    expect(response.status).toBe(400);
    expect(dig(written(), 'metadataRefreshPolicy')).toMatchObject({
      lastErrorCode: 'metadata_validation_failed',
    });
  });

  it('logs when even the failure state cannot be persisted, and still reports the validation error', async () => {
    mocks.safeFetchText.mockResolvedValue('<not-metadata/>');
    adapter().execute.mockRejectedValue(new Error('db down'));

    const response = await refresh();

    expect(response.status).toBe(400);
    expect(mocks.logError).toHaveBeenCalledWith(
      'Failed to persist SAML metadata refresh failure state',
      { providerId: 'provider-a' },
      expect.any(Error)
    );
  });

  it('allows an entityID change only with the explicit flag and the update permission', async () => {
    mocks.safeFetchText.mockResolvedValue(metadata('https://moved.example.test'));

    const denied = await refresh({ allowEntityIdChange: true }, [
      'admin:saml:providers:metadata:refresh',
    ]);
    expect(denied.status).toBe(403);

    adapter().execute.mockClear();
    const allowed = await refresh({ allowEntityIdChange: true });
    expect(allowed.status).toBe(200);
    expect(dig(written(), 'entityId')).toBe('https://moved.example.test');
  });

  it('answers 500 and audits a failure for an unexpected error', async () => {
    mocks.safeFetchText.mockResolvedValue(metadata());
    adapter().execute.mockRejectedValue(new Error('disk full'));

    const response = await refresh();

    expect(response.status).toBe(500);
    expect(mocks.logError).toHaveBeenCalledWith(
      'Refresh metadata error',
      { providerId: 'provider-a' },
      expect.any(Error)
    );
    expect(auditEntry('saml.provider.metadata_refreshed')).toMatchObject({
      resourceId: 'provider-a',
      severity: 'warning',
    });
  });
});

describe('expired metadata', () => {
  const EXPIRED = metadata('https://idp.example.test', '2020-01-01T00:00:00Z');

  it('suspends an enabled provider and records the expiry', async () => {
    mocks.safeFetchText.mockResolvedValue(EXPIRED);

    const response = await refresh();

    expect(response.status).toBe(200);
    const body = await bodyOf<unknown>(response);
    expect(body).toMatchObject({ success: true, expired: true, enabled: false });
    const policy = dig(written(), 'metadataRefreshPolicy');
    expect(policy).toMatchObject({
      sourceState: 'expired',
      lastErrorCode: 'metadata_expired',
      suspendedByMetadataSync: true,
    });
    expect((adapter().execute.mock.calls[0]?.[1] as unknown[])[1]).toBe(0);
    const refreshed = auditEntry('saml.metadata.refreshed');
    expect(refreshed).toMatchObject({ resource: 'saml_idp', resourceId: 'provider-a' });
    expect(refreshed?.severity).toBe('warning');
  });

  it('does not mark a provider that was already disabled as suspended by the sync', async () => {
    adapter().queryOne.mockResolvedValue(idpRow({}, 0));
    mocks.safeFetchText.mockResolvedValue(EXPIRED);

    await refresh();

    expect(dig(written(), 'metadataRefreshPolicy')).not.toHaveProperty('suspendedByMetadataSync');
  });

  it('keeps an earlier sync suspension even when the provider is already disabled', async () => {
    adapter().queryOne.mockResolvedValue(
      idpRow(
        {
          metadataRefreshPolicy: {
            mode: 'automatic',
            intervalSeconds: 3600,
            suspendedByMetadataSync: true,
          },
        },
        0
      )
    );
    mocks.safeFetchText.mockResolvedValue(EXPIRED);

    await refresh();

    expect(dig(written(), 'metadataRefreshPolicy')).toMatchObject({
      suspendedByMetadataSync: true,
    });
  });

  it('changes nothing for expired metadata served from a URL that was never adopted', async () => {
    mocks.safeFetchText.mockResolvedValue(EXPIRED);

    const response = await refresh({ metadataUrl: 'https://other.example.test/metadata.xml' });

    expect(response.status).toBe(400);
    expect(adapter().execute).not.toHaveBeenCalled();
    expect(
      (mocks.errors.at(-1)?.options as { variables: Record<string, string> }).variables
    ).toEqual({ field: 'metadataUrl', reason: 'The metadata at this URL has expired' });
  });

  it('reports a version race while suspending as a validation error', async () => {
    mocks.safeFetchText.mockResolvedValue(EXPIRED);
    adapter().execute.mockResolvedValue({ rowsAffected: 0 });

    const response = await refresh();

    expect(response.status).toBe(400);
    expect(adapter().execute).toHaveBeenCalledTimes(1);
    expect(auditEntry('saml.provider.metadata_refreshed')?.severity).toBe('warning');
  });
});

describe('successful refresh', () => {
  it('detects a version race on the final UPDATE', async () => {
    mocks.safeFetchText.mockResolvedValue(metadata());
    adapter().execute.mockResolvedValue({ rowsAffected: 0 });

    const response = await refresh();

    expect(response.status).toBe(400);
    expect(adapter().execute).toHaveBeenCalledTimes(1);
  });

  it('refreshes the stored configuration from the fetched metadata', async () => {
    mocks.safeFetchText.mockResolvedValue(metadata());

    const response = await refresh();

    expect(response.status).toBe(200);
    const stored = written();
    expect(dig(stored, 'metadataUrl')).toBe(URL);
    expect(dig(stored, 'metadataRefreshPolicy')).toMatchObject({
      sourceState: 'healthy',
      consecutiveFailures: 0,
    });
    expect((adapter().execute.mock.calls[0]?.[1] as unknown[])[1]).toBe(1);
  });
});
