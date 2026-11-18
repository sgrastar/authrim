/**
 * The signed-in admin's first-steps checklist progress (the admin console's overview)
 *
 * The console lists a few things to try in a new environment. Which of them an admin has finished
 * is kept here, per tenant, so the list looks the same in every browser. Only the progress is
 * stored: the items are the console's, named by a short identifier.
 *
 * Endpoints:
 * - GET    /api/admin/me/onboarding           - The finished items for the selected tenant
 * - PUT    /api/admin/me/onboarding/:item_id  - Mark an item finished
 * - DELETE /api/admin/me/onboarding/:item_id  - Mark an item not finished
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AdminAuthContext, DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import {
  AR_ERROR_CODES,
  AdminOnboardingRepository,
  adminAuthMiddleware,
  createErrorResponse,
  getLogger,
  getTenantIdFromContext,
  isAdminOnboardingItemId,
  isAdminStepUpHumanSession,
  requireDedicatedAdminDatabaseAdapter,
} from '@authrim/ar-lib-core';

type AdminContext = Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;

export const myOnboardingRouter = new Hono<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}>();

myOnboardingRouter.use('*', adminAuthMiddleware({}));

function adminAdapter(c: AdminContext): DatabaseAdapter {
  return requireDedicatedAdminDatabaseAdapter(c.env, 'admin-management');
}

function failure(c: AdminContext, action: string, error: unknown) {
  getLogger(c as unknown as Context<{ Bindings: Env }>)
    .module('ADMIN-ONBOARDING')
    .error('Admin onboarding progress request failed', {
      action,
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
  return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
}

/** The checklist is a person's: machine callers have none. */
function human(c: AdminContext): AdminAuthContext | null {
  const auth = c.get('adminAuth');
  return auth && isAdminStepUpHumanSession(auth) ? auth : null;
}

const invalidItem = (c: AdminContext) =>
  c.json(
    {
      error: 'invalid_request',
      error_description: 'item_id must be lowercase words joined by hyphens, 40 characters at most',
      field: 'item_id',
    },
    400
  );

async function listed(c: AdminContext, auth: AdminAuthContext) {
  const completed = await new AdminOnboardingRepository(adminAdapter(c)).list(
    auth.userId,
    getTenantIdFromContext(c)
  );
  return c.json({ completed });
}

myOnboardingRouter.get('/', async (c) => {
  c.header('Cache-Control', 'no-store');
  const auth = human(c);
  if (!auth) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  try {
    return await listed(c, auth);
  } catch (error) {
    return failure(c, 'admin_onboarding_get', error);
  }
});

myOnboardingRouter.put('/:item_id', async (c) => {
  c.header('Cache-Control', 'no-store');
  const auth = human(c);
  if (!auth) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  const itemId = c.req.param('item_id');
  if (!isAdminOnboardingItemId(itemId)) return invalidItem(c);
  try {
    const kept = await new AdminOnboardingRepository(adminAdapter(c)).complete(
      auth.userId,
      getTenantIdFromContext(c),
      itemId
    );
    if (!kept) {
      return c.json(
        {
          error: 'limit_reached',
          error_description: 'No more finished items can be kept for this tenant',
        },
        409
      );
    }
    return await listed(c, auth);
  } catch (error) {
    return failure(c, 'admin_onboarding_put', error);
  }
});

myOnboardingRouter.delete('/:item_id', async (c) => {
  c.header('Cache-Control', 'no-store');
  const auth = human(c);
  if (!auth) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  const itemId = c.req.param('item_id');
  if (!isAdminOnboardingItemId(itemId)) return invalidItem(c);
  try {
    await new AdminOnboardingRepository(adminAdapter(c)).reopen(
      auth.userId,
      getTenantIdFromContext(c),
      itemId
    );
    return await listed(c, auth);
  } catch (error) {
    return failure(c, 'admin_onboarding_delete', error);
  }
});
