/**
 * Named session profiles (how long a session lasts, whether it can be extended, single sign-on),
 * plus the live tenant-wide Default profile: the tenant's `session` settings and `oauth.sso_enabled`.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AdminAuthContext, CategoryName, Env, SettingScope } from '@authrim/ar-lib-core';
import {
  AR_ERROR_CODES,
  ALL_CATEGORY_META,
  SESSION_PROFILE_KEYS,
  SessionProfileRepository,
  adminAuthMiddleware,
  createAuthContextFromHono,
  createErrorResponse,
  flowsNameProfile,
  getLogger,
  isPlatformProfileId,
  getRateLimitProfileAsync,
  getTenantIdFromContext,
  rateLimitMiddleware,
  requireDedicatedAdminDatabaseAdapter,
  validateSettingValue,
} from '@authrim/ar-lib-core';
import { writeAdminAuditLog } from '../../admin-shared';
import {
  canAccessTenant,
  hasTenantSettingsPermission,
} from '../settings-v2/settings-authorization';
import { applyTenantSettingsChange } from '../settings-v2/tenant-settings-apply';
import { getSettingsManager } from '../settings-v2/settings-support';
import {
  creationNotAllowed,
  deleteTenantOverride,
  getPlatformEntry,
  listPlatformEntries,
  saveTenantOverride,
  tenantMayCreateProfile,
} from './tenant-platform-profiles';

type AdminContext = Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;
type Router = Hono<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;
export const sessionProfilesRouter: Router = new Hono();

const allowedKeys = new Set<string>(SESSION_PROFILE_KEYS);
/** The settings category each profile setting belongs to. */
const categoryOfKey = (key: string): 'session' | 'oauth' =>
  key.startsWith('oauth.') ? 'oauth' : 'session';
const metaOf = (key: string) =>
  (ALL_CATEGORY_META[categoryOfKey(key)].settings as Record<string, unknown>)[key] as Parameters<
    typeof validateSettingValue
  >[2];
const NAME_MAX = 80;
const VALUES_MAX_BYTES = 64 * 1024;

sessionProfilesRouter.use('*', adminAuthMiddleware({}));
sessionProfilesRouter.use('*', async (c, next) => {
  const profile = await getRateLimitProfileAsync(
    c.env,
    c.req.method === 'GET' || c.req.method === 'HEAD' ? 'lenient' : 'moderate'
  );
  return rateLimitMiddleware({ ...profile })(c as unknown as Context<{ Bindings: Env }>, next);
});
sessionProfilesRouter.use('*', async (c: AdminContext, next) => {
  const auth = c.get('adminAuth');
  const tenantId = getTenantIdFromContext(c);
  const action = c.req.method === 'GET' || c.req.method === 'HEAD' ? 'view' : 'edit';
  if (
    !auth ||
    !hasTenantSettingsPermission(auth, 'session', action, tenantId) ||
    !canAccessTenant(auth, tenantId)
  ) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  await next();
});

const repo = (c: AdminContext) =>
  new SessionProfileRepository(requireDedicatedAdminDatabaseAdapter(c.env, 'admin-management'));
const invalid = (c: AdminContext, field: string, reason: string) =>
  c.json({ error: 'invalid_request', error_description: reason, field }, 400);
const missing = (c: AdminContext) =>
  c.json({ error: 'not_found', error_description: 'Session profile not found' }, 404);
const conflict = (c: AdminContext, version: number) =>
  c.json(
    {
      error: 'conflict',
      error_description: 'The profile changed; reload and try again',
      current_version: version,
    },
    409
  );
const failure = (c: AdminContext, action: string, error: unknown) => {
  getLogger(c as unknown as Context<{ Bindings: Env }>)
    .module('SESSION-PROFILES')
    .error('Session profile request failed', {
      action,
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
  return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
};

/**
 * Whether a Flow of the tenant names the profile: its draft, the version it publishes, or a
 * version an interaction still running started with.
 */
async function profileInUse(c: AdminContext, tenantId: string, id: string): Promise<boolean> {
  const db = createAuthContextFromHono(
    c as unknown as Context<{ Bindings: Env }>,
    tenantId
  ).coreAdapter;
  return flowsNameProfile(db, tenantId, id, Math.floor(Date.now() / 1000));
}

async function bodyObject(c: AdminContext): Promise<Record<string, unknown> | null> {
  const body: unknown = await c.req.json().catch(() => null);
  return body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

function inputFrom(
  c: AdminContext,
  body: Record<string, unknown>
):
  | { input: { name: string; values: Record<string, unknown> }; error?: never }
  | { input?: never; error: Response } {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > NAME_MAX)
    return { error: invalid(c, 'name', `name must be 1 to ${NAME_MAX} characters`) };
  if (!body.values || typeof body.values !== 'object' || Array.isArray(body.values)) {
    return { error: invalid(c, 'values', 'values must be an object') };
  }
  const values = body.values as Record<string, unknown>;
  const rejected: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!allowedKeys.has(key)) {
      rejected[key] = 'Not a session profile setting';
      continue;
    }
    const validation = validateSettingValue(key, value, metaOf(key));
    if (!validation.valid) rejected[key] = validation.errors[0]?.reason ?? 'Invalid value';
  }
  if (Object.keys(rejected).length)
    return {
      error: c.json(
        {
          error: 'invalid_request',
          error_description: 'Some profile values are invalid',
          field: 'values',
          rejected,
        },
        400
      ),
    };
  if (new TextEncoder().encode(JSON.stringify(values)).length > VALUES_MAX_BYTES) {
    return { error: invalid(c, 'values', 'values are too large') };
  }
  return { input: { name, values } };
}

/** The Default profile's version: the versions of both settings documents it is read from. */
function defaultVersion(versions: Record<'session' | 'oauth', string>): string {
  return JSON.stringify(versions);
}

function readDefaultVersion(value: unknown): Record<'session' | 'oauth', string> | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const { session, oauth } = parsed as Record<string, unknown>;
    return typeof session === 'string' && typeof oauth === 'string' ? { session, oauth } : null;
  } catch {
    return null;
  }
}

async function defaultProfile(c: AdminContext, readOnly: boolean) {
  const tenantId = getTenantIdFromContext(c);
  const manager = getSettingsManager(c.env, c, true, false, undefined, { readOnly });
  const scope = { type: 'tenant', id: tenantId } satisfies SettingScope;
  const [session, oauth] = await Promise.all([
    manager.getAll('session', scope),
    manager.getAll('oauth', scope),
  ]);
  // Single sign-on is an oauth setting: shown only to an admin who may see that category.
  const auth = c.get('adminAuth');
  const seesOauth = auth ? hasTenantSettingsPermission(auth, 'oauth', 'view', tenantId) : false;
  const values: Record<string, unknown> = {};
  for (const key of SESSION_PROFILE_KEYS) {
    if (categoryOfKey(key) === 'oauth' && !seesOauth) continue;
    const value: unknown = (categoryOfKey(key) === 'oauth' ? oauth : session).values[key];
    if (value !== undefined) values[key] = value;
  }
  return {
    id: 'default',
    name: 'Default',
    is_system: true,
    values,
    // The oauth document's version stays hidden too from an admin who may not see it: it could
    // tell its one value apart.
    version: defaultVersion({
      session: String(session.version),
      oauth: seesOauth ? String(oauth.version) : 'hidden',
    }),
    created_by: null,
    created_at: null,
    updated_at: null,
  };
}

sessionProfilesRouter.get('/', async (c) => {
  c.header('Cache-Control', 'no-store');
  try {
    const tenantId = getTenantIdFromContext(c);
    const [builtIn, saved, platform] = await Promise.all([
      defaultProfile(c, true),
      repo(c).list(tenantId),
      listPlatformEntries(c, 'session', tenantId),
    ]);
    return c.json({
      profiles: [
        builtIn,
        ...saved.map((profile) => ({ ...profile, is_system: false, scope: 'tenant' })),
        ...platform,
      ],
    });
  } catch (error) {
    return failure(c, 'list', error);
  }
});

sessionProfilesRouter.post('/', async (c) => {
  c.header('Cache-Control', 'no-store');
  const auth = c.get('adminAuth');
  if (!auth) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  const body = await bodyObject(c);
  if (!body) return invalid(c, 'body', 'The body must be a JSON object');
  const parsed = inputFrom(c, body);
  if (parsed.error) return parsed.error;
  const input = parsed.input;
  if (input.name.toLowerCase() === 'default') return invalid(c, 'name', 'Default is reserved');
  try {
    if (!(await tenantMayCreateProfile(c, 'session'))) return creationNotAllowed(c);
    const result = await repo(c).create(getTenantIdFromContext(c), input, auth.userId);
    if (result.status === 'name_taken') return c.json({ error: 'profile_name_taken' }, 409);
    if (result.status === 'limit_reached') return c.json({ error: 'profile_limit_reached' }, 409);
    await writeAdminAuditLog(c, {
      action: 'session.profile.created',
      resourceType: 'session_profile',
      resourceId: result.profile.id,
      result: 'success',
      metadata: { name: result.profile.name },
    });
    return c.json({ profile: { ...result.profile, is_system: false, scope: 'tenant' } }, 201);
  } catch (error) {
    return failure(c, 'create', error);
  }
});

sessionProfilesRouter.get('/:id', async (c) => {
  c.header('Cache-Control', 'no-store');
  try {
    const id = c.req.param('id');
    if (id === 'default') return c.json({ profile: await defaultProfile(c, true) });
    if (isPlatformProfileId('session', id)) {
      const entry = await getPlatformEntry(c, 'session', getTenantIdFromContext(c), id);
      return entry ? c.json({ profile: entry }) : missing(c);
    }
    const profile = await repo(c).find(getTenantIdFromContext(c), id);
    return profile
      ? c.json({ profile: { ...profile, is_system: false, scope: 'tenant' } })
      : missing(c);
  } catch (error) {
    return failure(c, 'get', error);
  }
});

sessionProfilesRouter.put('/:id', async (c) => {
  c.header('Cache-Control', 'no-store');
  const auth = c.get('adminAuth');
  if (!auth) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  const body = await bodyObject(c);
  if (!body) return invalid(c, 'body', 'The body must be a JSON object');
  const id = c.req.param('id');
  // A platform profile: the tenant's copy of it (its name is the platform's).
  if (isPlatformProfileId('session', id)) {
    try {
      return await saveTenantOverride(c, 'session', getTenantIdFromContext(c), id, body);
    } catch (error) {
      return failure(c, 'override', error);
    }
  }
  const parsed = inputFrom(c, body);
  if (parsed.error) return parsed.error;
  const input = parsed.input;
  if (id === 'default') {
    if (input.name !== 'Default')
      return invalid(c, 'name', 'The Default profile cannot be renamed');
    const versions = readDefaultVersion(body.version);
    if (!versions) return invalid(c, 'version', 'version is required');
    try {
      const current = await defaultProfile(c, false);
      // Saved on top of what was read, or not at all: either document moved on is a conflict.
      if (current.version !== defaultVersion(versions)) {
        return c.json(
          {
            error: 'conflict',
            error_description: 'The profile changed; reload and try again',
            current_version: current.version,
          },
          409
        );
      }
      const changed = Object.entries(input.values).filter(
        ([key, value]) => JSON.stringify(current.values[key]) !== JSON.stringify(value)
      );
      // A setting the admin may not see is not changed through Default: its save could only
      // answer with what the admin may not see (its document's version).
      if (
        !hasTenantSettingsPermission(auth, 'oauth', 'view', getTenantIdFromContext(c)) &&
        changed.some(([key]) => categoryOfKey(key) === 'oauth')
      ) {
        return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
      }
      const categories = (['session', 'oauth'] as const).filter((category) =>
        changed.some(([key]) => categoryOfKey(key) === category)
      );
      const change = async (category: 'session' | 'oauth', dryRun: boolean) =>
        applyTenantSettingsChange({
          c,
          adminAuth: auth,
          tenantId: getTenantIdFromContext(c),
          category: category satisfies CategoryName,
          dryRun,
          readBody: async () => ({
            ifMatch: versions[category],
            set: Object.fromEntries(changed.filter(([key]) => categoryOfKey(key) === category)),
            clear: [],
          }),
        });
      // Every change is tried first: nothing is saved unless all of it can be.
      for (const category of categories) {
        const trial = await change(category, true);
        if (!trial.ok) return trial;
        const trialResult = await trial.json<{ rejected?: Record<string, unknown> }>();
        if (trialResult.rejected && Object.keys(trialResult.rejected).length) {
          return c.json(
            {
              error: 'invalid_request',
              error_description: 'Some settings cannot be changed',
              field: 'values',
              rejected: trialResult.rejected,
            },
            400
          );
        }
      }
      // The documents are saved one after the other: one that fails after another was saved is
      // answered with what was applied, and recorded, so nothing is left half-done unseen.
      const applied: Array<'session' | 'oauth'> = [];
      for (const category of categories) {
        let response: Response;
        try {
          response = await change(category, false);
        } catch (error) {
          if (applied.length === 0) throw error;
          response = new Response(null, { status: 500 });
        }
        if (!response.ok) {
          if (applied.length === 0) return response;
          await writeAdminAuditLog(c, {
            action: 'session.profile.partially_updated',
            resourceType: 'session_profile',
            resourceId: 'default',
            result: 'failure',
            metadata: { name: 'Default', applied, failed: category, status: response.status },
          });
          return c.json(
            {
              error: 'partially_applied',
              error_description:
                'Some of the Default profile was saved and the rest was not; reload and try again',
              applied,
              failed: category,
            },
            409
          );
        }
        applied.push(category);
      }
      await writeAdminAuditLog(c, {
        action: 'session.profile.updated',
        resourceType: 'session_profile',
        resourceId: 'default',
        result: 'success',
        metadata: { name: 'Default' },
      });
      return c.json({ profile: await defaultProfile(c, false) });
    } catch (error) {
      return failure(c, 'update_default', error);
    }
  }
  const expected = body.version;
  if (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected < 1) {
    return invalid(c, 'version', 'version must be a positive integer');
  }
  if (input.name.toLowerCase() === 'default') return invalid(c, 'name', 'Default is reserved');
  try {
    const result = await repo(c).update(getTenantIdFromContext(c), id, input, expected);
    if (result.status === 'not_found') return missing(c);
    if (result.status === 'name_taken') return c.json({ error: 'profile_name_taken' }, 409);
    if (result.status === 'conflict') return conflict(c, result.currentVersion);
    await writeAdminAuditLog(c, {
      action: 'session.profile.updated',
      resourceType: 'session_profile',
      resourceId: id,
      result: 'success',
      metadata: { name: result.profile.name, version: result.profile.version },
    });
    return c.json({ profile: { ...result.profile, is_system: false, scope: 'tenant' } });
  } catch (error) {
    return failure(c, 'update', error);
  }
});

sessionProfilesRouter.delete('/:id', async (c) => {
  c.header('Cache-Control', 'no-store');
  if (c.req.param('id') === 'default')
    return invalid(c, 'id', 'The Default profile cannot be deleted');
  try {
    const id = c.req.param('id');
    // A platform profile: removes the tenant's copy (the platform's values hold again).
    if (isPlatformProfileId('session', id)) {
      return await deleteTenantOverride(c, 'session', getTenantIdFromContext(c), id);
    }
    const profile = await repo(c).find(getTenantIdFromContext(c), id);
    if (!profile) return missing(c);
    // A Flow that names it (its draft, or the version it runs) could make no session once it is
    // gone: it is taken off the Flow first.
    if (await profileInUse(c, getTenantIdFromContext(c), id)) {
      return c.json(
        {
          error: 'conflict',
          error_description: 'A service flow uses this profile; choose another profile there first',
        },
        409
      );
    }
    if (!(await repo(c).delete(getTenantIdFromContext(c), id))) return missing(c);
    await writeAdminAuditLog(c, {
      action: 'session.profile.deleted',
      resourceType: 'session_profile',
      resourceId: id,
      result: 'success',
      metadata: { name: profile.name },
    });
    return c.body(null, 204);
  } catch (error) {
    return failure(c, 'delete', error);
  }
});
