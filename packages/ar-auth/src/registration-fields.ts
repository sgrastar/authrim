/**
 * Registration Fields API Handler
 *
 * Returns custom claim schemas marked as visible on the registration form.
 * Public endpoint — no authentication required.
 *
 * - GET /api/v1/registration-fields
 *
 * @packageDocumentation
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  createErrorResponse,
  AR_ERROR_CODES,
  getLogger,
  getTenantIdFromContext,
  listRegistrationFieldDefinitions,
  resolveCustomClaimRuntimeSourcesFromEnv,
} from '@authrim/ar-lib-core';

// =============================================================================
// Handler
// =============================================================================

/**
 * GET /api/v1/registration-fields
 * Returns fields with show_on_registration=1 for the current tenant.
 */
export async function registrationFieldsHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('REGISTRATION-FIELDS');

  try {
    const tenantId = getTenantIdFromContext(c);
    const sources = await resolveCustomClaimRuntimeSourcesFromEnv(c.env, tenantId);
    const fields = await listRegistrationFieldDefinitions(sources.schemaDb, tenantId);

    return c.json({ fields });
  } catch (error) {
    log.error('Failed to fetch registration fields', { error: String(error) });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}
