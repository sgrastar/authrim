/**
 * Signing-certificate rollover handlers (publish next / promote next / retire backup): request
 * validation, role mapping, optimistic concurrency, audit records and failure handling.
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
  logError: vi.fn(),
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
    createErrorResponse: (c: never, code: string, options?: unknown) => {
      mocks.errors.push({ code, options });
      return (actual.createErrorResponse as (...args: unknown[]) => unknown)(c, code, options);
    },
    getLogger: () => ({
      module: () => ({ error: mocks.logError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    }),
  };
});

import {
  handlePromoteSigningNext,
  handlePublishSigningNext,
  handleRetireSigningBackup,
} from '../providers';
import { RSA_2048_SHA256_PEM } from '../__fixtures__/certificates';

function adapter() {
  if (!mocks.adapter) throw new Error('adapter not initialised');
  return mocks.adapter;
}

function auditEntry(action: string): Record<string, unknown> | undefined {
  return mocks.audit.mock.calls
    .map((call) => call[1] as Record<string, unknown>)
    .find((entry) => entry.action === action);
}

function storedPolicy(): unknown {
  const parameters = adapter().execute.mock.calls[0]?.[1] as unknown[];
  return dig(parseJson(String(parameters[0])), 'signingKeyPolicy');
}

const UPDATED_AT = 1_700_000_001_000;
const NEXT = {
  slot: 'next',
  id: 'next-1',
  keyRef: 'tenant:tenant-a:idp:key-next',
  kid: 'kid-next',
  certificate: 'NEXTCERT',
  state: 'published_next',
};
const ACTIVE = {
  slot: 'active',
  id: 'active-1',
  keyRef: 'tenant:tenant-a:idp:key-active',
  kid: 'kid-active',
  certificate: 'ACTIVECERT',
  state: 'active',
};

function row(
  providerType: string,
  signingKeyPolicy?: Record<string, unknown>,
  updatedAt = UPDATED_AT
) {
  return providerRow({
    provider_type: providerType,
    updated_at: updatedAt,
    config_json: JSON.stringify({
      entityId: 'https://peer.example.test',
      ...(signingKeyPolicy ? { signingKeyPolicy } : {}),
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.errors.length = 0;
  mocks.adapter = createAdapter();
});

describe('request validation', () => {
  it.each([
    ['publish', handlePublishSigningNext],
    ['promote', handlePromoteSigningNext],
    ['retire', handleRetireSigningBackup],
  ])('%s refuses a caller without the matching permission', async (_name, handler) => {
    const response = await handler(harnessContext({ id: 'provider-a', permissions: [], body: {} }));

    expect(response.status).toBe(403);
    expect(adapter().queryOne).not.toHaveBeenCalled();
  });

  it('answers 404 when the route carries no provider id', async () => {
    const response = await handleRetireSigningBackup(harnessContext({ body: {} }));

    expect(response.status).toBe(404);
    expect(adapter().queryOne).not.toHaveBeenCalled();
  });

  it('answers 404 when the provider does not exist in the tenant', async () => {
    const response = await handleRetireSigningBackup(harnessContext({ id: 'gone', body: {} }));

    expect(response.status).toBe(404);
    expect(adapter().queryOne.mock.calls[0]?.[1]).toEqual(['gone', 'tenant-a']);
  });

  it('requires a certificate to publish a next certificate', async () => {
    adapter().queryOne.mockResolvedValue(row('saml_sp'));

    const response = await handlePublishSigningNext(
      harnessContext({ id: 'provider-a', body: { kid: 'k' } })
    );

    expect(response.status).toBe(400);
    expect((mocks.errors.at(-1)?.options as { variables: { field: string } }).variables.field).toBe(
      'certificate'
    );
    expect(adapter().execute).not.toHaveBeenCalled();
  });
});

describe('policy updates', () => {
  it('publishes a next certificate for an SP connection under the idp role', async () => {
    adapter().queryOne.mockResolvedValue(row('saml_sp'));

    const response = await handlePublishSigningNext(
      harnessContext({
        id: 'provider-a',
        body: {
          certificate: RSA_2048_SHA256_PEM,
          kid: 'kid-1',
          keyRef: 'tenant:tenant-a:idp:key-1',
        },
      })
    );

    expect(response.status).toBe(200);
    const body = await bodyOf<unknown>(response);
    expect(dig(body, 'success')).toBe(true);
    expect(dig(body, 'signingKeyPolicy', 'nextCandidates')).toHaveLength(1);
    expect(dig(body, 'signingKeyPolicy', 'nextCandidates', 0)).toMatchObject({
      slot: 'next',
      kid: 'kid-1',
      keyRef: 'tenant:tenant-a:idp:key-1',
      certificate: RSA_2048_SHA256_PEM,
      state: 'published_next',
    });
    expect(dig(storedPolicy(), 'nextCandidates', 0, 'kid')).toBe('kid-1');
    const entry = auditEntry('saml.signing_policy.updated');
    expect(entry).toMatchObject({
      resource: 'saml_sp',
      resourceId: 'provider-a',
      severity: 'warning',
    });
    expect(JSON.parse(String(entry?.metadata))).toMatchObject({
      role: 'idp',
      has_active_kid: false,
      has_next_kid: false,
      backup_count: 0,
    });
  });

  it('uses the sp role for an IdP connection', async () => {
    adapter().queryOne.mockResolvedValue(row('saml_idp'));

    await handlePublishSigningNext(
      harnessContext({
        id: 'provider-a',
        body: { certificate: RSA_2048_SHA256_PEM, keyRef: 'tenant:tenant-a:sp:key-1' },
      })
    );

    expect(parseJson(String(auditEntry('saml.signing_policy.updated')?.metadata))).toMatchObject({
      role: 'sp',
    });
  });

  it('promotes the next certificate to active and keeps the previous active as backup', async () => {
    adapter().queryOne.mockResolvedValue(
      row('saml_sp', {
        active: ACTIVE,
        nextCandidates: [NEXT],
        metadataCertificatePublication: 'active_next',
      })
    );

    const response = await handlePromoteSigningNext(
      harnessContext({ id: 'provider-a', body: { promotedAt: 123 } })
    );

    expect(response.status).toBe(200);
    const policy = storedPolicy();
    expect(dig(policy, 'active')).toMatchObject({
      kid: 'kid-next',
      slot: 'active',
      state: 'active',
    });
    expect(dig(policy, 'backup')).toMatchObject({
      kid: 'kid-active',
      slot: 'backup',
      state: 'overlap',
    });
    expect(dig(policy, 'metadataCertificatePublication')).toBe('active_next_backup');
    expect(parseJson(String(auditEntry('saml.signing_policy.updated')?.metadata))).toMatchObject({
      has_active_kid: true,
      backup_count: 1,
    });
  });

  it('retires the backup certificate', async () => {
    adapter().queryOne.mockResolvedValue(
      row('saml_idp', { active: ACTIVE, backup: { ...ACTIVE, slot: 'backup', kid: 'kid-old' } })
    );

    const response = await handleRetireSigningBackup(
      harnessContext({ id: 'provider-a', body: {} })
    );

    expect(response.status).toBe(200);
    const policy = storedPolicy();
    expect(dig(policy, 'backup')).toBeUndefined();
    expect(dig(policy, 'active', 'kid')).toBe('kid-active');
    expect(dig(policy, 'metadataCertificatePublication')).toBe('active_only');
    expect(parseJson(String(auditEntry('saml.signing_policy.updated')?.metadata))).toMatchObject({
      has_active_kid: true,
      backup_count: 0,
    });
  });

  it('guards the UPDATE with the row version and answers 409 when it no longer matches', async () => {
    const FUTURE = 4_000_000_000_000;
    adapter().queryOne.mockResolvedValue(row('saml_sp', undefined, FUTURE));
    adapter().execute.mockResolvedValue({ rowsAffected: 0 });

    const response = await handleRetireSigningBackup(
      harnessContext({ id: 'provider-a', body: {} })
    );

    expect(response.status).toBe(409);
    const parameters = adapter().execute.mock.calls[0]?.[1] as unknown[];
    expect(parameters.slice(2)).toEqual(['provider-a', 'tenant-a', FUTURE]);
    expect(parameters[1]).toBe(FUTURE + 1);
    expect(auditEntry('saml.signing_policy.updated')).toBeUndefined();
  });

  it('records a failure audit and answers 500 when the policy cannot be applied', async () => {
    adapter().queryOne.mockResolvedValue(row('saml_sp', { active: ACTIVE }));

    const response = await handlePromoteSigningNext(harnessContext({ id: 'provider-a', body: {} }));

    expect(response.status).toBe(500);
    expect(auditEntry('saml.signing_policy.updated')).toMatchObject({
      resource: 'saml_provider',
      resourceId: 'provider-a',
      severity: 'warning',
    });
    expect(mocks.logError).toHaveBeenCalledWith(
      'Update SAML signing policy error',
      { providerId: 'provider-a' },
      expect.any(Error)
    );
    expect(adapter().execute).not.toHaveBeenCalled();
  });

  it('refuses when the step-up check refuses, without writing', async () => {
    adapter().queryOne.mockResolvedValue(row('saml_sp'));
    mocks.stepUp.mockResolvedValueOnce(new Response('step-up', { status: 428 }));

    const response = await handleRetireSigningBackup(
      harnessContext({ id: 'provider-a', body: {} })
    );

    expect(response.status).toBe(428);
    expect(adapter().execute).not.toHaveBeenCalled();
  });
});
