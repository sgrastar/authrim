import { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  getTenantIdFromContext,
  createAuthContextFromHono,
  D1Adapter,
  createErrorResponse,
  AR_ERROR_CODES,
  validateAllowedOrigins,
  createAuditLogFromContext,
  scheduleAuditLogFromContext,
  getLogger,
  hashClientSecret,
  publishEvent,
  CLIENT_EVENTS,
  type ClientEventData,
  invalidateClientCache,
  invalidateClientCacheOnDelete,
  putClient,
  buildKVKey,
  getClient,
} from '@authrim/ar-lib-core';
import {
  parseClientStringArray,
  isCharArrayLike,
  logSanitizedError,
  getErrorDetailsForResponse,
  scheduleAdminAuditLog,
  toMilliseconds,
} from './admin-shared';

const VALID_DELEGATION_MODES = new Set(['none', 'delegation', 'impersonation']);

function validateOptionalStringArrayField(
  value: unknown,
  field: string
): { ok: true; value: string[] | null | undefined } | { ok: false; error: string } {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (value === null) {
    return { ok: true, value: null };
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    return { ok: false, error: `${field} must be an array of strings` };
  }
  if (isCharArrayLike(value)) {
    return {
      ok: false,
      error: `${field} appears malformed. Send full values, not character arrays.`,
    };
  }
  return { ok: true, value };
}

/**
 * Create a new OAuth client.
 * POST /admin/clients
 */
export async function adminClientCreateHandler(c: Context<{ Bindings: Env }>) {
  try {
    const body = await c.req.json<{
      client_name: string;
      redirect_uris: string[];
      grant_types?: string[];
      response_types?: string[];
      scope?: string;
      logo_uri?: string;
      client_uri?: string;
      policy_uri?: string;
      tos_uri?: string;
      contacts?: string[];
      token_endpoint_auth_method?: string;
      subject_type?: string;
      sector_identifier_uri?: string;
      is_trusted?: boolean;
      skip_consent?: boolean;
      allow_claims_without_scope?: boolean;
      allowed_redirect_origins?: string[];
      require_pkce?: boolean;
      token_exchange_allowed?: boolean;
      allowed_subject_token_clients?: string[] | null;
      allowed_token_exchange_resources?: string[] | null;
      delegation_mode?: 'none' | 'delegation' | 'impersonation';
      client_credentials_allowed?: boolean;
      allowed_scopes?: string[] | null;
      default_scope?: string | null;
      default_audience?: string | null;
    }>();

    if (!body.client_name) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'client_name is required',
        },
        400
      );
    }

    if (
      !body.redirect_uris ||
      !Array.isArray(body.redirect_uris) ||
      body.redirect_uris.length === 0
    ) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'redirect_uris is required and must be a non-empty array',
        },
        400
      );
    }

    for (const uri of body.redirect_uris) {
      try {
        new URL(uri);
      } catch {
        return c.json(
          {
            error: 'invalid_request',
            error_description: `Invalid redirect_uri: ${uri}`,
          },
          400
        );
      }
    }

    let validatedAllowedOrigins: string[] | undefined;
    if (body.allowed_redirect_origins !== undefined) {
      if (!Array.isArray(body.allowed_redirect_origins)) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'allowed_redirect_origins must be an array of origin strings',
          },
          400
        );
      }
      const originsValidation = validateAllowedOrigins(body.allowed_redirect_origins);
      if (!originsValidation.valid) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: `Invalid allowed_redirect_origins: ${originsValidation.errors.join(', ')}`,
          },
          400
        );
      }
      validatedAllowedOrigins = originsValidation.normalizedOrigins;
    }

    const allowedSubjectTokenClientsValidation = validateOptionalStringArrayField(
      body.allowed_subject_token_clients,
      'allowed_subject_token_clients'
    );
    if (!allowedSubjectTokenClientsValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: allowedSubjectTokenClientsValidation.error,
        },
        400
      );
    }

    const allowedTokenExchangeResourcesValidation = validateOptionalStringArrayField(
      body.allowed_token_exchange_resources,
      'allowed_token_exchange_resources'
    );
    if (!allowedTokenExchangeResourcesValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: allowedTokenExchangeResourcesValidation.error,
        },
        400
      );
    }

    const allowedScopesValidation = validateOptionalStringArrayField(
      body.allowed_scopes,
      'allowed_scopes'
    );
    if (!allowedScopesValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: allowedScopesValidation.error,
        },
        400
      );
    }

    if (
      body.delegation_mode !== undefined &&
      !VALID_DELEGATION_MODES.has(body.delegation_mode)
    ) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'delegation_mode must be one of none, delegation, impersonation',
        },
        400
      );
    }

    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const clientSecret =
      crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
    const clientSecretHash = await hashClientSecret(clientSecret);

    const client = await authCtx.repositories.client.create({
      client_name: body.client_name,
      client_secret_hash: clientSecretHash,
      tenant_id: tenantId,
      redirect_uris: body.redirect_uris,
      grant_types: body.grant_types || ['authorization_code'],
      response_types: body.response_types || ['code'],
      scope: body.scope || 'openid profile email',
      logo_uri: body.logo_uri || null,
      client_uri: body.client_uri || null,
      policy_uri: body.policy_uri || null,
      tos_uri: body.tos_uri || null,
      contacts: body.contacts || null,
      token_endpoint_auth_method:
        (body.token_endpoint_auth_method as
          | 'none'
          | 'client_secret_basic'
          | 'client_secret_post'
          | 'client_secret_jwt'
          | 'private_key_jwt') || 'client_secret_basic',
      subject_type: (body.subject_type as 'public' | 'pairwise') || 'public',
      sector_identifier_uri: body.sector_identifier_uri || null,
      is_trusted: body.is_trusted || false,
      skip_consent: body.skip_consent || false,
      allow_claims_without_scope: body.allow_claims_without_scope || false,
      token_exchange_allowed: body.token_exchange_allowed ?? false,
      allowed_subject_token_clients: allowedSubjectTokenClientsValidation.value,
      allowed_token_exchange_resources: allowedTokenExchangeResourcesValidation.value,
      delegation_mode: body.delegation_mode ?? 'delegation',
      client_credentials_allowed: body.client_credentials_allowed ?? false,
      allowed_scopes: allowedScopesValidation.value,
      default_scope: body.default_scope ?? null,
      default_audience: body.default_audience ?? null,
      allowed_redirect_origins: validatedAllowedOrigins,
      require_pkce: body.require_pkce || false,
    });

    await putClient(c.env, {
      client_id: client.client_id,
      client_secret_hash: client.client_secret_hash ?? undefined,
      client_name: client.client_name,
      redirect_uris: parseClientStringArray(client.redirect_uris, []),
      grant_types: parseClientStringArray(client.grant_types, ['authorization_code']),
      response_types: parseClientStringArray(client.response_types, ['code']),
      scope: client.scope ?? undefined,
      logo_uri: client.logo_uri ?? undefined,
      client_uri: client.client_uri ?? undefined,
      policy_uri: client.policy_uri ?? undefined,
      tos_uri: client.tos_uri ?? undefined,
      contacts: client.contacts ? parseClientStringArray(client.contacts, []) : undefined,
      post_logout_redirect_uris: client.post_logout_redirect_uris
        ? parseClientStringArray(client.post_logout_redirect_uris, [])
        : undefined,
      token_endpoint_auth_method: client.token_endpoint_auth_method,
      subject_type: client.subject_type ?? undefined,
      sector_identifier_uri: client.sector_identifier_uri ?? undefined,
      jwks: client.jwks ? JSON.parse(client.jwks) : undefined,
      jwks_uri: client.jwks_uri ?? undefined,
      is_trusted: client.is_trusted,
      skip_consent: client.skip_consent,
      allow_claims_without_scope: client.allow_claims_without_scope,
      token_exchange_allowed: client.token_exchange_allowed,
      allowed_subject_token_clients: client.allowed_subject_token_clients
        ? parseClientStringArray(client.allowed_subject_token_clients, [])
        : undefined,
      allowed_token_exchange_resources: client.allowed_token_exchange_resources
        ? parseClientStringArray(client.allowed_token_exchange_resources, [])
        : undefined,
      delegation_mode: client.delegation_mode,
      client_credentials_allowed: client.client_credentials_allowed,
      allowed_scopes: client.allowed_scopes
        ? parseClientStringArray(client.allowed_scopes, [])
        : undefined,
      default_scope: client.default_scope ?? undefined,
      default_audience: client.default_audience ?? undefined,
      backchannel_token_delivery_mode: client.backchannel_token_delivery_mode ?? undefined,
      backchannel_client_notification_endpoint:
        client.backchannel_client_notification_endpoint ?? undefined,
      backchannel_authentication_request_signing_alg:
        client.backchannel_authentication_request_signing_alg ?? undefined,
      backchannel_user_code_parameter: client.backchannel_user_code_parameter,
      userinfo_signed_response_alg: client.userinfo_signed_response_alg ?? undefined,
      backchannel_logout_uri: client.backchannel_logout_uri ?? undefined,
      backchannel_logout_session_required: client.backchannel_logout_session_required,
      frontchannel_logout_uri: client.frontchannel_logout_uri ?? undefined,
      frontchannel_logout_session_required: client.frontchannel_logout_session_required,
      allowed_redirect_origins: client.allowed_redirect_origins
        ? parseClientStringArray(client.allowed_redirect_origins, [])
        : undefined,
      software_id: client.software_id ?? undefined,
      software_version: client.software_version ?? undefined,
      requestable_scopes: client.requestable_scopes
        ? parseClientStringArray(client.requestable_scopes, [])
        : undefined,
      require_pkce: client.require_pkce,
      tenant_id: client.tenant_id,
      created_at: client.created_at,
      updated_at: client.updated_at,
    });

    const log = getLogger(c).module('ADMIN-CLIENT');
    publishEvent(c, {
      type: CLIENT_EVENTS.CREATED,
      tenantId,
      data: {
        clientId: client.client_id,
      } satisfies ClientEventData,
    }).catch((err: unknown) => {
      log.error(
        'Failed to publish client.created event',
        { action: 'publish_event' },
        err as Error
      );
    });

    scheduleAuditLogFromContext(c, 'client.created', 'client', client.client_id, {
      client_name: client.client_name,
      grant_types: client.grant_types,
    });
    scheduleAdminAuditLog(c, 'client.created', client.client_id, 'success', {
      client_name: client.client_name,
    });

    return c.json(
      {
        client: {
          client_id: client.client_id,
          client_secret: clientSecret,
          client_name: client.client_name,
          redirect_uris: parseClientStringArray(client.redirect_uris, []),
          grant_types: parseClientStringArray(client.grant_types, ['authorization_code']),
          response_types: parseClientStringArray(client.response_types, ['code']),
          scope: client.scope,
          logo_uri: client.logo_uri,
          client_uri: client.client_uri,
          policy_uri: client.policy_uri,
          tos_uri: client.tos_uri,
          contacts: client.contacts ? parseClientStringArray(client.contacts, []) : [],
          token_endpoint_auth_method: client.token_endpoint_auth_method,
          subject_type: client.subject_type,
          sector_identifier_uri: client.sector_identifier_uri,
          is_trusted: client.is_trusted,
          skip_consent: client.skip_consent,
          allow_claims_without_scope: client.allow_claims_without_scope,
          token_exchange_allowed: client.token_exchange_allowed,
          allowed_subject_token_clients: client.allowed_subject_token_clients
            ? parseClientStringArray(client.allowed_subject_token_clients, [])
            : [],
          allowed_token_exchange_resources: client.allowed_token_exchange_resources
            ? parseClientStringArray(client.allowed_token_exchange_resources, [])
            : [],
          delegation_mode: client.delegation_mode,
          client_credentials_allowed: client.client_credentials_allowed,
          allowed_scopes: client.allowed_scopes
            ? parseClientStringArray(client.allowed_scopes, [])
            : [],
          default_scope: client.default_scope,
          default_audience: client.default_audience,
          require_pkce: client.require_pkce,
          created_at: client.created_at,
          updated_at: client.updated_at,
        },
      },
      201
    );
  } catch (error) {
    logSanitizedError('Admin client create error', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to create client',
        ...getErrorDetailsForResponse(error, c.env),
      },
      500
    );
  }
}

export async function adminClientsListHandler(c: Context<{ Bindings: Env }>) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const page = parseInt(c.req.query('page') || '1');
    const limit = parseInt(c.req.query('limit') || '20');
    const search = c.req.query('search') || '';
    const authCtx = createAuthContextFromHono(c, tenantId);
    const result = await authCtx.repositories.client.listByTenant(tenantId, {
      page,
      limit,
      search: search || undefined,
    });

    const formattedClients = result.items.map((client) => {
      const { client_secret_hash: _excluded, ...clientWithoutHash } = client;
      return {
        ...clientWithoutHash,
        redirect_uris: parseClientStringArray(client.redirect_uris, []),
        grant_types: parseClientStringArray(client.grant_types, ['authorization_code']),
        response_types: parseClientStringArray(client.response_types, ['code']),
        contacts: client.contacts ? parseClientStringArray(client.contacts, []) : [],
        allowed_subject_token_clients: client.allowed_subject_token_clients
          ? parseClientStringArray(client.allowed_subject_token_clients, [])
          : [],
        allowed_token_exchange_resources: client.allowed_token_exchange_resources
          ? parseClientStringArray(client.allowed_token_exchange_resources, [])
          : [],
        allowed_scopes: client.allowed_scopes ? parseClientStringArray(client.allowed_scopes, []) : [],
        created_at: toMilliseconds(client.created_at),
        updated_at: toMilliseconds(client.updated_at),
      };
    });

    return c.json({
      clients: formattedClients,
      pagination: {
        page: result.page,
        limit: result.limit,
        total: result.total,
        totalPages: result.totalPages,
        hasNext: result.hasNext,
        hasPrev: result.hasPrev,
      },
    });
  } catch (error) {
    console.error('Admin clients list error:', error);
    logSanitizedError('Admin clients list error', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to retrieve clients',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      500
    );
  }
}

export async function adminClientGetHandler(c: Context<{ Bindings: Env }>) {
  try {
    const clientId = c.req.param('id')!;
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const client = await authCtx.repositories.client.findByClientId(clientId);

    if (!client) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'The requested resource was not found',
        },
        404
      );
    }

    const { client_secret_hash: _excluded, ...clientWithoutHash } = client;
    const formattedClient = {
      ...clientWithoutHash,
      redirect_uris: parseClientStringArray(client.redirect_uris, []),
      grant_types: parseClientStringArray(client.grant_types, ['authorization_code']),
      response_types: parseClientStringArray(client.response_types, ['code']),
      contacts: client.contacts ? parseClientStringArray(client.contacts, []) : [],
      allowed_subject_token_clients: client.allowed_subject_token_clients
        ? parseClientStringArray(client.allowed_subject_token_clients, [])
        : [],
      allowed_token_exchange_resources: client.allowed_token_exchange_resources
        ? parseClientStringArray(client.allowed_token_exchange_resources, [])
        : [],
      allowed_scopes: client.allowed_scopes ? parseClientStringArray(client.allowed_scopes, []) : [],
      created_at: toMilliseconds(client.created_at as number),
      updated_at: toMilliseconds(client.updated_at as number),
    };

    return c.json({
      client: formattedClient,
    });
  } catch (error) {
    logSanitizedError('Admin client get error', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to retrieve client',
      },
      500
    );
  }
}

export async function adminClientUpdateHandler(c: Context<{ Bindings: Env }>) {
  try {
    const clientId = c.req.param('id')!;
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const existingClient = await authCtx.repositories.client.findByClientId(clientId);

    if (!existingClient) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'The requested resource was not found',
        },
        404
      );
    }

    const body = await c.req.json();
    const {
      client_name,
      redirect_uris,
      grant_types,
      response_types,
      token_endpoint_auth_method,
      scope,
      logo_uri,
      client_uri,
      policy_uri,
      tos_uri,
      is_trusted,
      skip_consent,
      allow_claims_without_scope,
      allowed_redirect_origins,
      require_pkce,
      initiate_login_uri,
      login_ui_url,
      token_exchange_allowed,
      allowed_subject_token_clients,
      allowed_token_exchange_resources,
      delegation_mode,
      client_credentials_allowed,
      allowed_scopes,
      default_scope,
      default_audience,
    } = body;

    let validatedAllowedOrigins: string[] | undefined;
    if (allowed_redirect_origins !== undefined) {
      if (allowed_redirect_origins === null) {
        validatedAllowedOrigins = [];
      } else if (!Array.isArray(allowed_redirect_origins)) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'allowed_redirect_origins must be an array of origin strings',
          },
          400
        );
      } else {
        const originsValidation = validateAllowedOrigins(allowed_redirect_origins);
        if (!originsValidation.valid) {
          return c.json(
            {
              error: 'invalid_request',
              error_description: `Invalid allowed_redirect_origins: ${originsValidation.errors.join(', ')}`,
            },
            400
          );
        }
        validatedAllowedOrigins = originsValidation.normalizedOrigins;
      }
    }

    if (redirect_uris !== undefined) {
      if (!Array.isArray(redirect_uris) || redirect_uris.length === 0) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'redirect_uris must be a non-empty array',
          },
          400
        );
      }

      const hasInvalidUri = redirect_uris.some((uri) => {
        if (typeof uri !== 'string') return true;
        try {
          new URL(uri);
          return false;
        } catch {
          return true;
        }
      });

      if (hasInvalidUri) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'redirect_uris must contain valid URI strings',
          },
          400
        );
      }
    }

    if (grant_types !== undefined) {
      if (!Array.isArray(grant_types) || grant_types.some((v) => typeof v !== 'string')) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'grant_types must be an array of strings',
          },
          400
        );
      }

      if (isCharArrayLike(grant_types)) {
        return c.json(
          {
            error: 'invalid_request',
            error_description:
              'grant_types appears malformed. Send grant type values like authorization_code, not character arrays.',
          },
          400
        );
      }
    }

    if (response_types !== undefined) {
      if (!Array.isArray(response_types) || response_types.some((v) => typeof v !== 'string')) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'response_types must be an array of strings',
          },
          400
        );
      }

      if (isCharArrayLike(response_types)) {
        return c.json(
          {
            error: 'invalid_request',
            error_description:
              'response_types appears malformed. Send response type values like code, not character arrays.',
          },
          400
        );
      }
    }

    const allowedSubjectTokenClientsValidation = validateOptionalStringArrayField(
      allowed_subject_token_clients,
      'allowed_subject_token_clients'
    );
    if (!allowedSubjectTokenClientsValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: allowedSubjectTokenClientsValidation.error,
        },
        400
      );
    }

    const allowedTokenExchangeResourcesValidation = validateOptionalStringArrayField(
      allowed_token_exchange_resources,
      'allowed_token_exchange_resources'
    );
    if (!allowedTokenExchangeResourcesValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: allowedTokenExchangeResourcesValidation.error,
        },
        400
      );
    }

    const allowedScopesValidation = validateOptionalStringArrayField(
      allowed_scopes,
      'allowed_scopes'
    );
    if (!allowedScopesValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: allowedScopesValidation.error,
        },
        400
      );
    }

    if (delegation_mode !== undefined && !VALID_DELEGATION_MODES.has(delegation_mode)) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'delegation_mode must be one of none, delegation, impersonation',
        },
        400
      );
    }

    const hasUpdates = [
      client_name,
      redirect_uris,
      grant_types,
      response_types,
      token_endpoint_auth_method,
      scope,
      logo_uri,
      client_uri,
      policy_uri,
      tos_uri,
      is_trusted,
      skip_consent,
      allow_claims_without_scope,
      allowed_redirect_origins,
      require_pkce,
      initiate_login_uri,
      login_ui_url,
      token_exchange_allowed,
      allowed_subject_token_clients,
      allowed_token_exchange_resources,
      delegation_mode,
      client_credentials_allowed,
      allowed_scopes,
      default_scope,
      default_audience,
    ].some((v) => v !== undefined);

    if (!hasUpdates) {
      return c.json({
        success: true,
        message: 'No changes to update',
      });
    }

    const updatedClient = await authCtx.repositories.client.update(clientId, {
      client_name,
      redirect_uris,
      grant_types,
      response_types,
      token_endpoint_auth_method,
      scope,
      logo_uri,
      client_uri,
      policy_uri,
      tos_uri,
      is_trusted,
      skip_consent,
      allow_claims_without_scope,
      allowed_redirect_origins: validatedAllowedOrigins,
      require_pkce,
      initiate_login_uri,
      login_ui_url,
      token_exchange_allowed,
      allowed_subject_token_clients: allowedSubjectTokenClientsValidation.value,
      allowed_token_exchange_resources: allowedTokenExchangeResourcesValidation.value,
      delegation_mode,
      client_credentials_allowed,
      allowed_scopes: allowedScopesValidation.value,
      default_scope,
      default_audience,
    });

    const log = getLogger(c).module('ADMIN-CLIENT');
    try {
      await invalidateClientCache(c.env, clientId);
    } catch {
      log.warn('Failed to invalidate client cache', { action: 'cache_invalidate', clientId });
    }

    publishEvent(c, {
      type: CLIENT_EVENTS.UPDATED,
      tenantId,
      data: {
        clientId,
      } satisfies ClientEventData,
    }).catch((err: unknown) => {
      log.error(
        'Failed to publish client.updated event',
        { action: 'publish_event' },
        err as Error
      );
    });

    scheduleAuditLogFromContext(c, 'client.updated', 'client', clientId, {
      client_name: updatedClient?.client_name,
    });
    scheduleAdminAuditLog(c, 'client.updated', clientId, 'success', {
      client_name: updatedClient?.client_name,
    });

    if (updatedClient) {
      const { client_secret_hash: _excluded, ...clientWithoutHash } = updatedClient;
      return c.json({
        success: true,
        client: {
          ...clientWithoutHash,
          redirect_uris: parseClientStringArray(updatedClient.redirect_uris, []),
          grant_types: parseClientStringArray(updatedClient.grant_types, ['authorization_code']),
          response_types: parseClientStringArray(updatedClient.response_types, ['code']),
          contacts: updatedClient.contacts
            ? parseClientStringArray(updatedClient.contacts, [])
            : [],
          allowed_subject_token_clients: updatedClient.allowed_subject_token_clients
            ? parseClientStringArray(updatedClient.allowed_subject_token_clients, [])
            : [],
          allowed_token_exchange_resources: updatedClient.allowed_token_exchange_resources
            ? parseClientStringArray(updatedClient.allowed_token_exchange_resources, [])
            : [],
          allowed_scopes: updatedClient.allowed_scopes
            ? parseClientStringArray(updatedClient.allowed_scopes, [])
            : [],
        },
      });
    }

    return c.json({
      success: true,
      client: updatedClient,
    });
  } catch (error) {
    logSanitizedError('Admin client update error', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to update client',
      },
      500
    );
  }
}

export async function adminClientDeleteHandler(c: Context<{ Bindings: Env }>) {
  try {
    const clientId = c.req.param('id')!;
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const exists = await authCtx.repositories.client.exists(clientId);

    if (!exists) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'The requested resource was not found',
        },
        404
      );
    }

    await authCtx.repositories.client.delete(clientId);

    const log = getLogger(c).module('ADMIN-CLIENT');
    try {
      await invalidateClientCacheOnDelete(c.env, clientId, tenantId);
    } catch {
      log.warn('Failed to invalidate client cache on delete', {
        action: 'cache_invalidate',
        clientId,
      });
    }

    publishEvent(c, {
      type: CLIENT_EVENTS.DELETED,
      tenantId,
      data: {
        clientId,
      } satisfies ClientEventData,
    }).catch((err: unknown) => {
      log.error(
        'Failed to publish client.deleted event',
        { action: 'publish_event' },
        err as Error
      );
    });

    scheduleAuditLogFromContext(c, 'client.deleted', 'client', clientId, {});
    scheduleAdminAuditLog(c, 'client.deleted', clientId, 'success');

    return c.json({
      success: true,
      message: 'Client deleted successfully',
    });
  } catch (error) {
    logSanitizedError('Admin client delete error', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to delete client',
      },
      500
    );
  }
}

export async function adminClientsBulkDeleteHandler(c: Context<{ Bindings: Env }>) {
  try {
    const body = await c.req.json<{ client_ids: string[] }>();
    const { client_ids } = body;

    if (!client_ids || !Array.isArray(client_ids) || client_ids.length === 0) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'client_ids array is required',
        },
        400
      );
    }

    if (client_ids.length > 100) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Cannot delete more than 100 clients at once',
        },
        400
      );
    }

    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const result = await authCtx.repositories.client.bulkDelete(client_ids);
    const log = getLogger(c).module('ADMIN-CLIENT');
    const successfullyDeletedIds = client_ids.filter((id) => !result.failed.includes(id));
    for (const clientId of successfullyDeletedIds) {
      try {
        await c.env.CLIENTS_CACHE.delete(buildKVKey('client', clientId));
      } catch {
        log.warn('Failed to invalidate client cache', { action: 'cache_invalidate', clientId });
      }
    }

    const errors =
      result.failed.length > 0
        ? result.failed.map((id) => `Failed to delete ${id}: client not found or delete failed`)
        : undefined;

    scheduleAdminAuditLog(c, 'client.bulk_deleted', null, 'success', {
      deleted_count: result.deleted,
      requested_count: client_ids.length,
      failed_count: result.failed.length,
      deleted_ids: successfullyDeletedIds,
      failed_ids: result.failed.length > 0 ? result.failed : undefined,
    });

    return c.json({
      success: true,
      deleted: result.deleted,
      requested: client_ids.length,
      errors,
    });
  } catch (error) {
    logSanitizedError('Admin clients bulk delete error', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to delete clients',
      },
      500
    );
  }
}

export async function adminClientRegenerateSecretHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('ADMIN-CLIENT');
  const tenantId = getTenantIdFromContext(c);
  const clientId = c.req.param('id')!;

  if (!clientId) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'id' },
    });
  }

  try {
    const body = await c.req
      .json<{
        revoke_existing_tokens?: boolean;
        grace_period_hours?: number;
      }>()
      .catch(() => ({ revoke_existing_tokens: undefined, grace_period_hours: undefined }));

    const gracePeriodHours = body.grace_period_hours;
    if (gracePeriodHours !== undefined && (gracePeriodHours < 1 || gracePeriodHours > 168)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'grace_period_hours', reason: 'Must be between 1 and 168 hours' },
      });
    }

    const adapter = createAuthContextFromHono(c, tenantId).coreAdapter;
    const client = await getClient(c.env, clientId, adapter);

    if (!client || client.tenant_id !== tenantId) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const randomBytes = new Uint8Array(32);
    crypto.getRandomValues(randomBytes);
    const newSecret = Array.from(randomBytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const newSecretHash = await hashClientSecret(newSecret);
    const nowTs = Math.floor(Date.now() / 1000);

    if (gracePeriodHours) {
      log.warn('Grace period requested but not supported in current schema', {
        action: 'regenerate_secret',
        clientId,
        gracePeriodHours,
      });
    }

    await adapter.execute(
      `UPDATE oauth_clients SET
        client_secret_hash = ?,
        updated_at = ?
       WHERE client_id = ? AND tenant_id = ?`,
      [newSecretHash, nowTs, clientId, tenantId]
    );

    let revokedTokens = 0;
    if (body.revoke_existing_tokens) {
      const tokenResult = await adapter.execute(
        'UPDATE refresh_tokens SET revoked = 1, revoked_at = ? WHERE client_id = ? AND tenant_id = ? AND revoked = 0',
        [nowTs, clientId, tenantId]
      );
      revokedTokens = tokenResult.rowsAffected;
    }

    try {
      await c.env.CLIENTS_CACHE.delete(buildKVKey('client', clientId));
    } catch {
      log.warn('Failed to invalidate client cache after secret regeneration', {
        action: 'cache_invalidate',
        clientId,
      });
    }

    await createAuditLogFromContext(c, 'client.secret_regenerate', 'client', clientId, {
      grace_period_hours: gracePeriodHours,
      revoked_tokens: revokedTokens,
    });
    scheduleAdminAuditLog(c, 'client.secret_regenerated', clientId, 'success', {
      grace_period_hours: gracePeriodHours,
      revoked_tokens: revokedTokens,
    });

    log.info('Client secret regenerated', {
      action: 'client_secret_regenerate',
      clientId,
      gracePeriodHours,
      revokedTokens,
    });

    c.header('Cache-Control', 'no-store');

    return c.json({
      client_id: clientId,
      client_secret: newSecret,
      created_at: new Date(nowTs * 1000).toISOString(),
      revoked_tokens: revokedTokens,
    });
  } catch (error) {
    logSanitizedError('Admin client regenerate secret error', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}
