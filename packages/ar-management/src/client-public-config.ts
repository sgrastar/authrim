/**
 * Public Client Configuration Endpoint
 * GET /oauth/clients/:client_id/config
 *
 * Returns public client metadata for SDK initialization and client discovery.
 * This endpoint is intentionally public (no authentication required) to allow
 * clients to fetch their own configuration before authentication.
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { getClientCached, createErrorResponse, AR_ERROR_CODES } from '@authrim/ar-lib-core';

/**
 * Public Client Configuration Response
 * Contains only public metadata - no sensitive information like client_secret
 */
export interface PublicClientConfig {
  client_id: string;
  client_name?: string;
  logo_uri?: string;
  client_uri?: string;
  policy_uri?: string;
  tos_uri?: string;
  login_ui_url?: string;
  initiate_login_uri?: string;
}

/**
 * GET /oauth/clients/:client_id/config
 *
 * Returns public client configuration for SDK initialization.
 * This endpoint does not require authentication and returns only public metadata.
 *
 * @param c - Hono context
 * @returns Public client configuration or error response
 */
export async function clientPublicConfigHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  const clientId = c.req.param('client_id')!;

  if (!clientId) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'client_id' },
    });
  }

  // Use getClientCached for performance (KV + request-level cache)
  const client = await getClientCached(c, c.env, clientId);

  if (!client) {
    return c.json(
      {
        error: 'invalid_client',
        error_description: 'Client not found',
      },
      404
    );
  }

  // Build response with only public information
  const response: PublicClientConfig = {
    client_id: client.client_id as string,
  };

  // Add optional public fields if present
  if (client.client_name) response.client_name = client.client_name as string;
  if (client.logo_uri) response.logo_uri = client.logo_uri as string;
  if (client.client_uri) response.client_uri = client.client_uri as string;
  if (client.policy_uri) response.policy_uri = client.policy_uri as string;
  if (client.tos_uri) response.tos_uri = client.tos_uri as string;
  if (client.login_ui_url) response.login_ui_url = client.login_ui_url as string;
  if (client.initiate_login_uri) response.initiate_login_uri = client.initiate_login_uri as string;

  return c.json(response, 200, {
    'Cache-Control': 'public, max-age=300', // 5 minutes cache
  });
}
