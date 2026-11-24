/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- shared route-test harness over untyped JSON and vi mocks */
// Shared fakes for the logging-control-b-*.mutation.test.ts files. Each test file registers the
// vi.mock factories (they must live in the test file) and delegates to the builders below.
import { vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

export const mockAdapter = {
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  batch: vi.fn(),
  transaction: vi.fn(),
  isHealthy: vi.fn(),
  getType: vi.fn(),
  close: vi.fn(),
};

export const auditWrite = vi.fn(
  async (_context: unknown, _input: Record<string, unknown>) => 'audit-id-1'
);

export const coreFakes = {
  resolveRuntimeTarget: vi.fn(),
  resolveTenantDatabase: vi.fn(),
  resolveTenantProfiles: vi.fn(),
  notificationEnqueue: vi.fn(),
  ensureDatabaseAdapter: vi.fn(),
  hasBackupSnapshot: vi.fn(),
  loadChunkedSensitiveDetail: vi.fn(),
  retireGeneration: vi.fn(),
  listBackupTenantKeys: vi.fn(),
};

export const repoFakes = {
  detectCatalogRepairFindings: vi.fn(),
  applySafeCatalogRepairs: vi.fn(),
  loadCriticalPolicy: vi.fn(),
  loadSensitiveDetailPolicy: vi.fn(),
  updateCriticalPolicy: vi.fn(),
  updateSensitiveDetailPolicy: vi.fn(),
  upsertCoverageStatuses: vi.fn(),
};

export const readAdapterFakes = {
  queryOne: vi.fn(),
  query: vi.fn(),
  hasArchive: vi.fn(),
  coverage: vi.fn(),
  createLogReadAdapter: vi.fn(),
};

export function buildReadAdapterMock<T extends Record<string, unknown>>(actual: T) {
  return {
    ...actual,
    createLogReadAdapter: readAdapterFakes.createLogReadAdapter,
    logCoverageHeaders: vi.fn(() => vi.fn()),
  };
}

export const stepUpFakes = {
  requireAdminStepUp: vi.fn(),
  refuseAdminFreshAuth: vi.fn(),
};

export const messagingFakes = {
  listJobs: vi.fn(),
  getJob: vi.fn(),
  createJob: vi.fn(),
  requestCancel: vi.fn(),
  markCancelled: vi.fn(),
  listRepairFindings: vi.fn(),
  getRepairFinding: vi.fn(),
  markRepairFindingApplied: vi.fn(),
  enqueue: vi.fn(),
  writePayload: vi.fn(),
};

export const keysFakes = { enqueue: vi.fn() };

export function buildKeysMock<T extends Record<string, unknown>>(actual: T) {
  class FakeSqlLoggingRewrapJobQueue {
    enqueue = keysFakes.enqueue;
  }
  return { ...actual, SqlLoggingRewrapJobQueue: FakeSqlLoggingRewrapJobQueue };
}

export function buildMessagingMock<T extends Record<string, unknown>>(actual: T) {
  class FakeSqlLoggingMessageJobStore {
    listJobs = messagingFakes.listJobs;
    getJob = messagingFakes.getJob;
    createJob = messagingFakes.createJob;
    requestCancel = messagingFakes.requestCancel;
    markCancelled = messagingFakes.markCancelled;
    listRepairFindings = messagingFakes.listRepairFindings;
    getRepairFinding = messagingFakes.getRepairFinding;
    markRepairFindingApplied = messagingFakes.markRepairFindingApplied;
  }
  return {
    ...actual,
    SqlLoggingMessageJobStore: FakeSqlLoggingMessageJobStore,
    enqueueLoggingMessagePayload: messagingFakes.enqueue,
  };
}

export function buildPayloadStorageMock<T extends Record<string, unknown>>(actual: T) {
  return { ...actual, writeEncryptedLoggingMessagePayload: messagingFakes.writePayload };
}

export function buildCoreMock<T extends Record<string, unknown>>(actual: T) {
  const codes = actual.AR_ERROR_CODES as Record<string, string>;
  const statusByCode: Record<string, number> = {
    [codes.ADMIN_INSUFFICIENT_PERMISSIONS]: 403,
    [codes.ADMIN_INVALID_REQUEST]: 400,
    [codes.ADMIN_RESOURCE_NOT_FOUND]: 404,
    [codes.ADMIN_CONFLICT]: 409,
    [codes.INTERNAL_ERROR]: 500,
  };
  class FakeInternalNotificationEventRepository {
    enqueue = coreFakes.notificationEnqueue;
  }
  return {
    ...actual,
    requireAdminDatabaseAdapter: vi.fn(() => mockAdapter),
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => mockAdapter),
    getTenantIdFromContext: vi.fn((c: { get: (key: string) => unknown }) => c.get('tenantId')),
    resolveRuntimeLoggingPolicyTargetFromEnv: coreFakes.resolveRuntimeTarget,
    resolveTenantDatabaseSourceFromRegistry: coreFakes.resolveTenantDatabase,
    resolveTenantRuntimeProfilesFromEnv: coreFakes.resolveTenantProfiles,
    ensureDatabaseAdapter: coreFakes.ensureDatabaseAdapter,
    AdminLoggingControlRepository: class FakeAdminLoggingControlRepository {
      detectCatalogRepairFindings = repoFakes.detectCatalogRepairFindings;
      applySafeCatalogRepairs = repoFakes.applySafeCatalogRepairs;
      loadCriticalPolicy = repoFakes.loadCriticalPolicy;
      loadSensitiveDetailPolicy = repoFakes.loadSensitiveDetailPolicy;
      updateCriticalPolicy = repoFakes.updateCriticalPolicy;
      updateSensitiveDetailPolicy = repoFakes.updateSensitiveDetailPolicy;
      upsertCoverageStatuses = repoFakes.upsertCoverageStatuses;
    },
    loadChunkedSensitiveDetailJson: coreFakes.loadChunkedSensitiveDetail,
    retireDeletedLogObjectGeneration: coreFakes.retireGeneration,
    hasCapturingTenantBackupSnapshot: coreFakes.hasBackupSnapshot,
    listCapturingTenantBackupTenantKeys: coreFakes.listBackupTenantKeys,
    InternalNotificationEventRepository: FakeInternalNotificationEventRepository,
    createErrorResponse: vi.fn(
      (
        c: { json: (body: unknown, status?: number) => Response },
        errorCode: string,
        options?: { extensions?: Record<string, unknown> }
      ) =>
        c.json({ error: errorCode, ...(options?.extensions ?? {}) }, statusByCode[errorCode] ?? 500)
    ),
  };
}

export const envFixture = {
  DB_ADMIN: {},
  LOGGING_CURSOR_HMAC_SECRET: 'test-logging-cursor-secret',
  AUTHRIM_CONFIG: { put: vi.fn(), get: vi.fn() },
  LOG_ARCHIVE: { put: vi.fn(), get: vi.fn() },
  SENSITIVE_DETAILS: { put: vi.fn(), get: vi.fn() },
  EXPORT_ARTIFACTS: { put: vi.fn(), get: vi.fn(), delete: vi.fn() },
  AUDIT_ARCHIVE: { put: vi.fn(), get: vi.fn(), delete: vi.fn() },
  OBJECT_ENCRYPTION_ROOT_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
};
export const env = envFixture as unknown as Env;

export function resetFakes(): void {
  vi.clearAllMocks();
  for (const fn of [mockAdapter.query, mockAdapter.queryOne, mockAdapter.execute]) {
    fn.mockReset();
  }
  mockAdapter.query.mockResolvedValue([]);
  mockAdapter.queryOne.mockResolvedValue(null);
  mockAdapter.execute.mockResolvedValue({ rowsAffected: 1 });
  mockAdapter.batch.mockReset().mockResolvedValue([]);
  mockAdapter.transaction.mockReset().mockImplementation(async (cb) => cb(mockAdapter));
  mockAdapter.isHealthy.mockReset().mockResolvedValue(true);
  mockAdapter.getType.mockReset().mockReturnValue('d1');
  auditWrite.mockReset().mockResolvedValue('audit-id-1');
  for (const fn of Object.values(coreFakes)) fn.mockReset();
  coreFakes.hasBackupSnapshot.mockResolvedValue(false);
  coreFakes.listBackupTenantKeys.mockResolvedValue(new Set());
  keysFakes.enqueue.mockReset();
  for (const fn of Object.values(repoFakes)) fn.mockReset();
  repoFakes.detectCatalogRepairFindings.mockResolvedValue([]);
  repoFakes.applySafeCatalogRepairs.mockResolvedValue({ applied: [], skipped: [] });
  readAdapterFakes.queryOne.mockReset().mockResolvedValue(null);
  readAdapterFakes.query.mockReset().mockResolvedValue([]);
  readAdapterFakes.hasArchive.mockReset().mockReturnValue(false);
  readAdapterFakes.coverage.mockReset().mockReturnValue({ complete: true });
  readAdapterFakes.createLogReadAdapter.mockReset().mockReturnValue({
    adapter: { queryOne: readAdapterFakes.queryOne, query: readAdapterFakes.query },
    hasArchive: readAdapterFakes.hasArchive,
    coverage: readAdapterFakes.coverage,
  });
  for (const fn of Object.values(messagingFakes)) fn.mockReset();
  messagingFakes.writePayload.mockResolvedValue({
    objectRef: 'payloads/obj.json',
    sha256: 'sha-1',
    redactedSummary: { redacted: true },
    validationSummary: { valid: true },
  });
  messagingFakes.createJob.mockImplementation(async (input: Record<string, any>) => ({
    id: input.id,
    kind: input.kind,
    status: 'queued',
    lane: input.lane,
    criticality: input.criticality,
    tenantKey: input.topology?.tenantKey ?? null,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    payloadObjectRef: input.payloadObjectRef,
  }));
  messagingFakes.enqueue.mockResolvedValue({
    queued: true,
    bindingName: 'LOGGING_DELIVERY_QUEUE',
    payloadId: 'qpl_1',
  });
  stepUpFakes.requireAdminStepUp.mockReset().mockResolvedValue(null);
  stepUpFakes.refuseAdminFreshAuth.mockReset().mockResolvedValue(null);
  for (const store of [
    envFixture.AUTHRIM_CONFIG,
    envFixture.LOG_ARCHIVE,
    envFixture.SENSITIVE_DETAILS,
    envFixture.EXPORT_ARTIFACTS,
    envFixture.AUDIT_ARCHIVE,
  ]) {
    for (const fn of Object.values(store)) {
      (fn as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue(null);
    }
  }
}
