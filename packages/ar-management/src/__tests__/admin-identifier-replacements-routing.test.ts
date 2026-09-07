import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  routedPii: { query: vi.fn(), batch: vi.fn() },
  defaultPii: { query: vi.fn(), batch: vi.fn() },
  resolveAccount: vi.fn(),
  tenantMetadata: vi.fn(),
  createPii: vi.fn(),
  audit: vi.fn(),
  resume: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getTenantIdFromContext: vi.fn(() => 'tenant-a'),
    getRuntimeUserStoreSourcesFromHonoContext: vi.fn(() => undefined),
    getTenantMetadataContextFromHono: mocks.tenantMetadata,
    resolveAccountDataContextFromHono: mocks.resolveAccount,
    createPIIContextFromHono: mocks.createPii,
    createAuditLogFromContext: mocks.audit,
  };
});

vi.mock('../account-identifier-replacement', () => ({
  resumeIdentifierReplacementOperation: mocks.resume,
}));

import {
  adminUserIdentifierReplacementResumeHandler,
  adminUserIdentifierReplacementsHandler,
} from '../admin-identifier-replacements';

function context(operationId?: string, accountId = 'account-a') {
  return {
    req: {
      param: vi.fn((name: string) => (name === 'operationId' ? operationId : accountId)),
    },
    env: {},
    json: vi.fn((body: unknown, status = 200) => Response.json(body, { status })),
  } as never;
}

describe('Admin identifier replacement shard routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.routedPii.query.mockResolvedValue([]);
    mocks.defaultPii.query.mockResolvedValue([]);
    mocks.routedPii.batch.mockResolvedValue([]);
    mocks.defaultPii.batch.mockResolvedValue([]);
    mocks.resolveAccount.mockResolvedValue(undefined);
    mocks.audit.mockResolvedValue(undefined);
    mocks.resume.mockResolvedValue('completed');
    mocks.tenantMetadata.mockReturnValue({
      tenantId: 'tenant-a',
      coreDb: {},
    });
    mocks.createPii.mockReturnValue({ defaultPiiAdapter: mocks.routedPii });
  });

  it('resolves the account route before reading its PII shard', async () => {
    const response = await adminUserIdentifierReplacementsHandler(context());

    expect(response.status).toBe(200);
    expect(mocks.resolveAccount).toHaveBeenCalledWith(expect.anything(), 'account-a');
    expect(mocks.resolveAccount.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.createPii.mock.invocationCallOrder[0]!
    );
    expect(mocks.routedPii.query).toHaveBeenCalledOnce();
    expect(mocks.defaultPii.query).not.toHaveBeenCalled();
  });

  it('accepts persisted user IDs that begin with an underscore', async () => {
    const response = await adminUserIdentifierReplacementsHandler(
      context(undefined, '_WdnkLInMNDz8yJNZUlzA')
    );

    expect(response.status).toBe(200);
    expect(mocks.resolveAccount).toHaveBeenCalledWith(expect.anything(), '_WdnkLInMNDz8yJNZUlzA');
  });

  it('fails closed when the account route cannot be resolved', async () => {
    mocks.resolveAccount.mockRejectedValue(new Error('account_data_wrong_tenant'));

    const response = await adminUserIdentifierReplacementsHandler(context());

    expect(response.status).toBe(500);
    expect(mocks.createPii).not.toHaveBeenCalled();
    expect(mocks.routedPii.query).not.toHaveBeenCalled();
    expect(mocks.defaultPii.query).not.toHaveBeenCalled();
  });

  it('keeps Admin resume reads and writes on the resolved account PII shard', async () => {
    const operationId = 'identifier-replacement:00000000-0000-4000-8000-000000000001';
    const blocked = {
      operation_id: operationId,
      authority: 'admin',
      state: 'blocked_forward_repair',
      error_code: 'redacted',
      created_at: 100,
      updated_at: 110,
      completed_at: null,
    };
    const resumed = { ...blocked, state: 'completed', error_code: null, completed_at: 120 };
    mocks.routedPii.query.mockResolvedValueOnce([blocked]).mockResolvedValueOnce([resumed]);
    mocks.routedPii.batch.mockResolvedValue([
      { success: true, rowsAffected: 1 },
      { success: true, rowsAffected: 1 },
    ]);

    const response = await adminUserIdentifierReplacementResumeHandler(context(operationId));

    expect(response.status).toBe(200);
    expect(mocks.resolveAccount).toHaveBeenCalledOnce();
    expect(mocks.routedPii.batch).toHaveBeenCalledOnce();
    expect(mocks.defaultPii.batch).not.toHaveBeenCalled();
    expect(mocks.resume).toHaveBeenCalledWith(expect.anything(), {
      operationId,
      tenantId: 'tenant-a',
      accountId: 'account-a',
    });
  });
});
