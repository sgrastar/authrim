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
  D1Adapter,
  createErrorResponse,
  AR_ERROR_CODES,
  getLogger,
  getTenantIdFromContext,
} from '@authrim/ar-lib-core';

// =============================================================================
// Types
// =============================================================================

interface RegistrationFieldRow {
  field_key: string;
  display_label: string;
  field_type: string;
  registration_required: number;
  registration_order: number;
  registration_placeholder: string | null;
  validation_rules: string | null;
}

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
    const adapter = new D1Adapter({ db: c.env.DB });

    const rows = await adapter.query<RegistrationFieldRow>(
      `SELECT field_key, display_label, field_type, registration_required,
              registration_order, registration_placeholder, validation_rules
       FROM custom_claim_schemas
       WHERE tenant_id = ? AND show_on_registration = 1 AND is_active = 1
       ORDER BY registration_order ASC, display_order ASC`,
      [tenantId]
    );

    const fields = rows.map((row) => ({
      field_key: row.field_key,
      display_label: row.display_label,
      field_type: row.field_type,
      required: row.registration_required === 1,
      order: row.registration_order,
      placeholder: row.registration_placeholder,
      validation_rules: row.validation_rules ? JSON.parse(row.validation_rules) : null,
    }));

    return c.json({ fields });
  } catch (error) {
    log.error('Failed to fetch registration fields', { error: String(error) });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}
