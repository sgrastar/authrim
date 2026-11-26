/** Public OpenID4VP presentation definition fetched by wallet presentation_definition_uri. */

import { isConfiguredShard } from '../../utils/configured-shard';
import type { Context } from 'hono';
import {
  AR_ERROR_CODES,
  createErrorResponse,
  getLogger,
  getTenantIdFromContext,
} from '@authrim/ar-lib-core';
import type { Env, VPRequestState } from '../../types';
import { getVPRequestStoreById } from '../../utils/vp-request-sharding';

export async function vpPresentationDefinitionRoute(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  const log = getLogger(c).module('VC-VERIFIER');
  try {
    const requestId = c.req.param('id');
    if (!requestId) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'id' },
      });
    }
    const tenantId = getTenantIdFromContext(c);
    const { stub, resolution } = getVPRequestStoreById(c.env, requestId, tenantId);
    if (!(await isConfiguredShard(c.env, tenantId, resolution))) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    const response = await stub.fetch(
      new Request(
        `https://internal/get?id=${encodeURIComponent(requestId)}&tenant_id=${encodeURIComponent(tenantId)}`
      )
    );
    if (response.status === 404) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    if (!response.ok) {
      // Storage failure is not "not found": the wallet must be able to retry.
      log.error('VP presentation definition store returned an error', { status: response.status });
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }
    const request = (await response.json()) as VPRequestState;
    if (request.status !== 'pending' || request.expiresAt <= Date.now()) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    if (!request.presentationDefinition) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json(request.presentationDefinition);
  } catch (error) {
    log.error('VP presentation definition retrieval failed', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}
