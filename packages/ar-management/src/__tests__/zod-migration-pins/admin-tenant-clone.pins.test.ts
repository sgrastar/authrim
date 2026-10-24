/**
 * zod 3 -> 4 migration pins for admin-tenant-clone.ts
 * (TenantCloneRequestSchema, CloneOptionsSchema, CloneSourceSnapshotSchema).
 *
 * `createErrorResponse` is mocked: status comes from the real implementation, the body is
 * `{ error: code, ...options }` so `variables.reason` (joined zod messages) is pinned.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  source: { query: vi.fn(), queryOne: vi.fn(), execute: vi.fn() },
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.source })),
    createAuditLogFromContext: vi.fn(),
    createAuditLog: vi.fn(),
    requireAdminDatabaseAdapter: vi.fn(() => mocks.source),
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(async () => mocks.source),
    createErrorResponse: vi.fn(async (c, code, options) => {
      const real = await actual.createErrorResponse(c, code, options);
      return Response.json({ error: code, ...options }, { status: real.status });
    }),
    getLogger: vi.fn(() => ({ module: vi.fn(() => ({ error: vi.fn() })) })),
  };
});

vi.mock('../../tenant-alias-directory', () => ({
  resolveTenantDiscoveryAliasDirectoryInput: vi.fn(async (_env, input) => ({
    ...input,
    routeProjection: {},
  })),
  prepareTenantDiscoveryAliasDirectory: vi.fn(async () => undefined),
  activateTenantDiscoveryAliasDirectory: vi.fn(async () => undefined),
  ensureActiveTenantDiscoveryAliasDirectory: vi.fn(async () => undefined),
}));
vi.mock('../../admin-tenant-access', () => ({
  requirePlatformTenantManagementAuthority: vi.fn(async () => null),
}));
vi.mock('../../single-tenant-guard', () => ({
  ensureSupportedTenantId: vi.fn(async () => null),
  isSingleTenantMode: vi.fn(() => false),
  createSingleTenantMutationError: vi.fn(),
}));
vi.mock('../../admin-tenants', () => ({
  beginTenantProvisioning: vi.fn(),
  formatTenantProvisioningOperation: vi.fn((operation) => operation),
  provisionTenant: vi.fn(),
  activateProvisionedTenant: vi.fn(),
  rotateProvisionedTenantSigningKey: vi.fn(),
  rollbackProvisionedTenant: vi.fn(),
}));

import {
  adminTenantCloneHandler,
  prepareTenantCloneForProvisioning,
} from '../../admin-tenant-clone';

function context(body: unknown, bodyError = false) {
  return {
    req: {
      path: '/api/admin/tenants/source/clone',
      header: vi.fn(() => undefined),
      param: vi.fn(() => 'source'),
      json: bodyError
        ? vi.fn().mockRejectedValue(new SyntaxError('invalid json'))
        : vi.fn().mockResolvedValue(body),
    },
    env: {},
    get: vi.fn(() => ({ userId: 'admin-1' })),
    json: vi.fn((value: unknown, status = 200) => Response.json(value, { status })),
  } as never;
}

async function clone(body: unknown, bodyError = false) {
  const response = await adminTenantCloneHandler(context(body, bodyError));
  return { status: response.status, body: await response.json() };
}

const invalid = (field: string, reason: string) => ({
  status: 400,
  body: { error: 'AR130003', variables: { field, reason } },
});

/** Passed zod + dependency validation and reached the source-tenant lookup (mock returns null). */
const REACHED_SOURCE_LOOKUP = {
  status: 404,
  body: { error: 'AR060004', variables: { resource: 'source tenant' } },
};

const valid = { id: 'target', name: 'Target' };

describe('zod pins: TenantCloneRequestSchema (POST /tenants/:id/clone)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.source.queryOne.mockReset();
    mocks.source.queryOne.mockResolvedValue(null);
  });

  it('invalid JSON is reported by a hand-written message', async () => {
    expect(await clone(undefined, true)).toEqual(
      invalid('body', 'Request body must be valid JSON')
    );
  });

  it('non-object roots / missing required', async () => {
    expect(await clone(null)).toEqual(invalid('body', 'Expected object, received null'));
    expect(await clone([])).toEqual(invalid('body', 'Expected object, received array'));
    expect(await clone('x')).toEqual(invalid('body', 'Expected object, received string'));
    expect(await clone({})).toEqual(invalid('body', 'Required, Required'));
    expect(await clone({ id: 'target' })).toEqual(invalid('body', 'Required'));
  });

  it('per-field messages (regex() without message yields "Invalid")', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ id: 5, name: 'N' }, 'Expected string, received number'],
      [{ id: '', name: 'N' }, 'String must contain at least 1 character(s), Invalid'],
      [{ id: 'UPPER', name: 'N' }, 'Invalid'],
      [{ id: '-x', name: 'N' }, 'Invalid'],
      [{ id: 'x-', name: 'N' }, 'Invalid'],
      [{ id: 'a'.repeat(64), name: 'N' }, 'String must contain at most 63 character(s)'],
      [{ id: 'platform', name: 'N' }, 'id is reserved'],
      [{ id: 'Platform', name: 'N' }, 'Invalid, id is reserved'],
      [{ id: 'ok', name: '' }, 'String must contain at least 1 character(s)'],
      [{ id: 'ok', name: 'n'.repeat(201) }, 'String must contain at most 200 character(s)'],
      [{ ...valid, tenant_code: 'BAD CODE' }, 'Invalid'],
      [{ ...valid, tenant_code: 'platform' }, 'tenant_code is reserved'],
      [{ ...valid, tenant_code: '' }, 'String must contain at least 1 character(s), Invalid'],
      [{ ...valid, description: 'd'.repeat(501) }, 'String must contain at most 500 character(s)'],
      [{ ...valid, description: 1 }, 'Expected string, received number'],
      [
        { ...valid, isolation_policy: 'dedicated' },
        "Invalid enum value. Expected 'shared_pool' | 'tenant_exclusive', received 'dedicated'",
      ],
      [
        { ...valid, isolation_policy: 5 },
        "Expected 'shared_pool' | 'tenant_exclusive', received number",
      ],
      [{ ...valid, include_clients: 'yes' }, 'Expected boolean, received string'],
      [{ ...valid, include_roles: 1 }, 'Expected boolean, received number'],
      [{ ...valid, include_webhooks: null }, 'Expected boolean, received null'],
      [{ ...valid, copy: 'all' }, 'Expected object, received string'],
      [{ ...valid, copy: null }, 'Expected object, received null'],
      [{ ...valid, copy: [] }, 'Expected object, received array'],
      [{ ...valid, copy: { settings: 'yes' } }, 'Expected boolean, received string'],
      [{ ...valid, copy: { unknown: true } }, "Unrecognized key(s) in object: 'unknown'"],
      [{ ...valid, extra: 1 }, "Unrecognized key(s) in object: 'extra'"],
      [{ ...valid, extra: 1, other: 2 }, "Unrecognized key(s) in object: 'extra', 'other'"],
      [
        { id: 'BAD', name: '', description: 1, include_roles: 'x', copy: { a: 1 }, z: 1 },
        "Invalid, String must contain at least 1 character(s), Expected string, received number, Unrecognized key(s) in object: 'a', Expected boolean, received string, Unrecognized key(s) in object: 'z'",
      ],
    ];
    for (const [body, reason] of cases) {
      expect(await clone(body)).toEqual(invalid('body', reason));
    }
  });

  it('valid minimal / full bodies pass schema and dependency validation', async () => {
    expect(await clone(valid)).toEqual(REACHED_SOURCE_LOOKUP);
    expect(
      await clone({
        id: 'a'.repeat(63),
        tenant_code: 'code-1',
        name: 'n'.repeat(200),
        description: 'd'.repeat(500),
        isolation_policy: 'shared_pool',
        copy: {
          settings: true,
          secret_settings: true,
          clients: true,
          client_credentials: true,
          roles: false,
          admin_access: true,
          webhooks: true,
          webhook_secrets: true,
        },
        include_clients: true,
        include_roles: false,
        include_webhooks: true,
      })
    ).toEqual(REACHED_SOURCE_LOOKUP);
  });

  it('CloneOptions defaults (settings=true, roles=true, others=false) drive dependency validation', async () => {
    // secret_settings needs settings: default settings=true makes this valid
    expect(await clone({ ...valid, copy: { secret_settings: true } })).toEqual(
      REACHED_SOURCE_LOOKUP
    );
    expect(await clone({ ...valid, copy: { settings: false, secret_settings: true } })).toEqual(
      invalid('copy', 'secret_settings requires settings')
    );
    // client_credentials needs clients: default clients=false makes this invalid
    expect(await clone({ ...valid, copy: { client_credentials: true } })).toEqual(
      invalid('copy', 'client_credentials requires clients')
    );
    // legacy include_clients overrides the default (and an explicit copy.clients)
    expect(
      await clone({ ...valid, copy: { client_credentials: true }, include_clients: true })
    ).toEqual(REACHED_SOURCE_LOOKUP);
    expect(
      await clone({
        ...valid,
        copy: { clients: true, client_credentials: true },
        include_clients: false,
      })
    ).toEqual(invalid('copy', 'client_credentials requires clients'));
    expect(await clone({ ...valid, copy: { webhook_secrets: true } })).toEqual(
      invalid('copy', 'webhook_secrets requires webhooks')
    );
    expect(
      await clone({ ...valid, copy: { webhook_secrets: true }, include_webhooks: true })
    ).toEqual(REACHED_SOURCE_LOOKUP);
    // empty copy object == omitted copy
    expect(await clone({ ...valid, copy: {} })).toEqual(REACHED_SOURCE_LOOKUP);
  });

  it('target must differ from source (checked after zod)', async () => {
    expect(await clone({ id: 'source', name: 'Same' })).toEqual(
      invalid('id', 'Destination tenant must differ from source tenant')
    );
  });
});

describe('zod pins: CloneOptionsSchema / CloneSourceSnapshotSchema via prepareTenantCloneForProvisioning', () => {
  const sha = 'a'.repeat(64);
  const operation = (payload: Record<string, unknown>) =>
    ({
      operationKind: 'clone',
      sourceTenantId: 'source',
      tenantId: 'target',
      tenantCode: 'target',
      tenantName: 'Target',
      tenantDescription: null,
      isolationPolicy: 'tenant_exclusive',
      createdBy: 'admin-1',
      preparationPayload: payload,
    }) as never;
  const route = { target: { bindingRef: 'MISSING_BINDING' } } as never;
  const prepare = (payload: Record<string, unknown>) =>
    prepareTenantCloneForProvisioning({} as never, operation(payload), route).then(
      () => 'resolved',
      (error: Error) => error.message
    );
  const snapshot = { tenant_updated_at: 5, database_version: sha, kv_version: sha };
  const INVALID = 'tenant_provisioning_clone_payload_invalid';
  /** schema + dependency checks passed, then the missing target binding stops it */
  const PASSED = 'tenant_provisioning_clone_binding_unavailable';

  it('accepts an empty copy object (all defaults) and a full snapshot', async () => {
    expect(await prepare({ copy: {}, source_snapshot: snapshot })).toBe(PASSED);
    expect(
      await prepare({
        copy: { settings: false, roles: false, clients: true, client_credentials: true },
        source_snapshot: { ...snapshot, tenant_updated_at: 0 },
      })
    ).toBe(PASSED);
  });

  it.each([
    ['copy missing (also fails the 2-key pre-check)', { source_snapshot: snapshot }],
    ['copy null', { copy: null, source_snapshot: snapshot }],
    ['copy unknown key (strict)', { copy: { nope: true }, source_snapshot: snapshot }],
    ['copy wrong type', { copy: { settings: 'true' }, source_snapshot: snapshot }],
    [
      'dependency: secret_settings without settings',
      { copy: { settings: false, secret_settings: true }, source_snapshot: snapshot },
    ],
    [
      'dependency: client_credentials without clients',
      { copy: { client_credentials: true }, source_snapshot: snapshot },
    ],
    [
      'dependency: webhook_secrets without webhooks',
      { copy: { webhook_secrets: true }, source_snapshot: snapshot },
    ],
    ['snapshot missing', { copy: {} }],
    ['snapshot unknown key (strict)', { copy: {}, source_snapshot: { ...snapshot, extra: 1 } }],
    [
      'snapshot negative updated_at',
      { copy: {}, source_snapshot: { ...snapshot, tenant_updated_at: -1 } },
    ],
    [
      'snapshot float updated_at',
      { copy: {}, source_snapshot: { ...snapshot, tenant_updated_at: 1.5 } },
    ],
    [
      'snapshot string updated_at',
      { copy: {}, source_snapshot: { ...snapshot, tenant_updated_at: '5' } },
    ],
    [
      'snapshot short database_version',
      { copy: {}, source_snapshot: { ...snapshot, database_version: 'abc' } },
    ],
    [
      'snapshot upper-case hex',
      { copy: {}, source_snapshot: { ...snapshot, kv_version: 'A'.repeat(64) } },
    ],
    [
      'snapshot 65-char hex (regex is anchored)',
      { copy: {}, source_snapshot: { ...snapshot, kv_version: 'a'.repeat(65) } },
    ],
    ['snapshot null', { copy: {}, source_snapshot: null }],
  ])('rejects: %s', async (_name, payload) => {
    expect(await prepare(payload)).toBe(INVALID);
  });

  it('copy of `undefined` (key present) is rejected: CloneOptionsSchema itself is not optional', async () => {
    expect(await prepare({ copy: undefined, source_snapshot: snapshot })).toBe(INVALID);
  });
});
