/**
 * The tenant's lite Login UI switch.
 *
 * GET /api/admin/login-ui/lite-mode
 *   The published policy (from the tenant's LitePolicyStore), what the settings record, and
 *   whether the tenant could switch to `always` now (`readiness.issues`).
 * PUT /api/admin/login-ui/lite-mode   { "mode": "off" | "always" }
 *   Switches the tenant. Under the policy store's lease: the compatibility check (for `always`),
 *   the policy commit (mode and the actions that require human verification, as one value), then
 *   the setting `login-ui.lite_mode` as the record of what was published. The settings PATCH
 *   refuses that setting: this route is the only way to change it.
 *
 * The tenant comes from the request context, as for the other Login UI admin routes.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  AR_ERROR_CODES,
  adminAuthMiddleware,
  createErrorResponse,
  getLitePolicyStore,
  getLogger,
  getRateLimitProfileAsync,
  getTenantIdFromContext,
  isLiteMode,
  rateLimitMiddleware,
  type AdminAuthContext,
  type Env,
  type LiteMode,
  type LitePolicySnapshot,
  type SettingScope,
} from '@authrim/ar-lib-core';
import { writeAdminAuditLog } from '../../admin-shared';
import { requiredHumanVerificationActions } from '../../human-verification-guards';
import {
  liteModeChangeInProgressResponse,
  liteModeUnsupportedResponse,
  litePolicyUnavailableResponse,
} from '../../lite-mode-guard';
import { evaluateLiteReadiness } from '../../lite-mode-readiness';
import {
  canAccessTenant,
  hasTenantSettingsPermission,
} from '../settings-v2/settings-authorization';
import {
  getSettingsManager,
  invalidateAuthenticationMethodsCacheRevision,
} from '../settings-v2/settings-support';
import {
  applyTenantSettingsChange,
  type TenantSettingsContext,
} from '../settings-v2/tenant-settings-apply';

type AdminContext = TenantSettingsContext;
type Router = Hono<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;

const LITE_MODE_KEY = 'login-ui.lite_mode';

export const loginUILiteModeRouter: Router = new Hono();
loginUILiteModeRouter.use('*', adminAuthMiddleware({}));
loginUILiteModeRouter.use('*', async (c, next) => {
  const profile = await getRateLimitProfileAsync(
    c.env,
    c.req.method === 'GET' || c.req.method === 'HEAD' ? 'lenient' : 'moderate'
  );
  return rateLimitMiddleware({ ...profile })(c as unknown as Context<{ Bindings: Env }>, next);
});
loginUILiteModeRouter.use('*', async (c: AdminContext, next) => {
  const auth = c.get('adminAuth');
  const tenantId = getTenantIdFromContext(c);
  const reading = c.req.method === 'GET' || c.req.method === 'HEAD';
  // Switching changes the Login UI and the human verification provider: both categories' edit.
  const allowed = reading
    ? hasTenantSettingsPermission(auth, 'login-ui', 'view', tenantId)
    : hasTenantSettingsPermission(auth, 'login-ui', 'edit', tenantId) &&
      hasTenantSettingsPermission(auth, 'authentication-methods', 'edit', tenantId);
  if (!auth || !allowed || !canAccessTenant(auth, tenantId)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  await next();
});

function log(c: AdminContext) {
  return getLogger(c as unknown as Context<{ Bindings: Env }>).module('LOGIN-UI-LITE-MODE');
}

function policyBody(snapshot: LitePolicySnapshot) {
  return {
    mode: snapshot.liteMode,
    policy_revision: snapshot.policyRevision,
    generation: snapshot.generation,
    updated_at: snapshot.updatedAt > 0 ? new Date(snapshot.updatedAt).toISOString() : null,
    human_verification_required: snapshot.humanVerificationRequired,
  };
}

async function readRecordedMode(c: AdminContext, tenantId: string) {
  const manager = getSettingsManager(c.env, c, true, false, undefined, { readOnly: true });
  const scope: SettingScope = { type: 'tenant', id: tenantId };
  const state = await manager.getAll('login-ui', scope);
  const value = state.values[LITE_MODE_KEY];
  return { mode: isLiteMode(value) ? value : 'off', settingsVersion: state.version };
}

/** Writes the setting that records the published mode (the settings PATCH refuses it otherwise). */
async function recordMode(c: AdminContext, tenantId: string, mode: LiteMode): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { settingsVersion } = await readRecordedMode(c, tenantId);
    const response = await applyTenantSettingsChange({
      c,
      adminAuth: c.get('adminAuth'),
      tenantId,
      category: 'login-ui',
      litePolicyRecord: true,
      readBody: async () => ({ ifMatch: settingsVersion, set: { [LITE_MODE_KEY]: mode } }),
    });
    if (response.ok) return true;
    if (response.status !== 409) return false;
  }
  return false;
}

loginUILiteModeRouter.get('/', async (c) => {
  c.header('Cache-Control', 'no-store');
  const tenantId = getTenantIdFromContext(c);
  const store = getLitePolicyStore(c.env, tenantId);
  try {
    const status = store ? await store.getStatusRpc(tenantId) : null;
    const [recorded, issues] = await Promise.all([
      readRecordedMode(c, tenantId),
      evaluateLiteReadiness(c, tenantId),
    ]);
    return c.json({
      ...(status
        ? policyBody(status.snapshot)
        : { mode: 'off', policy_revision: null, generation: 0, updated_at: null }),
      change_in_progress: status?.changeInProgress ?? false,
      recorded_mode: recorded.mode,
      readiness: { ready: issues.length === 0, issues },
    });
  } catch (error) {
    log(c).error('Lite mode read failed', {}, error as Error);
    return litePolicyUnavailableResponse(c);
  }
});

loginUILiteModeRouter.put('/', async (c) => {
  c.header('Cache-Control', 'no-store');
  const tenantId = getTenantIdFromContext(c);
  let mode: unknown;
  try {
    mode = (await c.req.json<{ mode?: unknown }>())?.mode;
  } catch {
    mode = undefined;
  }
  if (!isLiteMode(mode)) {
    return c.json(
      { error: 'invalid_request', error_description: 'mode must be "off" or "always"' },
      400
    );
  }
  const store = getLitePolicyStore(c.env, tenantId);
  if (!store) {
    return liteModeUnsupportedResponse(c, [{ code: 'policy_store_unavailable' }]);
  }

  let lease: Awaited<ReturnType<typeof store.acquireLeaseRpc>>;
  try {
    lease = await store.acquireLeaseRpc(tenantId);
  } catch (error) {
    log(c).error('Lite policy lease failed', {}, error as Error);
    return litePolicyUnavailableResponse(c);
  }
  if (!lease.acquired) return liteModeChangeInProgressResponse(c, lease.retryAfterMs);

  let leaseOpen = true;
  try {
    const before = await store.getSnapshotRpc(tenantId);
    if (mode === 'always') {
      const issues = await evaluateLiteReadiness(c, tenantId);
      if (issues.length > 0) return liteModeUnsupportedResponse(c, issues);
    }
    const required = await requiredHumanVerificationActions(c.env, tenantId);
    const committed = await store.commitRpc({
      tenantId,
      token: lease.token,
      expectedGeneration: lease.generation,
      liteMode: mode,
      humanVerificationRequired: required,
    });
    leaseOpen = false;
    if (!committed.committed) return liteModeChangeInProgressResponse(c, 1000);

    const recorded = await recordMode(c, tenantId, mode).catch((error: unknown) => {
      log(c).error('Lite mode published but not recorded in settings', {}, error as Error);
      return false;
    });
    await invalidateAuthenticationMethodsCacheRevision(c, tenantId, 'login_ui_lite_mode');
    await writeAdminAuditLog(c, {
      action: 'login_ui.lite_mode.changed',
      resourceType: 'login_ui_lite_mode',
      resourceId: tenantId,
      result: 'success',
      metadata: {
        from: before.liteMode,
        to: mode,
        policy_revision: committed.snapshot.policyRevision,
        recorded,
      },
    });
    return c.json({ ...policyBody(committed.snapshot), recorded });
  } catch (error) {
    log(c).error('Lite mode change failed', {}, error as Error);
    return litePolicyUnavailableResponse(c);
  } finally {
    if (leaseOpen) await store.releaseRpc(tenantId, lease.token).catch(() => undefined);
  }
});
