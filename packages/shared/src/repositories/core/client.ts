/**
 * Client Repository
 *
 * Repository for OAuth 2.0 client data stored in D1_CORE.
 * Contains all client configuration and metadata.
 *
 * Note: Does not extend BaseRepository because oauth_clients table
 * uses client_id as primary key instead of id.
 *
 * OAuth 2.0 / OIDC client fields:
 * - client_id, client_secret: Client credentials
 * - client_name, logo_uri, etc.: Client metadata
 * - redirect_uris, grant_types, response_types: OAuth configuration
 * - token_endpoint_auth_method: Authentication method
 * - Token Exchange settings (RFC 8693)
 * - Client Credentials settings (RFC 6749 Section 4.4)
 * - CIBA settings (OpenID Connect CIBA)
 */

import type { DatabaseAdapter } from '../../db/adapter';
import {
  type PaginationOptions,
  type PaginationResult,
  generateId,
  getCurrentTimestamp,
} from '../base';

/**
 * Token endpoint authentication methods
 */
export type TokenEndpointAuthMethod =
  | 'none'
  | 'client_secret_basic'
  | 'client_secret_post'
  | 'client_secret_jwt'
  | 'private_key_jwt';

/**
 * Subject type for OIDC
 */
export type SubjectType = 'public' | 'pairwise';

/**
 * Token exchange delegation mode
 */
export type DelegationMode = 'none' | 'delegation' | 'impersonation';

/**
 * CIBA token delivery mode
 */
export type CIBADeliveryMode = 'poll' | 'ping' | 'push';

/**
 * OAuth Client entity
 */
export interface OAuthClient {
  /** Client ID (primary key) */
  client_id: string;
  client_secret: string | null;
  client_name: string;
  tenant_id: string;

  // OAuth 2.0 / OIDC metadata
  redirect_uris: string; // JSON array
  grant_types: string; // JSON array
  response_types: string; // JSON array
  scope: string | null;
  logo_uri: string | null;
  client_uri: string | null;
  policy_uri: string | null;
  tos_uri: string | null;
  contacts: string | null; // JSON array
  post_logout_redirect_uris: string | null; // JSON array

  // OIDC subject type
  subject_type: SubjectType;
  sector_identifier_uri: string | null;

  // Authentication
  token_endpoint_auth_method: TokenEndpointAuthMethod;
  jwks: string | null; // JSON object
  jwks_uri: string | null;

  // Trust settings
  is_trusted: boolean;
  skip_consent: boolean;
  allow_claims_without_scope: boolean;

  // Token Exchange (RFC 8693)
  token_exchange_allowed: boolean;
  allowed_subject_token_clients: string | null; // JSON array
  allowed_token_exchange_resources: string | null; // JSON array
  delegation_mode: DelegationMode;

  // Client Credentials (RFC 6749 Section 4.4)
  client_credentials_allowed: boolean;
  allowed_scopes: string | null; // JSON array
  default_scope: string | null;
  default_audience: string | null;

  // CIBA settings
  backchannel_token_delivery_mode: CIBADeliveryMode | null;
  backchannel_client_notification_endpoint: string | null;
  backchannel_authentication_request_signing_alg: string | null;
  backchannel_user_code_parameter: boolean;

  // UserInfo response signing
  userinfo_signed_response_alg: string | null;

  // Timestamps
  created_at: number;
  updated_at: number;
}

/**
 * Client create input
 */
export interface CreateClientInput {
  client_id?: string;
  client_secret?: string | null;
  client_name: string;
  tenant_id?: string;
  redirect_uris: string[];
  grant_types?: string[];
  response_types?: string[];
  scope?: string | null;
  logo_uri?: string | null;
  client_uri?: string | null;
  policy_uri?: string | null;
  tos_uri?: string | null;
  contacts?: string[] | null;
  post_logout_redirect_uris?: string[] | null;
  subject_type?: SubjectType;
  sector_identifier_uri?: string | null;
  token_endpoint_auth_method?: TokenEndpointAuthMethod;
  jwks?: Record<string, unknown> | null;
  jwks_uri?: string | null;
  is_trusted?: boolean;
  skip_consent?: boolean;
  allow_claims_without_scope?: boolean;
  token_exchange_allowed?: boolean;
  allowed_subject_token_clients?: string[] | null;
  allowed_token_exchange_resources?: string[] | null;
  delegation_mode?: DelegationMode;
  client_credentials_allowed?: boolean;
  allowed_scopes?: string[] | null;
  default_scope?: string | null;
  default_audience?: string | null;
  backchannel_token_delivery_mode?: CIBADeliveryMode | null;
  backchannel_client_notification_endpoint?: string | null;
  backchannel_authentication_request_signing_alg?: string | null;
  backchannel_user_code_parameter?: boolean;
  userinfo_signed_response_alg?: string | null;
}

/**
 * Client update input
 */
export interface UpdateClientInput {
  client_name?: string;
  client_secret?: string | null;
  redirect_uris?: string[];
  grant_types?: string[];
  response_types?: string[];
  scope?: string | null;
  logo_uri?: string | null;
  client_uri?: string | null;
  policy_uri?: string | null;
  tos_uri?: string | null;
  contacts?: string[] | null;
  post_logout_redirect_uris?: string[] | null;
  subject_type?: SubjectType;
  sector_identifier_uri?: string | null;
  token_endpoint_auth_method?: TokenEndpointAuthMethod;
  jwks?: Record<string, unknown> | null;
  jwks_uri?: string | null;
  is_trusted?: boolean;
  skip_consent?: boolean;
  allow_claims_without_scope?: boolean;
  token_exchange_allowed?: boolean;
  allowed_subject_token_clients?: string[] | null;
  allowed_token_exchange_resources?: string[] | null;
  delegation_mode?: DelegationMode;
  client_credentials_allowed?: boolean;
  allowed_scopes?: string[] | null;
  default_scope?: string | null;
  default_audience?: string | null;
  backchannel_token_delivery_mode?: CIBADeliveryMode | null;
  backchannel_client_notification_endpoint?: string | null;
  backchannel_authentication_request_signing_alg?: string | null;
  backchannel_user_code_parameter?: boolean;
  userinfo_signed_response_alg?: string | null;
}

/**
 * Client filter options
 */
export interface ClientFilterOptions {
  tenant_id?: string;
  client_name?: string;
  is_trusted?: boolean;
  token_exchange_allowed?: boolean;
  client_credentials_allowed?: boolean;
}

/**
 * Client search options (for LIKE queries)
 */
export interface ClientSearchOptions extends PaginationOptions {
  search?: string; // Search in client_name and client_id
}

/**
 * OAuth Client Repository
 */
export class ClientRepository {
  protected readonly adapter: DatabaseAdapter;

  constructor(adapter: DatabaseAdapter) {
    this.adapter = adapter;
  }

  /**
   * Create a new client
   */
  async create(input: CreateClientInput): Promise<OAuthClient> {
    const now = getCurrentTimestamp();
    const clientId = input.client_id || generateId();

    const client: OAuthClient = {
      client_id: clientId,
      client_secret: input.client_secret ?? null,
      client_name: input.client_name,
      tenant_id: input.tenant_id || 'default',
      redirect_uris: JSON.stringify(input.redirect_uris),
      grant_types: JSON.stringify(input.grant_types || ['authorization_code']),
      response_types: JSON.stringify(input.response_types || ['code']),
      scope: input.scope ?? null,
      logo_uri: input.logo_uri ?? null,
      client_uri: input.client_uri ?? null,
      policy_uri: input.policy_uri ?? null,
      tos_uri: input.tos_uri ?? null,
      contacts: input.contacts ? JSON.stringify(input.contacts) : null,
      post_logout_redirect_uris: input.post_logout_redirect_uris
        ? JSON.stringify(input.post_logout_redirect_uris)
        : null,
      subject_type: input.subject_type || 'public',
      sector_identifier_uri: input.sector_identifier_uri ?? null,
      token_endpoint_auth_method: input.token_endpoint_auth_method || 'client_secret_basic',
      jwks: input.jwks ? JSON.stringify(input.jwks) : null,
      jwks_uri: input.jwks_uri ?? null,
      is_trusted: input.is_trusted ?? false,
      skip_consent: input.skip_consent ?? false,
      allow_claims_without_scope: input.allow_claims_without_scope ?? false,
      token_exchange_allowed: input.token_exchange_allowed ?? false,
      allowed_subject_token_clients: input.allowed_subject_token_clients
        ? JSON.stringify(input.allowed_subject_token_clients)
        : null,
      allowed_token_exchange_resources: input.allowed_token_exchange_resources
        ? JSON.stringify(input.allowed_token_exchange_resources)
        : null,
      delegation_mode: input.delegation_mode || 'delegation',
      client_credentials_allowed: input.client_credentials_allowed ?? false,
      allowed_scopes: input.allowed_scopes ? JSON.stringify(input.allowed_scopes) : null,
      default_scope: input.default_scope ?? null,
      default_audience: input.default_audience ?? null,
      backchannel_token_delivery_mode: input.backchannel_token_delivery_mode ?? null,
      backchannel_client_notification_endpoint:
        input.backchannel_client_notification_endpoint ?? null,
      backchannel_authentication_request_signing_alg:
        input.backchannel_authentication_request_signing_alg ?? null,
      backchannel_user_code_parameter: input.backchannel_user_code_parameter ?? false,
      userinfo_signed_response_alg: input.userinfo_signed_response_alg ?? null,
      created_at: now,
      updated_at: now,
    };

    await this.adapter.execute(
      `INSERT INTO oauth_clients (
        client_id, client_secret, client_name, tenant_id,
        redirect_uris, grant_types, response_types, scope,
        logo_uri, client_uri, policy_uri, tos_uri, contacts,
        post_logout_redirect_uris, subject_type, sector_identifier_uri,
        token_endpoint_auth_method, jwks, jwks_uri,
        is_trusted, skip_consent, allow_claims_without_scope,
        token_exchange_allowed, allowed_subject_token_clients,
        allowed_token_exchange_resources, delegation_mode,
        client_credentials_allowed, allowed_scopes, default_scope, default_audience,
        backchannel_token_delivery_mode, backchannel_client_notification_endpoint,
        backchannel_authentication_request_signing_alg, backchannel_user_code_parameter,
        userinfo_signed_response_alg,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        client.client_id,
        client.client_secret,
        client.client_name,
        client.tenant_id,
        client.redirect_uris,
        client.grant_types,
        client.response_types,
        client.scope,
        client.logo_uri,
        client.client_uri,
        client.policy_uri,
        client.tos_uri,
        client.contacts,
        client.post_logout_redirect_uris,
        client.subject_type,
        client.sector_identifier_uri,
        client.token_endpoint_auth_method,
        client.jwks,
        client.jwks_uri,
        client.is_trusted ? 1 : 0,
        client.skip_consent ? 1 : 0,
        client.allow_claims_without_scope ? 1 : 0,
        client.token_exchange_allowed ? 1 : 0,
        client.allowed_subject_token_clients,
        client.allowed_token_exchange_resources,
        client.delegation_mode,
        client.client_credentials_allowed ? 1 : 0,
        client.allowed_scopes,
        client.default_scope,
        client.default_audience,
        client.backchannel_token_delivery_mode,
        client.backchannel_client_notification_endpoint,
        client.backchannel_authentication_request_signing_alg,
        client.backchannel_user_code_parameter ? 1 : 0,
        client.userinfo_signed_response_alg,
        client.created_at,
        client.updated_at,
      ]
    );

    return client;
  }

  /**
   * Find client by client_id
   */
  async findByClientId(clientId: string): Promise<OAuthClient | null> {
    const result = await this.adapter.queryOne<OAuthClient>(
      'SELECT * FROM oauth_clients WHERE client_id = ?',
      [clientId]
    );
    return result ? this.mapFromDb(result) : null;
  }

  /**
   * Update a client
   */
  async update(clientId: string, input: UpdateClientInput): Promise<OAuthClient | null> {
    const existing = await this.findByClientId(clientId);
    if (!existing) {
      return null;
    }

    const now = getCurrentTimestamp();
    const updates: string[] = ['updated_at = ?'];
    const params: unknown[] = [now];

    // Build dynamic update query
    if (input.client_name !== undefined) {
      updates.push('client_name = ?');
      params.push(input.client_name);
    }
    if (input.client_secret !== undefined) {
      updates.push('client_secret = ?');
      params.push(input.client_secret);
    }
    if (input.redirect_uris !== undefined) {
      updates.push('redirect_uris = ?');
      params.push(JSON.stringify(input.redirect_uris));
    }
    if (input.grant_types !== undefined) {
      updates.push('grant_types = ?');
      params.push(JSON.stringify(input.grant_types));
    }
    if (input.response_types !== undefined) {
      updates.push('response_types = ?');
      params.push(JSON.stringify(input.response_types));
    }
    if (input.scope !== undefined) {
      updates.push('scope = ?');
      params.push(input.scope);
    }
    if (input.logo_uri !== undefined) {
      updates.push('logo_uri = ?');
      params.push(input.logo_uri);
    }
    if (input.client_uri !== undefined) {
      updates.push('client_uri = ?');
      params.push(input.client_uri);
    }
    if (input.policy_uri !== undefined) {
      updates.push('policy_uri = ?');
      params.push(input.policy_uri);
    }
    if (input.tos_uri !== undefined) {
      updates.push('tos_uri = ?');
      params.push(input.tos_uri);
    }
    if (input.contacts !== undefined) {
      updates.push('contacts = ?');
      params.push(input.contacts ? JSON.stringify(input.contacts) : null);
    }
    if (input.post_logout_redirect_uris !== undefined) {
      updates.push('post_logout_redirect_uris = ?');
      params.push(
        input.post_logout_redirect_uris ? JSON.stringify(input.post_logout_redirect_uris) : null
      );
    }
    if (input.subject_type !== undefined) {
      updates.push('subject_type = ?');
      params.push(input.subject_type);
    }
    if (input.sector_identifier_uri !== undefined) {
      updates.push('sector_identifier_uri = ?');
      params.push(input.sector_identifier_uri);
    }
    if (input.token_endpoint_auth_method !== undefined) {
      updates.push('token_endpoint_auth_method = ?');
      params.push(input.token_endpoint_auth_method);
    }
    if (input.jwks !== undefined) {
      updates.push('jwks = ?');
      params.push(input.jwks ? JSON.stringify(input.jwks) : null);
    }
    if (input.jwks_uri !== undefined) {
      updates.push('jwks_uri = ?');
      params.push(input.jwks_uri);
    }
    if (input.is_trusted !== undefined) {
      updates.push('is_trusted = ?');
      params.push(input.is_trusted ? 1 : 0);
    }
    if (input.skip_consent !== undefined) {
      updates.push('skip_consent = ?');
      params.push(input.skip_consent ? 1 : 0);
    }
    if (input.allow_claims_without_scope !== undefined) {
      updates.push('allow_claims_without_scope = ?');
      params.push(input.allow_claims_without_scope ? 1 : 0);
    }
    if (input.token_exchange_allowed !== undefined) {
      updates.push('token_exchange_allowed = ?');
      params.push(input.token_exchange_allowed ? 1 : 0);
    }
    if (input.allowed_subject_token_clients !== undefined) {
      updates.push('allowed_subject_token_clients = ?');
      params.push(
        input.allowed_subject_token_clients
          ? JSON.stringify(input.allowed_subject_token_clients)
          : null
      );
    }
    if (input.allowed_token_exchange_resources !== undefined) {
      updates.push('allowed_token_exchange_resources = ?');
      params.push(
        input.allowed_token_exchange_resources
          ? JSON.stringify(input.allowed_token_exchange_resources)
          : null
      );
    }
    if (input.delegation_mode !== undefined) {
      updates.push('delegation_mode = ?');
      params.push(input.delegation_mode);
    }
    if (input.client_credentials_allowed !== undefined) {
      updates.push('client_credentials_allowed = ?');
      params.push(input.client_credentials_allowed ? 1 : 0);
    }
    if (input.allowed_scopes !== undefined) {
      updates.push('allowed_scopes = ?');
      params.push(input.allowed_scopes ? JSON.stringify(input.allowed_scopes) : null);
    }
    if (input.default_scope !== undefined) {
      updates.push('default_scope = ?');
      params.push(input.default_scope);
    }
    if (input.default_audience !== undefined) {
      updates.push('default_audience = ?');
      params.push(input.default_audience);
    }
    if (input.backchannel_token_delivery_mode !== undefined) {
      updates.push('backchannel_token_delivery_mode = ?');
      params.push(input.backchannel_token_delivery_mode);
    }
    if (input.backchannel_client_notification_endpoint !== undefined) {
      updates.push('backchannel_client_notification_endpoint = ?');
      params.push(input.backchannel_client_notification_endpoint);
    }
    if (input.backchannel_authentication_request_signing_alg !== undefined) {
      updates.push('backchannel_authentication_request_signing_alg = ?');
      params.push(input.backchannel_authentication_request_signing_alg);
    }
    if (input.backchannel_user_code_parameter !== undefined) {
      updates.push('backchannel_user_code_parameter = ?');
      params.push(input.backchannel_user_code_parameter ? 1 : 0);
    }
    if (input.userinfo_signed_response_alg !== undefined) {
      updates.push('userinfo_signed_response_alg = ?');
      params.push(input.userinfo_signed_response_alg);
    }

    params.push(clientId);

    await this.adapter.execute(
      `UPDATE oauth_clients SET ${updates.join(', ')} WHERE client_id = ?`,
      params
    );

    return this.findByClientId(clientId);
  }

  /**
   * Delete a client
   */
  async delete(clientId: string): Promise<boolean> {
    const result = await this.adapter.execute('DELETE FROM oauth_clients WHERE client_id = ?', [
      clientId,
    ]);
    return result.rowsAffected > 0;
  }

  /**
   * Allowed sort fields for client queries (prevents SQL injection)
   */
  private static readonly ALLOWED_SORT_FIELDS = new Set([
    'client_id',
    'client_name',
    'created_at',
    'updated_at',
    'tenant_id',
  ]);

  /**
   * Escape LIKE wildcards to prevent unintended pattern matching
   */
  private escapeLikePattern(value: string): string {
    return value.replace(/[%_\\]/g, (char) => `\\${char}`);
  }

  /**
   * Validate and sanitize sort field to prevent SQL injection
   */
  private validateSortField(field: string): string {
    if (!ClientRepository.ALLOWED_SORT_FIELDS.has(field)) {
      return 'created_at'; // Safe default
    }
    return field;
  }

  /**
   * Validate sort order to prevent SQL injection
   */
  private validateSortOrder(order: string): 'ASC' | 'DESC' {
    const normalized = order.toUpperCase();
    return normalized === 'ASC' ? 'ASC' : 'DESC';
  }

  /** Maximum allowed limit per page */
  private static readonly MAX_LIMIT = 100;

  /** Minimum allowed limit per page */
  private static readonly MIN_LIMIT = 1;

  /**
   * Validate and normalize pagination parameters
   * @param page - Page number (must be >= 1)
   * @param limit - Items per page (must be 1-100)
   * @returns Validated and normalized values
   */
  private validatePagination(page: number, limit: number): { page: number; limit: number } {
    // Ensure page is at least 1
    const validPage = Number.isInteger(page) && page >= 1 ? page : 1;

    // Ensure limit is within bounds
    let validLimit = limit;
    if (!Number.isInteger(limit) || limit < ClientRepository.MIN_LIMIT) {
      validLimit = ClientRepository.MIN_LIMIT;
    } else if (limit > ClientRepository.MAX_LIMIT) {
      validLimit = ClientRepository.MAX_LIMIT;
    }

    return { page: validPage, limit: validLimit };
  }

  /**
   * List clients with pagination and search
   */
  async listByTenant(
    tenantId: string,
    options: ClientSearchOptions = {}
  ): Promise<PaginationResult<OAuthClient>> {
    const { search, sortBy = 'created_at', sortOrder = 'desc' } = options;

    // Validate pagination parameters to prevent invalid offsets
    const { page, limit } = this.validatePagination(options.page ?? 1, options.limit ?? 20);

    // Validate sort parameters to prevent SQL injection
    const safeSortBy = this.validateSortField(sortBy);
    const safeSortOrder = this.validateSortOrder(sortOrder);

    const conditions: string[] = ['tenant_id = ?'];
    const params: unknown[] = [tenantId];

    if (search) {
      // Escape LIKE wildcards to prevent unintended pattern matching
      const escapedSearch = this.escapeLikePattern(search);
      conditions.push("(client_name LIKE ? ESCAPE '\\' OR client_id LIKE ? ESCAPE '\\')");
      const searchPattern = `%${escapedSearch}%`;
      params.push(searchPattern, searchPattern);
    }

    const whereClause = conditions.join(' AND ');
    const offset = (page - 1) * limit;

    // Get total count
    const countResult = await this.adapter.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM oauth_clients WHERE ${whereClause}`,
      params
    );
    const total = countResult?.count || 0;

    // Get items (sortBy and sortOrder are validated)
    const items = await this.adapter.query<OAuthClient>(
      `SELECT * FROM oauth_clients WHERE ${whereClause} ORDER BY ${safeSortBy} ${safeSortOrder} LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const totalPages = Math.ceil(total / limit);

    return {
      items: items.map((item) => this.mapFromDb(item)),
      total,
      page,
      limit,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    };
  }

  /**
   * Count clients by tenant
   */
  async countByTenant(tenantId: string): Promise<number> {
    const result = await this.adapter.queryOne<{ count: number }>(
      'SELECT COUNT(*) as count FROM oauth_clients WHERE tenant_id = ?',
      [tenantId]
    );
    return result?.count || 0;
  }

  /**
   * Check if client exists
   */
  async exists(clientId: string): Promise<boolean> {
    const result = await this.adapter.queryOne<{ client_id: string }>(
      'SELECT client_id FROM oauth_clients WHERE client_id = ?',
      [clientId]
    );
    return result !== null;
  }

  /**
   * Bulk delete clients
   */
  async bulkDelete(clientIds: string[]): Promise<{ deleted: number; failed: string[] }> {
    let deleted = 0;
    const failed: string[] = [];

    for (const clientId of clientIds) {
      try {
        const success = await this.delete(clientId);
        if (success) {
          deleted++;
        } else {
          failed.push(clientId);
        }
      } catch {
        failed.push(clientId);
      }
    }

    return { deleted, failed };
  }

  /**
   * Map database row to entity (handle boolean conversions)
   */
  private mapFromDb(row: OAuthClient): OAuthClient {
    return {
      ...row,
      is_trusted: Boolean(row.is_trusted),
      skip_consent: Boolean(row.skip_consent),
      allow_claims_without_scope: Boolean(row.allow_claims_without_scope),
      token_exchange_allowed: Boolean(row.token_exchange_allowed),
      client_credentials_allowed: Boolean(row.client_credentials_allowed),
      backchannel_user_code_parameter: Boolean(row.backchannel_user_code_parameter),
    };
  }
}
