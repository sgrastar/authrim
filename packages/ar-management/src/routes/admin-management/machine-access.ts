import { Hono } from 'hono';
import type { Context } from 'hono';
import type {
  AdminAuthContext,
  AdminMachineCredentialAlgorithm,
  AdminMachineCredentialStatus,
  AdminMachinePrincipalStatus,
  AdminMachinePrincipalType,
  AdminMachineTenantScope,
  AdminMachineWriteGuard,
  Env,
} from '@authrim/ar-lib-core';
import {
  ADMIN_PERMISSIONS,
  AR_ERROR_CODES,
  AdminMachineAccessRepository,
  AdminMachineConflictError,
  adminAuthMiddleware,
  createErrorResponse,
  getTenantIdFromContext,
  hasAdminPermission,
  hasGlobalAdminPermission,
  intersectMachinePermissionSets,
  requireDedicatedAdminDatabaseAdapter,
  resolveMachineTenantScope,
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

/** Principal types that act for the platform; creating one is for a platform administrator. */
const PLATFORM_PRINCIPAL_TYPES = new Set<AdminMachinePrincipalType>([
  'setup_tool',
  'admin_ui_bff',
  'internal_service',
]);

/** The principals the bootstrap writes, by their fixed IDs. */
const PLATFORM_PRINCIPAL_IDS = new Set(['amp_authrim_setup', 'amp_authrim_admin_ui_bff']);

/**
 * Whether the principal acts for the platform (the setup tool, the Admin UI, an internal service).
 * Its tokens are trusted for platform operations by what the principal is, so changing it, or
 * handing out a key for it, is for a platform administrator whatever its tenant scope says.
 */
function isPlatformPrincipal(principal: {
  id: string;
  clientId: string;
  principalType: AdminMachinePrincipalType;
}): boolean {
  return (
    PLATFORM_PRINCIPAL_IDS.has(principal.id) ||
    PLATFORM_PRINCIPAL_TYPES.has(principal.principalType) ||
    principal.clientId === 'authrim-setup'
  );
}

const CREDENTIAL_ALGORITHMS = new Set<AdminMachineCredentialAlgorithm>(['ES256', 'PS256', 'RS256']);
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
    ? Array.from(
        new Set(
          value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
        )
      )
    : [];
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

/**
 * Whom a machine principal or credential may be given to.
 *
 * A machine token reaches the tenants in its scope and holds the permissions of its principal,
 * narrowed by its credential's own. When that scope is every tenant, its permissions are global
 * permissions. `auth.permissions` adds up every assignment of the actor that applies to the
 * request, so a permission the actor holds only for this tenant is in it too; handing it out with a
 * reach beyond this tenant would make a global permission out of a local one. So:
 * - within the tenants the actor's own permissions apply to, the actor may hand out what its
 *   permissions hold;
 * - beyond them (every tenant, or another tenant), the actor needs the permission to do so from a
 *   global assignment, and may hand out only what its global permissions hold.
 */
type MachineReach = readonly string[];

/** The tenants the actor's `permissions` apply to as a whole (the request's tenant for a global actor). */
function localTenantIds(c: AdminContext): Set<string> {
  const auth = getAuth(c);
  if ((auth.tenantScope ?? []).includes('*')) {
    return new Set([getTenantIdFromContext(c)]);
  }
  return new Set(auth.tenantScope ?? (auth.tenantId ? [auth.tenantId] : []));
}

function reachOfScopes(scopes: AdminMachineTenantScope[]): string[] {
  const reach: string[] = [];
  for (const scope of scopes) {
    if (scope.scopeMode === 'all') {
      reach.push('*');
    } else if (scope.scopeMode === 'allow' && scope.tenantId) {
      reach.push(scope.tenantId);
    }
  }
  return reach;
}

function permissionsWithin(held: string[] | undefined, permissions: readonly string[]): boolean {
  return permissions.every((permission) => hasAdminPermission(held ?? [], permission));
}

/**
 * Whether the actor may give a machine access of `permissions` over `reach`. `requested` is what
 * the request itself names; when the access reaches no tenant, only that has to be within the
 * actor's permissions, as what a principal holds without any tenant does nothing.
 */
function actorMayGrant(
  c: AdminContext,
  authorityPermission: string,
  permissions: readonly string[],
  reachGiven: MachineReach,
  requested: readonly string[] = permissions,
  platform = false
): boolean {
  const auth = getAuth(c);
  // A platform principal is never the tenant's own, whichever tenants it is limited to.
  const reach = platform ? ['*', ...reachGiven] : reachGiven;
  if (reach.length === 0) {
    return permissionsWithin(auth.permissions, requested);
  }
  const local = localTenantIds(c);
  if (reach.every((tenant) => tenant !== '*' && local.has(tenant))) {
    return permissionsWithin(auth.permissions, permissions);
  }
  return (
    hasGlobalAdminPermission(auth, authorityPermission) &&
    permissionsWithin(auth.globalPermissions, permissions)
  );
}

/**
 * Whether the actor may see and manage something that reaches `scopes`: a principal or credential
 * that reaches beyond the actor's own tenant is managed with a global permission.
 */
function scopesWithinActorReach(
  c: AdminContext,
  scopes: AdminMachineTenantScope[],
  permission: string
): boolean {
  if (hasGlobalAdminPermission(getAuth(c), permission)) {
    return true;
  }
  const local = localTenantIds(c);
  return (
    local.size > 0 &&
    scopes.length > 0 &&
    scopes.every(
      (scope) => scope.scopeMode === 'allow' && scope.tenantId && local.has(scope.tenantId)
    )
  );
}

/** Whether everything in `reach` (tenant IDs, or '*') is within what the actor manages. */
function reachWithinActor(c: AdminContext, reach: readonly string[], permission: string): boolean {
  if (hasGlobalAdminPermission(getAuth(c), permission)) {
    return true;
  }
  const local = localTenantIds(c);
  return reach.every((tenant) => tenant !== '*' && local.has(tenant));
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
  if (
    isPlatformPrincipal(principal) &&
    !hasGlobalAdminPermission(getAuth(c), ADMIN_PERMISSIONS.ADMIN_MACHINE_ACCESS_READ)
  ) {
    return null;
  }
  return scopesWithinActorReach(
    c,
    principal.tenantScopes,
    ADMIN_PERMISSIONS.ADMIN_MACHINE_ACCESS_READ
  )
    ? principal
    : null;
}

async function principalIsWithinActorScope(
  c: AdminContext,
  repo: AdminMachineAccessRepository,
  principalId: string,
  permission: string
): Promise<boolean> {
  const [principal, tenantScopes] = await Promise.all([
    repo.findPrincipalById(principalId),
    repo.getPrincipalTenantScopes(principalId),
  ]);
  if (
    principal &&
    isPlatformPrincipal(principal) &&
    !hasGlobalAdminPermission(getAuth(c), permission)
  ) {
    return false;
  }
  return scopesWithinActorReach(c, tenantScopes, permission);
}

async function credentialIsWithinActorScope(
  c: AdminContext,
  repo: AdminMachineAccessRepository,
  principalId: string,
  credentialId: string,
  permission: string
): Promise<boolean> {
  if (!(await principalIsWithinActorScope(c, repo, principalId, permission))) {
    return false;
  }
  const [principalScopes, credentialScopes] = await Promise.all([
    repo.getPrincipalTenantScopes(principalId),
    repo.getCredentialTenantScopes(credentialId),
  ]);
  // The credential is judged by what it reaches on its principal, the same narrowing that issuing
  // it and the token endpoint apply: a scope it asks for beyond the principal's adds nothing.
  return reachWithinActor(
    c,
    resolveMachineTenantScope(principalScopes, credentialScopes),
    permission
  );
}

/**
 * Whether the actor may give this credential what it would end up with on its principal: the
 * principal's permissions narrowed by the credential's own, over the principal's tenants narrowed
 * by the credential's. Issuing a key for a principal hands over exactly that.
 */
async function actorMayGrantCredential(
  c: AdminContext,
  repo: AdminMachineAccessRepository,
  principalId: string,
  credential: { permissions: string[]; tenantScopes: AdminMachineTenantScope[] }
): Promise<boolean> {
  const [principal, principalPermissions, principalScopes] = await Promise.all([
    repo.findPrincipalById(principalId),
    repo.getPrincipalPermissions(principalId),
    repo.getPrincipalTenantScopes(principalId),
  ]);
  const effectivePermissions =
    credential.permissions.length > 0
      ? intersectMachinePermissionSets(principalPermissions, credential.permissions)
      : principalPermissions;
  const effectiveReach = resolveMachineTenantScope(principalScopes, credential.tenantScopes);
  return actorMayGrant(
    c,
    ADMIN_PERMISSIONS.ADMIN_MACHINE_ACCESS_WRITE,
    effectivePermissions,
    effectiveReach,
    credential.permissions,
    principal !== null && isPlatformPrincipal(principal)
  );
}

/**
 * The revision of a principal, read before anything else the request decides on, so that the write
 * can check it is still the state the decision was made on.
 */
async function principalGuard(
  repo: AdminMachineAccessRepository,
  principalId: string
): Promise<AdminMachineWriteGuard | null> {
  const revision = await repo.getPrincipalRevision(principalId);
  return revision === null ? null : { principal: { id: principalId, revision } };
}

/** The same for a credential and the principal whose permissions and tenants it narrows. */
async function credentialGuard(
  repo: AdminMachineAccessRepository,
  principalId: string,
  credentialId: string
): Promise<AdminMachineWriteGuard | null> {
  const [principal, credential] = await Promise.all([
    repo.getPrincipalRevision(principalId),
    repo.getCredentialRevision(credentialId),
  ]);
  return principal === null || credential === null
    ? null
    : {
        principal: { id: principalId, revision: principal },
        credential: { id: credentialId, revision: credential },
      };
}

/** A write whose guard failed answers 409: read the state again and decide again. */
async function guardedWrite<T>(c: AdminContext, run: () => Promise<T>): Promise<T | Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof AdminMachineConflictError) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_CONFLICT);
    }
    throw error;
  }
}

const PRIVATE_JWK_FIELDS = new Set(['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k']);

function hasPrivateJwkMaterial(jwk: Record<string, unknown>): boolean {
  return Object.keys(jwk).some((key) => PRIVATE_JWK_FIELDS.has(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function validatePublicJwk(
  jwk: Record<string, unknown>,
  alg: AdminMachineCredentialAlgorithm
): boolean {
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
      jwk.kty === 'EC' && jwk.crv === 'P-256' && isNonEmptyString(jwk.x) && isNonEmptyString(jwk.y)
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
  const tenantScopes = parseTenantScopes(body?.tenant_scopes);
  const permissions = asStringArray(body?.permissions);
  if (
    !tenantScopes ||
    !actorMayGrant(
      c,
      ADMIN_PERMISSIONS.ADMIN_MACHINE_ACCESS_WRITE,
      permissions,
      reachOfScopes(tenantScopes)
    )
  ) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }
  // The setup tool, the Admin UI and the internal services act for the platform, not for a
  // tenant: only a platform administrator creates one, and with global permissions at most.
  if (
    (PLATFORM_PRINCIPAL_TYPES.has(principalType as AdminMachinePrincipalType) ||
      clientId === 'authrim-setup') &&
    !(
      hasGlobalAdminPermission(getAuth(c), ADMIN_PERMISSIONS.ADMIN_MACHINE_ACCESS_WRITE) &&
      permissionsWithin(getAuth(c).globalPermissions, permissions)
    )
  ) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }
  // One atomic write: a principal never exists with only part of what it was meant to have.
  const principal = await repo.createPrincipalWithGrant(
    {
      clientId,
      displayName,
      description: body?.description === null ? null : asString(body?.description),
      principalType: principalType as AdminMachinePrincipalType,
      tokenTtlSeconds,
      createdBy: actor,
    },
    { permissions, tenantScopes },
    actor
  );
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
  const guard = await principalGuard(repo, principalId);
  const existing = await repo.findPrincipalById(principalId);
  if (!existing || !guard) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  }
  if (
    !(await principalIsWithinActorScope(
      c,
      repo,
      principalId,
      ADMIN_PERMISSIONS.ADMIN_MACHINE_ACCESS_WRITE
    ))
  ) {
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

  // What the principal ends up with is what has to be within the actor's authority, whichever of
  // its permissions and tenants the request changes; both are checked before anything is saved.
  const newPermissions =
    body?.permissions === undefined ? undefined : asStringArray(body.permissions);
  const newTenantScopes =
    body?.tenant_scopes === undefined ? undefined : parseTenantScopes(body.tenant_scopes);
  if (newTenantScopes === null) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }
  if (newPermissions !== undefined || newTenantScopes !== undefined) {
    const [finalPermissions, finalTenantScopes] = await Promise.all([
      newPermissions ?? repo.getPrincipalPermissions(principalId),
      newTenantScopes ?? repo.getPrincipalTenantScopes(principalId),
    ]);
    if (
      !actorMayGrant(
        c,
        ADMIN_PERMISSIONS.ADMIN_MACHINE_ACCESS_WRITE,
        finalPermissions,
        reachOfScopes(finalTenantScopes),
        newPermissions ?? [],
        isPlatformPrincipal(existing)
      )
    ) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
    }
  }

  const actor = actorRef(c);
  // Its fields, permissions and tenant scopes change in one atomic write, so a failure part-way
  // cannot leave new permissions on the old scope.
  const written = await guardedWrite(c, () =>
    repo.updatePrincipalWithGrant(
      principalId,
      {
        displayName,
        description: body?.description === undefined ? undefined : asString(body.description),
        tokenTtlSeconds,
      },
      { permissions: newPermissions, tenantScopes: newTenantScopes },
      actor,
      guard
    )
  );
  if (written instanceof Response) return written;
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
  const guard = await principalGuard(repo, principalId);
  const existing = await repo.findPrincipalById(principalId);
  if (!existing || !guard) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  }
  if (
    !(await principalIsWithinActorScope(
      c,
      repo,
      principalId,
      ADMIN_PERMISSIONS.ADMIN_MACHINE_ACCESS_DELETE
    ))
  ) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  }
  const deleted = await guardedWrite(c, () =>
    repo.updatePrincipal(
      principalId,
      {
        status: 'deleted',
        disabledBy: actorRef(c),
      },
      guard
    )
  );
  if (deleted instanceof Response) return deleted;
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
  const guard = await principalGuard(repo, principalId);
  const principal = await repo.findPrincipalById(principalId);
  if (!principal || !guard) {
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
  const tenantScopes = parseTenantScopes(body?.tenant_scopes);
  const permissions = asStringArray(body?.permissions);
  if (
    !kid ||
    !displayName ||
    typeof alg !== 'string' ||
    !CREDENTIAL_ALGORITHMS.has(alg as AdminMachineCredentialAlgorithm) ||
    !publicJwkJson ||
    !tenantScopes ||
    !(await principalIsWithinActorScope(
      c,
      repo,
      principalId,
      ADMIN_PERMISSIONS.ADMIN_MACHINE_ACCESS_WRITE
    )) ||
    !(await actorMayGrantCredential(c, repo, principalId, { permissions, tenantScopes }))
  ) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }

  const actor = actorRef(c);
  // The key and its own permissions and tenant scopes are written together: without them the
  // credential would take everything the principal has.
  const credential = await guardedWrite(c, () =>
    repo.createCredentialWithGrant(
      {
        principalId,
        kid,
        publicJwkJson,
        alg: alg as AdminMachineCredentialAlgorithm,
        displayName,
        description: body?.description === null ? null : asString(body?.description),
        notBefore: asOptionalEpochMs(body?.not_before) ?? null,
        expiresAt: asOptionalEpochMs(body?.expires_at) ?? null,
        createdBy: actor,
      },
      { permissions, tenantScopes },
      actor,
      guard
    )
  );
  if (credential instanceof Response) return credential;
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
  const guard = await credentialGuard(repo, c.req.param('id'), credentialId);
  const credential = await repo.findCredentialById(credentialId);
  if (!credential || !guard || credential.principalId !== c.req.param('id')) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  }
  if (
    !(await credentialIsWithinActorScope(
      c,
      repo,
      credential.principalId,
      credentialId,
      ADMIN_PERMISSIONS.ADMIN_MACHINE_ACCESS_WRITE
    ))
  ) {
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

  const newPermissions =
    body?.permissions === undefined ? undefined : asStringArray(body.permissions);
  const newTenantScopes =
    body?.tenant_scopes === undefined ? undefined : parseTenantScopes(body.tenant_scopes);
  if (newTenantScopes === null) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }
  // Anything that keeps or brings back what the credential can do (its permissions, its tenants,
  // its validity window, or making it usable again) has to be within the actor's authority;
  // revoking it or renaming it does not.
  const keepsCredentialUsable =
    newPermissions !== undefined ||
    newTenantScopes !== undefined ||
    body?.not_before !== undefined ||
    body?.expires_at !== undefined ||
    status === 'active' ||
    status === 'rotating';
  if (keepsCredentialUsable) {
    const [currentPermissions, currentTenantScopes] = await Promise.all([
      repo.getCredentialPermissions(credentialId),
      repo.getCredentialTenantScopes(credentialId),
    ]);
    if (
      !(await actorMayGrantCredential(c, repo, credential.principalId, {
        permissions: newPermissions ?? currentPermissions,
        tenantScopes: newTenantScopes ?? currentTenantScopes,
      }))
    ) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
    }
  }

  const actor = actorRef(c);
  const updated = await guardedWrite(c, () =>
    repo.updateCredentialWithGrant(
      credentialId,
      {
        displayName,
        description: body?.description === undefined ? undefined : asString(body.description),
        status: status as AdminMachineCredentialStatus | undefined,
        notBefore: asOptionalEpochMs(body?.not_before),
        expiresAt: asOptionalEpochMs(body?.expires_at),
        revokedBy: status === 'revoked' ? actor : undefined,
        revokeReason: body?.revoke_reason === undefined ? undefined : asString(body.revoke_reason),
      },
      { permissions: newPermissions, tenantScopes: newTenantScopes },
      actor,
      guard
    )
  );
  if (updated instanceof Response) return updated;
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
  const guard = await credentialGuard(repo, principalId, oldCredentialId);
  const [principal, oldCredential] = await Promise.all([
    repo.findPrincipalById(principalId),
    repo.findCredentialById(oldCredentialId),
  ]);
  if (!principal || !guard || !oldCredential || oldCredential.principalId !== principalId) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  }
  if (
    !(await credentialIsWithinActorScope(
      c,
      repo,
      principalId,
      oldCredentialId,
      ADMIN_PERMISSIONS.ADMIN_MACHINE_ACCESS_WRITE
    ))
  ) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  }

  // A revoked or expired credential is finished: rotating it would bring it back.
  if (oldCredential.status !== 'active' && oldCredential.status !== 'rotating') {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_CONFLICT);
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
    body?.tenant_scopes === undefined ? undefined : parseTenantScopes(body.tenant_scopes);
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
    body?.permissions === undefined ? undefined : asStringArray(body.permissions);

  // The new credential takes over the old one's permissions and tenants unless the request names
  // its own, and what it ends up with on the principal has to be within the actor's authority.
  const [oldPermissions, oldTenantScopes] = await Promise.all([
    repo.getCredentialPermissions(oldCredentialId),
    repo.getCredentialTenantScopes(oldCredentialId),
  ]);
  const newCredentialPermissions = requestedPermissions ?? oldPermissions;
  const newCredentialTenantScopes = requestedTenantScopes ?? oldTenantScopes;
  if (
    !(await actorMayGrantCredential(c, repo, principalId, {
      permissions: newCredentialPermissions,
      tenantScopes: newCredentialTenantScopes,
    }))
  ) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }

  const actor = actorRef(c);
  // The old key keeps working for the overlap and no longer than it already would: rotation never
  // lengthens what the old credential can do, which would hand its authority on past a revoke.
  const overlapEnd = Date.now() + overlapSeconds * 1000;
  const oldExpiresAt = Math.min(oldCredential.expiresAt ?? overlapEnd, overlapEnd);
  // One atomic write: the old key moves to its overlap only together with the new key's rows.
  const rotated = await guardedWrite(c, () =>
    repo.rotateCredential({
      previousCredentialId: oldCredentialId,
      previousUpdate: {
        status: 'rotating',
        expiresAt: oldExpiresAt,
        revokeReason: 'rotation_overlap',
      },
      next: {
        principalId,
        kid,
        publicJwkJson,
        alg: alg as AdminMachineCredentialAlgorithm,
        displayName,
        description: body?.description === null ? null : asString(body?.description),
        notBefore: asOptionalEpochMs(body?.not_before) ?? null,
        expiresAt: asOptionalEpochMs(body?.expires_at) ?? null,
        createdBy: actor,
      },
      grant: { permissions: newCredentialPermissions, tenantScopes: newCredentialTenantScopes },
      actor,
      guard,
    })
  );
  if (rotated instanceof Response) return rotated;
  const newCredential = rotated;
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

  return c.json(
    {
      credential: newCredential,
      previous_credential: await repo.findCredentialById(oldCredentialId),
    },
    201
  );
});

machineAccessRouter.post('/principals/:id/disable', async (c) => {
  const forbidden = await requirePermission(c, ADMIN_PERMISSIONS.ADMIN_MACHINE_ACCESS_DELETE);
  if (forbidden) return forbidden;

  const repo = getRepo(c);
  const principalId = c.req.param('id');
  const guard = await principalGuard(repo, principalId);
  const principal = await repo.findPrincipalById(principalId);
  if (!principal || !guard) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  }
  if (
    !(await principalIsWithinActorScope(
      c,
      repo,
      principalId,
      ADMIN_PERMISSIONS.ADMIN_MACHINE_ACCESS_DELETE
    ))
  ) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  }
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const updated = await guardedWrite(c, () =>
    repo.updatePrincipal(
      principalId,
      {
        status: 'disabled',
        disabledBy: actorRef(c),
      },
      guard
    )
  );
  if (updated instanceof Response) return updated;
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
  const guard = await principalGuard(repo, principalId);
  const principal = await repo.findPrincipalById(principalId);
  if (!principal || !guard) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  }
  if (
    !(await principalIsWithinActorScope(
      c,
      repo,
      principalId,
      ADMIN_PERMISSIONS.ADMIN_MACHINE_ACCESS_WRITE
    ))
  ) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  }
  // Enabling brings back everything the principal holds, so the actor has to be able to give it,
  // as when it was made. (Disabling does not revoke the credentials: they stay as they are, and
  // the principal's status is what stops their tokens meanwhile.)
  const [heldPermissions, heldTenantScopes] = await Promise.all([
    repo.getPrincipalPermissions(principalId),
    repo.getPrincipalTenantScopes(principalId),
  ]);
  if (
    !actorMayGrant(
      c,
      ADMIN_PERMISSIONS.ADMIN_MACHINE_ACCESS_WRITE,
      heldPermissions,
      reachOfScopes(heldTenantScopes),
      heldPermissions,
      isPlatformPrincipal(principal)
    )
  ) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }
  const updated = await guardedWrite(c, () =>
    repo.updatePrincipal(principalId, { status: 'active' }, guard)
  );
  if (updated instanceof Response) return updated;
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
    const guard = await credentialGuard(repo, c.req.param('id'), credentialId);
    const credential = await repo.findCredentialById(credentialId);
    if (!credential || !guard || credential.principalId !== c.req.param('id')) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    if (
      !(await credentialIsWithinActorScope(
        c,
        repo,
        credential.principalId,
        credentialId,
        ADMIN_PERMISSIONS.ADMIN_MACHINE_ACCESS_DELETE
      ))
    ) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const reason = asString(body?.reason) ?? 'emergency_revoke';
    const updated = await guardedWrite(c, () =>
      repo.updateCredential(
        credentialId,
        {
          status: 'revoked',
          revokedBy: actorRef(c),
          revokeReason: reason,
        },
        guard
      )
    );
    if (updated instanceof Response) return updated;
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
  const guard = await credentialGuard(repo, c.req.param('id'), credentialId);
  const credential = await repo.findCredentialById(credentialId);
  if (!credential || !guard || credential.principalId !== c.req.param('id')) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  }
  if (
    !(await credentialIsWithinActorScope(
      c,
      repo,
      credential.principalId,
      credentialId,
      ADMIN_PERMISSIONS.ADMIN_MACHINE_ACCESS_DELETE
    ))
  ) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  }
  const revoked = await guardedWrite(c, () =>
    repo.updateCredential(
      credentialId,
      {
        status: 'revoked',
        revokedBy: actorRef(c),
        revokeReason: 'deleted_by_admin_api',
      },
      guard
    )
  );
  if (revoked instanceof Response) return revoked;
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
