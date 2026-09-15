import { Hono } from 'hono';
import { beforeEach, expect, it, vi } from 'vitest';
import { ADMIN_PERMISSIONS, type AdminAuthContext } from '@authrim/ar-lib-core';
import { tenantBackupsRouter } from '../routes/admin-management/tenant-backups';
const state = vi.hoisted(() => ({
  get: vi.fn(),
  listViews: vi.fn(),
  getView: vi.fn(),
  resume: vi.fn(),
  download: vi.fn(),
  cancel: vi.fn(),
  audit: vi.fn(),
  create: vi.fn(),
  load: vi.fn(),
  start: vi.fn(),
  startImport: vi.fn(),
  uploadCreate: vi.fn(),
  uploadGet: vi.fn(),
  uploadPrepare: vi.fn(),
  uploadCancel: vi.fn(),
  uploadAllocate: vi.fn(),
  uploadPart: vi.fn(),
  importCreate: vi.fn(),
}));
let auth: AdminAuthContext;
vi.mock('@authrim/ar-lib-core', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-core')>()),
  adminAuthMiddleware:
    () => async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
      c.set('adminAuth', auth);
      await next();
    },
  getTenantIdFromContext: () => 'tenant-a',
  requireDedicatedAdminDatabaseAdapter: () => ({}),
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/operation-store', () => ({
  TenantBackupOperationStore: class {
    get = state.get;
    requestCancel = state.cancel;
    resumeWaiting = state.resume;
  },
}));
vi.mock('../tenant-backup-operation-read-model', () => ({
  TenantBackupOperationReadModel: class {
    list = state.listViews;
    get = state.getView;
  },
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/operation-request', () => ({
  TenantBackupRequestStore: class {
    create = state.create;
    load = state.load;
    start = state.start;
    startImport = state.startImport;
  },
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/published-artifact-reader', () => ({
  openTenantBackupDownload: state.download,
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/upload-store', () => ({
  TENANT_BACKUP_UPLOAD_PART_BYTES: 8 * 1024 * 1024,
  TenantBackupUploadStore: class {
    create = state.uploadCreate;
    get = state.uploadGet;
    prepareCompletion = state.uploadPrepare;
    requestCancel = state.uploadCancel;
  },
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/allocate-upload', () => ({
  initializeTenantBackupMultipart: state.uploadAllocate,
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/upload-part', () => ({
  uploadTenantBackupPart: state.uploadPart,
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/import-request', () => ({
  TenantBackupImportRequestStore: class {
    create = state.importCreate;
  },
}));
vi.mock('../request-issuer', () => ({
  getCanonicalTenantBaseUrlAsync: async () => 'https://canonical.example',
}));
vi.mock('../admin-shared', () => ({ writeAdminAuditLog: state.audit }));
function request(
  path: string,
  method = 'GET',
  body?: BodyInit,
  env: Record<string, unknown> = {},
  contentType = 'application/json'
) {
  const app = new Hono();
  app.route('/api/admin/tenant-backups', tenantBackupsRouter as never);
  return app.request(
    '/api/admin/tenant-backups/' + path,
    { method, body, headers: body ? { 'Content-Type': contentType } : undefined },
    env
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  auth = {
    userId: 'admin',
    tenantId: 'tenant-a',
    authMethod: 'session',
    actorType: 'human',
    roles: [],
    permissions: [
      ADMIN_PERMISSIONS.BACKUPS_READ,
      ADMIN_PERMISSIONS.BACKUPS_MANAGE,
      ADMIN_PERMISSIONS.BACKUPS_EXPORT,
      ADMIN_PERMISSIONS.BACKUPS_IMPORT,
    ],
    mfaVerified: true,
    authenticationTimeMs: Date.now(),
  };
  state.get.mockImplementation(async (tenant: string) =>
    tenant === 'tenant-a'
      ? {
          id: 'operation',
          kind: 'export',
          state: 'queued',
          phase: 'prepare',
          revision: 0,
          created_at: 1,
          updated_at: 1,
          cursor_json: 'PRIVATE',
          request_digest: 'PRIVATE',
          lease_owner: 'PRIVATE',
        }
      : null
  );
  state.cancel.mockResolvedValue({ state: 'cancelling' });
  state.resume.mockResolvedValue({
    id: 'operation',
    state: 'queued',
    phase: 'await_restore_approval',
    revision: 4,
  });
  state.audit.mockResolvedValue('audit');
  state.create.mockResolvedValue({
    id: 'created-operation',
    kind: 'export',
    state: 'waiting',
    phase: 'unlock',
    revision: 0,
  });
  state.load.mockResolvedValue({
    kind: 'export',
    selection: { logs: { sensitive: false } },
    source: { tenantId: 'tenant-a', issuer: 'https://canonical.example', productVersion: '0.4.2' },
  });
  state.startImport.mockResolvedValue({
    id: 'operation',
    state: 'queued',
    phase: 'prepare',
    revision: 1,
  });
  const upload = {
    id: 'upload-original',
    tenant_id: 'tenant-a',
    actor_id: 'admin',
    expected_bytes: 174,
    expected_sha256: 'a'.repeat(64),
    expires_at: Date.now() + 60_000,
    state: 'uploading',
  };
  state.uploadCreate.mockResolvedValue(upload);
  state.uploadGet.mockResolvedValue(upload);
  state.uploadAllocate.mockResolvedValue(upload);
  state.uploadPart.mockResolvedValue({ partNumber: 1, etag: 'etag-1' });
  state.uploadPrepare.mockResolvedValue({ upload: { ...upload, state: 'completing' }, parts: [] });
  state.uploadCancel.mockResolvedValue({ ...upload, state: 'cancelling' });
  state.importCreate.mockResolvedValue({
    id: 'created-import',
    kind: 'import',
    state: 'waiting',
    phase: 'unlock',
    revision: 0,
  });
  state.listViews.mockResolvedValue([
    {
      id: 'operation',
      kind: 'export',
      state: 'queued',
      phase: 'prepare',
      revision: 0,
      createdAt: 1,
      updatedAt: 1,
      lastErrorCode: null,
    },
  ]);
  state.getView.mockResolvedValue({
    operation: {
      id: 'operation',
      kind: 'export',
      state: 'queued',
      phase: 'prepare',
      revision: 0,
      created_at: 1,
      updated_at: 1,
      last_error_code: null,
      request_digest: 'ab'.repeat(32),
    },
    intent: {
      kind: 'export',
      selection,
      source: {
        tenantId: 'tenant-a',
        issuer: 'https://canonical.example',
        productVersion: '0.4.2',
      },
    },
    view: {
      id: 'operation',
      kind: 'export',
      state: 'queued',
      phase: 'prepare',
      revision: 0,
      createdAt: 1,
      updatedAt: 1,
      lastErrorCode: null,
      selection,
      publication: null,
      preview: null,
    },
  });
});

it('allocates an idempotent encrypted import upload after durable audit evidence', async () => {
  const body = JSON.stringify({
    idempotencyKey: 'upload-request',
    sizeBytes: 174,
    sha256: 'a'.repeat(64),
  });
  const response = await request('uploads', 'POST', body, { IMPORT_ARTIFACTS: {} });
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({
    id: 'upload-original',
    state: 'uploading',
    partSize: 8 * 1024 * 1024,
    partCount: 1,
    expiresAt: expect.any(Number),
  });
  expect(state.uploadCreate).toHaveBeenCalledWith(
    expect.objectContaining({
      tenantId: 'tenant-a',
      actorId: 'admin',
      idempotencyKey: 'upload-request',
      bytes: 174,
      sha256: 'a'.repeat(64),
    })
  );
  expect(state.audit).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      action: 'tenant_backup.upload_requested',
      resourceId: 'upload-original',
    })
  );
  expect(state.uploadAllocate).toHaveBeenCalledAfter(state.audit);
});

it('reads only the authenticated actor-owned upload progress', async () => {
  const response = await request('uploads/upload-original');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    id: 'upload-original',
    state: 'uploading',
    sizeBytes: 174,
    sha256: 'a'.repeat(64),
    expiresAt: expect.any(Number),
  });
  expect(state.uploadGet).toHaveBeenCalledWith(
    { tenantId: 'tenant-a', actorId: 'admin', uploadId: 'upload-original' },
    expect.any(Number)
  );
  state.uploadGet.mockRejectedValueOnce(new Error('not owned'));
  expect((await request('uploads/upload-original')).status).toBe(404);
});

it('fails upload allocation closed on permission, input, storage, audit and identity conflicts', async () => {
  const valid = JSON.stringify({
    idempotencyKey: 'upload-request',
    sizeBytes: 174,
    sha256: 'a'.repeat(64),
  });
  auth.permissions = auth.permissions?.filter(
    (permission) => permission !== ADMIN_PERMISSIONS.BACKUPS_IMPORT
  );
  expect((await request('uploads', 'POST', valid, { IMPORT_ARTIFACTS: {} })).status).toBe(403);
  auth.permissions?.push(ADMIN_PERMISSIONS.BACKUPS_IMPORT);
  expect((await request('uploads', 'POST', '{}', { IMPORT_ARTIFACTS: {} })).status).toBe(400);
  expect((await request('uploads', 'POST', valid)).status).toBe(503);
  state.audit.mockResolvedValueOnce(null);
  expect((await request('uploads', 'POST', valid, { IMPORT_ARTIFACTS: {} })).status).toBe(503);
  expect(state.uploadAllocate).not.toHaveBeenCalled();
  state.uploadCreate.mockRejectedValueOnce(new Error('conflict'));
  expect((await request('uploads', 'POST', valid, { IMPORT_ARTIFACTS: {} })).status).toBe(409);
});

it('uploads bounded binary parts and queues completion without accepting incomplete input', async () => {
  const env = { IMPORT_ARTIFACTS: {} };
  const part = await request(
    'uploads/upload-original/parts/1',
    'PUT',
    new Uint8Array([1, 2, 3]),
    env,
    'application/octet-stream'
  );
  expect(part.status).toBe(200);
  expect(await part.json()).toEqual({ partNumber: 1, etag: 'etag-1' });
  expect(state.uploadPart).toHaveBeenCalledWith(
    expect.objectContaining({
      owner: { tenantId: 'tenant-a', actorId: 'admin', uploadId: 'upload-original' },
      number: 1,
    })
  );
  expect(
    (
      await request(
        'uploads/upload-original/parts/1',
        'PUT',
        new Uint8Array(5000),
        env,
        'application/octet-stream'
      )
    ).status
  ).toBe(200);
  expect((await request('uploads/upload-original/parts/0', 'PUT', '{}', env)).status).toBe(400);

  const complete = await request('uploads/upload-original/complete', 'POST', undefined, env);
  expect(complete.status).toBe(202);
  expect(await complete.json()).toEqual({ id: 'upload-original', state: 'completing' });
  state.uploadPrepare.mockRejectedValueOnce(new Error('incomplete'));
  expect((await request('uploads/upload-original/complete', 'POST', undefined, env)).status).toBe(
    409
  );
});

it('queues actor-owned upload cancellation for asynchronous R2 cleanup', async () => {
  const env = { IMPORT_ARTIFACTS: {} };
  const response = await request('uploads/upload-original/cancel', 'POST', undefined, env);
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ id: 'upload-original', state: 'cancelling' });
  expect(state.audit).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      action: 'tenant_backup.upload_cancel_requested',
      resourceId: 'upload-original',
    })
  );
  expect(state.uploadCancel).toHaveBeenCalledWith(
    { tenantId: 'tenant-a', actorId: 'admin', uploadId: 'upload-original' },
    expect.any(Number)
  );
  state.uploadCancel.mockRejectedValueOnce(new Error('bound'));
  expect((await request('uploads/upload-original/cancel', 'POST', undefined, env)).status).toBe(
    409
  );
});

it('creates an import from verified upload handles without accepting source identity', async () => {
  const response = await request(
    'imports',
    'POST',
    JSON.stringify({ idempotencyKey: 'import-request', selection, uploadIds: ['upload-original'] }),
    { TENANT_BACKUP_WRAPPING_KEY: 'ab'.repeat(32), IMPORT_ARTIFACTS: {} }
  );
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({
    id: 'created-import',
    kind: 'import',
    state: 'waiting',
    phase: 'unlock',
    revision: 0,
  });
  expect(state.importCreate).toHaveBeenCalledWith(
    expect.objectContaining({
      tenantId: 'tenant-a',
      actorId: 'admin',
      idempotencyKey: 'import-request',
      source: {
        tenantId: 'tenant-a',
        issuer: 'https://canonical.example',
        productVersion: '0.4.2',
      },
      selection,
      uploadIds: ['upload-original'],
    })
  );
  expect(state.audit).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      action: 'tenant_backup.import_requested',
      resourceId: expect.any(String),
    })
  );
});

it('rejects import creation without permission, storage, key service or valid handles', async () => {
  const body = JSON.stringify({
    idempotencyKey: 'import-request',
    selection,
    uploadIds: ['upload-original'],
  });
  auth.permissions = auth.permissions?.filter(
    (permission) => permission !== ADMIN_PERMISSIONS.BACKUPS_IMPORT
  );
  expect(
    (
      await request('imports', 'POST', body, {
        TENANT_BACKUP_WRAPPING_KEY: 'ab'.repeat(32),
        IMPORT_ARTIFACTS: {},
      })
    ).status
  ).toBe(403);
  auth.permissions?.push(ADMIN_PERMISSIONS.BACKUPS_IMPORT);
  expect((await request('imports', 'POST', body)).status).toBe(503);
  expect((await request('imports', 'POST', body, { IMPORT_ARTIFACTS: {} })).status).toBe(503);
  expect(
    (
      await request(
        'imports',
        'POST',
        JSON.stringify({ idempotencyKey: 'import-request', selection, uploadIds: [] }),
        { TENANT_BACKUP_WRAPPING_KEY: 'ab'.repeat(32), IMPORT_ARTIFACTS: {} }
      )
    ).status
  ).toBe(400);
  expect(state.importCreate).not.toHaveBeenCalled();
});
it('scopes status by authenticated tenant and returns only public progress', async () => {
  const response = await request('operation');
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(await response.json()).toEqual({
    id: 'operation',
    kind: 'export',
    state: 'queued',
    phase: 'prepare',
    revision: 0,
    createdAt: 1,
    updatedAt: 1,
    lastErrorCode: null,
    selection,
    publication: null,
    preview: null,
  });
  expect(state.getView).toHaveBeenCalledWith('tenant-a', 'operation', expect.any(Number));
  auth.tenantId = 'tenant-b';
  expect((await request('operation')).status).toBe(403);
  auth.tenantId = 'tenant-a';
  state.getView.mockResolvedValueOnce(null);
  expect((await request('operation')).status).toBe(404);
});

it('lists recent operation progress for recovery after reopening Admin UI', async () => {
  const response = await request('operations');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    operations: await state.listViews.mock.results[0]?.value,
  });
  expect(state.listViews).toHaveBeenCalledWith('tenant-a');
});

it('approves only the exact current blocker-free import preview after audit persistence', async () => {
  state.getView.mockResolvedValueOnce({
    operation: {
      id: 'operation',
      kind: 'import',
      state: 'waiting',
      phase: 'await_restore_approval',
      revision: 3,
      request_digest: 'ab'.repeat(32),
    },
    intent: { kind: 'import', selection },
    view: {
      preview: { planDigest: 'cd'.repeat(32), canApprove: true },
    },
  });
  const response = await request(
    'operation/approve',
    'POST',
    JSON.stringify({ revision: 3, planDigest: 'cd'.repeat(32) })
  );
  expect(response.status).toBe(202);
  expect(state.audit).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      action: 'tenant_backup.restore_approved',
      metadata: { revision: 3, planDigest: 'cd'.repeat(32) },
    })
  );
  expect(state.resume).toHaveBeenCalledWith(
    'tenant-a',
    'operation',
    3,
    'ab'.repeat(32),
    expect.any(Number)
  );
});

it('rejects stale or blocked restore approval before audit and resume', async () => {
  state.getView.mockResolvedValueOnce({
    operation: {
      id: 'operation',
      kind: 'import',
      state: 'waiting',
      phase: 'await_restore_approval',
      revision: 3,
      request_digest: 'ab'.repeat(32),
    },
    intent: { kind: 'import', selection },
    view: {
      preview: { planDigest: 'cd'.repeat(32), canApprove: false },
    },
  });
  const response = await request(
    'operation/approve',
    'POST',
    JSON.stringify({ revision: 3, planDigest: 'cd'.repeat(32) })
  );
  expect(response.status).toBe(409);
  expect(state.audit).not.toHaveBeenCalled();
  expect(state.resume).not.toHaveBeenCalled();
});
it.each(['permission', 'tenant', 'mfa', 'stale', 'machine'])(
  'rejects cancel without %s assurance before mutation',
  async (mode) => {
    if (mode === 'permission') auth.permissions = [ADMIN_PERMISSIONS.BACKUPS_READ];
    if (mode === 'tenant') auth.tenantId = undefined;
    if (mode === 'mfa') auth.mfaVerified = false;
    if (mode === 'stale') auth.authenticationTimeMs = 1;
    if (mode === 'machine') auth.authMethod = 'machine_access_token';
    expect((await request('operation/cancel', 'POST')).status).toBe(403);
    expect(state.cancel).not.toHaveBeenCalled();
  }
);
it('requires audit persistence before accepting cancellation and reports conflict', async () => {
  state.audit.mockResolvedValueOnce(null);
  expect((await request('operation/cancel', 'POST')).status).toBe(503);
  expect(state.cancel).not.toHaveBeenCalled();
  expect((await request('operation/cancel', 'POST')).status).toBe(202);
  expect(state.audit).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ action: 'tenant_backup.cancel_requested', resourceId: 'operation' })
  );
  state.cancel.mockResolvedValue(null);
  expect((await request('operation/cancel', 'POST')).status).toBe(409);
});
it('requires the operation-specific permission before cancellation', async () => {
  state.load.mockResolvedValue({ kind: 'import', selection: { logs: { sensitive: false } } });
  auth.permissions = [ADMIN_PERMISSIONS.BACKUPS_READ, ADMIN_PERMISSIONS.BACKUPS_MANAGE];
  expect((await request('operation/cancel', 'POST')).status).toBe(403);
  expect(state.audit).not.toHaveBeenCalled();
  expect(state.cancel).not.toHaveBeenCalled();
});
it('rejects malformed key input and fails closed without a wrapping key', async () => {
  expect(
    (
      await request(
        'operation/key-challenges/c/accept',
        'POST',
        '{"passphrase":"must not be accepted"}'
      )
    ).status
  ).toBe(400);
  expect((await request('operation/key-challenges', 'POST')).status).toBe(503);
  expect(state.audit).not.toHaveBeenCalled();
});

it('requires an operation-owned input identifier for each import key challenge', async () => {
  state.load.mockResolvedValue({
    kind: 'import',
    selection: { logs: { sensitive: false } },
    source: { tenantId: 'tenant-a', issuer: 'https://canonical.example', productVersion: '0.4.2' },
  });
  expect((await request('operation/key-challenges', 'POST')).status).toBe(400);
  expect(
    (
      await request(
        'operation/key-challenges',
        'POST',
        JSON.stringify({ inputId: 'upload-original' })
      )
    ).status
  ).toBe(503);
  auth.permissions = auth.permissions?.filter(
    (permission) => permission !== ADMIN_PERMISSIONS.BACKUPS_IMPORT
  );
  expect(
    (
      await request(
        'operation/key-challenges',
        'POST',
        JSON.stringify({ inputId: 'upload-original' })
      )
    ).status
  ).toBe(403);
});

const selection = {
  settings: true,
  users: false,
  admin: false,
  artifacts: false,
  logs: { audit: false, other: false, sensitive: false, period: 'all' },
};
it('creates an export with the canonical source and returns only waiting progress', async () => {
  const response = await request(
    'exports',
    'POST',
    JSON.stringify({ idempotencyKey: 'request', selection }),
    { TENANT_BACKUP_WRAPPING_KEY: 'ab'.repeat(32), EXPORT_ARTIFACTS: {} }
  );
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({
    id: 'created-operation',
    kind: 'export',
    state: 'waiting',
    phase: 'unlock',
    revision: 0,
  });
  expect(state.create).toHaveBeenCalledWith(
    expect.objectContaining({
      tenantId: 'tenant-a',
      actorId: 'admin',
      idempotencyKey: 'request',
      intent: expect.objectContaining({
        source: {
          tenantId: 'tenant-a',
          issuer: 'https://canonical.example',
          productVersion: '0.4.2',
        },
        selection,
        inputs: [],
      }) as unknown,
    })
  );
});
it('rejects source injection, missing export permission and sensitive detail without permission', async () => {
  const env = { TENANT_BACKUP_WRAPPING_KEY: 'ab'.repeat(32), EXPORT_ARTIFACTS: {} };
  expect(
    (
      await request(
        'exports',
        'POST',
        JSON.stringify({ idempotencyKey: 'request', selection, source: { tenantId: 'other' } }),
        env
      )
    ).status
  ).toBe(400);
  expect(
    (
      await request(
        'exports',
        'POST',
        JSON.stringify({
          idempotencyKey: 'request',
          selection: { ...selection, logs: { ...selection.logs, sensitive: true } },
        }),
        env
      )
    ).status
  ).toBe(403);
  auth.permissions = [ADMIN_PERMISSIONS.BACKUPS_READ, ADMIN_PERMISSIONS.BACKUPS_MANAGE];
  expect(
    (
      await request(
        'exports',
        'POST',
        JSON.stringify({ idempotencyKey: 'request', selection }),
        env
      )
    ).status
  ).toBe(403);
  expect(state.create).not.toHaveBeenCalled();
});

it('starts only a current export source and propagates key or revision conflicts', async () => {
  const env = { TENANT_BACKUP_WRAPPING_KEY: 'ab'.repeat(32), EXPORT_ARTIFACTS: {} };
  state.load.mockResolvedValue({
    kind: 'export',
    selection,
    source: { tenantId: 'tenant-a', issuer: 'https://canonical.example', productVersion: '0.4.2' },
  });
  state.start.mockResolvedValue({
    id: 'operation',
    state: 'queued',
    phase: 'prepare',
    revision: 1,
  });
  const body = JSON.stringify({ challengeId: 'challenge', revision: 0 });
  expect((await request('operation/start', 'POST', body, env)).status).toBe(202);
  expect(state.start).toHaveBeenCalledWith(
    expect.objectContaining({
      tenantId: 'tenant-a',
      operationId: 'operation',
      actorId: 'admin',
      challengeId: 'challenge',
      revision: 0,
    })
  );
  state.start.mockResolvedValue(null);
  expect((await request('operation/start', 'POST', body, env)).status).toBe(409);
  state.start.mockClear();
  state.load.mockResolvedValue({
    kind: 'export',
    selection,
    source: { tenantId: 'tenant-a', issuer: 'https://changed.example', productVersion: '0.4.2' },
  });
  expect((await request('operation/start', 'POST', body, env)).status).toBe(409);
  expect(state.start).not.toHaveBeenCalled();
});

it('starts an import with import permission and import storage', async () => {
  state.load.mockResolvedValue({
    kind: 'import',
    selection,
    source: { tenantId: 'tenant-a', issuer: 'https://canonical.example', productVersion: '0.4.2' },
  });
  const body = JSON.stringify({
    challenges: [{ inputId: 'upload-original', challengeId: 'challenge' }],
    revision: 0,
  });
  const env = { TENANT_BACKUP_WRAPPING_KEY: 'ab'.repeat(32), IMPORT_ARTIFACTS: {} };
  expect((await request('operation/start', 'POST', body, env)).status).toBe(202);
  expect(state.startImport).toHaveBeenCalledWith(
    expect.objectContaining({
      challenges: [{ inputId: 'upload-original', challengeId: 'challenge' }],
    })
  );
  auth.permissions = auth.permissions?.filter(
    (permission) => permission !== ADMIN_PERMISSIONS.BACKUPS_IMPORT
  );
  expect((await request('operation/start', 'POST', body, env)).status).toBe(403);
  auth.permissions?.push(ADMIN_PERMISSIONS.BACKUPS_IMPORT);
  expect(
    (
      await request('operation/start', 'POST', body, {
        TENANT_BACKUP_WRAPPING_KEY: 'ab'.repeat(32),
      })
    ).status
  ).toBe(503);
});

it('rejects creation and start without artifact storage before enqueueing work', async () => {
  const env = { TENANT_BACKUP_WRAPPING_KEY: 'ab'.repeat(32) };
  const create = await request(
    'exports',
    'POST',
    JSON.stringify({ idempotencyKey: 'request', selection }),
    env
  );
  expect(create.status).toBe(503);
  expect(await create.json()).toEqual({ error: 'backup_storage_unavailable' });
  expect(state.create).not.toHaveBeenCalled();
  state.load.mockResolvedValue({
    kind: 'export',
    selection,
    source: { tenantId: 'tenant-a', issuer: 'https://canonical.example', productVersion: '0.4.2' },
  });
  const start = await request(
    'operation/start',
    'POST',
    JSON.stringify({ challengeId: 'challenge', revision: 0 }),
    env
  );
  expect(start.status).toBe(503);
  expect(await start.json()).toEqual({ error: 'backup_storage_unavailable' });
  expect(state.start).not.toHaveBeenCalled();
  expect(state.audit).not.toHaveBeenCalled();
});

it('downloads ciphertext only after authorization and audit persistence', async () => {
  state.load.mockResolvedValue({ kind: 'export', selection: { logs: { sensitive: false } } });
  state.download.mockResolvedValue({
    byteCount: 3,
    chunks: (async function* () {
      expect(state.audit).toHaveBeenCalled();
      yield new Uint8Array([1, 2, 3]);
    })(),
  });
  const response = await request('operation/download', 'GET', undefined, { EXPORT_ARTIFACTS: {} });
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(response.headers.get('Content-Disposition')).toContain('attachment');
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  expect(state.download).toHaveBeenCalledWith(
    expect.objectContaining({ tenantId: 'tenant-a', operationId: 'operation' })
  );
});
it('rejects download without export permission, fresh authentication, or sensitive-log permission', async () => {
  auth.permissions = [ADMIN_PERMISSIONS.BACKUPS_READ];
  expect((await request('operation/download')).status).toBe(403);
  auth.permissions.push(ADMIN_PERMISSIONS.BACKUPS_EXPORT);
  auth.authenticationTimeMs = Date.now() - 600000;
  expect((await request('operation/download')).status).toBe(403);
  auth.authenticationTimeMs = Date.now();
  state.load.mockResolvedValue({ kind: 'export', selection: { logs: { sensitive: true } } });
  expect((await request('operation/download')).status).toBe(403);
  expect(state.download).not.toHaveBeenCalled();
});
it('does not stream when audit fails and reports expired downloads without audit success', async () => {
  state.load.mockResolvedValue({ kind: 'export', selection: { logs: { sensitive: false } } });
  const started = vi.fn();
  state.download.mockResolvedValue({
    byteCount: 3,
    chunks: (async function* () {
      started();
      yield new Uint8Array([1, 2, 3]);
    })(),
  });
  state.audit.mockResolvedValue(false);
  expect(
    (await request('operation/download', 'GET', undefined, { EXPORT_ARTIFACTS: {} })).status
  ).toBe(503);
  expect(started).not.toHaveBeenCalled();
  state.audit.mockClear();
  state.download.mockRejectedValue(new Error('expired'));
  expect(
    (await request('operation/download', 'GET', undefined, { EXPORT_ARTIFACTS: {} })).status
  ).toBe(409);
  expect(state.audit).not.toHaveBeenCalled();
});
