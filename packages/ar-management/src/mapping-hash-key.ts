import type { Context } from 'hono';
import { getTenantIdFromContext, type Env, type AdminAuthContext } from '@authrim/ar-lib-core';
import { MAPPING_HASH_SECRET_REF } from '@authrim/ar-lib-core/services/mapping-hash';
import { recordAdminOperationAudit } from './admin-operation-audit';

type AdminContext = Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;

/** Read metadata only; missing keys remain missing. */
export async function adminMappingHashKeyGetHandler(c: AdminContext): Promise<Response> {
  c.header('Cache-Control', 'no-store');
  if (!c.env.KEY_MANAGER) return c.json({ error: 'unavailable' }, 503);
  try {
    const tenantId = getTenantIdFromContext(c);
    const secret = await c.env.KEY_MANAGER.get(
      c.env.KEY_MANAGER.idFromName(`${tenantId}-v3`)
    ).getExistingSecretRpc(MAPPING_HASH_SECRET_REF);
    return c.json({ installed: secret !== null, kid: secret?.active.kid ?? null });
  } catch {
    return c.json({ error: 'unavailable' }, 503);
  }
}

/** Settings-write authorization is applied by the owning route; no key material is returned. */
export async function adminMappingHashKeyRotateHandler(c: AdminContext): Promise<Response> {
  c.header('Cache-Control', 'no-store');
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_request' }, 400);
  }
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => key !== 'expectedKid') ||
    !('expectedKid' in body) ||
    typeof body.expectedKid !== 'string' ||
    !body.expectedKid ||
    body.expectedKid.length > 256
  )
    return c.json({ error: 'invalid_request' }, 400);
  if (!c.env.KEY_MANAGER) return c.json({ error: 'unavailable' }, 503);
  const tenantId = getTenantIdFromContext(c);
  let result: { kid: string };
  try {
    result = await c.env.KEY_MANAGER.get(
      c.env.KEY_MANAGER.idFromName(`${tenantId}-v3`)
    ).rotateMappingHashKeyRpc(body.expectedKid);
  } catch (error) {
    if (error instanceof Error && error.message === 'mapping_hash_key_missing')
      return c.json({ error: 'not_found' }, 404);
    if (error instanceof Error && error.message === 'mapping_hash_key_conflict')
      return c.json({ error: 'conflict' }, 409);
    return c.json({ error: 'unavailable' }, 503);
  }
  await recordAdminOperationAudit(c as unknown as Parameters<typeof recordAdminOperationAudit>[0], {
    tenantId: tenantId,
    action: 'field_mapping.hash_key.rotate',
    resourceType: 'field_mapping_hash_key',
    resourceId: result.kid,
    metadata: { kid: result.kid },
    severity: 'warning',
  });
  return c.json(result);
}
