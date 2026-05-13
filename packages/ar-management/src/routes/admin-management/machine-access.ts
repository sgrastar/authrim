import { Hono } from 'hono';
import type { Context } from 'hono';
import type {
  AdminAuthContext,
  AdminMachineCredentialAlgorithm,
  AdminMachineCredentialStatus,
  AdminMachinePrincipalStatus,
  AdminMachinePrincipalType,
  AdminMachineTenantScope,
  Env,
} from '@authrim/ar-lib-core';
import {
  ADMIN_PERMISSIONS,
  AR_ERROR_CODES,
  AdminMachineAccessRepository,
  adminAuthMiddleware,
  createErrorResponse,
  hasAdminPermission,
  requireDedicatedAdminDatabaseAdapter,
} from '@authrim/ar-lib-core';
import { writeAdminAuditLog } from '../../admin-shared';

type AdminContext = Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;

const PRINCIPAL_TYPES = new Set<AdminMachinePrincipalType>([
  'setup_tool',
  'admin_ui_bff',
  'automation',
  'ci',
  'mcp_server',
  'ai_agent',
  'internal_service',
  'integration',
]);

const CREDENTIAL_ALGORITHMS = new Set<AdminMachineCredentialAlgorithm>([
  'ES256',
  'PS256',
  'RS256',
]);
const DEFAULT_ROTATION_OVERLAP_SECONDS = 24 * 60 * 60;
const MAX_ROTATION_OVERLAP_SECONDS = 7 * 24 * 60 * 60;

export const machineAccessRouter = new Hono<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}>();

machineAccessRouter.use(
  '*',
  adminAuthMiddleware({
    requirePermissions: [ADMIN_PERMISSIONS.ADMIN_MACHINE_ACCESS_READ],
  })
);

function getRepo(c: AdminContext): AdminMachineAccessRepository {
  return new AdminMachineAccessRepository(
    requireDedicatedAdminDatabaseAdapter(c.env, 'admin-machine-access-management')
  );
}

function getAuth(c: AdminContext): AdminAuthContext {
  return c.get('adminAuth') as AdminAuthContext;
}

function actorRef(c: AdminContext) {
  const auth = getAuth(c);
  return {
    actorType:
      auth.actorType ?? (auth.authMethod === 'machine_access_token' ? 'machine' : 'admin_user'),
    actorId: auth.actorId ?? auth.userId,
  };
}

async function requirePermission(c: AdminContext, permission: string): Promise<Response | null> {
  if (hasAdminPermission(getAuth(c).permissions || [], permission)) {
    return null;
  }
  return await createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : [];
}

function parsePermissionsForActor(c: AdminContext, value: unknown): string[] | null {
  const permissions = asStringArray(value);
  const actorPermissions = getAuth(c).permissions || [];
  return permissions.every((permission) => hasAdminPermission(actorPermissions, permission))
    ? permissions
    : null;
}

function asOptionalNonEmptyString(value: unknown): string | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  const parsed = asString(value);
  return parsed ?? null;
}

function asOptionalEpochMs(value: unknown): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value < 1e12 ? Math.floor(value * 1000) : Math.floor(value);
}

function parseTenantScopes(value: unknown): AdminMachineTenantScope[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return [{ scopeMode: 'none', tenantId: null }];
  }

  const scopes = value
    .map((entry): AdminMachineTenantScope | null => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return null;
      }
      const record = entry as Record<string, unknown>;
      const scopeMode = record.scope_mode;
      const tenantId = record.tenant_id;
      if (scopeMode === 'none' || scopeMode === 'all') {
        return { scopeMode, tenantId: null };
      }
      if (scopeMode === 'allow' && typeof tenantId === 'string' && tenantId.length > 0) {
        return { scopeMode, tenantId };
      }
      return null;
    })
    .filter((entry): entry is AdminMachineTenantScope => entry !== null);
  return scopes.length === value.length ? scopes : null;
}

function isGlobalAdminActor(auth: AdminAuthContext): boolean {
  return (auth.tenantScope ?? []).includes('*');
}

function tenantScopesWithinActorScope(
  auth: AdminAuthContext,
  scopes: AdminMachineTenantScope[]
): boolean {
  if (isGlobalAdminActor(auth)) {
    return true;
  }

  const allowedTenantIds = new Set(auth.tenantScope ?? (auth.tenantId ? [auth.tenantId] : []));
  if (allowedTenantIds.size === 0) {
    return false;
  }

  return (
    scopes.length > 0 &&
    scopes.every(
      (scope) =>
        scope.scopeMode === 'allow' && scope.tenantId && allowedTenantIds.has(scope.tenantId)
    )
  );
}

function validateTenantScopesForActor(
  auth: AdminAuthContext,
  scopes: AdminMachineTenantScope[] | null
): AdminMachineTenantScope[] | null {
  if (!scopes) {
    return null;
  }
  if (isGlobalAdminActor(auth)) {
    return scopes;
  }

  const allowedTenantIds = new Set(auth.tenantScope ?? (auth.tenantId ? [auth.tenantId] : []));
  for (const scope of scopes) {
    if (scope.scopeMode === 'all') {
      return null;
    }
    if (scope.scopeMode === 'allow' && (!scope.tenantId || !allowedTenantIds.has(scope.tenantId))) {
      return null;
    }
  }
  return scopes;
}

function parseTenantScopesForActor(
  c: AdminContext,
  value: unknown
): AdminMachineTenantScope[] | null {
  return validateTenantScopesForActor(getAuth(c), parseTenantScopes(value));
}

async function getVisiblePrincipalResponse(
  c: AdminContext,
  repo: AdminMachineAccessRepository,
  principalId: string
) {
  const principal = await principalResponse(repo, principalId);
  if (!principal) {
    return null;
  }
  return tenantScopesWithinActorScope(getAuth(c), principal.tenantScopes) ? principal : null;
}

async function principalIsWithinActorScope(
  c: AdminContext,
  repo: AdminMachineAccessRepository,
  principalId: string
): Promise<boolean> {
  const tenantScopes = await repo.getPrincipalTenantScopes(principalId);
  return tenantScopesWithinActorScope(getAuth(c), tenantScopes);
}

async function credentialIsWithinActorScope(
  c: AdminContext,
  repo: AdminMachineAccessRepository,
  principalId: string,
  credentialId: string
): Promise<boolean> {
  const [principalScopes, credentialScopes] = await Promise.all([
    repo.getPrincipalTenantScopes(principalId),
    repo.getCredentialTenantScopes(credentialId),
  ]);
  const effectiveScopes = credentialScopes.length > 0 ? credentialScopes : principalScopes;
  return (
    tenantScopesWithinActorScope(getAuth(c), principalScopes) &&
    tenantScopesWithinActorScope(getAuth(c), effectiveScopes)
  );
}

const PRIVATE_JWK_FIELDS = new Set([
  'd',
  'p',
  'q',
  'dp',
  'dq',
  'qi',
  'oth',
  'k',
]);

function hasPrivateJwkMaterial(jwk: Record<string, unknown>): boolean {
  return Object.keys(jwk).some((key) => PRIVATE_JWK_FIELDS.has(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function validatePublicJwk(jwk: Record<string, unknown>, alg: AdminMachineCredentialAlgorithm): boolean {
  if (hasPrivateJwkMaterial(jwk)) {
    return false;
  }
  if (jwk.alg !== undefined && jwk.alg !== alg) {
    return false;
  }
  if (jwk.use !== undefined && jwk.use !== 'sig') {
    return false;
  }
  if (
    Array.isArray(jwk.key_ops) &&
    jwk.key_ops.some((operation) =>
      ['sign', 'decrypt', 'unwrapKey', 'deriveKey', 'deriveBits'].includes(String(operation))
    )
  ) {
    return false;
  }

  if (alg === 'ES256') {
    return (
      jwk.kty === 'EC' &&
      jwk.crv === 'P-256' &&
      isNonEmptyString(jwk.x) &&
      isNonEmptyString(jwk.y)
    );
  }
  return jwk.kty === 'RSA' && isNonEmptyString(jwk.n) && isNonEmptyString(jwk.e);
}

function parsePublicJwkJson(value: unknown, alg: AdminMachineCredentialAlgorithm): string | null {
  const jwk = typeof value === 'string' ? JSON.parse(value) : value;
  if (!jwk || typeof jwk !== 'object' || Array.isArray(jwk)) {
    return null;
  }
  const record = jwk as Record<string, unknown>;
  return validatePublicJwk(record, alg) ? JSON.stringify(record) : null;
}

function parseRotationOverlapSeconds(value: unknown): number | null {
  if (value === undefined || value === null) {
    return DEFAULT_ROTATION_OVERLAP_SECONDS;
  }
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > MAX_ROTATION_OVERLAP_SECONDS
  ) {
    return null;
  }
  return value;
}

async function principalResponse(repo: AdminMachineAccessRepository, principalId: string) {
  const principal = await repo.findPrincipalById(principalId);
  if (!principal) {
    return null;
  }
  const [permissions, tenantScopes, credentials] = await Promise.all([
    repo.getPrincipalPermissions(principal.id),
    repo.getPrincipalTenantScopes(principal.id),
    repo.listCredentials(principal.id),
  ]);
  return {
    ...principal,
    permissions,
    tenantScopes,
    credentials,
  };
}

machineAccessRouter.get('/principals', async (c) => {
  const repo = getRepo(c);
  const statusQuery = c.req.query('status');
  const status =
    statusQuery === 'active' || statusQuery === 'disabled' || statusQuery === 'deleted'
      ? (statusQuery as AdminMachinePrincipalStatus)
      : undefined;
  const principalTypeQuery = c.req.query('principal_type');
  const principalType =
    principalTypeQuery && PRINCIPAL_TYPES.has(principalTypeQuery as AdminMachinePrincipalType)
      ? (principalTypeQuery as AdminMachinePrincipalType)
      : undefined;
  const page = Math.max(Number.parseInt(c.req.query('page') || '1', 10), 1);
  const limit = Math.min(Math.max(Number.parseInt(c.req.query('limit') || '50', 10), 1), 100);
  const principals = await repo.listPrincipals({
    status,
    principalType,
    limit,
    offset: (page - 1) * limit,
  });
  const items = await Promise.all(
    principals.map(async (principal) => getVisiblePrincipalResponse(c, repo, principal.id))
  );
  return c.json({
    items: items.filter(Boolean),
    page,
    limit,
  });
});

machineAccessRouter.post('/principals', async (c) => {
  const forbidden = await requirePermission(c, ADMIN_PERMISSIONS.ADMIN_MACHINE_ACCESS_WRITE);
  if (forbidden) return forbidden;

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const clientId = asString(body?.client_id);
  const displayName = asString(body?.display_name);
  const principalType = body?.principal_type;
  const tokenTtlSeconds = Number(body?.token_ttl_seconds ?? 600);
  if (
    !clientId ||
    !displayName ||
    typeof principalType !== 'string' ||
    !PRINCIPAL_TYPES.has(principalType as AdminMachinePrincipalType) ||
    !Number.isInteger(tokenTtlSeconds) ||
    tokenTtlSeconds <= 0 ||
    tokenTtlSeconds > 900
  ) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }

  const repo = getRepo(c);
  const actor = actorRef(c);
  const tenantScopes = parseTenantScopesForActor(c, body?.tenant_scopes);
  const permissions = parsePermissionsForActor(c, body?.permissions);
  if (!tenantScopes || !permissions) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }
  const principal = await repo.createPrincipal({
    clientId,
    displayName,
    description: body?.description === null ? null : asString(body?.description),
    principalType: principalType as AdminMachinePrincipalType,
    tokenTtlSeconds,
    createdBy: actor,
  });
  await repo.setPrincipalPermissions(principal.id, permissions, actor);
  await repo.setPrincipalTenantScopes(principal.id, tenantScopes, actor);
  await writeAdminAuditLog(c, {
    action: 'admin_machine_access.principal.created',
    resourceType: 'admin_machine_principal',
    resourceId: principal.id,
    result: 'success',
    metadata: { client_id: clientId, principal_type: principalType },
  });

  return c.json({ principal: await principalResponse(repo, principal.id) }, 201);
});

machineAccessRouter.get('/principals/:id', async (c) => {
  const repo = getRepo(c);
  const principal = await getVisiblePrincipalResponse(c, repo, c.req.param('id'));
  if (!principal) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  }
  return c.json({ principal });
});

machineAccessRouter.patch('/principals/:id', async (c) => {
  const forbidden = await requirePermission(c, ADMIN_PERMISSIONS.ADMIN_MACHINE_ACCESS_WRITE);
  if (forbidden) return forbidden;

  const repo = getRepo(c);
  const principalId = c.req.param('id');
  const existing = await repo.findPrincipalById(principalId);
  if (!existing) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  }
  if (!(await principalIsWithinActorScope(c, repo, principalId))) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  }

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const tokenTtlSeconds =
    body?.token_ttl_seconds === undefined ? undefined : Number(body.token_ttl_seconds);
  if (
    tokenTtlSeconds !== undefined &&
    (!Number.isInteger(tokenTtlSeconds) || tokenTtlSeconds <= 0 || tokenTtlSeconds > 900)
  ) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }

  const displayName = asOptionalNonEmptyString(body?.display_name);
  if (displayName === null) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }

  const actor = actorRef(c);
  await repo.updatePrincipal(principalId, {
    displayName,
    description: body?.description === undefined ? undefined : asString(body.description),
    tokenTtlSeconds,
  });
  if (body?.permissions !== undefined) {
    const permissions = parsePermissionsForActor(c, body.permissions);
    if (!permissions) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
    }
    await repo.setPrincipalPermissions(principalId, permissions, actor);
  }
  if (body?.tenant_scopes !== undefined) {
    const tenantScopes = parseTenantScopesForActor(c, body.tenant_scopes);
    if (!tenantScopes) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
    }
    await repo.setPrincipalTenantScopes(principalId, tenantScopes, actor);
  }
  await writeAdminAuditLog(c, {
    action: 'admin_machine_access.principal.updated',
    resourceType: 'admin_machine_principal',
    resourceId: principalId,
    result: 'success',
  });

  return c.json({ principal: await principalResponse(repo, principalId) });
});

machineAccessRouter.delete('/principals/:id', async (c) => {
  const forbidden = await requirePermission(c, ADMIN_PERMISSIONS.ADMIN_MACHINE_ACCESS_DELETE);
  if (forbidden) return forbidden;

  const repo = getRepo(c);
  const principalId = c.req.param('id');
  const existing = await repo.findPrincipalById(principalId);
  if (!existing) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  }
  if (!(await principalIsWithinActorScope(c, repo, principalId))) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  }
  await repo.updatePrincipal(principalId, {
    status: 'deleted',
    disabledBy: actorRef(c),
  });
  await writeAdminAuditLog(c, {
    action: 'admin_machine_access.principal.deleted',
    resourceType: 'admin_machine_principal',
    resourceId: principalId,
    result: 'success',
    severity: 'warn',
  });
  return c.json({ success: true });
});

machineAccessRouter.post('/principals/:id/credentials', async (c) => {
  const forbidden = await requirePermission(c, ADMIN_PERMISSIONS.ADMIN_MACHINE_ACCESS_WRITE);
  if (forbidden) return forbidden;

  const repo = getRepo(c);
  const principalId = c.req.param('id');
  const principal = await repo.findPrincipalById(principalId);
  if (!principal) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  }
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const kid = asString(body?.kid);
  const displayName = asString(body?.display_name);
  const alg = body?.alg;
  let publicJwkJson: string | null = null;
  try {
    publicJwkJson =
      typeof alg === 'string' && CREDENTIAL_ALGORITHMS.has(alg as AdminMachineCredentialAlgorithm)
        ? parsePublicJwkJson(
            body?.public_jwk_json ?? body?.public_jwk,
            alg as AdminMachineCredentialAlgorithm
          )
        : null;
  } catch {
    publicJwkJson = null;
  }
  const tenantScopes = parseTenantScopesForActor(c, body?.tenant_scopes);
  const permissions = parsePermissionsForActor(c, body?.permissions);
  if (
    !kid ||
    !displayName ||
    typeof alg !== 'string' ||
    !CREDENTIAL_ALGORITHMS.has(alg as AdminMachineCredentialAlgorithm) ||
    !publicJwkJson ||
    !tenantScopes ||
    !permissions ||
    !(await principalIsWithinActorScope(c, repo, principalId))
  ) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }

  const actor = actorRef(c);
  const credential = await repo.createCredential({
    principalId,
    kid,
    publicJwkJson,
    alg: alg as AdminMachineCredentialAlgorithm,
    displayName,
    description: body?.description === null ? null : asString(body?.description),
    notBefore: asOptionalEpochMs(body?.not_before) ?? null,
    expiresAt: asOptionalEpochMs(body?.expires_at) ?? null,
    createdBy: actor,
  });
  await repo.setCredentialPermissions(credential.id, permissions, actor);
  await repo.setCredentialTenantScopes(credential.id, tenantScopes, actor);
  await writeAdminAuditLog(c, {
    action: 'admin_machine_access.credential.created',
    resourceType: 'admin_machine_credential',
    resourceId: credential.id,
    result: 'success',
    metadata: { principal_id: principalId, kid },
  });

  return c.json({ credential }, 201);
});

machineAccessRouter.patch('/principals/:id/credentials/:credentialId', async (c) => {
  const forbidden = await requirePermission(c, ADMIN_PERMISSIONS.ADMIN_MACHINE_ACCESS_WRITE);
  if (forbidden) return forbidden;

  const repo = getRepo(c);
  const credentialId = c.req.param('credentialId');
  const credential = await repo.findCredentialById(credentialId);
  if (!credential || credential.principalId !== c.req.param('id')) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  }
  if (!(await credentialIsWithinActorScope(c, repo, credential.principalId, credentialId))) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  }

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const status = body?.status;
  if (
    status !== undefined &&
    status !== 'active' &&
    status !== 'rotating' &&
    status !== 'revoked' &&
    status !== 'expired'
  ) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }

  const displayName = asOptionalNonEmptyString(body?.display_name);
  if (displayName === null) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }

  const actor = actorRef(c);
  const updated = await repo.updateCredential(credentialId, {
    displayName,
    description: body?.description === undefined ? undefined : asString(body.description),
    status: status as AdminMachineCredentialStatus | undefined,
    notBefore: asOptionalEpochMs(body?.not_before),
    expiresAt: asOptionalEpochMs(body?.expires_at),
    revokedBy: status === 'revoked' ? actor : undefined,
    revokeReason: body?.revoke_reason === undefined ? undefined : asString(body.revoke_reason),
  });
  if (body?.permissions !== undefined) {
    const permissions = parsePermissionsForActor(c, body.permissions);
    if (!permissions) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
    }
    await repo.setCredentialPermissions(credentialId, permissions, actor);
  }
  if (body?.tenant_scopes !== undefined) {
    const tenantScopes = parseTenantScopesForActor(c, body.tenant_scopes);
    if (!tenantScopes) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
    }
    await repo.setCredentialTenantScopes(credentialId, tenantScopes, actor);
  }
  await writeAdminAuditLog(c, {
    action: 'admin_machine_access.credential.updated',
    resourceType: 'admin_machine_credential',
    resourceId: credentialId,
    result: 'success',
    metadata: { principal_id: credential.principalId },
  });

  return c.json({ credential: updated });
});

machineAccessRouter.post('/principals/:id/credentials/:credentialId/rotate', async (c) => {
  const forbidden = await requirePermission(c, ADMIN_PERMISSIONS.ADMIN_MACHINE_ACCESS_WRITE);
  if (forbidden) return forbidden;

  const repo = getRepo(c);
  const principalId = c.req.param('id');
  const oldCredentialId = c.req.param('credentialId');
  const [principal, oldCredential] = await Promise.all([
    repo.findPrincipalById(principalId),
    repo.findCredentialById(oldCredentialId),
  ]);
  if (!principal || !oldCredential || oldCredential.principalId !== principalId) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  }
  if (!(await credentialIsWithinActorScope(c, repo, principalId, oldCredentialId))) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  }

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const kid = asString(body?.kid);
  const displayName = asString(body?.display_name);
  const alg = body?.alg;
  const overlapSeconds = parseRotationOverlapSeconds(body?.overlap_seconds);
  let publicJwkJson: string | null = null;
  try {
    publicJwkJson =
      typeof alg === 'string' && CREDENTIAL_ALGORITHMS.has(alg as AdminMachineCredentialAlgorithm)
        ? parsePublicJwkJson(
            body?.public_jwk_json ?? body?.public_jwk,
            alg as AdminMachineCredentialAlgorithm
          )
        : null;
  } catch {
    publicJwkJson = null;
  }
  const requestedTenantScopes =
    body?.tenant_scopes === undefined ? undefined : parseTenantScopesForActor(c, body.tenant_scopes);
  if (
    !kid ||
    !displayName ||
    typeof alg !== 'string' ||
    !CREDENTIAL_ALGORITHMS.has(alg as AdminMachineCredentialAlgorithm) ||
    !publicJwkJson ||
    overlapSeconds === null ||
    requestedTenantScopes === null
  ) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }
  const requestedPermissions =
    body?.permissions === undefined ? undefined : parsePermissionsForActor(c, body.permissions);
  if (requestedPermissions === null) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }

  const actor = actorRef(c);
  const oldExpiresAt = Date.now() + overlapSeconds * 1000;
  await repo.updateCredential(oldCredentialId, {
    status: 'rotating',
    expiresAt: oldExpiresAt,
    revokeReason: 'rotation_overlap',
  });
  const newCredential = await repo.createCredential({
    principalId,
    kid,
    publicJwkJson,
    alg: alg as AdminMachineCredentialAlgorithm,
    displayName,
    description: body?.description === null ? null : asString(body?.description),
    notBefore: asOptionalEpochMs(body?.not_before) ?? null,
    expiresAt: asOptionalEpochMs(body?.expires_at) ?? null,
    createdBy: actor,
  });

  const [oldPermissions, oldTenantScopes] = await Promise.all([
    repo.getCredentialPermissions(oldCredentialId),
    repo.getCredentialTenantScopes(oldCredentialId),
  ]);
  const effectiveTenantScopes =
    body?.tenant_scopes === undefined
      ? validateTenantScopesForActor(getAuth(c), oldTenantScopes)
      : requestedTenantScopes;
  if (!effectiveTenantScopes) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }
  await repo.setCredentialPermissions(
    newCredential.id,
    requestedPermissions === undefined ? oldPermissions : requestedPermissions,
    actor
  );
  await repo.setCredentialTenantScopes(
    newCredential.id,
    effectiveTenantScopes,
    actor
  );
  await writeAdminAuditLog(c, {
    action: 'admin_machine_access.credential.rotated',
    resourceType: 'admin_machine_credential',
    resourceId: newCredential.id,
    result: 'success',
    severity: 'warn',
    metadata: {
      principal_id: principalId,
      previous_credential_id: oldCredentialId,
      overlap_seconds: overlapSeconds,
      previous_expires_at: oldExpiresAt,
    },
  });

  return c.json({
    credential: newCredential,
    previous_credential: await repo.findCredentialById(oldCredentialId),
  }, 201);
});

machineAccessRouter.post('/principals/:id/disable', async (c) => {
  const forbidden = await requirePermission(c, ADMIN_PERMISSIONS.ADMIN_MACHINE_ACCESS_DELETE);
  if (forbidden) return forbidden;

  const repo = getRepo(c);
  const principalId = c.req.param('id');
  const principal = await repo.findPrincipalById(principalId);
  if (!principal) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  }
  if (!(await principalIsWithinActorScope(c, repo, principalId))) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  }
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const updated = await repo.updatePrincipal(principalId, {
    status: 'disabled',
    disabledBy: actorRef(c),
  });
  await writeAdminAuditLog(c, {
    action: 'admin_machine_access.principal.disabled',
    resourceType: 'admin_machine_principal',
    resourceId: principalId,
    result: 'success',
    severity: 'warn',
    metadata: { reason: asString(body?.reason) },
  });
  return c.json({ principal: updated });
});

machineAccessRouter.post('/principals/:id/enable', async (c) => {
  const forbidden = await requirePermission(c, ADMIN_PERMISSIONS.ADMIN_MACHINE_ACCESS_WRITE);
  if (forbidden) return forbidden;

  const repo = getRepo(c);
  const principalId = c.req.param('id');
  const principal = await repo.findPrincipalById(principalId);
  if (!principal) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  }
  if (!(await principalIsWithinActorScope(c, repo, principalId))) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  }
  const updated = await repo.updatePrincipal(principalId, {
    status: 'active',
  });
  await writeAdminAuditLog(c, {
    action: 'admin_machine_access.principal.enabled',
    resourceType: 'admin_machine_principal',
    resourceId: principalId,
    result: 'success',
  });
  return c.json({ principal: updated });
});

machineAccessRouter.post(
  '/principals/:id/credentials/:credentialId/emergency-revoke',
  async (c) => {
    const forbidden = await requirePermission(c, ADMIN_PERMISSIONS.ADMIN_MACHINE_ACCESS_DELETE);
    if (forbidden) return forbidden;

    const repo = getRepo(c);
    const credentialId = c.req.param('credentialId');
    const credential = await repo.findCredentialById(credentialId);
    if (!credential || credential.principalId !== c.req.param('id')) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    if (!(await credentialIsWithinActorScope(c, repo, credential.principalId, credentialId))) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const reason = asString(body?.reason) ?? 'emergency_revoke';
    const updated = await repo.updateCredential(credentialId, {
      status: 'revoked',
      revokedBy: actorRef(c),
      revokeReason: reason,
    });
    await writeAdminAuditLog(c, {
      action: 'admin_machine_access.credential.emergency_revoked',
      resourceType: 'admin_machine_credential',
      resourceId: credentialId,
      result: 'success',
      severity: 'critical',
      metadata: { principal_id: credential.principalId, reason },
    });
    return c.json({ credential: updated });
  }
);

machineAccessRouter.delete('/principals/:id/credentials/:credentialId', async (c) => {
  const forbidden = await requirePermission(c, ADMIN_PERMISSIONS.ADMIN_MACHINE_ACCESS_DELETE);
  if (forbidden) return forbidden;

  const repo = getRepo(c);
  const credentialId = c.req.param('credentialId');
  const credential = await repo.findCredentialById(credentialId);
  if (!credential || credential.principalId !== c.req.param('id')) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  }
  if (!(await credentialIsWithinActorScope(c, repo, credential.principalId, credentialId))) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  }
  await repo.updateCredential(credentialId, {
    status: 'revoked',
    revokedBy: actorRef(c),
    revokeReason: 'deleted_by_admin_api',
  });
  await writeAdminAuditLog(c, {
    action: 'admin_machine_access.credential.revoked',
    resourceType: 'admin_machine_credential',
    resourceId: credentialId,
    result: 'success',
    severity: 'warn',
    metadata: { principal_id: credential.principalId },
  });
  return c.json({ success: true });
});
