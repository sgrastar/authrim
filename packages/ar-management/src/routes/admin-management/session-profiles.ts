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
  getLogger,
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

/** Whether a Flow of the tenant names the profile: its draft, or the version it runs. */
async function profileInUse(c: AdminContext, tenantId: string, id: string): Promise<boolean> {
  const db = createAuthContextFromHono(
    c as unknown as Context<{ Bindings: Env }>,
    tenantId
  ).coreAdapter;
  const needle = `%"session_profile_ref":${JSON.stringify(id)}%`;
  const row = await db.queryOne<{ id: string }>(
    `SELECT f.id AS id FROM flows f
       LEFT JOIN flow_versions v ON v.id = f.published_version_id AND v.tenant_id = f.tenant_id
      WHERE f.tenant_id = ? AND f.deleted_at IS NULL
        AND (f.draft_editor_json LIKE ? OR v.runtime_snapshot_json LIKE ?)
      LIMIT 1`,
    [tenantId, needle, needle]
  );
  return row !== null && row !== undefined;
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
  const values: Record<string, unknown> = {};
  for (const key of SESSION_PROFILE_KEYS) {
    const value: unknown = (categoryOfKey(key) === 'oauth' ? oauth : session).values[key];
    if (value !== undefined) values[key] = value;
  }
  return {
    id: 'default',
    name: 'Default',
    is_system: true,
    values,
    version: defaultVersion({ session: String(session.version), oauth: String(oauth.version) }),
    created_by: null,
    created_at: null,
    updated_at: null,
  };
}

sessionProfilesRouter.get('/', async (c) => {
  c.header('Cache-Control', 'no-store');
  try {
    const [builtIn, saved] = await Promise.all([
      defaultProfile(c, true),
      repo(c).list(getTenantIdFromContext(c)),
    ]);
    return c.json({
      profiles: [builtIn, ...saved.map((profile) => ({ ...profile, is_system: false }))],
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
    return c.json({ profile: { ...result.profile, is_system: false } }, 201);
  } catch (error) {
    return failure(c, 'create', error);
  }
});

sessionProfilesRouter.get('/:id', async (c) => {
  c.header('Cache-Control', 'no-store');
  try {
    if (c.req.param('id') === 'default') return c.json({ profile: await defaultProfile(c, true) });
    const profile = await repo(c).find(getTenantIdFromContext(c), c.req.param('id'));
    return profile ? c.json({ profile: { ...profile, is_system: false } }) : missing(c);
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
  const parsed = inputFrom(c, body);
  if (parsed.error) return parsed.error;
  const input = parsed.input;
  const id = c.req.param('id');
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
      for (const category of categories) {
        const response = await change(category, false);
        if (!response.ok) return response;
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
    return c.json({ profile: { ...result.profile, is_system: false } });
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
