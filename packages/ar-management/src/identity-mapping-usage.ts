/**
 * GET /api/admin/identity-mapping/usage?set_id=...
 *
 * Where a Mapping Set is used (the platform's and the tenants' default, apps, credential
 * profiles), for showing what a change would affect and for checking before removing or switching
 * off a set. It runs the same search as the operations that refuse on it, so the answer and the
 * refusal agree.
 *
 * The set is the caller's tenant's or the platform's; a set another tenant owns, or none, is 404.
 * The caller sees their own tenant's references in full. For a set the platform owns, the
 * references in other tenants are given as counts, unless the caller has global authority.
 */
import type { Context } from 'hono';
import {
  getTenantIdFromContext,
  mappingSetReferenceBlock,
  PLATFORM_MAPPING_TENANT_ID,
  requireDedicatedAdminDatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import {
  canSeeOtherTenantReferences,
  scanMappingSetReferences,
  summarizeForRequest,
} from './identity-mapping-set-reference-guard';

const SET_ID_MAX_LENGTH = 200;

export async function adminIdentityMappingUsageHandler(c: Context<{ Bindings: Env }>) {
  const setId = c.req.query('set_id');
  if (!setId || setId !== setId.trim() || setId.length > SET_ID_MAX_LENGTH) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'set_id is required and must be a Mapping Set ID',
      },
      400
    );
  }
  try {
    const tenantId = getTenantIdFromContext(c);
    const admin = requireDedicatedAdminDatabaseAdapter(c.env, 'identity-mapping-usage');
    const owner = await admin.queryOne<{ tenant_id: string }>(
      'SELECT tenant_id FROM field_mapping_sets WHERE id = ? AND tenant_id IN (?, ?)',
      [setId, tenantId, PLATFORM_MAPPING_TENANT_ID]
    );
    if (!owner) {
      return c.json({ error: 'not_found', error_description: 'field mapping set not found' }, 404);
    }
    // Looking at every tenant's databases is a read per tenant, so it is for a caller with global
    // authority (who is also the one who may change the platform's sets). The others get their
    // own tenant's, and are told the rest was not looked at.
    const scan = await scanMappingSetReferences(c, {
      setId,
      ownerTenantId: owner.tenant_id,
      purpose: 'delete',
      scanOtherTenants: canSeeOtherTenantReferences(c),
    });
    const blocking = mappingSetReferenceBlock(scan);
    const onlyOtherTenantsUnscanned =
      scan.references.length === 0 && scan.unscanned.every((item) => item.area === 'other_tenants');
    return c.json({
      setId,
      owner: owner.tenant_id === PLATFORM_MAPPING_TENANT_ID ? 'platform' : 'tenant',
      usage: summarizeForRequest(c, scan),
      // Whether removing or switching off the set would be refused now; null when other tenants
      // were not looked at and nothing else is in the way, so it is not known.
      blocksChange: onlyOtherTenantsUnscanned && blocking ? null : blocking !== null,
    });
  } catch {
    return c.json(
      { error: 'internal_error', error_description: 'Mapping Set usage could not be read' },
      500
    );
  }
}
