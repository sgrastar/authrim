/**
 * The platform's authentication method and session profiles (admin migration 015):
 *
 *   /api/admin/platform/authentication-method-profiles
 *   /api/admin/platform/session-profiles
 *
 * List, create, read, change, lock or unlock, and delete. Every tenant may use them (the tenant
 * routes list them beside its own), so only a platform administrator with a global assignment
 * may read or change them here, and a change is an environment-wide one (covered by the tenant
 * backup writer as such) with its audit record.
 *
 * Deleting: one operation claims the profile (active → deleting, with its token; a second
 * delete meanwhile is refused), so no Flow takes a new reference to it, then every tenant's Flows
 * are searched. It is marked deleted only when none names it and every tenant could be read;
 * otherwise this operation gives it back as active and the answer says why. A deleted profile
 * keeps its row (not listed, not named anew): a Flow that came to name it in a race still reads
 * it, rather than losing its profile.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AdminAuthContext, Env } from '@authrim/ar-lib-core';
import {
  AR_ERROR_CODES,
  NamedProfileRepository,
  PlatformProfileRepository,
  adminAuthMiddleware,
  createErrorResponse,
  ensureDatabaseAdapter,
  findPlatformProfileReferences,
  getLogger,
  getRateLimitProfileAsync,
  rateLimitMiddleware,
  requireDedicatedAdminDatabaseAdapter,
  resolveAuthCorePersistenceAdapterFromEnv,
  type PlatformProfile,
  type PlatformProfileKind,
} from '@authrim/ar-lib-core';
import { writeAdminAuditLog } from '../admin-shared';
import { runTenantBackupCoveredMutation } from '../tenant-backup-writer';
import {
  checkRolePermission,
  hasGlobalPlatformSettingsEdit,
} from './settings-v2/settings-authorization';
import {
  checkProfileValues,
  profileName,
  profileValuesError,
} from './admin-management/profile-input';

type AdminContext = Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;
type Router = Hono<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;

const PARTITION = 'platform-profiles';
const LABEL: Readonly<Record<PlatformProfileKind, string>> = {
  method: 'authentication_method',
  session: 'session',
};
const TENANT_TABLE: Readonly<
  Record<PlatformProfileKind, 'authentication_method_profiles' | 'session_profiles'>
> = {
  method: 'authentication_method_profiles',
  session: 'session_profiles',
};

/** Whether the caller may read the platform's profiles: a global assignment, as for editing. */
function canViewPlatformProfiles(auth: AdminAuthContext | undefined): boolean {
  if (!auth) return false;
  if (auth.authMethod === 'machine_access_token')
    return hasGlobalPlatformSettingsEdit(auth, 'profiles');
  if (!(auth.tenantScope ?? []).includes('*')) return false;
  return checkRolePermission(auth.globalRoles ?? [], 'profiles', 'platform', 'view');
}

function view(profile: PlatformProfile, overridingTenants?: number) {
  return {
    id: profile.id,
    name: profile.name,
    values: profile.values,
    version: profile.version,
    locked: profile.locked,
    state: profile.state,
    created_by: profile.created_by,
    created_at: profile.created_at,
    updated_at: profile.updated_at,
    ...(overridingTenants === undefined ? {} : { overriding_tenants: overridingTenants }),
  };
}

const invalid = (c: AdminContext, field: string, reason: string) =>
  c.json({ error: 'invalid_request', error_description: reason, field }, 400);
const missing = (c: AdminContext) =>
  c.json({ error: 'not_found', error_description: 'Platform profile not found' }, 404);
const conflict = (c: AdminContext, version: number) =>
  c.json(
    {
      error: 'conflict',
      error_description: 'The profile changed; reload and try again',
      current_version: version,
    },
    409
  );

async function bodyObject(c: AdminContext): Promise<Record<string, unknown> | null> {
  const body: unknown = await c.req.json().catch(() => null);
  return body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

export function createPlatformProfilesRouter(kind: PlatformProfileKind): Router {
  const router: Router = new Hono();
  const resource = `platform_${LABEL[kind]}_profile`;
  const action = (verb: string) => `platform.${LABEL[kind]}_profile.${verb}`;
  const adminAdapter = (c: AdminContext) => requireDedicatedAdminDatabaseAdapter(c.env, PARTITION);
  const repo = (c: AdminContext) => new PlatformProfileRepository(adminAdapter(c), kind);
  const tenantRepo = (c: AdminContext) =>
    new NamedProfileRepository(adminAdapter(c), TENANT_TABLE[kind]);
  const failure = (c: AdminContext, step: string, error: unknown) => {
    getLogger(c as unknown as Context<{ Bindings: Env }>)
      .module('PLATFORM-PROFILES')
      .error('Platform profile request failed', {
        action: step,
        kind,
        errorType: error instanceof Error ? error.name : 'Unknown',
      });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  };
  /** An environment-wide change, as the tenant backup writer covers one. */
  const covered = (c: AdminContext, run: () => Promise<Response>) =>
    runTenantBackupCoveredMutation({ env: c.env, scope: 'environment', run });

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
    // Every tenant uses these profiles: a role given for one tenant does not reach them.
    const allowed = reading
      ? canViewPlatformProfiles(auth)
      : hasGlobalPlatformSettingsEdit(auth, 'profiles');
    if (!allowed) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    await next();
  });

  router.get('/', async (c) => {
    c.header('Cache-Control', 'no-store');
    try {
      const profiles = await repo(c).list();
      const tenants = tenantRepo(c);
      const counts = await Promise.all(profiles.map((p) => tenants.countOverridingTenants(p.id)));
      return c.json({ profiles: profiles.map((p, index) => view(p, counts[index])) });
    } catch (error) {
      return failure(c, 'list', error);
    }
  });

  router.post('/', async (c) => {
    const body = await bodyObject(c);
    if (!body) return invalid(c, 'body', 'A JSON object is required');
    const name = profileName(body.name);
    if (!name) return invalid(c, 'name', 'name must be 1 to 80 characters');
    if (name.toLowerCase() === 'default') return invalid(c, 'name', 'This name is reserved');
    const check = checkProfileValues(kind, body.values, { platform: true });
    if (!check.ok) return profileValuesError(c, check);
    return covered(c, async () => {
      try {
        const auth = c.get('adminAuth');
        const result = await repo(c).create({ name, values: check.values }, auth?.userId ?? null);
        if (result.status === 'name_taken') {
          return c.json(
            { error: 'conflict', error_description: 'A platform profile has this name' },
            409
          );
        }
        if (result.status === 'limit_reached') {
          return c.json(
            { error: 'limit_reached', error_description: 'The platform has its most profiles' },
            409
          );
        }
        await writeAdminAuditLog(c, {
          action: action('created'),
          resourceType: resource,
          resourceId: result.profile.id,
          result: 'success',
          metadata: { scope: 'platform', name },
          after: { values: result.profile.values },
        });
        return c.json({ profile: view(result.profile, 0) }, 201);
      } catch (error) {
        return failure(c, 'create', error);
      }
    });
  });

  router.get('/:id', async (c) => {
    c.header('Cache-Control', 'no-store');
    try {
      const profile = await repo(c).find(c.req.param('id'));
      if (!profile || profile.state === 'deleted') return missing(c);
      const count = await tenantRepo(c).countOverridingTenants(profile.id);
      return c.json({ profile: view(profile, count) });
    } catch (error) {
      return failure(c, 'get', error);
    }
  });

  router.put('/:id', async (c) => {
    const body = await bodyObject(c);
    if (!body) return invalid(c, 'body', 'A JSON object is required');
    const name = profileName(body.name);
    if (!name) return invalid(c, 'name', 'name must be 1 to 80 characters');
    if (name.toLowerCase() === 'default') return invalid(c, 'name', 'This name is reserved');
    if (typeof body.version !== 'number' || !Number.isSafeInteger(body.version)) {
      return invalid(c, 'version', 'version is required');
    }
    const version = body.version;
    const check = checkProfileValues(kind, body.values, { platform: true });
    if (!check.ok) return profileValuesError(c, check);
    return covered(c, async () => {
      try {
        const before = await repo(c).find(c.req.param('id'));
        if (!before || before.state === 'deleted') return missing(c);
        const result = await repo(c).update(before.id, { name, values: check.values }, version);
        if (result.status === 'not_found') return missing(c);
        if (result.status === 'conflict') return conflict(c, result.currentVersion);
        if (result.status === 'name_taken') {
          return c.json(
            { error: 'conflict', error_description: 'A platform profile has this name' },
            409
          );
        }
        await writeAdminAuditLog(c, {
          action: action('updated'),
          resourceType: resource,
          resourceId: before.id,
          result: 'success',
          metadata: {
            scope: 'platform',
            from_version: before.version,
            version: result.profile.version,
          },
          before: { name: before.name, values: before.values },
          after: { name, values: result.profile.values },
        });
        return c.json({ profile: view(result.profile) });
      } catch (error) {
        return failure(c, 'update', error);
      }
    });
  });

  /** Locks or unlocks: `{ locked: boolean, version }`. A locked profile sets tenants' copies aside. */
  router.put('/:id/lock', async (c) => {
    const body = await bodyObject(c);
    if (!body || typeof body.locked !== 'boolean') {
      return invalid(c, 'locked', 'locked must be true or false');
    }
    if (typeof body.version !== 'number' || !Number.isSafeInteger(body.version)) {
      return invalid(c, 'version', 'version is required');
    }
    const locked = body.locked;
    const version = body.version;
    return covered(c, async () => {
      try {
        const before = await repo(c).find(c.req.param('id'));
        if (!before || before.state === 'deleted') return missing(c);
        const result = await repo(c).setLocked(before.id, locked, version);
        if (result.status === 'not_found') return missing(c);
        if (result.status === 'conflict') return conflict(c, result.currentVersion);
        if (result.status !== 'updated') return failure(c, 'lock', new Error(result.status));
        const overriding = await tenantRepo(c).countOverridingTenants(result.profile.id);
        await writeAdminAuditLog(c, {
          action: action(locked ? 'locked' : 'unlocked'),
          resourceType: resource,
          resourceId: result.profile.id,
          result: 'success',
          // How many tenants' copies are set aside (locked) or apply again (unlocked).
          metadata: {
            scope: 'platform',
            overriding_tenants: overriding,
            version: result.profile.version,
          },
          // The state the change was made from (the version checked it was this one).
          before: { locked: before.locked },
          after: { locked },
        });
        return c.json({ profile: view(result.profile, overriding) });
      } catch (error) {
        return failure(c, 'lock', error);
      }
    });
  });

  router.delete('/:id', async (c) => {
    return covered(c, async () => {
      const id = c.req.param('id');
      const token = crypto.randomUUID();
      try {
        const profile = await repo(c).find(id);
        if (!profile || profile.state === 'deleted') return missing(c);
        if (!(await repo(c).claimDeleting(id, token))) {
          return c.json(
            {
              error: 'delete_in_progress',
              error_description: 'This profile is already being deleted',
            },
            409
          );
        }
        // No new reference is taken from here on (publishing refuses it).
        const scan = await findPlatformProfileReferences({
          profileId: id,
          listTenantIds: async (limit) => {
            if (!c.env.DB) throw new Error('database_not_configured');
            const rows = await ensureDatabaseAdapter(c.env.DB, PARTITION).query<{ id: string }>(
              "SELECT id FROM tenants WHERE lifecycle_state <> 'deleted' ORDER BY id LIMIT ?",
              [limit]
            );
            return rows.map((row) => row.id);
          },
          resolveCoreAdapter: (tenantId) =>
            resolveAuthCorePersistenceAdapterFromEnv(c.env, PARTITION, { tenantId }),
        });
        if (scan.tenants.length > 0 || scan.unscanned.length > 0) {
          await repo(c).releaseDeleting(id, token);
          await writeAdminAuditLog(c, {
            action: action('delete_refused'),
            resourceType: resource,
            resourceId: id,
            result: 'failure',
            metadata: {
              scope: 'platform',
              tenants: scan.tenants,
              truncated: scan.truncated,
              unscanned: scan.unscanned,
            },
          });
          return c.json(
            {
              error: scan.tenants.length > 0 ? 'profile_in_use' : 'reference_check_incomplete',
              error_description:
                scan.tenants.length > 0
                  ? 'Flows of some tenants use this profile'
                  : 'Not every tenant could be checked; the profile is kept',
              tenants: scan.tenants,
              truncated: scan.truncated,
              unscanned: scan.unscanned.length,
            },
            409
          );
        }
        if (!(await repo(c).finishDeleting(id, token))) {
          return failure(c, 'delete', new Error('delete_claim_lost'));
        }
        await writeAdminAuditLog(c, {
          action: action('deleted'),
          resourceType: resource,
          resourceId: id,
          result: 'success',
          metadata: { scope: 'platform', name: profile.name, version: profile.version },
          before: { name: profile.name, values: profile.values, locked: profile.locked },
        });
        return c.body(null, 204);
      } catch (error) {
        // A search that failed half way leaves the profile usable, not half deleted. Given back
        // whether or not the claim was seen to succeed (its answer may be what was lost): only
        // this operation's token can give it back. One that cannot even do that is taken over by
        // a later delete once it has held it too long (claimDeleting).
        await repo(c)
          .releaseDeleting(id, token)
          .catch(() => undefined);
        return failure(c, 'delete', error);
      }
    });
  });

  return router;
}
