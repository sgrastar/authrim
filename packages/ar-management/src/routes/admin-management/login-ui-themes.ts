/**
 * Saved Login UI themes: named sets of appearance settings a tenant keeps, edits and applies.
 *
 * Endpoints (under /api/admin/login-ui/themes):
 * - GET    /            - The tenant's themes (summaries) and which one is applied
 * - POST   /            - Save a theme
 * - GET    /:id         - One theme, and whether it is the applied one
 * - PUT    /:id         - Replace a theme (If-Match: its version)
 * - DELETE /:id         - Delete a theme (not the applied one)
 * - POST   /:id/apply   - Make a theme the tenant's live Login UI
 *
 * A theme holds values for the appearance keys in LOGIN_UI_THEME_KEYS and nothing else. Applying
 * it writes the tenant's `login-ui` settings document through the same save the settings PATCH
 * runs (applyTenantSettingsChange: version check, validation, canonical store, KV projection,
 * audit, authentication-methods cache revision), so a theme can do nothing a PATCH could not.
 * Reads need settings read; writes need the login UI settings permission (route access rules).
 * Every route also asks what the `login-ui` settings themselves ask (the category's roles and the
 * caller's reach of the tenant), so the themes cannot be read or changed by anyone the settings
 * would refuse.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AdminAuthContext, Env, SettingScope } from '@authrim/ar-lib-core';
import {
  AR_ERROR_CODES,
  LOGIN_UI_SETTINGS_META,
  LOGIN_UI_THEME_KEYS,
  LoginUIThemeRepository,
  adminAuthMiddleware,
  createErrorResponse,
  getLogger,
  getRateLimitProfileAsync,
  getTenantIdFromContext,
  rateLimitMiddleware,
  requireDedicatedAdminDatabaseAdapter,
  validateLoginUICustomCss,
  validateSettingValue,
  type DatabaseAdapter,
  type LoginUITheme,
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

export const loginUIThemesRouter: Router = new Hono();
loginUIThemesRouter.use('*', adminAuthMiddleware({}));
// As the settings routes: lenient to read, moderate to change (apply writes the settings too).
loginUIThemesRouter.use('*', async (c, next) => {
  const profile = await getRateLimitProfileAsync(
    c.env,
    c.req.method === 'GET' || c.req.method === 'HEAD' ? 'lenient' : 'moderate'
  );
  return rateLimitMiddleware({ ...profile })(c as unknown as Context<{ Bindings: Env }>, next);
});
loginUIThemesRouter.use('*', async (c: AdminContext, next) => {
  const auth = c.get('adminAuth');
  const tenantId = getTenantIdFromContext(c);
  const action = c.req.method === 'GET' || c.req.method === 'HEAD' ? 'view' : 'edit';
  if (
    !auth ||
    !hasTenantSettingsPermission(auth, 'login-ui', action, tenantId) ||
    !canAccessTenant(auth, tenantId)
  ) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  await next();
});

const NAME_MAX = 80;
/** Upper bound on the stored JSON of one theme (custom CSS is the only large value). */
const VALUES_MAX_BYTES = 256 * 1024;
const ACTIVE_ID_KEY = 'login-ui.active_theme_id';
const ACTIVE_VERSION_KEY = 'login-ui.active_theme_version';
const THEME_KEYS: ReadonlySet<string> = new Set(LOGIN_UI_THEME_KEYS);

/**
 * Whether the settings save refused because the document is no longer at the version read (its
 * 409 then names the current version). Other refusals, a 409 among them, are passed on as they are.
 */
async function isVersionConflict(response: Response): Promise<boolean> {
  if (response.status !== 409) return false;
  const body = await response
    .clone()
    .json<{ currentVersion?: unknown }>()
    .catch(() => null);
  return body?.currentVersion !== undefined;
}

function settingsConflict(c: AdminContext): Response {
  return refuse(
    c,
    409,
    'settings_conflict',
    'The Login UI settings changed while the theme was applied; try again'
  );
}

function themeLog(c: AdminContext) {
  return getLogger(c as unknown as Context<{ Bindings: Env }>).module('LOGIN-UI-THEMES');
}

function adminAdapter(c: AdminContext): DatabaseAdapter {
  return requireDedicatedAdminDatabaseAdapter(c.env, 'admin-management');
}

const invalid = (c: AdminContext, field: string, description: string) =>
  c.json({ error: 'invalid_request', error_description: description, field }, 400);

const notFound = (c: AdminContext) =>
  c.json({ error: 'not_found', error_description: 'Theme not found' }, 404);

async function jsonBody(c: AdminContext): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await c.req.json();
    return body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function failure(c: AdminContext, action: string, error: unknown) {
  themeLog(c).error('Login UI theme request failed', {
    action,
    errorType: error instanceof Error ? error.name : 'Unknown',
  });
  return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
}

const versionEtag = (version: number) => `"${version}"`;

/** The version in If-Match: "3", 3 or "v3"; null when absent, NaN when unreadable. */
function parseIfMatchVersion(c: AdminContext): number | null {
  const raw = c.req.header('if-match');
  if (!raw) return null;
  const normalized = raw.trim().replace(/^W\//, '').replace(/^"|"$/g, '').replace(/^v/, '');
  const version = /^\d+$/.test(normalized) ? Number.parseInt(normalized, 10) : Number.NaN;
  return Number.isSafeInteger(version) && version > 0 ? version : Number.NaN;
}

function conflict(c: AdminContext, reason: string, currentVersion: number) {
  return createErrorResponse(c, AR_ERROR_CODES.ADMIN_CONFLICT, {
    extensions: {
      details: {
        conflict: {
          reason,
          actual_version: currentVersion,
          current_etag: versionEtag(currentVersion),
        },
      },
      current_version: currentVersion,
    },
  });
}

const refuse = (c: AdminContext, status: 409, error: string, description: string) =>
  c.json({ error, error_description: description }, status);

interface ThemeInput {
  name: string;
  values: Record<string, unknown>;
}

/** A valid `{ name, values }` body, or the 400 that says what is wrong. */
function readThemeInput(
  c: AdminContext,
  body: Record<string, unknown>
): { ok: true; input: ThemeInput } | { ok: false; response: Response } {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > NAME_MAX) {
    return { ok: false, response: invalid(c, 'name', `name must be 1 to ${NAME_MAX} characters`) };
  }
  const raw = body.values;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, response: invalid(c, 'values', 'values must be an object') };
  }

  const values: Record<string, unknown> = {};
  const rejected: Record<string, string> = {};
  for (const key of Object.keys(raw)) {
    if (!THEME_KEYS.has(key)) {
      rejected[key] = 'Not a Login UI theme setting';
      continue;
    }
    const value = (raw as Record<string, unknown>)[key];
    const meta = LOGIN_UI_SETTINGS_META[key as keyof typeof LOGIN_UI_SETTINGS_META];
    const validation = validateSettingValue(key, value, meta);
    if (!validation.valid) {
      rejected[key] = validation.errors[0]?.reason ?? 'Validation failed';
      continue;
    }
    if (key === 'login-ui.custom_css') {
      // The same check and sanitising the settings PATCH applies to custom CSS.
      const css = validateLoginUICustomCss(value);
      if (!css.valid) {
        rejected[key] = css.errors.join(' ');
        continue;
      }
      values[key] = css.sanitizedCss ?? '';
      continue;
    }
    values[key] = value;
  }
  if (Object.keys(rejected).length > 0) {
    return {
      ok: false,
      response: c.json(
        {
          error: 'invalid_request',
          error_description: 'Some values are not valid Login UI theme settings',
          field: 'values',
          rejected_keys: Object.keys(rejected),
          rejected,
        },
        400
      ),
    };
  }
  if (new TextEncoder().encode(JSON.stringify(values)).length > VALUES_MAX_BYTES) {
    return { ok: false, response: invalid(c, 'values', 'values are too large') };
  }
  return { ok: true, input: { name, values } };
}

const themeJson = (theme: LoginUITheme) => ({
  id: theme.id,
  name: theme.name,
  values: theme.values,
  version: theme.version,
  created_by: theme.created_by,
  created_at: theme.created_at,
  updated_at: theme.updated_at,
});

interface ActiveTheme {
  theme_id: string;
  version: number;
}

/** The tenant's login-ui document: its version and which theme was applied last. */
async function readLoginUIState(c: AdminContext, tenantId: string, readOnly: boolean) {
  const manager = getSettingsManager(c.env, c, true, false, undefined, { readOnly });
  const scope: SettingScope = { type: 'tenant', id: tenantId };
  const state = await manager.getAll('login-ui', scope);
  const id = state.values[ACTIVE_ID_KEY];
  const version = state.values[ACTIVE_VERSION_KEY];
  const active: ActiveTheme | null =
    typeof id === 'string' && id !== ''
      ? { theme_id: id, version: typeof version === 'number' ? version : 0 }
      : null;
  return { settingsVersion: state.version, active };
}

loginUIThemesRouter.get('/', async (c) => {
  c.header('Cache-Control', 'no-store');
  try {
    const tenantId = getTenantIdFromContext(c);
    const [themes, { active }] = await Promise.all([
      new LoginUIThemeRepository(adminAdapter(c)).list(tenantId),
      readLoginUIState(c, tenantId, true),
    ]);
    return c.json({ themes, active });
  } catch (error) {
    return failure(c, 'login_ui_themes_list', error);
  }
});

loginUIThemesRouter.post('/', async (c) => {
  c.header('Cache-Control', 'no-store');
  const auth = c.get('adminAuth');
  if (!auth) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  const body = await jsonBody(c);
  if (!body) return invalid(c, 'body', 'The body must be a JSON object');
  const parsed = readThemeInput(c, body);
  if (!parsed.ok) return parsed.response;
  try {
    const result = await new LoginUIThemeRepository(adminAdapter(c)).create(
      getTenantIdFromContext(c),
      parsed.input,
      auth.userId
    );
    if (result.status === 'name_taken') {
      return refuse(c, 409, 'theme_name_taken', 'A theme with this name already exists');
    }
    if (result.status === 'limit_reached') {
      return refuse(c, 409, 'theme_limit_reached', 'The tenant has reached the limit of themes');
    }
    await writeAdminAuditLog(c, {
      action: 'login_ui.theme.created',
      resourceType: 'login_ui_theme',
      resourceId: result.theme.id,
      result: 'success',
      metadata: { name: result.theme.name, keys: Object.keys(result.theme.values) },
    });
    c.header('ETag', versionEtag(result.theme.version));
    return c.json({ theme: themeJson(result.theme) }, 201);
  } catch (error) {
    return failure(c, 'login_ui_theme_create', error);
  }
});

loginUIThemesRouter.get('/:id', async (c) => {
  c.header('Cache-Control', 'no-store');
  try {
    const tenantId = getTenantIdFromContext(c);
    const theme = await new LoginUIThemeRepository(adminAdapter(c)).find(
      tenantId,
      c.req.param('id') ?? ''
    );
    if (!theme) return notFound(c);
    const { active } = await readLoginUIState(c, tenantId, true);
    c.header('ETag', versionEtag(theme.version));
    return c.json({ theme: themeJson(theme), active: active?.theme_id === theme.id });
  } catch (error) {
    return failure(c, 'login_ui_theme_get', error);
  }
});

loginUIThemesRouter.put('/:id', async (c) => {
  c.header('Cache-Control', 'no-store');
  const auth = c.get('adminAuth');
  if (!auth) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  const expected = parseIfMatchVersion(c);
  if (expected === null) {
    return c.json(
      {
        error: 'precondition_required',
        error_description: 'If-Match with the theme version is required',
      },
      428
    );
  }
  if (Number.isNaN(expected)) return invalid(c, 'if-match', 'If-Match must be a theme version');
  const body = await jsonBody(c);
  if (!body) return invalid(c, 'body', 'The body must be a JSON object');
  const parsed = readThemeInput(c, body);
  if (!parsed.ok) return parsed.response;
  try {
    const result = await new LoginUIThemeRepository(adminAdapter(c)).update(
      getTenantIdFromContext(c),
      c.req.param('id') ?? '',
      parsed.input,
      expected
    );
    if (result.status === 'not_found') return notFound(c);
    if (result.status === 'conflict') {
      return conflict(c, 'concurrent_modification', result.currentVersion);
    }
    if (result.status === 'name_taken') {
      return refuse(c, 409, 'theme_name_taken', 'A theme with this name already exists');
    }
    await writeAdminAuditLog(c, {
      action: 'login_ui.theme.updated',
      resourceType: 'login_ui_theme',
      resourceId: result.theme.id,
      result: 'success',
      metadata: {
        name: result.theme.name,
        version: result.theme.version,
        keys: Object.keys(result.theme.values),
      },
    });
    c.header('ETag', versionEtag(result.theme.version));
    return c.json({ theme: themeJson(result.theme) });
  } catch (error) {
    return failure(c, 'login_ui_theme_update', error);
  }
});

loginUIThemesRouter.delete('/:id', async (c) => {
  c.header('Cache-Control', 'no-store');
  const auth = c.get('adminAuth');
  if (!auth) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  try {
    const tenantId = getTenantIdFromContext(c);
    const repository = new LoginUIThemeRepository(adminAdapter(c));
    const id = c.req.param('id') ?? '';
    const theme = await repository.find(tenantId, id);
    if (!theme) return notFound(c);
    const { active } = await readLoginUIState(c, tenantId, true);
    if (active?.theme_id === id) {
      return refuse(c, 409, 'theme_active', 'The applied theme cannot be deleted');
    }
    if (!(await repository.delete(tenantId, id))) return notFound(c);
    await writeAdminAuditLog(c, {
      action: 'login_ui.theme.deleted',
      resourceType: 'login_ui_theme',
      resourceId: id,
      result: 'success',
      metadata: { name: theme.name },
    });
    return c.body(null, 204);
  } catch (error) {
    return failure(c, 'login_ui_theme_delete', error);
  }
});

loginUIThemesRouter.post('/:id/apply', async (c) => {
  c.header('Cache-Control', 'no-store');
  const auth = c.get('adminAuth');
  if (!auth) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);

  // The body is optional: `{ version }` asks for that exact version of the theme.
  let requiredVersion: number | undefined;
  const text = await c.req.text();
  if (text.trim() !== '') {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return invalid(c, 'body', 'The body must be a JSON object');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return invalid(c, 'body', 'The body must be a JSON object');
    }
    const version = (body as Record<string, unknown>).version;
    if (version !== undefined) {
      if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
        return invalid(c, 'version', 'version must be a positive integer');
      }
      requiredVersion = version;
    }
  }

  try {
    const tenantId = getTenantIdFromContext(c);
    const theme = await new LoginUIThemeRepository(adminAdapter(c)).find(
      tenantId,
      c.req.param('id') ?? ''
    );
    if (!theme) return notFound(c);
    if (requiredVersion !== undefined && requiredVersion !== theme.version) {
      return conflict(c, 'theme_version_changed', theme.version);
    }

    // Every theme key is set to the theme's value or cleared, so the live Login UI is the theme.
    const set: Record<string, unknown> = {
      ...theme.values,
      [ACTIVE_ID_KEY]: theme.id,
      [ACTIVE_VERSION_KEY]: theme.version,
    };
    const clear = LOGIN_UI_THEME_KEYS.filter((key) => !(key in theme.values));

    // The document may change between reading its version and saving: read again once.
    for (let attempt = 0; attempt < 2; attempt++) {
      const { settingsVersion } = await readLoginUIState(c, tenantId, false);
      // The settings save keeps what it accepts and answers 200 when anything was saved, so a
      // theme with a value the tenant's settings no longer accept (or a key the platform holds)
      // would be applied in part. Try it first: a theme is applied whole or not at all.
      const trial = await applyTenantSettingsChange({
        c,
        adminAuth: auth,
        tenantId,
        category: 'login-ui',
        dryRun: true,
        readBody: async () => ({ ifMatch: settingsVersion, set, clear }),
      });
      if (await isVersionConflict(trial)) {
        if (attempt === 0) continue;
        return settingsConflict(c);
      }
      if (!trial.ok) return trial;
      const rejected =
        (await trial.clone().json<{ rejected?: Record<string, unknown> }>()).rejected ?? {};
      if (Object.keys(rejected).length > 0) {
        return c.json(
          {
            error: 'theme_not_applicable',
            error_description: 'Some values of the theme are not accepted by the Login UI settings',
            rejected_keys: Object.keys(rejected),
            rejected,
          },
          400
        );
      }
      const response = await applyTenantSettingsChange({
        c,
        adminAuth: auth,
        tenantId,
        category: 'login-ui',
        readBody: async () => ({ ifMatch: settingsVersion, set, clear }),
      });
      if (await isVersionConflict(response)) {
        if (attempt === 0) continue;
        return settingsConflict(c);
      }
      if (!response.ok) return response;
      const saved = await response.json<{ version?: unknown }>();
      await writeAdminAuditLog(c, {
        action: 'login_ui.theme.applied',
        resourceType: 'login_ui_theme',
        resourceId: theme.id,
        result: 'success',
        metadata: { name: theme.name, version: theme.version },
      });
      return c.json({
        active: { theme_id: theme.id, version: theme.version },
        settings_version: typeof saved.version === 'string' ? saved.version : null,
      });
    }
    return refuse(c, 409, 'settings_conflict', 'The Login UI settings changed; try again');
  } catch (error) {
    return failure(c, 'login_ui_theme_apply', error);
  }
});
