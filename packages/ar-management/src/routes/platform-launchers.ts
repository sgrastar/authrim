/**
 * The platform's application launchers (admin migration 026):
 *
 *   /api/admin/platform/launchers           list, create
 *   /api/admin/platform/launchers/options   the icons a launcher may use
 *   /api/admin/platform/launchers/order     the platform's order
 *   /api/admin/platform/launchers/assets    upload a background image (the platform's own)
 *   /api/admin/platform/launchers/:id       read, change (by version), delete
 *
 * A platform launcher is a plain link shown to everyone, shared with no tenant yet (`none`), with
 * every tenant (`all`), or with the tenants listed (`selected`, tenants that exist when it is
 * saved; a tenant made later is not added). `tenant_change_allowed` (on by default) lets a tenant
 * change it (its own copy) or hide it; off, tenants show it as it is. Every tenant may show these,
 * so only a platform administrator with a global assignment may read or change them, and a change
 * is an environment-wide one (covered by the tenant backup writer as such) with its audit record.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type {
  AdminAuthContext,
  ApplicationLauncher,
  Env,
  PlatformLauncher,
  PlatformLauncherShareMode,
} from '@authrim/ar-lib-core';
import {
  AR_ERROR_CODES,
  adminAuthMiddleware,
  createErrorResponse,
  ensureDatabaseAdapter,
  getLogger,
  getRateLimitProfileAsync,
  isValidTenantIdentifier,
  rateLimitMiddleware,
  requireDedicatedAdminDatabaseAdapter,
} from '@authrim/ar-lib-core';
import { platformLauncherAssetUploadHandler } from '../admin-public-assets';
import { writeAdminAuditLog } from '../admin-shared';
import { PHOSPHOR_ICON_NAMES, type Row } from '../launcher-config';
import { normalizeLauncherInput } from '../launchers';
import {
  PLATFORM_LAUNCHER_ID_PREFIX,
  PLATFORM_LAUNCHER_LIMIT,
  PLATFORM_LAUNCHER_TENANT_LIMIT,
  deletePlatformLauncher,
  findPlatformLauncher,
  insertPlatformLauncher,
  isPlatformLauncherShareMode,
  listPlatformLaunchers,
  storedShape,
  updatePlatformLauncher,
  writePlatformLauncherOrder,
} from '../platform-launchers-store';
import { runTenantBackupCoveredMutation } from '../tenant-backup-writer';
import {
  checkRolePermission,
  hasGlobalPlatformSettingsEdit,
  hasPlatformSettingsView,
} from './settings-v2/settings-authorization';

type AdminContext = Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;
type Router = Hono<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;

const PARTITION = 'platform-launchers';
const RESOURCE = 'platform_application_launcher';
/** Launchers are part of what tenants' sign-in and account pages show: the Login UI category. */
const CATEGORY = 'login-ui';

const invalid = (c: AdminContext, field: string, reason: string) =>
  c.json({ error: 'invalid_request', error_description: reason, field }, 400);
const missing = (c: AdminContext) =>
  c.json({ error: 'not_found', error_description: 'Platform launcher not found' }, 404);
const conflict = (c: AdminContext, version: number | null) =>
  c.json(
    {
      error: 'conflict',
      error_description: 'The launcher changed; reload and try again',
      ...(version === null ? {} : { current_version: version }),
    },
    409
  );

async function bodyObject(c: AdminContext): Promise<Row | null> {
  const body: unknown = await c.req.json().catch(() => null);
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Row) : null;
}

interface SharingInput {
  shareMode: PlatformLauncherShareMode;
  tenantIds: string[];
  tenantChangeAllowed: boolean;
}

/**
 * The sharing fields of a body, `existing` filling those left out. The listed tenants must exist
 * (and not be deleted); they are kept only for `selected`.
 */
async function readSharing(
  c: AdminContext,
  body: Row,
  existing?: PlatformLauncher
): Promise<SharingInput | Response> {
  const shareMode =
    body.share_mode === undefined ? (existing?.share_mode ?? 'none') : body.share_mode;
  if (!isPlatformLauncherShareMode(shareMode)) {
    return invalid(c, 'share_mode', 'share_mode must be none, all or selected');
  }
  if (body.tenant_change_allowed !== undefined && typeof body.tenant_change_allowed !== 'boolean') {
    return invalid(c, 'tenant_change_allowed', 'tenant_change_allowed must be a boolean');
  }
  const tenantChangeAllowed =
    typeof body.tenant_change_allowed === 'boolean'
      ? body.tenant_change_allowed
      : (existing?.tenant_change_allowed ?? true);
  const rawTenants = body.tenant_ids === undefined ? (existing?.tenant_ids ?? []) : body.tenant_ids;
  if (
    !Array.isArray(rawTenants) ||
    rawTenants.length > PLATFORM_LAUNCHER_TENANT_LIMIT ||
    rawTenants.some((id) => typeof id !== 'string' || !isValidTenantIdentifier(id))
  ) {
    return invalid(
      c,
      'tenant_ids',
      `tenant_ids must list at most ${PLATFORM_LAUNCHER_TENANT_LIMIT} tenant IDs`
    );
  }
  const tenantIds = shareMode === 'selected' ? [...new Set(rawTenants as string[])].sort() : [];
  if (shareMode === 'selected') {
    if (tenantIds.length === 0) {
      return invalid(c, 'tenant_ids', 'Choose at least one tenant to share with');
    }
    const unknown = await unknownTenants(c, tenantIds);
    if (unknown.length > 0) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Some tenants do not exist',
          field: 'tenant_ids',
          tenant_ids: unknown,
        },
        400
      );
    }
  }
  return { shareMode, tenantIds, tenantChangeAllowed };
}

async function unknownTenants(c: AdminContext, tenantIds: string[]): Promise<string[]> {
  if (!c.env.DB) throw new Error('database_not_configured');
  const db = ensureDatabaseAdapter(c.env.DB, PARTITION);
  const found = new Set<string>();
  for (let index = 0; index < tenantIds.length; index += 90) {
    const ids = tenantIds.slice(index, index + 90);
    const rows = await db.query<{ id: string }>(
      `SELECT id FROM tenants
        WHERE id IN (${ids.map(() => '?').join(', ')}) AND lifecycle_state <> 'deleted'`,
      ids
    );
    for (const row of rows) found.add(row.id);
  }
  return tenantIds.filter((id) => !found.has(id));
}

function auditView(launcher: PlatformLauncher) {
  return {
    name: launcher.name,
    launch_url: launcher.launch_url,
    enabled: launcher.enabled,
    share_mode: launcher.share_mode,
    tenant_ids: launcher.tenant_ids,
    tenant_change_allowed: launcher.tenant_change_allowed,
  };
}

/**
 * Reading needs a role held through a global assignment, as editing does (`roles` adds up the
 * tenant-limited ones too); a machine token needs the global settings read permission.
 */
function canView(auth: AdminAuthContext | undefined): boolean {
  if (!auth) return false;
  if (auth.authMethod === 'machine_access_token') return hasPlatformSettingsView(auth, CATEGORY);
  if (!(auth.tenantScope ?? []).includes('*')) return false;
  return checkRolePermission(auth.globalRoles ?? [], CATEGORY, 'platform', 'view');
}

export function createPlatformLaunchersRouter(): Router {
  const router: Router = new Hono();
  const adapter = (c: AdminContext) => requireDedicatedAdminDatabaseAdapter(c.env, PARTITION);
  const failure = (c: AdminContext, step: string, error: unknown) => {
    getLogger(c as unknown as Context<{ Bindings: Env }>)
      .module('PLATFORM-LAUNCHERS')
      .error('Platform launcher request failed', {
        action: step,
        errorType: error instanceof Error ? error.name : 'Unknown',
      });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  };
  /** An environment-wide change, as the tenant backup writer covers one. */
  const covered = (c: AdminContext, run: () => Promise<Response>) =>
    runTenantBackupCoveredMutation({ env: c.env, scope: 'environment', run });
  const normalize = (c: AdminContext, body: Row, existing?: ApplicationLauncher) =>
    normalizeLauncherInput(c as unknown as Context<{ Bindings: Env }>, body, existing, 'platform');

  router.use('*', adminAuthMiddleware({}));
  router.use('*', async (c, next) => {
    const profile = await getRateLimitProfileAsync(
      c.env,
      c.req.method === 'GET' || c.req.method === 'HEAD' ? 'lenient' : 'moderate'
    );
    return rateLimitMiddleware({ ...profile })(c as unknown as Context<{ Bindings: Env }>, next);
  });
  router.use('*', async (c: AdminContext, next) => {
    const auth = c.get('adminAuth');
    const reading = c.req.method === 'GET' || c.req.method === 'HEAD';
    // Every tenant may show these launchers: a role given for one tenant does not reach them.
    const allowed = reading ? canView(auth) : hasGlobalPlatformSettingsEdit(auth, CATEGORY);
    if (!allowed) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    await next();
  });

  router.get('/', async (c) => {
    c.header('Cache-Control', 'no-store');
    try {
      return c.json({ launchers: await listPlatformLaunchers(adapter(c)) });
    } catch (error) {
      return failure(c, 'list', error);
    }
  });

  router.get('/options', (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json({ phosphor_icons: [...PHOSPHOR_ICON_NAMES] });
  });

  router.post('/assets', (c) =>
    covered(c, () => platformLauncherAssetUploadHandler(c as unknown as Context<{ Bindings: Env }>))
  );

  router.post('/', async (c) => {
    const body = await bodyObject(c);
    if (!body) return invalid(c, 'body', 'A JSON object is required');
    return covered(c, async () => {
      try {
        const input = await normalize(c, body);
        if (input instanceof Response) return input;
        const sharing = await readSharing(c, body);
        if (sharing instanceof Response) return sharing;
        const now = Date.now();
        const launcher: ApplicationLauncher = {
          ...input,
          id: `${PLATFORM_LAUNCHER_ID_PREFIX}${crypto.randomUUID()}`,
          created_at: now,
          updated_at: now,
        };
        const auth = c.get('adminAuth');
        if (
          !(await insertPlatformLauncher(
            adapter(c),
            { launcher, ...sharing },
            auth?.userId ?? null
          ))
        ) {
          return c.json(
            {
              error: 'limit_reached',
              error_description: `The platform can have at most ${PLATFORM_LAUNCHER_LIMIT} launchers`,
            },
            409
          );
        }
        const created = await findPlatformLauncher(adapter(c), launcher.id);
        if (!created) return failure(c, 'create', new Error('created_launcher_missing'));
        await writeAdminAuditLog(c, {
          action: 'platform.launcher.created',
          resourceType: RESOURCE,
          resourceId: created.id,
          result: 'success',
          metadata: { scope: 'platform' },
          after: auditView(created),
        });
        return c.json({ launcher: created }, 201);
      } catch (error) {
        return failure(c, 'create', error);
      }
    });
  });

  router.put('/order', async (c) => {
    const body = await bodyObject(c);
    const ids = body?.launcher_ids;
    if (
      !Array.isArray(ids) ||
      ids.length > PLATFORM_LAUNCHER_LIMIT ||
      ids.some((id) => typeof id !== 'string') ||
      new Set(ids).size !== ids.length
    ) {
      return invalid(c, 'launcher_ids', 'launcher_ids must list each launcher once');
    }
    return covered(c, async () => {
      try {
        const launchers = await listPlatformLaunchers(adapter(c));
        const known = new Set(launchers.map((launcher) => launcher.id));
        if (ids.length !== launchers.length || ids.some((id) => !known.has(id as string))) {
          return conflict(c, null);
        }
        const order = (ids as string[]).map((id, index) => ({ id, sort_order: index * 10 }));
        await writePlatformLauncherOrder(adapter(c), order);
        await writeAdminAuditLog(c, {
          action: 'platform.launcher.reordered',
          resourceType: RESOURCE,
          resourceId: 'order',
          result: 'success',
          metadata: { scope: 'platform', launcher_ids: ids },
        });
        return c.json({ launchers: await listPlatformLaunchers(adapter(c)) });
      } catch (error) {
        return failure(c, 'order', error);
      }
    });
  });

  router.get('/:id', async (c) => {
    c.header('Cache-Control', 'no-store');
    try {
      const launcher = await findPlatformLauncher(adapter(c), c.req.param('id'));
      return launcher ? c.json({ launcher }) : missing(c);
    } catch (error) {
      return failure(c, 'get', error);
    }
  });

  router.put('/:id', async (c) => {
    const body = await bodyObject(c);
    if (!body) return invalid(c, 'body', 'A JSON object is required');
    if (typeof body.version !== 'number' || !Number.isSafeInteger(body.version)) {
      return invalid(c, 'version', 'version is required');
    }
    const version = body.version;
    return covered(c, async () => {
      try {
        const before = await findPlatformLauncher(adapter(c), c.req.param('id'));
        if (!before) return missing(c);
        if (before.version !== version) return conflict(c, before.version);
        const input = await normalize(c, body, storedShape(before));
        if (input instanceof Response) return input;
        const sharing = await readSharing(c, body, before);
        if (sharing instanceof Response) return sharing;
        const launcher: ApplicationLauncher = {
          ...input,
          id: before.id,
          created_at: before.created_at,
          updated_at: Date.now(),
        };
        const write = { launcher, ...sharing, writeSortOrder: body.sort_order !== undefined };
        if (!(await updatePlatformLauncher(adapter(c), write, version))) {
          const current = await findPlatformLauncher(adapter(c), before.id);
          return current ? conflict(c, current.version) : missing(c);
        }
        const after = await findPlatformLauncher(adapter(c), before.id);
        if (!after) return missing(c);
        await writeAdminAuditLog(c, {
          action: 'platform.launcher.updated',
          resourceType: RESOURCE,
          resourceId: after.id,
          result: 'success',
          metadata: { scope: 'platform', from_version: before.version, version: after.version },
          before: auditView(before),
          after: auditView(after),
        });
        return c.json({ launcher: after });
      } catch (error) {
        return failure(c, 'update', error);
      }
    });
  });

  /** Deletes by version (`?version=`); tenants' own state of it is left, and no longer shown. */
  router.delete('/:id', async (c) => {
    const version = Number(c.req.query('version'));
    if (!Number.isSafeInteger(version) || version < 1) {
      return invalid(c, 'version', 'version is required');
    }
    return covered(c, async () => {
      try {
        const before = await findPlatformLauncher(adapter(c), c.req.param('id'));
        if (!before) return missing(c);
        if (!(await deletePlatformLauncher(adapter(c), before.id, version))) {
          const current = await findPlatformLauncher(adapter(c), before.id);
          return current ? conflict(c, current.version) : missing(c);
        }
        await writeAdminAuditLog(c, {
          action: 'platform.launcher.deleted',
          resourceType: RESOURCE,
          resourceId: before.id,
          result: 'success',
          metadata: { scope: 'platform', version: before.version },
          before: auditView(before),
        });
        return c.body(null, 204);
      } catch (error) {
        return failure(c, 'delete', error);
      }
    });
  });

  return router;
}
