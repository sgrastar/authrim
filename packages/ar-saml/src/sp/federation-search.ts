/**
 * GET /saml/sp/federation/:sourceId/idps?q=&limit=
 *
 * The institution picker's search: IdPs of one federation source's verified inventory that its
 * policy lets take part (the exception list, registration authorities and entity categories
 * applied), by display name. Public (the login screen reads it before anyone is signed in), so it
 * answers only what the source itself publishes (name, entityID, an https logo) and is bounded.
 */
import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { AR_ERROR_CODES, createErrorResponse } from '@authrim/ar-lib-core';
import { getFederationSourceForLogin, searchFederationIdPs } from '../admin/providers';
import { resolveSAMLTenantIdFromContext } from '../common/tenant';

const SOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export async function handleFederationIdPSearch(c: Context<{ Bindings: Env }>): Promise<Response> {
  const sourceId = c.req.param('sourceId');
  if (!sourceId || !SOURCE_ID_PATTERN.test(sourceId)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  }
  const tenantId = resolveSAMLTenantIdFromContext(c);
  const source = await getFederationSourceForLogin(c.env, tenantId, sourceId);
  // A source that sends users to a Discovery Service has no search of its own.
  if (!source || source.idpSelection.mode !== 'authrim_search') {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  }
  const limitParam = Number(c.req.query('limit') ?? DEFAULT_LIMIT);
  const limit = Number.isInteger(limitParam)
    ? Math.min(Math.max(limitParam, 1), MAX_LIMIT)
    : DEFAULT_LIMIT;
  const result = await searchFederationIdPs(c.env, tenantId, source, {
    q: c.req.query('q') ?? undefined,
    limit,
  });
  if (!result) return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  return c.json(
    {
      sourceId: source.id,
      displayName: source.displayName,
      items: result.items,
      truncated: result.truncated,
    },
    200,
    { 'Cache-Control': 'public, max-age=60' }
  );
}
