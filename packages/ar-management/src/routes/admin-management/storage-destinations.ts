import { Hono } from 'hono';
import type { Context } from 'hono';
import type {
  AdminAuthContext,
  AdminResourceScopeType,
  AdminResourceStatus,
  Env,
  StorageDestinationProvider,
} from '@authrim/ar-lib-core';
import {
  ADMIN_PERMISSIONS,
  AR_ERROR_CODES,
  type AdminStorageDestination,
  AdminStorageDestinationRepository,
  createErrorResponse,
  encryptValue,
  getTenantIdFromContext,
  hasAdminPermission,
  requireDedicatedAdminDatabaseAdapter,
} from '@authrim/ar-lib-core';
import {
  validateDestinationProviderConfig,
  type DestinationProvider,
} from '@authrim/ar-lib-logging/destinations';
import { requireAdminPermissionOrElevationGrant } from '../../admin-elevation-access';
import { writeAdminAuditLog } from '../../admin-shared';
import { testStorageDestinationConnectivity } from './connectivity-tests';
import {
  adminActionEnvelope,
  adminDetailEnvelope,
  adminListEnvelope,
  adminMutationEnvelope,
  createAdminFieldErrorResponse,
  fieldError,
} from './response-helpers';

type AdminContext = Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;

const STORAGE_DESTINATION_PROVIDERS = new Set<StorageDestinationProvider>([
  'r2',
  'aws_s3',
  'sftp',
  'custom',
]);
const STORAGE_DESTINATION_STATUSES = new Set<AdminResourceStatus>(['active', 'disabled']);
const STORAGE_DESTINATION_SECRET_KEY_PATTERN =
  /(?:authorization|cookie|token|secret|password|passphrase|credential|private[_-]?key|api[_-]?key|client[_-]?secret|signature|hmac|access[_-]?key)/i;

export const storageDestinationsRouter = new Hono<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}>();

function getAdminAdapter(c: AdminContext) {
  return requireDedicatedAdminDatabaseAdapter(c.env, 'admin-storage-destinations');
}

function getAuth(c: AdminContext): AdminAuthContext {
  return c.get('adminAuth') as AdminAuthContext;
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

function sanitizeStorageDestinationForAuth(
  authContext: AdminAuthContext,
  destination: AdminStorageDestination
): AdminStorageDestination {
  if (hasPlatformAuthority(authContext)) {
    return destination;
  }
  return {
    ...destination,
    config: {},
    credential_key_version: null,
    credential_updated_at: null,
    credential_updated_by: null,
  };
}

function sanitizeStorageDestinationsForAuth(
  authContext: AdminAuthContext,
  destinations: AdminStorageDestination[]
): AdminStorageDestination[] {
  return destinations.map((destination) =>
    sanitizeStorageDestinationForAuth(authContext, destination)
  );
}

function parseConfig(config: unknown): Record<string, unknown> {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return {};
  }
  return config as Record<string, unknown>;
}

function validateStorageDestinationConfig(
  provider: StorageDestinationProvider,
  config: Record<string, unknown>
): { valid: true } | { valid: false; fields: ReturnType<typeof fieldError>[] } {
  const result = validateDestinationProviderConfig(provider as DestinationProvider, config);
  const fields = result.errors.map((error) =>
    fieldError(`config.${error.field}`, error.message, `Config field ${error.field} is required.`)
  );
  const forbiddenPath = findForbiddenStorageDestinationConfigPath(config);
  if (forbiddenPath) {
    fields.push(
      fieldError(
        `config.${forbiddenPath}`,
        'secret_not_allowed',
        'Storage destination config must reference credentials, not include secret values.'
      )
    );
  }
  return fields.length === 0 ? { valid: true } : { valid: false, fields };
}

function findForbiddenStorageDestinationConfigPath(
  config: Record<string, unknown>,
  path: string[] = []
): string | null {
  for (const [key, value] of Object.entries(config)) {
    const nextPath = [...path, key];
    if (STORAGE_DESTINATION_SECRET_KEY_PATTERN.test(key)) {
      return nextPath.join('.');
    }
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) {
        if (item && typeof item === 'object') {
          const nested = findForbiddenStorageDestinationConfigPath(
            item as Record<string, unknown>,
            [...nextPath, String(index)]
          );
          if (nested) {
            return nested;
          }
        }
      }
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = findForbiddenStorageDestinationConfigPath(
        value as Record<string, unknown>,
        nextPath
      );
      if (nested) {
        return nested;
      }
    }
  }
  return null;
}

async function getScope(
  c: AdminContext
): Promise<{ scopeType: AdminResourceScopeType; scopeId: string } | Response> {
  const scopeType = (c.req.query('scope_type') || 'tenant') as AdminResourceScopeType;
  if (scopeType === 'platform') {
    if (!hasPlatformAuthority(getAuth(c))) {
      return await createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    }
    return { scopeType: 'platform', scopeId: 'platform' };
  }
  if (scopeType !== 'tenant') {
    return await createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }
  return { scopeType: 'tenant', scopeId: getTenantIdFromContext(c) };
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
): Promise<{
  encrypted: string;
  keyVersion: number;
} | null> {
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
): Promise<string | null> {
  return writeAdminAuditLog(c, {
    action,
    resourceType: 'admin_storage_destination',
    resourceId,
    result,
    severity: action.includes('credential') || action.includes('delete') ? 'warn' : 'info',
    metadata,
  });
}

async function requireHighRiskApproval(
  c: AdminContext,
  input: { action: string; resourceId: string; detailClass: string }
): Promise<Response | null> {
  const resolution = await requireAdminPermissionOrElevationGrant(c, {
    directPermission: ADMIN_PERMISSIONS.ALL,
    requestSurface: 'storage_destinations',
    requestedAction: input.action,
    resourceClass: 'admin_storage_destination',
    resourceIds: [input.resourceId],
    detailClass: input.detailClass,
  });
  return resolution instanceof Response ? resolution : null;
}

async function requirePlatformMutationAuthority(c: AdminContext): Promise<Response | null> {
  if (hasPlatformAuthority(getAuth(c))) {
    return null;
  }
  return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
}

storageDestinationsRouter.get('/', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_LIST)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  const scope = await getScope(c);
  if (scope instanceof Response) {
    return scope;
  }

  try {
    const repo = new AdminStorageDestinationRepository(getAdminAdapter(c));
    const items = await repo.listByScope(scope.scopeType, scope.scopeId);
    return c.json(adminListEnvelope(sanitizeStorageDestinationsForAuth(authContext, items)));
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

storageDestinationsRouter.get('/usable', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_READ)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  try {
    const repo = new AdminStorageDestinationRepository(getAdminAdapter(c));
    const items = await repo.listUsableForTenant(getTenantIdFromContext(c));
    return c.json(adminListEnvelope(sanitizeStorageDestinationsForAuth(authContext, items)));
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

storageDestinationsRouter.post('/', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_CREATE)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const platformError = await requirePlatformMutationAuthority(c);
  if (platformError) {
    return platformError;
  }

  const scope: { scopeType: AdminResourceScopeType; scopeId: string } = {
    scopeType: 'platform',
    scopeId: 'platform',
  };

  try {
    const body = await c.req.json<{
      name?: string;
      display_name?: string;
      description?: string | null;
      provider?: StorageDestinationProvider;
      config?: unknown;
      credential?: unknown;
      status?: AdminResourceStatus;
    }>();

    if (!body.name || !body.provider || !STORAGE_DESTINATION_PROVIDERS.has(body.provider)) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
    }
    if (body.status !== undefined && !STORAGE_DESTINATION_STATUSES.has(body.status)) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
    }
    const config = parseConfig(body.config);
    const configValidation = validateStorageDestinationConfig(body.provider, config);
    if (!configValidation.valid) {
      return createAdminFieldErrorResponse(c, configValidation.fields);
    }

    let credential: { encrypted: string; keyVersion: number } | null = null;
    if (body.credential !== undefined) {
      if (!hasPermission(authContext, ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_CREDENTIALS_WRITE)) {
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

    const repo = new AdminStorageDestinationRepository(getAdminAdapter(c));
    const created = await repo.createDestination({
      scope_type: scope.scopeType,
      scope_id: scope.scopeId,
      name: body.name.trim(),
      display_name: body.display_name?.trim() || body.name.trim(),
      description: body.description ?? null,
      provider: body.provider,
      config,
      credential_encrypted: credential?.encrypted ?? null,
      credential_key_version: credential?.keyVersion ?? null,
      credential_updated_by: credential ? authContext.userId : null,
      status: body.status ?? 'active',
      created_by: authContext.userId,
    });

    const auditId = await createAuditLog(c, 'storage_destination.create', created.id, 'success', {
      scope_type: created.scope_type,
      scope_id: created.scope_id,
      provider: created.provider,
      credential_set: !!credential,
    });
    return c.json(adminMutationEnvelope(created, { auditId }), 201);
  } catch {
    await createAuditLog(c, 'storage_destination.create', 'unknown', 'failure');
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

storageDestinationsRouter.get('/:id', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_READ)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  try {
    const repo = new AdminStorageDestinationRepository(getAdminAdapter(c));
    const destination = await repo.getDestination(c.req.param('id')!);
    if (!destination) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    if (destination.scope_type === 'platform' && !hasPlatformAuthority(authContext)) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    }
    if (destination.scope_type === 'tenant' && destination.scope_id !== getTenantIdFromContext(c)) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    return c.json(adminDetailEnvelope(sanitizeStorageDestinationForAuth(authContext, destination)));
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

storageDestinationsRouter.patch('/:id', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_UPDATE)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const platformError = await requirePlatformMutationAuthority(c);
  if (platformError) {
    return platformError;
  }

  try {
    const repo = new AdminStorageDestinationRepository(getAdminAdapter(c));
    const existing = await repo.getDestination(c.req.param('id')!);
    if (!existing) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    if (existing.scope_type === 'platform' && !hasPlatformAuthority(authContext)) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    }
    if (existing.scope_type === 'tenant' && existing.scope_id !== getTenantIdFromContext(c)) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const body = await c.req.json<{
      display_name?: string;
      description?: string | null;
      config?: unknown;
      status?: AdminResourceStatus;
    }>();
    if (body.status !== undefined && !STORAGE_DESTINATION_STATUSES.has(body.status)) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
    }
    const config = body.config === undefined ? undefined : parseConfig(body.config);
    if (config !== undefined) {
      const configValidation = validateStorageDestinationConfig(existing.provider, config);
      if (!configValidation.valid) {
        return createAdminFieldErrorResponse(c, configValidation.fields);
      }
    }

    const updated = await repo.updateDestination(existing.id, {
      display_name: body.display_name,
      description: body.description,
      config,
      status: body.status,
      updated_by: authContext.userId,
    });
    if (!updated) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const auditId = await createAuditLog(c, 'storage_destination.update', updated.id, 'success');
    return c.json(adminMutationEnvelope(updated, { auditId }));
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

storageDestinationsRouter.put('/:id/credentials', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_CREDENTIALS_WRITE)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const platformError = await requirePlatformMutationAuthority(c);
  if (platformError) {
    return platformError;
  }

  try {
    const repo = new AdminStorageDestinationRepository(getAdminAdapter(c));
    const existing = await repo.getDestination(c.req.param('id')!);
    if (!existing) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    if (existing.scope_type === 'platform' && !hasPlatformAuthority(authContext)) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    }
    if (existing.scope_type === 'tenant' && existing.scope_id !== getTenantIdFromContext(c)) {
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

    const auditId = await createAuditLog(
      c,
      'storage_destination.credential.update',
      updated.id,
      'success'
    );
    return c.json(adminMutationEnvelope(updated, { auditId }));
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

storageDestinationsRouter.get('/:id/usage', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_USAGE_READ)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  try {
    const repo = new AdminStorageDestinationRepository(getAdminAdapter(c));
    const destination = await repo.getDestination(c.req.param('id')!);
    if (!destination) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    if (destination.scope_type === 'platform' && !hasPlatformAuthority(authContext)) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    }
    if (destination.scope_type === 'tenant' && destination.scope_id !== getTenantIdFromContext(c)) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    const items = await repo.listUsage(destination.id);
    return c.json(adminListEnvelope(items));
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

storageDestinationsRouter.post('/:id/usage', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_UPDATE)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const platformError = await requirePlatformMutationAuthority(c);
  if (platformError) {
    return platformError;
  }

  try {
    const repo = new AdminStorageDestinationRepository(getAdminAdapter(c));
    const destination = await repo.getDestination(c.req.param('id')!);
    if (!destination) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    if (destination.scope_type === 'platform' && !hasPlatformAuthority(authContext)) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    }
    if (destination.scope_type === 'tenant' && destination.scope_id !== getTenantIdFromContext(c)) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const body = await c.req.json<{
      feature?: string;
      resource_type?: string;
      resource_id?: string;
      metadata?: unknown;
    }>();
    if (!body.feature || !body.resource_type || !body.resource_id) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
    }

    const usage = await repo.recordUsage({
      destination_id: destination.id,
      feature: body.feature,
      resource_type: body.resource_type,
      resource_id: body.resource_id,
      tenant_id: getTenantIdFromContext(c),
      metadata: parseConfig(body.metadata),
      created_by: authContext.userId,
    });
    return c.json(adminMutationEnvelope(usage), 201);
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

storageDestinationsRouter.post('/:id/test', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_TEST)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const platformError = await requirePlatformMutationAuthority(c);
  if (platformError) {
    return platformError;
  }

  try {
    const repo = new AdminStorageDestinationRepository(getAdminAdapter(c));
    const destination = await repo.getDestinationWithCredential(c.req.param('id')!);
    if (!destination) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    if (destination.scope_type === 'platform' && !hasPlatformAuthority(authContext)) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    }
    if (destination.scope_type === 'tenant' && destination.scope_id !== getTenantIdFromContext(c)) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    const result = await testStorageDestinationConnectivity(c.env, destination);
    const auditId = await createAuditLog(
      c,
      'storage_destination.test',
      destination.id,
      result.status === 'ok' ? 'success' : 'failure',
      {
        provider: destination.provider,
        status: result.status,
        message: result.message,
      }
    );
    return c.json(adminActionEnvelope(result, { auditId }), result.status === 'error' ? 400 : 200);
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

storageDestinationsRouter.delete('/:id', async (c) => {
  const authContext = getAuth(c);
  if (!hasPermission(authContext, ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_DELETE)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const platformError = await requirePlatformMutationAuthority(c);
  if (platformError) {
    return platformError;
  }

  try {
    const repo = new AdminStorageDestinationRepository(getAdminAdapter(c));
    const existing = await repo.getDestination(c.req.param('id')!);
    if (!existing) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    if (existing.scope_type === 'platform' && !hasPlatformAuthority(authContext)) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    }
    if (existing.scope_type === 'tenant' && existing.scope_id !== getTenantIdFromContext(c)) {
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

    const deleted = await repo.deleteDestination(existing.id, authContext.userId);
    if (!deleted) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const auditId = await createAuditLog(c, 'storage_destination.delete', existing.id, 'success', {
      scope_type: existing.scope_type,
      scope_id: existing.scope_id,
      provider: existing.provider,
    });
    return c.json(adminActionEnvelope({ success: true }, { auditId }));
  } catch (error) {
    if (error instanceof Error && error.message === 'storage_destination_in_use') {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_CONFLICT);
    }
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

export default storageDestinationsRouter;
