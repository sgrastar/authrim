/** Public OpenID4VP authorization request object fetched by wallet request_uri. */

import type { Context } from 'hono';
import {
  AR_ERROR_CODES,
  createErrorResponse,
  getLogger,
  getTenantIdFromContext,
} from '@authrim/ar-lib-core';
import type { Env, VPRequestState } from '../../types';
import { getVPRequestStoreById } from '../../utils/vp-request-sharding';

export async function vpRequestObjectRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const log = getLogger(c).module('VC-VERIFIER');
  try {
    const requestId = c.req.param('id');
    if (!requestId) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'id' },
      });
    }
    const tenantId = getTenantIdFromContext(c);
    const { stub } = getVPRequestStoreById(c.env, requestId, tenantId);
    const response = await stub.fetch(
      new Request(
        `https://internal/get?id=${encodeURIComponent(requestId)}&tenant_id=${encodeURIComponent(tenantId)}`
      )
    );
    if (!response.ok) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    const request = (await response.json()) as VPRequestState;
    if (request.status !== 'pending' || request.expiresAt <= Date.now()) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json({
      response_type: 'vp_token',
      client_id: request.clientId,
      client_id_scheme: 'pre-registered',
      response_mode: request.responseMode,
      response_uri: request.responseUri,
      nonce: request.nonce,
      state: request.id,
      ...(request.presentationDefinition
        ? { presentation_definition: request.presentationDefinition }
        : {}),
      ...(request.dcqlQuery ? { dcql_query: request.dcqlQuery } : {}),
    });
  } catch (error) {
    log.error('VP request object retrieval failed', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  }
}
