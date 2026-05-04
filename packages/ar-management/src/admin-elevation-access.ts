import type { Context } from 'hono';
import type { AdminAuthContext, ElevationGrant, Env } from '@authrim/ar-lib-core';
import {
  ElevationGrantRepository,
  getTenantIdFromContext,
  hasAdminPermission,
  requireDedicatedAdminDatabaseAdapter,
} from '@authrim/ar-lib-core';
import { writeAdminAuditLog } from './admin-shared';

type AdminContext = Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;

const DEFAULT_TARGET_AUDIENCE = 'admin_api';

export interface AdminElevationAccessRequirement {
  directPermission: string;
  requestSurface: string;
  requestedAction: string;
  resourceClass: string;
  resourceIds?: Array<string | null | undefined>;
  detailClass?: string | null;
  targetAudience?: string;
}

export interface AdminElevationAccessResolution {
  grantedBy: 'permission' | 'grant';
  grant: ElevationGrant | null;
}

export async function auditAdminSensitiveRead(
  c: AdminContext,
  resolution: AdminElevationAccessResolution,
  input: {
    action: string;
    resourceType: string;
    resourceId: string | null;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  try {
    await writeAdminAuditLog(c as any, {
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      result: 'success',
      severity: 'info',
      metadata: {
        access_path: resolution.grantedBy,
        grant_id: resolution.grant?.public_grant_id ?? null,
        ...(input.metadata ?? {}),
      },
    });
  } catch {
    // Detail reads should not fail because audit logging failed.
  }
}

function normalizeIds(values: Array<string | null | undefined> | undefined): string[] {
  if (!values?.length) {
    return [];
  }

  return Array.from(
    new Set(
      values
        .map((value) => value?.trim())
        .filter((value): value is string => !!value)
    )
  );
}

function matchesScope(
  grant: ElevationGrant,
  requirement: AdminElevationAccessRequirement,
  tenantId: string
): boolean {
  if (grant.status !== 'active') {
    return false;
  }
  if (grant.tenant_id !== tenantId) {
    return false;
  }
  if (grant.target_audience !== (requirement.targetAudience ?? DEFAULT_TARGET_AUDIENCE)) {
    return false;
  }
  if (grant.resource_class !== requirement.resourceClass) {
    return false;
  }

  const scope = grant.scope_json;
  if (scope.tenant_id !== tenantId) {
    return false;
  }
  if (scope.surface !== requirement.requestSurface) {
    return false;
  }
  if (scope.action !== requirement.requestedAction) {
    return false;
  }
  if (scope.resource_class !== requirement.resourceClass) {
    return false;
  }

  const requestedIds = normalizeIds(requirement.resourceIds);
  if (requestedIds.length > 0 && scope.resource_ids?.length) {
    const allowedIds = new Set(scope.resource_ids);
    if (!requestedIds.some((value) => allowedIds.has(value))) {
      return false;
    }
  }

  if (requirement.detailClass && scope.detail_classes?.length) {
    const allowedDetailClasses = new Set(scope.detail_classes);
    if (!allowedDetailClasses.has(requirement.detailClass)) {
      return false;
    }
  }

  return true;
}

function buildApprovalRequiredResponse(
  c: AdminContext,
  requirement: AdminElevationAccessRequirement
): Response {
  return c.json(
    {
      error: 'approval_required',
      error_description: 'Additional approval is required to access this sensitive detail.',
      requirement: {
        surface: requirement.requestSurface,
        action: requirement.requestedAction,
        resource_class: requirement.resourceClass,
        resource_ids: normalizeIds(requirement.resourceIds),
        detail_class: requirement.detailClass ?? null,
        target_audience: requirement.targetAudience ?? DEFAULT_TARGET_AUDIENCE,
      },
    },
    403
  );
}

async function findMatchingGrant(
  c: AdminContext,
  requirement: AdminElevationAccessRequirement
): Promise<ElevationGrant | null> {
  const adminAuth = c.get('adminAuth');
  if (!adminAuth?.userId) {
    return null;
  }

  const adapter = requireDedicatedAdminDatabaseAdapter(c.env, 'admin-elevation-access');
  const grantRepo = new ElevationGrantRepository(adapter);
  const tenantId = getTenantIdFromContext(c);
  const targetAudience = requirement.targetAudience ?? DEFAULT_TARGET_AUDIENCE;
  const explicitGrantId =
    c.req.query('grant_id') ?? c.req.header('X-Authrim-Elevation-Grant') ?? null;

  if (explicitGrantId) {
    const grant = await grantRepo.getElevationGrantByPublicId(explicitGrantId);
    if (!grant) {
      return null;
    }
    if (grant.actor_subject_type !== 'admin_user' || grant.actor_subject_id !== adminAuth.userId) {
      return null;
    }
    if (grant.expires_at <= Date.now() || grant.revoked_at) {
      return null;
    }
    return matchesScope(grant, requirement, tenantId) ? grant : null;
  }

  const candidates = await grantRepo.listActiveElevationGrants({
    tenantId,
    actorSubjectType: 'admin_user',
    actorSubjectId: adminAuth.userId,
    resourceClass: requirement.resourceClass,
    targetAudience,
    now: Date.now(),
  });

  return (
    candidates.find((grant: ElevationGrant) => matchesScope(grant, requirement, tenantId)) ?? null
  );
}

export async function requireAdminPermissionOrElevationGrant(
  c: AdminContext,
  requirement: AdminElevationAccessRequirement
): Promise<AdminElevationAccessResolution | Response> {
  const adminAuth = c.get('adminAuth');
  const permissions = adminAuth?.permissions || [];
  if (hasAdminPermission(permissions, requirement.directPermission)) {
    return {
      grantedBy: 'permission',
      grant: null,
    };
  }

  const grant = await findMatchingGrant(c, requirement);
  if (!grant) {
    return buildApprovalRequiredResponse(c, requirement);
  }

  return {
    grantedBy: 'grant',
    grant,
  };
}
