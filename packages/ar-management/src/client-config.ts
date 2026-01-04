/**
 * RFC 7592 - OAuth 2.0 Dynamic Client Registration Management Protocol
 * https://www.rfc-editor.org/rfc/rfc7592.html
 *
 * This module implements the Client Configuration Endpoint which allows
 * registered clients to manage their own configuration using a
 * registration_access_token.
 *
 * Endpoints:
 * - GET /clients/:client_id - Read client configuration
 * - PUT /clients/:client_id - Update client configuration
 * - DELETE /clients/:client_id - Delete client registration
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import type { ClientRegistrationResponse, ClientMetadata, JWKS } from '@authrim/ar-lib-core';
import {
  getClient,
  timingSafeEqual,
  arrayBufferToBase64Url,
  D1Adapter,
  type DatabaseAdapter,
  createErrorResponse,
  AR_ERROR_CODES,
  getLogger,
  // Audit logging
  createAuditLog,
  // Event publishing
  publishEvent,
  CLIENT_EVENTS,
  // Cache key builder
  buildKVKey,
} from '@authrim/ar-lib-core';

/**
 * Validate URI for security (HTTPS required, no fragments, no dangerous schemes)
 *
 * @param uri - URI to validate
 * @param fieldName - Field name for error messages
 * @returns Error message if invalid, null if valid
 */
function validateSecureUri(uri: string, fieldName: string): string | null {
  try {
    const parsed = new URL(uri);

    // Block dangerous schemes (javascript:, data:, file:, etc.)
    const allowedSchemes = ['https:', 'http:'];
    if (!allowedSchemes.includes(parsed.protocol)) {
      return `${fieldName} must use HTTP or HTTPS scheme`;
    }

    // HTTPS required (allow http://localhost for development only)
    if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost') {
      return `${fieldName} must use HTTPS (except localhost for development)`;
    }

    // Fragment identifiers not allowed (security: prevents token leakage via Referer)
    if (parsed.hash) {
      return `${fieldName} must not contain fragment identifiers`;
    }

    return null;
  } catch {
    return `${fieldName} must be a valid URI`;
  }
}

/**
 * Validate redirect_uris array for security
 *
 * @param uris - Array of redirect URIs
 * @returns Error message if invalid, null if valid
 */
function validateRedirectUris(uris: unknown): string | null {
  if (!Array.isArray(uris) || uris.length === 0) {
    return 'redirect_uris must be a non-empty array';
  }

  for (const uri of uris) {
    if (typeof uri !== 'string') {
      return 'All redirect_uris must be strings';
    }

    const error = validateSecureUri(uri, 'redirect_uri');
    if (error) {
      return error;
    }
  }

  return null;
}

/**
 * Validate client update request body for security
 *
 * Critical: Prevents SSRF, Open Redirect, and injection attacks
 *
 * @param body - Request body
 * @returns Error response if invalid, null if valid
 */
function validateUpdateRequest(
  body: Partial<ClientMetadata>
): { error: string; error_description: string } | null {
  // Validate redirect_uris if provided
  if (body.redirect_uris !== undefined) {
    const error = validateRedirectUris(body.redirect_uris);
    if (error) {
      return { error: 'invalid_client_metadata', error_description: error };
    }
  }

  // Validate backchannel_logout_uri if provided
  if (body.backchannel_logout_uri !== undefined) {
    if (typeof body.backchannel_logout_uri !== 'string') {
      return {
        error: 'invalid_client_metadata',
        error_description: 'backchannel_logout_uri must be a string',
      };
    }
    const error = validateSecureUri(body.backchannel_logout_uri, 'backchannel_logout_uri');
    if (error) {
      return { error: 'invalid_client_metadata', error_description: error };
    }
  }

  // Validate frontchannel_logout_uri if provided
  if (body.frontchannel_logout_uri !== undefined) {
    if (typeof body.frontchannel_logout_uri !== 'string') {
      return {
        error: 'invalid_client_metadata',
        error_description: 'frontchannel_logout_uri must be a string',
      };
    }
    const error = validateSecureUri(body.frontchannel_logout_uri, 'frontchannel_logout_uri');
    if (error) {
      return { error: 'invalid_client_metadata', error_description: error };
    }
  }

  // Validate initiate_login_uri if provided
  if (body.initiate_login_uri !== undefined) {
    if (typeof body.initiate_login_uri !== 'string') {
      return {
        error: 'invalid_client_metadata',
        error_description: 'initiate_login_uri must be a string',
      };
    }
    const error = validateSecureUri(body.initiate_login_uri, 'initiate_login_uri');
    if (error) {
      return { error: 'invalid_client_metadata', error_description: error };
    }
  }

  // Validate post_logout_redirect_uris if provided
  if (body.post_logout_redirect_uris !== undefined) {
    if (!Array.isArray(body.post_logout_redirect_uris)) {
      return {
        error: 'invalid_client_metadata',
        error_description: 'post_logout_redirect_uris must be an array',
      };
    }
    for (const uri of body.post_logout_redirect_uris) {
      if (typeof uri !== 'string') {
        return {
          error: 'invalid_client_metadata',
          error_description: 'All post_logout_redirect_uris must be strings',
        };
      }
      const error = validateSecureUri(uri, 'post_logout_redirect_uri');
      if (error) {
        return { error: 'invalid_client_metadata', error_description: error };
      }
    }
  }

  return null;
}

/**
 * Validate registration_access_token from Authorization header
 *
 * Security considerations:
 * - Uses timing-safe comparison to prevent timing attacks
 * - Token is hashed (SHA-256) before comparison
 * - Returns null on any validation failure (no information leakage)
 *
 * @param c - Hono context
 * @returns client_id if valid, null otherwise
 */
async function validateRegistrationAccessToken(
  c: Context<{ Bindings: Env }>
): Promise<string | null> {
  const authHeader = c.req.header('Authorization');

  // Check for Bearer token
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.slice(7); // Remove 'Bearer ' prefix
  const clientId = c.req.param('client_id');

  if (!clientId || !token) {
    return null;
  }

  // Fetch client from D1/cache
  const client = await getClient(c.env, clientId);
  if (!client) {
    return null;
  }

  // Check if registration_access_token_hash exists
  const storedHash = client.registration_access_token_hash as string | null;
  if (!storedHash) {
    // Client doesn't have a registration_access_token (legacy client)
    return null;
  }

  // Hash the provided token
  const encoder = new TextEncoder();
  const tokenData = encoder.encode(token);
  const tokenHashBuffer = await crypto.subtle.digest('SHA-256', tokenData);
  const tokenHash = arrayBufferToBase64Url(tokenHashBuffer);

  // Timing-safe comparison
  if (!timingSafeEqual(tokenHash, storedHash)) {
    return null;
  }

  return clientId;
}

/**
 * Build client metadata response (excludes sensitive fields)
 *
 * Per RFC 7592, the response MUST NOT include:
 * - client_secret (security risk)
 * - registration_access_token (already possessed by client)
 *
 * @param client - Client data from database
 * @param issuerUrl - ISSUER_URL for building registration_client_uri
 * @returns Client metadata suitable for response
 */
function buildClientResponse(
  client: ClientMetadata,
  issuerUrl: string
): Partial<ClientRegistrationResponse> {
  const response: Partial<ClientRegistrationResponse> = {
    client_id: client.client_id as string,
    // registration_client_uri is dynamically generated
    registration_client_uri: `${issuerUrl}/clients/${client.client_id}`,
  };

  // Add optional fields if present
  if (client.client_name) response.client_name = client.client_name as string;
  if (client.redirect_uris) response.redirect_uris = client.redirect_uris as string[];
  if (client.grant_types) response.grant_types = client.grant_types as string[];
  if (client.response_types) response.response_types = client.response_types as string[];
  if (client.token_endpoint_auth_method)
    response.token_endpoint_auth_method = client.token_endpoint_auth_method as string;
  if (client.scope) response.scope = client.scope as string;
  if (client.contacts) response.contacts = client.contacts as string[];
  if (client.logo_uri) response.logo_uri = client.logo_uri as string;
  if (client.client_uri) response.client_uri = client.client_uri as string;
  if (client.policy_uri) response.policy_uri = client.policy_uri as string;
  if (client.tos_uri) response.tos_uri = client.tos_uri as string;
  if (client.jwks_uri) response.jwks_uri = client.jwks_uri as string;
  if (client.jwks) response.jwks = client.jwks as JWKS;
  if (client.subject_type) response.subject_type = client.subject_type as 'public' | 'pairwise';
  if (client.sector_identifier_uri)
    response.sector_identifier_uri = client.sector_identifier_uri as string;
  if (client.userinfo_signed_response_alg)
    response.userinfo_signed_response_alg = client.userinfo_signed_response_alg as string;
  if (client.id_token_signed_response_alg)
    response.id_token_signed_response_alg = client.id_token_signed_response_alg as string;
  if (client.request_object_signing_alg)
    response.request_object_signing_alg = client.request_object_signing_alg as string;
  if (client.post_logout_redirect_uris)
    response.post_logout_redirect_uris = client.post_logout_redirect_uris as string[];
  if (client.backchannel_logout_uri)
    response.backchannel_logout_uri = client.backchannel_logout_uri as string;
  if (client.backchannel_logout_session_required !== undefined)
    response.backchannel_logout_session_required =
      client.backchannel_logout_session_required as boolean;
  if (client.frontchannel_logout_uri)
    response.frontchannel_logout_uri = client.frontchannel_logout_uri as string;
  if (client.frontchannel_logout_session_required !== undefined)
    response.frontchannel_logout_session_required =
      client.frontchannel_logout_session_required as boolean;
  // OIDC 3rd Party Initiated Login
  if (client.initiate_login_uri) response.initiate_login_uri = client.initiate_login_uri as string;

  // Timestamps
  if (client.created_at) {
    // Convert to Unix timestamp if stored in milliseconds
    const createdAt =
      typeof client.created_at === 'number' && client.created_at > 1e12
        ? Math.floor((client.created_at as number) / 1000)
        : (client.created_at as number);
    response.client_id_issued_at = createdAt;
  }

  // client_secret_expires_at (0 = never expires)
  response.client_secret_expires_at = 0;

  return response;
}

/**
 * GET /clients/:client_id - Read Client Configuration
 *
 * RFC 7592 Section 2.1
 *
 * Returns the current configuration of a registered client.
 * Requires valid registration_access_token in Authorization header.
 */
export async function clientConfigGetHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    // Validate registration_access_token
    const clientId = await validateRegistrationAccessToken(c);
    if (!clientId) {
      // RFC 7592: Return 401 with invalid_token error
      return c.json(
        {
          error: 'invalid_token',
          error_description: 'Invalid or missing registration_access_token',
        },
        401
      );
    }

    // Fetch client data
    const client = await getClient(c.env, clientId);
    if (!client) {
      // Should not happen if validateRegistrationAccessToken passed
      return c.json(
        {
          error: 'invalid_client',
          error_description: 'Client not found',
        },
        404
      );
    }

    // Build response (excludes sensitive fields)
    const response = buildClientResponse(client, c.env.ISSUER_URL);

    const log = getLogger(c).module('RFC7592');
    // Publish event (non-blocking)
    publishEvent(c, {
      type: CLIENT_EVENTS.CONFIG_READ,
      tenantId: 'default',
      data: { clientId },
    }).catch((err) =>
      log.error('Failed to publish config read event', { action: 'config_read' }, err as Error)
    );

    log.info('Client config read', { action: 'config_read', clientId });

    return c.json(response, 200, {
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
    });
  } catch (error) {
    const log = getLogger(c).module('RFC7592');
    log.error('Client config GET error', { action: 'config_read' }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * PUT /clients/:client_id - Update Client Configuration
 *
 * RFC 7592 Section 2.2
 *
 * Updates the configuration of a registered client.
 * The request body contains the complete updated client metadata.
 * Requires valid registration_access_token in Authorization header.
 */
export async function clientConfigUpdateHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    // Validate registration_access_token
    const clientId = await validateRegistrationAccessToken(c);
    if (!clientId) {
      return c.json(
        {
          error: 'invalid_token',
          error_description: 'Invalid or missing registration_access_token',
        },
        401
      );
    }

    // Parse request body
    const body = (await c.req.json().catch(() => null)) as Partial<ClientMetadata> | null;
    if (!body) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Invalid or missing request body',
        },
        400
      );
    }

    // RFC 7592: client_id in body must match URL parameter if present
    if (body.client_id && body.client_id !== clientId) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'client_id in request body does not match URL',
        },
        400
      );
    }

    // Security: Validate all URIs to prevent SSRF and Open Redirect attacks
    const validationError = validateUpdateRequest(body);
    if (validationError) {
      return c.json(validationError, 400);
    }

    // Fetch existing client
    const existingClient = await getClient(c.env, clientId);
    if (!existingClient) {
      return c.json(
        {
          error: 'invalid_client',
          error_description: 'Client not found',
        },
        404
      );
    }

    // Update client in D1
    const coreAdapter: DatabaseAdapter = new D1Adapter({ db: c.env.DB });
    const now = Date.now();

    // Helper function to serialize array/object fields
    const serializeField = (newValue: unknown, existingValue: unknown): string | null => {
      if (newValue !== undefined) {
        return newValue ? JSON.stringify(newValue) : null;
      }
      if (existingValue !== undefined && existingValue !== null) {
        // existingClient already has parsed values from getClient
        return JSON.stringify(existingValue);
      }
      return null;
    };

    // Build complete update SQL with all updatable fields
    try {
      await coreAdapter.execute(
        `
        UPDATE oauth_clients SET
          client_name = ?,
          redirect_uris = ?,
          grant_types = ?,
          response_types = ?,
          scope = ?,
          contacts = ?,
          logo_uri = ?,
          client_uri = ?,
          policy_uri = ?,
          tos_uri = ?,
          jwks_uri = ?,
          jwks = ?,
          subject_type = ?,
          sector_identifier_uri = ?,
          id_token_signed_response_alg = ?,
          userinfo_signed_response_alg = ?,
          request_object_signing_alg = ?,
          post_logout_redirect_uris = ?,
          backchannel_logout_uri = ?,
          backchannel_logout_session_required = ?,
          frontchannel_logout_uri = ?,
          frontchannel_logout_session_required = ?,
          initiate_login_uri = ?,
          updated_at = ?
        WHERE client_id = ?
        `,
        [
          // Basic client info
          body.client_name ?? (existingClient.client_name as string | null),
          serializeField(body.redirect_uris, existingClient.redirect_uris),
          serializeField(body.grant_types, existingClient.grant_types),
          serializeField(body.response_types, existingClient.response_types),
          body.scope ?? (existingClient.scope as string | null),
          serializeField(body.contacts, existingClient.contacts),
          // URIs
          body.logo_uri ?? (existingClient.logo_uri as string | null),
          body.client_uri ?? (existingClient.client_uri as string | null),
          body.policy_uri ?? (existingClient.policy_uri as string | null),
          body.tos_uri ?? (existingClient.tos_uri as string | null),
          body.jwks_uri ?? (existingClient.jwks_uri as string | null),
          // JWKS
          serializeField(body.jwks, existingClient.jwks),
          // Subject type
          body.subject_type ?? (existingClient.subject_type as string | null),
          body.sector_identifier_uri ?? (existingClient.sector_identifier_uri as string | null),
          // Algorithm preferences
          body.id_token_signed_response_alg ??
            (existingClient.id_token_signed_response_alg as string | null),
          body.userinfo_signed_response_alg ??
            (existingClient.userinfo_signed_response_alg as string | null),
          body.request_object_signing_alg ??
            (existingClient.request_object_signing_alg as string | null),
          // Logout URIs
          serializeField(body.post_logout_redirect_uris, existingClient.post_logout_redirect_uris),
          body.backchannel_logout_uri ?? (existingClient.backchannel_logout_uri as string | null),
          body.backchannel_logout_session_required !== undefined
            ? body.backchannel_logout_session_required
              ? 1
              : 0
            : existingClient.backchannel_logout_session_required
              ? 1
              : 0,
          body.frontchannel_logout_uri ?? (existingClient.frontchannel_logout_uri as string | null),
          body.frontchannel_logout_session_required !== undefined
            ? body.frontchannel_logout_session_required
              ? 1
              : 0
            : existingClient.frontchannel_logout_session_required
              ? 1
              : 0,
          // OIDC 3rd Party Initiated Login
          body.initiate_login_uri ?? (existingClient.initiate_login_uri as string | null),
          // Timestamp
          now,
          // WHERE clause
          clientId,
        ]
      );
    } catch (updateError) {
      const log = getLogger(c).module('RFC7592');
      log.error('D1 UPDATE error', { action: 'config_update', clientId }, updateError as Error);
      throw updateError;
    }

    const log = getLogger(c).module('RFC7592');
    // Invalidate cache (use same key format as kv.ts getClient)
    const cacheKey = buildKVKey('client', clientId);
    await c.env.CLIENTS_CACHE.delete(cacheKey).catch(() => {
      log.warn('Failed to invalidate client cache', { action: 'config_update', clientId });
    });

    // Fetch updated client and return response
    const updatedClient = await getClient(c.env, clientId);
    if (!updatedClient) {
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }

    const response = buildClientResponse(updatedClient, c.env.ISSUER_URL);

    // Audit log (non-blocking) - client self-modification is security-relevant
    createAuditLog(c.env, {
      userId: clientId, // Client acting on its own behalf
      action: 'client.config.updated',
      resource: 'oauth_clients',
      resourceId: clientId,
      ipAddress: c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'unknown',
      userAgent: c.req.header('User-Agent')?.substring(0, 256) || 'unknown',
      metadata: JSON.stringify({ method: 'PUT', endpoint: '/clients/:client_id' }),
      severity: 'info',
    }).catch((err) =>
      log.error('Failed to create audit log', { action: 'config_update' }, err as Error)
    );

    // Publish event (non-blocking)
    publishEvent(c, {
      type: CLIENT_EVENTS.CONFIG_UPDATED,
      tenantId: 'default',
      data: { clientId },
    }).catch((err) =>
      log.error('Failed to publish config updated event', { action: 'config_update' }, err as Error)
    );

    log.info('Client config updated', { action: 'config_update', clientId });

    return c.json(response, 200, {
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
    });
  } catch (error) {
    // Log detailed error for debugging
    const log = getLogger(c).module('RFC7592');
    log.error('Client config PUT error', { action: 'config_update' }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * DELETE /clients/:client_id - Delete Client Registration
 *
 * RFC 7592 Section 2.3
 *
 * Deletes a registered client and all associated data.
 * Requires valid registration_access_token in Authorization header.
 */
export async function clientConfigDeleteHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    // Validate registration_access_token
    const clientId = await validateRegistrationAccessToken(c);
    if (!clientId) {
      return c.json(
        {
          error: 'invalid_token',
          error_description: 'Invalid or missing registration_access_token',
        },
        401
      );
    }

    // Delete client from D1
    const coreAdapter: DatabaseAdapter = new D1Adapter({ db: c.env.DB });
    await coreAdapter.execute('DELETE FROM oauth_clients WHERE client_id = ?', [clientId]);

    const log = getLogger(c).module('RFC7592');
    // Invalidate cache (use same key format as kv.ts getClient)
    const cacheKey = buildKVKey('client', clientId);
    await c.env.CLIENTS_CACHE.delete(cacheKey).catch(() => {
      log.warn('Failed to invalidate client cache', { action: 'config_delete', clientId });
    });

    // Audit log (non-blocking) - client deletion is security-critical
    createAuditLog(c.env, {
      userId: clientId, // Client acting on its own behalf
      action: 'client.config.deleted',
      resource: 'oauth_clients',
      resourceId: clientId,
      ipAddress: c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'unknown',
      userAgent: c.req.header('User-Agent')?.substring(0, 256) || 'unknown',
      metadata: JSON.stringify({ method: 'DELETE', endpoint: '/clients/:client_id' }),
      severity: 'warning', // Deletion is a significant action
    }).catch((err) =>
      log.error('Failed to create audit log', { action: 'config_delete' }, err as Error)
    );

    // Publish event (non-blocking)
    publishEvent(c, {
      type: CLIENT_EVENTS.CONFIG_DELETED,
      tenantId: 'default',
      data: { clientId },
    }).catch((err) =>
      log.error('Failed to publish config deleted event', { action: 'config_delete' }, err as Error)
    );

    log.info('Client deleted', { action: 'config_delete', clientId });

    // RFC 7592: Return 204 No Content on successful deletion
    return c.body(null, 204);
  } catch (error) {
    const log = getLogger(c).module('RFC7592');
    log.error('Client config DELETE error', { action: 'config_delete' }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}
