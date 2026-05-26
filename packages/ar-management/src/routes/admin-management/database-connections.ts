import { Hono } from 'hono';
import type { Context } from 'hono';
import type {
  AdminAuthContext,
  AdminResourceStatus,
  DatabaseConnectionProvider,
  Env,
} from '@authrim/ar-lib-core';
import {
  ADMIN_PERMISSIONS,
  AR_ERROR_CODES,
  AdminDatabaseConnectionRepository,
  createAuthContextFromHono,
  createErrorResponse,
  encryptValue,
  getTenantIdFromContext,
  hasAdminPermission,
  requireDedicatedAdminDatabaseAdapter,
  TenantDatabaseRegistryRepository,
} from '@authrim/ar-lib-core';
import { requireAdminPermissionOrElevationGrant } from '../../admin-elevation-access';
import { writeAdminAuditLog } from '../../admin-shared';
import { testDatabaseConnectionConnectivity } from './connectivity-tests';

type AdminContext = Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;

const DATABASE_CONNECTION_PROVIDERS = new Set<DatabaseConnectionProvider>([
  'd1',
  'hyperdrive',
  'postgres',
  'mysql',
  'custom',
]);
const DATABASE_CONNECTION_STATUSES = new Set<AdminResourceStatus>(['active', 'disabled']);

export const databaseConnectionsRouter = new Hono<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}>();

interface ManagedDatabaseConnection {
  id: string;
  name: string;
  display_name: string;
  description: string | null;
  provider: DatabaseConnectionProvider;
  config: Record<string, unknown>;
  managed_by: 'setup';
  read_only: true;
  has_credential: false;
  credential_key_version: null;
  credential_updated_at: null;
  credential_updated_by: null;
  status: AdminResourceStatus;
  created_by: string;
  updated_by: string;
  created_at: number;
  updated_at: number;
  tenant_assignments?: DatabaseConnectionTenantAssignment[];
}

interface DatabaseConnectionTenantAssignment {
  id: string;
  name: string;
  kind: 'tenant' | 'platform';
}

interface TenantLabelRow {
  id: string;
  name: string;
  lifecycle_state?: string;
}

interface AssignableDatabaseConnection {
  id: string;
  name: string;
  config: Record<string, unknown>;
}

const SETUP_D1_CONNECTIONS: Array<{
  id: string;
  bindingRef: 'DB' | 'DB_PII' | 'DB_ADMIN';
  name: string;
  displayName: string;
  role: string;
  logicalSource: string;
  description: string;
}> = [
  {
    id: 'setup-d1-core',
    bindingRef: 'DB',
    name: 'setup-d1-core',
    displayName: 'Core D1',
    role: 'core',
    logicalSource: 'core',
    description: 'Setup-managed D1 database for non-PII auth data and runtime metadata.',
  },
  {
    id: 'setup-d1-pii',
    bindingRef: 'DB_PII',
    name: 'setup-d1-pii',
    displayName: 'PII D1',
    role: 'pii',
    logicalSource: 'pii',
    description: 'Setup-managed D1 database for personal information and identity data.',
  },
  {
    id: 'setup-d1-admin',
    bindingRef: 'DB_ADMIN',
    name: 'setup-d1-admin',
    displayName: 'Admin D1',
    role: 'control',
    logicalSource: 'control',
    description:
      'Setup-managed D1 database for Admin UI users, sessions, audit logs, and control data.',
  },
];

function getAdminAdapter(c: AdminContext) {
  return requireDedicatedAdminDatabaseAdapter(c.env, 'admin-database-connections');
}

function getCoreAdapter(c: AdminContext) {
  return createAuthContextFromHono(
    c as unknown as Context<{ Bindings: Env }>,
    getTenantIdFromContext(c)
  ).coreAdapter;
}

function getAuth(c: AdminContext): AdminAuthContext {
  return c.get('adminAuth') as AdminAuthContext;
}

function hasRuntimeBinding(env: Env, bindingRef: string): boolean {
  return Boolean((env as unknown as Record<string, unknown>)[bindingRef]);
}

function buildSetupD1Connections(env: Env): ManagedDatabaseConnection[] {
  return SETUP_D1_CONNECTIONS.filter((connection) =>
    hasRuntimeBinding(env, connection.bindingRef)
  ).map((connection) => ({
    id: connection.id,
    name: connection.name,
    display_name: connection.displayName,
    description: connection.description,
    provider: 'd1',
    config: {
      bindingRef: connection.bindingRef,
      role: connection.role,
      logicalSource: connection.logicalSource,
      managedBy: 'setup',
    },
    managed_by: 'setup',
    read_only: true,
    has_credential: false,
    credential_key_version: null,
    credential_updated_at: null,
    credential_updated_by: null,
    status: 'active',
    created_by: 'setup',
    updated_by: 'setup',
    created_at: 0,
    updated_at: 0,
  }));
}

function getSetupD1Connection(env: Env, id: string): ManagedDatabaseConnection | null {
  return buildSetupD1Connections(env).find((connection) => connection.id === id) ?? null;
}

async function listTenantLabels(c: AdminContext): Promise<DatabaseConnectionTenantAssignment[]> {
  try {
    const coreBinding = (c.env as unknown as { DB?: { prepare?: unknown } }).DB;
    if (!coreBinding || typeof coreBinding.prepare !== 'function') {
      return [];
    }
    const rows = await getCoreAdapter(c).query<TenantLabelRow>(
      `SELECT id, name, lifecycle_state FROM tenants WHERE lifecycle_state = 'active' ORDER BY name ASC`
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name || row.id,
      kind: 'tenant' as const,
    }));
  } catch {
    return [];
  }
}

async function buildDatabaseTenantAssignments(
  c: AdminContext,
  connections: AssignableDatabaseConnection[]
): Promise<Map<string, DatabaseConnectionTenantAssignment[]>> {
  const tenants = await listTenantLabels(c);
  const tenantById = new Map(tenants.map((tenant) => [tenant.id, tenant]));
  const assignments = new Map<string, DatabaseConnectionTenantAssignment[]>();
  const connectionById = new Map(connections.map((connection) => [connection.id, connection]));
  const connectionByName = new Map(connections.map((connection) => [connection.name, connection]));
  const connectionByBinding = new Map(
    connections
      .map(
        (connection) =>
          [String(connection.config.bindingRef ?? '').toUpperCase(), connection] as const
      )
      .filter(([binding]) => binding.length > 0)
  );

  function add(connectionId: string, assignment: DatabaseConnectionTenantAssignment) {
    const existing = assignments.get(connectionId) ?? [];
    if (!existing.some((item) => item.kind === assignment.kind && item.id === assignment.id)) {
      existing.push(assignment);
      assignments.set(connectionId, existing);
    }
  }

  try {
    const registry = new TenantDatabaseRegistryRepository(getAdminAdapter(c));
    const rows = [
      ...(await registry.listActiveRegistryRowsForRole('tenant_core', 1000, 0)),
      ...(await registry.listActiveRegistryRowsForRole('tenant_pii', 1000, 0)),
      ...(await registry.listActiveRegistryRowsForRole('tenant_audit', 1000, 0)),
      ...(await registry.listActiveRegistryRowsForRole('tenant_custom', 1000, 0)),
    ];
    for (const row of rows) {
      const connection =
        (row.connection_ref
          ? (connectionById.get(row.connection_ref) ?? connectionByName.get(row.connection_ref))
          : undefined) ??
        (row.binding_ref ? connectionByBinding.get(row.binding_ref.toUpperCase()) : undefined);
      const tenant = tenantById.get(row.tenant_id) ?? {
        id: row.tenant_id,
        name: row.tenant_id,
        kind: 'tenant' as const,
      };
      if (connection) {
        add(connection.id, tenant);
      }
    }
  } catch {
    // Registry rows may not exist in older or shared-D1 deployments.
  }

  if (c.env.DEFAULT_STORAGE_PROFILE_ID !== 'builtin:storage:tenant-d1') {
    for (const connection of connections) {
      const binding = String(connection.config.bindingRef ?? '').toUpperCase();
      if ((binding === 'DB' || binding === 'DB_PII') && !assignments.has(connection.id)) {
        for (const tenant of tenants) {
          add(connection.id, tenant);
        }
      }
    }
  }

  for (const connection of connections) {
    const binding = String(connection.config.bindingRef ?? '').toUpperCase();
    if (binding === 'DB_ADMIN') {
      add(connection.id, { id: 'platform', name: 'Platform', kind: 'platform' });
    }
  }

  return assignments;
}

async function attachTenantAssignments<T extends AssignableDatabaseConnection>(
  c: AdminContext,
  connections: T[]
): Promise<Array<T & { tenant_assignments: DatabaseConnectionTenantAssignment[] }>> {
  const assignments = await buildDatabaseTenantAssignments(c, connections);
  return connections.map((connection) => ({
    ...connection,
    tenant_assignments: assignments.get(connection.id) ?? [],
  }));
}

function hasPermission(authContext: AdminAuthContext, permission: string): boolean {
  return hasAdminPermission(authContext.permissions || [], permission);
}

function hasPlatformAuthority(authContext: AdminAuthContext): boolean {
  return (
    hasAdminPermission(authContext.permissions || [], ADMIN_PERMISSIONS.ALL) ||
    (authContext.roles || []).includes('super_admin') ||
    (authContext.roles || []).includes('system_admin')
  );
}

function parseConfig(config: unknown): Record<string, unknown> {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return {};
  }
  return config as Record<string, unknown>;
}

function getCredentialEncryptionKey(env: Env): { key: string; version: number } | null {
  const key =
    env.ADMIN_CREDENTIAL_ENCRYPTION_KEY || env.RP_TOKEN_ENCRYPTION_KEY || env.PII_ENCRYPTION_KEY;
  if (!key) {
    return null;
  }
  const version = Number.parseInt(env.PII_ENCRYPTION_KEY_VERSION || '1', 10) || 1;
  return { key, version };
}

async function encryptCredential(
  c: AdminContext,
  credential: unknown
): Promise<{ encrypted: string; keyVersion: number } | null> {
  const keyInfo = getCredentialEncryptionKey(c.env);
  if (!keyInfo) {
    return null;
  }
  const plaintext = typeof credential === 'string' ? credential : JSON.stringify(credential ?? {});
  const encrypted = await encryptValue(plaintext, keyInfo.key, 'AES-256-GCM', keyInfo.version);
  return {
    encrypted: encrypted.encrypted,
    keyVersion: encrypted.keyVersion,
  };
}

async function createAuditLog(
  c: AdminContext,
  action: string,
  resourceId: string,
  result: 'success' | 'failure',
  metadata?: Record<string, unknown>
): Promise<void> {
  await writeAdminAuditLog(c, {
    action,
    resourceType: 'admin_database_connection',
    resourceId,
    result,
    severity: action.includes('credential') || action.includes('delete') ? 'warn' : 'info',
    metadata,
  });
}

async function requirePlatform(c: AdminContext): Promise<Response | null> {
  if (hasPlatformAuthority(getAuth(c))) {
    return null;
  }
  return await createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
}

async function requireHighRiskApproval(
  c: AdminContext,
  input: { action: string; resourceId: string; detailClass: string }
): Promise<Response | null> {
  const resolution = await requireAdminPermissionOrElevationGrant(c, {
    directPermission: ADMIN_PERMISSIONS.ALL,
    requestSurface: 'database_connections',
    requestedAction: input.action,
    resourceClass: 'admin_database_connection',
    resourceIds: [input.resourceId],
    detailClass: input.detailClass,
  });
  return resolution instanceof Response ? resolution : null;
}

databaseConnectionsRouter.get('/', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.DATABASE_CONNECTIONS_LIST)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const platformError = await requirePlatform(c);
  if (platformError) {
    return platformError;
  }

  try {
    const repo = new AdminDatabaseConnectionRepository(getAdminAdapter(c));
    const storedItems = await repo.listConnections();
    const setupItems = buildSetupD1Connections(c.env);
    const setupBindingRefs = new Set(
      setupItems.map((item) => String(item.config.bindingRef ?? '').toUpperCase())
    );
    const items = [
      ...setupItems,
      ...storedItems.filter((item) => {
        const bindingRef = String(item.config.bindingRef ?? '').toUpperCase();
        return !bindingRef || !setupBindingRefs.has(bindingRef);
      }),
    ];
    const itemsWithAssignments = await attachTenantAssignments(c, items);
    return c.json({ items: itemsWithAssignments, total: itemsWithAssignments.length });
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

databaseConnectionsRouter.post('/', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.DATABASE_CONNECTIONS_CREATE)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const platformError = await requirePlatform(c);
  if (platformError) {
    return platformError;
  }

  try {
    const body = await c.req.json<{
      name?: string;
      display_name?: string;
      description?: string | null;
      provider?: DatabaseConnectionProvider;
      config?: unknown;
      credential?: unknown;
      status?: AdminResourceStatus;
    }>();

    if (!body.name || !body.provider || !DATABASE_CONNECTION_PROVIDERS.has(body.provider)) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
    }
    if (body.status !== undefined && !DATABASE_CONNECTION_STATUSES.has(body.status)) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
    }

    let credential: { encrypted: string; keyVersion: number } | null = null;
    if (body.credential !== undefined) {
      if (!hasPermission(authContext, ADMIN_PERMISSIONS.DATABASE_CONNECTIONS_CREDENTIALS_WRITE)) {
        return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
      }
      credential = await encryptCredential(c, body.credential);
      if (!credential) {
        return c.json(
          {
            error: 'credential_encryption_not_configured',
            error_description:
              'ADMIN_CREDENTIAL_ENCRYPTION_KEY, RP_TOKEN_ENCRYPTION_KEY, or PII_ENCRYPTION_KEY is required to store credentials.',
          },
          500
        );
      }
    }

    const repo = new AdminDatabaseConnectionRepository(getAdminAdapter(c));
    const created = await repo.createConnection({
      name: body.name.trim(),
      display_name: body.display_name?.trim() || body.name.trim(),
      description: body.description ?? null,
      provider: body.provider,
      config: parseConfig(body.config),
      credential_encrypted: credential?.encrypted ?? null,
      credential_key_version: credential?.keyVersion ?? null,
      credential_updated_by: credential ? authContext.userId : null,
      status: body.status ?? 'active',
      created_by: authContext.userId,
    });

    await createAuditLog(c, 'database_connection.create', created.id, 'success', {
      provider: created.provider,
      credential_set: !!credential,
    });
    return c.json(created, 201);
  } catch {
    await createAuditLog(c, 'database_connection.create', 'unknown', 'failure');
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

databaseConnectionsRouter.get('/:id', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.DATABASE_CONNECTIONS_READ)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const platformError = await requirePlatform(c);
  if (platformError) {
    return platformError;
  }

  try {
    const setupConnection = getSetupD1Connection(c.env, c.req.param('id')!);
    if (setupConnection) {
      const [connection] = await attachTenantAssignments(c, [setupConnection]);
      return c.json(connection);
    }

    const repo = new AdminDatabaseConnectionRepository(getAdminAdapter(c));
    const connection = await repo.getConnection(c.req.param('id')!);
    if (!connection) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    const [connectionWithAssignments] = await attachTenantAssignments(c, [connection]);
    return c.json(connectionWithAssignments);
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

databaseConnectionsRouter.patch('/:id', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.DATABASE_CONNECTIONS_UPDATE)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const platformError = await requirePlatform(c);
  if (platformError) {
    return platformError;
  }

  try {
    const body = await c.req.json<{
      display_name?: string;
      description?: string | null;
      config?: unknown;
      status?: AdminResourceStatus;
    }>();
    if (body.status !== undefined && !DATABASE_CONNECTION_STATUSES.has(body.status)) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
    }

    const repo = new AdminDatabaseConnectionRepository(getAdminAdapter(c));
    const updated = await repo.updateConnection(c.req.param('id')!, {
      display_name: body.display_name,
      description: body.description,
      config: body.config === undefined ? undefined : parseConfig(body.config),
      status: body.status,
      updated_by: authContext.userId,
    });
    if (!updated) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    await createAuditLog(c, 'database_connection.update', updated.id, 'success');
    return c.json(updated);
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

databaseConnectionsRouter.put('/:id/credentials', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.DATABASE_CONNECTIONS_CREDENTIALS_WRITE)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const platformError = await requirePlatform(c);
  if (platformError) {
    return platformError;
  }

  try {
    const repo = new AdminDatabaseConnectionRepository(getAdminAdapter(c));
    const existing = await repo.getConnection(c.req.param('id')!);
    if (!existing) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const approvalError = await requireHighRiskApproval(c, {
      action: 'credential_update',
      resourceId: existing.id,
      detailClass: 'credential',
    });
    if (approvalError) {
      return approvalError;
    }

    const body = await c.req.json<{ credential?: unknown }>();
    if (body.credential === undefined) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
    }

    const credential = await encryptCredential(c, body.credential);
    if (!credential) {
      return c.json(
        {
          error: 'credential_encryption_not_configured',
          error_description:
            'ADMIN_CREDENTIAL_ENCRYPTION_KEY, RP_TOKEN_ENCRYPTION_KEY, or PII_ENCRYPTION_KEY is required to store credentials.',
        },
        500
      );
    }

    const updated = await repo.updateCredential(existing.id, {
      credential_encrypted: credential.encrypted,
      key_version: credential.keyVersion,
      updated_by: authContext.userId,
    });
    if (!updated) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    await createAuditLog(c, 'database_connection.credential.update', updated.id, 'success');
    return c.json(updated);
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

databaseConnectionsRouter.post('/:id/test', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.DATABASE_CONNECTIONS_TEST)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const platformError = await requirePlatform(c);
  if (platformError) {
    return platformError;
  }

  try {
    const repo = new AdminDatabaseConnectionRepository(getAdminAdapter(c));
    const setupConnection = getSetupD1Connection(c.env, c.req.param('id')!);
    const connection = setupConnection
      ? { ...setupConnection, credential_encrypted: null }
      : await repo.getConnectionWithCredential(c.req.param('id')!);
    if (!connection) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    const result = await testDatabaseConnectionConnectivity(c.env, connection);
    await createAuditLog(
      c,
      'database_connection.test',
      connection.id,
      result.status === 'ok' ? 'success' : 'failure',
      {
        provider: connection.provider,
        status: result.status,
        message: result.message,
      }
    );
    return c.json(result, result.status === 'error' ? 400 : 200);
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

databaseConnectionsRouter.get('/:id/usage', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.DATABASE_CONNECTIONS_READ)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const platformError = await requirePlatform(c);
  if (platformError) {
    return platformError;
  }

  try {
    const repo = new AdminDatabaseConnectionRepository(getAdminAdapter(c));
    const connection = await repo.getConnection(c.req.param('id')!);
    if (!connection) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    const items = await repo.listUsage(connection.id);
    return c.json({ items, total: items.length });
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

databaseConnectionsRouter.delete('/:id', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.DATABASE_CONNECTIONS_DELETE)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const platformError = await requirePlatform(c);
  if (platformError) {
    return platformError;
  }

  try {
    const repo = new AdminDatabaseConnectionRepository(getAdminAdapter(c));
    const existing = await repo.getConnection(c.req.param('id')!);
    if (!existing) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const approvalError = await requireHighRiskApproval(c, {
      action: 'delete',
      resourceId: existing.id,
      detailClass: 'destructive',
    });
    if (approvalError) {
      return approvalError;
    }

    const deleted = await repo.deleteConnection(existing.id, authContext.userId);
    if (!deleted) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    await createAuditLog(c, 'database_connection.delete', existing.id, 'success', {
      provider: existing.provider,
    });
    return c.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === 'database_connection_in_use') {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_CONFLICT);
    }
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

export default databaseConnectionsRouter;
