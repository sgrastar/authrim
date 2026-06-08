/**
 * Client Repository
 *
 * Repository for OAuth 2.0 client data stored in D1_CORE.
 * Contains all client configuration and metadata.
 *
 * Note: Does not extend BaseRepository because oauth_clients table
 * uses (tenant_id, client_id) as the primary key instead of id.
 *
 * OAuth 2.0 / OIDC client fields:
 * - client_id, client_secret_hash: Client credentials (secret stored as SHA-256 hash)
 * - client_name, logo_uri, etc.: Client metadata
 * - redirect_uris, grant_types, response_types: OAuth configuration
 * - token_endpoint_auth_method: Authentication method
 * - Token Exchange settings (RFC 8693)
 * - Client Credentials settings (RFC 6749 Section 4.4)
 * - CIBA settings (OpenID Connect CIBA)
 */

import type { DatabaseAdapter } from '../../db/adapter';
import type { AttributeReleaseConsentPolicy } from '../../services/identity-release-consent';
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

export type ClientApplicationType = 'web' | 'native' | 'spa' | 'service';
export type ClientChannel = 'browser' | 'native' | 'server';
export type BrowserPublicClientMode = 'strict' | 'cookie_fallback';
export type BrowserRefreshTokenPolicy = 'disabled' | 'dpop_bound';

export interface ClientIdentityFieldMappingSetSelector {
  fieldMappingSetId?: string;
  fieldMappingVersionId?: string;
  destinationNamespace?: string;
  sourceProfileId?: string;
  destinationProfileId?: string;
}

/**
 * OAuth Client entity
 */
export interface OAuthClient {
  /** Public OAuth client ID, unique within a tenant */
  client_id: string;
  /** SHA-256 hash of the client secret (null for public clients) */
  client_secret_hash: string | null;
  client_name: string;
  description: string | null;
  tenant_id: string;
  application_type: ClientApplicationType | null;
  // Internal storage name for the public/Admin "application_group" concept.
  // The trust_group fields remain the security-boundary identifiers until a schema rename.
  trust_group: string | null;
  trust_group_id: string | null;
  browser_public_client_mode: BrowserPublicClientMode | null;
  browser_refresh_token_policy: BrowserRefreshTokenPolicy;
  native_sso_enabled: boolean | null;
  native_channel_allowed: boolean | null;
  allowed_channels: string | null; // JSON array
  device_secret_revoke_enabled: boolean | null;
  device_secret_revoke_trust_groups: string | null; // JSON array
  device_secret_introspection_enabled: boolean | null;
  device_secret_introspection_trust_groups: string | null; // JSON array

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
  claims_parameter_policy: string | null; // JSON object
  identity_mapping?: string | null; // JSON object
  attribute_release_consent?: string | null; // JSON object
  asc_enabled: boolean;
  asc_protected_request_required: boolean;
  asc_sao_enabled: boolean;
  asc_transformed_claims_enabled: boolean;
  asc_allowed_transformed_claims: string | null; // JSON array

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
  default_resource: string | null;

  // CIBA settings
  backchannel_token_delivery_mode: CIBADeliveryMode | null;
  backchannel_client_notification_endpoint: string | null;
  backchannel_authentication_request_signing_alg: string | null;
  backchannel_user_code_parameter: boolean;

  // UserInfo response signing
  userinfo_signed_response_alg: string | null;

  // ==========================================================================
  // OIDC Logout Support (Back-Channel & Front-Channel Logout)
  // ==========================================================================
  /** Backchannel logout URI - receives logout token via POST */
  backchannel_logout_uri: string | null;
  /** Whether sid claim is required in backchannel logout token */
  backchannel_logout_session_required: boolean;
  /** Frontchannel logout URI - called via iframe during logout */
  frontchannel_logout_uri: string | null;
  /** Whether sid is required in frontchannel logout */
  frontchannel_logout_session_required: boolean;

  // ==========================================================================
  // Custom Redirect URIs (Authrim Extension)
  // ==========================================================================
  /**
   * Allowed origins for custom redirect URIs (error_uri, cancel_uri).
   * This is the internal storage precursor for the public/Admin "web_origin_registry" surface.
   * JSON array of origin strings (e.g., '["https://app.example.com"]').
   * Same-origin with redirect_uri is always allowed without registration.
   * Note: This is an Authrim extension, not OIDC standard.
   */
  allowed_redirect_origins: string | null;

  // RFC 7591: Dynamic Client Registration
  software_id: string | null;
  software_version: string | null;
  requestable_scopes: string | null; // JSON array

  // PKCE (RFC 7636)
  /** Whether PKCE is required for authorization requests */
  require_pkce: boolean;

  // OIDC Dynamic Client Registration
  initiate_login_uri: string | null;
  login_ui_url: string | null;

  // Timestamps
  created_at: number;
  updated_at: number;
}

/**
 * Client create input
 */
export interface CreateClientInput {
  client_id?: string;
  /** SHA-256 hash of the client secret (null for public clients) */
  client_secret_hash?: string | null;
  client_name: string;
  description?: string | null;
  tenant_id?: string;
  application_type?: ClientApplicationType | null;
  // Public/Admin APIs should translate application_group to these internal trust_group fields.
  trust_group?: string | null;
  trust_group_id?: string | null;
  browser_public_client_mode?: BrowserPublicClientMode | null;
  browser_refresh_token_policy?: BrowserRefreshTokenPolicy | null;
  native_sso_enabled?: boolean | null;
  native_channel_allowed?: boolean | null;
  allowed_channels?: ClientChannel[] | null;
  device_secret_revoke_enabled?: boolean | null;
  device_secret_revoke_trust_groups?: string[] | null;
  device_secret_introspection_enabled?: boolean | null;
  device_secret_introspection_trust_groups?: string[] | null;
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
  claims_parameter_policy?: Record<
    string,
    'scope_required' | 'claims_allowed' | 'forbidden'
  > | null;
  identity_mapping?: ClientIdentityFieldMappingSetSelector | null;
  attribute_release_consent?: AttributeReleaseConsentPolicy | null;
  asc_enabled?: boolean;
  asc_protected_request_required?: boolean;
  asc_sao_enabled?: boolean;
  asc_transformed_claims_enabled?: boolean;
  asc_allowed_transformed_claims?: string[] | null;
  token_exchange_allowed?: boolean;
  allowed_subject_token_clients?: string[] | null;
  allowed_token_exchange_resources?: string[] | null;
  delegation_mode?: DelegationMode;
  client_credentials_allowed?: boolean;
  allowed_scopes?: string[] | null;
  default_scope?: string | null;
  default_audience?: string | null;
  default_resource?: string | null;
  backchannel_token_delivery_mode?: CIBADeliveryMode | null;
  backchannel_client_notification_endpoint?: string | null;
  backchannel_authentication_request_signing_alg?: string | null;
  backchannel_user_code_parameter?: boolean;
  userinfo_signed_response_alg?: string | null;
  // OIDC Logout
  backchannel_logout_uri?: string | null;
  backchannel_logout_session_required?: boolean;
  frontchannel_logout_uri?: string | null;
  frontchannel_logout_session_required?: boolean;
  // Public/Admin APIs should translate web_origin_registry membership to this internal origin list.
  // Custom Redirect URIs (Authrim Extension)
  allowed_redirect_origins?: string[] | null;
  // RFC 7591: Dynamic Client Registration
  software_id?: string | null;
  software_version?: string | null;
  requestable_scopes?: string[] | null;
  // PKCE (RFC 7636)
  require_pkce?: boolean;
  // OIDC Dynamic Client Registration
  initiate_login_uri?: string | null;
  login_ui_url?: string | null;
}

/**
 * Client update input
 */
export interface UpdateClientInput {
  client_name?: string;
  description?: string | null;
  /** SHA-256 hash of the client secret (null for public clients) */
  client_secret_hash?: string | null;
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
  claims_parameter_policy?: Record<
    string,
    'scope_required' | 'claims_allowed' | 'forbidden'
  > | null;
  identity_mapping?: ClientIdentityFieldMappingSetSelector | null;
  attribute_release_consent?: AttributeReleaseConsentPolicy | null;
  asc_enabled?: boolean;
  asc_protected_request_required?: boolean;
  asc_sao_enabled?: boolean;
  asc_transformed_claims_enabled?: boolean;
  asc_allowed_transformed_claims?: string[] | null;
  application_type?: ClientApplicationType | null;
  // Public/Admin APIs should translate application_group to these internal trust_group fields.
  trust_group?: string | null;
  trust_group_id?: string | null;
  browser_public_client_mode?: BrowserPublicClientMode | null;
  browser_refresh_token_policy?: BrowserRefreshTokenPolicy | null;
  native_sso_enabled?: boolean | null;
  native_channel_allowed?: boolean | null;
  allowed_channels?: ClientChannel[] | null;
  device_secret_revoke_enabled?: boolean | null;
  device_secret_revoke_trust_groups?: string[] | null;
  device_secret_introspection_enabled?: boolean | null;
  device_secret_introspection_trust_groups?: string[] | null;
  token_exchange_allowed?: boolean;
  allowed_subject_token_clients?: string[] | null;
  allowed_token_exchange_resources?: string[] | null;
  delegation_mode?: DelegationMode;
  client_credentials_allowed?: boolean;
  allowed_scopes?: string[] | null;
  default_scope?: string | null;
  default_audience?: string | null;
  default_resource?: string | null;
  backchannel_token_delivery_mode?: CIBADeliveryMode | null;
  backchannel_client_notification_endpoint?: string | null;
  backchannel_authentication_request_signing_alg?: string | null;
  backchannel_user_code_parameter?: boolean;
  userinfo_signed_response_alg?: string | null;
  // OIDC Logout
  backchannel_logout_uri?: string | null;
  backchannel_logout_session_required?: boolean;
  frontchannel_logout_uri?: string | null;
  frontchannel_logout_session_required?: boolean;
  // Public/Admin APIs should translate web_origin_registry membership to this internal origin list.
  // Custom Redirect URIs (Authrim Extension)
  allowed_redirect_origins?: string[] | null;
  // RFC 7591: Dynamic Client Registration
  software_id?: string | null;
  software_version?: string | null;
  requestable_scopes?: string[] | null;
  // PKCE (RFC 7636)
  require_pkce?: boolean;
  // OIDC Dynamic Client Registration
  initiate_login_uri?: string | null;
  login_ui_url?: string | null;
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
  search?: string; // Search in client_name, client_id, and description
}

function requireTenantId(tenantId: string, context: string): string {
  const normalized = tenantId.trim();
  if (!normalized) {
    throw new Error(`${context} requires tenantId`);
  }
  return normalized;
}

function resolveInputTenantId(
  repositoryTenantId: string,
  inputTenantId: string | undefined,
  context: string
): string {
  if (inputTenantId === undefined) {
    return repositoryTenantId;
  }
  const normalized = requireTenantId(inputTenantId, context);
  if (normalized !== repositoryTenantId) {
    throw new Error(`${context} tenantId does not match repository tenant`);
  }
  return normalized;
}

/**
 * OAuth Client Repository
 */
export class ClientRepository {
  protected readonly adapter: DatabaseAdapter;
  private readonly tenantId: string;

  constructor(adapter: DatabaseAdapter, tenantId: string) {
    this.adapter = adapter;
    this.tenantId = requireTenantId(tenantId, 'ClientRepository');
  }

  /**
   * Create a new client
   */
  async create(input: CreateClientInput): Promise<OAuthClient> {
    const now = getCurrentTimestamp();
    const clientId = input.client_id || generateId();
    const tenantId = resolveInputTenantId(
      this.tenantId,
      input.tenant_id,
      'ClientRepository.create'
    );

    const client: OAuthClient = {
      client_id: clientId,
      client_secret_hash: input.client_secret_hash ?? null,
      client_name: input.client_name,
      description: input.description ?? null,
      tenant_id: tenantId,
      application_type: input.application_type ?? 'web',
      trust_group: input.trust_group ?? null,
      trust_group_id: input.trust_group_id ?? input.trust_group ?? null,
      browser_public_client_mode: input.browser_public_client_mode ?? null,
      browser_refresh_token_policy: input.browser_refresh_token_policy ?? 'disabled',
      native_sso_enabled: input.native_sso_enabled ?? null,
      native_channel_allowed: input.native_channel_allowed ?? null,
      allowed_channels: input.allowed_channels ? JSON.stringify(input.allowed_channels) : null,
      device_secret_revoke_enabled: input.device_secret_revoke_enabled ?? null,
      device_secret_revoke_trust_groups: input.device_secret_revoke_trust_groups
        ? JSON.stringify(input.device_secret_revoke_trust_groups)
        : null,
      device_secret_introspection_enabled: input.device_secret_introspection_enabled ?? null,
      device_secret_introspection_trust_groups: input.device_secret_introspection_trust_groups
        ? JSON.stringify(input.device_secret_introspection_trust_groups)
        : null,
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
      claims_parameter_policy: input.claims_parameter_policy
        ? JSON.stringify(input.claims_parameter_policy)
        : null,
      identity_mapping: input.identity_mapping ? JSON.stringify(input.identity_mapping) : null,
      attribute_release_consent: input.attribute_release_consent
        ? JSON.stringify(input.attribute_release_consent)
        : null,
      asc_enabled: input.asc_enabled ?? true,
      asc_protected_request_required: input.asc_protected_request_required ?? true,
      asc_sao_enabled: input.asc_sao_enabled ?? true,
      asc_transformed_claims_enabled: input.asc_transformed_claims_enabled ?? true,
      asc_allowed_transformed_claims: input.asc_allowed_transformed_claims
        ? JSON.stringify(input.asc_allowed_transformed_claims)
        : null,
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
      default_resource: input.default_resource ?? null,
      backchannel_token_delivery_mode: input.backchannel_token_delivery_mode ?? null,
      backchannel_client_notification_endpoint:
        input.backchannel_client_notification_endpoint ?? null,
      backchannel_authentication_request_signing_alg:
        input.backchannel_authentication_request_signing_alg ?? null,
      backchannel_user_code_parameter: input.backchannel_user_code_parameter ?? false,
      userinfo_signed_response_alg: input.userinfo_signed_response_alg ?? null,
      // OIDC Logout
      backchannel_logout_uri: input.backchannel_logout_uri ?? null,
      backchannel_logout_session_required: input.backchannel_logout_session_required ?? false,
      frontchannel_logout_uri: input.frontchannel_logout_uri ?? null,
      frontchannel_logout_session_required: input.frontchannel_logout_session_required ?? false,
      // Custom Redirect URIs (Authrim Extension)
      allowed_redirect_origins: input.allowed_redirect_origins
        ? JSON.stringify(input.allowed_redirect_origins)
        : null,
      // RFC 7591: Dynamic Client Registration
      software_id: input.software_id ?? null,
      software_version: input.software_version ?? null,
      requestable_scopes: input.requestable_scopes
        ? JSON.stringify(input.requestable_scopes)
        : null,
      // PKCE (RFC 7636)
      require_pkce: input.require_pkce ?? false,
      // OIDC Dynamic Client Registration
      initiate_login_uri: input.initiate_login_uri ?? null,
      login_ui_url: input.login_ui_url ?? null,
      created_at: now,
      updated_at: now,
    };

    await this.adapter.execute(
      `INSERT INTO oauth_clients (
        client_id, client_secret_hash, client_name, description, tenant_id,
        application_type, trust_group, trust_group_id,
        browser_public_client_mode, browser_refresh_token_policy,
        native_sso_enabled, native_channel_allowed, allowed_channels,
        device_secret_revoke_enabled, device_secret_revoke_trust_groups,
        device_secret_introspection_enabled, device_secret_introspection_trust_groups,
        redirect_uris, grant_types, response_types, scope,
        logo_uri, client_uri, policy_uri, tos_uri, contacts,
        post_logout_redirect_uris, subject_type, sector_identifier_uri,
        token_endpoint_auth_method, jwks, jwks_uri,
        is_trusted, skip_consent, allow_claims_without_scope,
        claims_parameter_policy, identity_mapping, attribute_release_consent,
        asc_enabled, asc_protected_request_required,
        asc_sao_enabled, asc_transformed_claims_enabled, asc_allowed_transformed_claims,
        token_exchange_allowed, allowed_subject_token_clients,
        allowed_token_exchange_resources, delegation_mode,
        client_credentials_allowed, allowed_scopes, default_scope, default_audience,
        default_resource,
        backchannel_token_delivery_mode, backchannel_client_notification_endpoint,
        backchannel_authentication_request_signing_alg, backchannel_user_code_parameter,
        userinfo_signed_response_alg,
        backchannel_logout_uri, backchannel_logout_session_required,
        frontchannel_logout_uri, frontchannel_logout_session_required,
        allowed_redirect_origins,
        software_id, software_version, requestable_scopes,
        require_pkce,
        initiate_login_uri, login_ui_url,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        client.client_id,
        client.client_secret_hash,
        client.client_name,
        client.description,
        client.tenant_id,
        client.application_type,
        client.trust_group,
        client.trust_group_id,
        client.browser_public_client_mode,
        client.browser_refresh_token_policy,
        client.native_sso_enabled === null ? null : client.native_sso_enabled ? 1 : 0,
        client.native_channel_allowed === null ? null : client.native_channel_allowed ? 1 : 0,
        client.allowed_channels,
        client.device_secret_revoke_enabled === null
          ? null
          : client.device_secret_revoke_enabled
            ? 1
            : 0,
        client.device_secret_revoke_trust_groups,
        client.device_secret_introspection_enabled === null
          ? null
          : client.device_secret_introspection_enabled
            ? 1
            : 0,
        client.device_secret_introspection_trust_groups,
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
        client.claims_parameter_policy,
        client.identity_mapping,
        client.attribute_release_consent,
        client.asc_enabled ? 1 : 0,
        client.asc_protected_request_required ? 1 : 0,
        client.asc_sao_enabled ? 1 : 0,
        client.asc_transformed_claims_enabled ? 1 : 0,
        client.asc_allowed_transformed_claims,
        client.token_exchange_allowed ? 1 : 0,
        client.allowed_subject_token_clients,
        client.allowed_token_exchange_resources,
        client.delegation_mode,
        client.client_credentials_allowed ? 1 : 0,
        client.allowed_scopes,
        client.default_scope,
        client.default_audience,
        client.default_resource,
        client.backchannel_token_delivery_mode,
        client.backchannel_client_notification_endpoint,
        client.backchannel_authentication_request_signing_alg,
        client.backchannel_user_code_parameter ? 1 : 0,
        client.userinfo_signed_response_alg,
        client.backchannel_logout_uri,
        client.backchannel_logout_session_required ? 1 : 0,
        client.frontchannel_logout_uri,
        client.frontchannel_logout_session_required ? 1 : 0,
        client.allowed_redirect_origins,
        client.software_id,
        client.software_version,
        client.requestable_scopes,
        client.require_pkce ? 1 : 0,
        client.initiate_login_uri,
        client.login_ui_url,
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
      'SELECT * FROM oauth_clients WHERE tenant_id = ? AND client_id = ?',
      [this.tenantId, clientId]
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
    if (input.description !== undefined) {
      updates.push('description = ?');
      params.push(input.description);
    }
    if (input.client_secret_hash !== undefined) {
      updates.push('client_secret_hash = ?');
      params.push(input.client_secret_hash);
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
    if (input.claims_parameter_policy !== undefined) {
      updates.push('claims_parameter_policy = ?');
      params.push(
        input.claims_parameter_policy ? JSON.stringify(input.claims_parameter_policy) : null
      );
    }
    if (input.identity_mapping !== undefined) {
      updates.push('identity_mapping = ?');
      params.push(input.identity_mapping ? JSON.stringify(input.identity_mapping) : null);
    }
    if (input.attribute_release_consent !== undefined) {
      updates.push('attribute_release_consent = ?');
      params.push(
        input.attribute_release_consent ? JSON.stringify(input.attribute_release_consent) : null
      );
    }
    if (input.asc_enabled !== undefined) {
      updates.push('asc_enabled = ?');
      params.push(input.asc_enabled ? 1 : 0);
    }
    if (input.asc_protected_request_required !== undefined) {
      updates.push('asc_protected_request_required = ?');
      params.push(input.asc_protected_request_required ? 1 : 0);
    }
    if (input.asc_sao_enabled !== undefined) {
      updates.push('asc_sao_enabled = ?');
      params.push(input.asc_sao_enabled ? 1 : 0);
    }
    if (input.asc_transformed_claims_enabled !== undefined) {
      updates.push('asc_transformed_claims_enabled = ?');
      params.push(input.asc_transformed_claims_enabled ? 1 : 0);
    }
    if (input.asc_allowed_transformed_claims !== undefined) {
      updates.push('asc_allowed_transformed_claims = ?');
      params.push(
        input.asc_allowed_transformed_claims
          ? JSON.stringify(input.asc_allowed_transformed_claims)
          : null
      );
    }
    if (input.application_type !== undefined) {
      updates.push('application_type = ?');
      params.push(input.application_type);
    }
    if (input.trust_group !== undefined) {
      updates.push('trust_group = ?');
      params.push(input.trust_group);
      updates.push('trust_group_id = ?');
      params.push(input.trust_group);
    }
    if (input.trust_group_id !== undefined) {
      updates.push('trust_group_id = ?');
      params.push(input.trust_group_id);
    }
    if (input.browser_public_client_mode !== undefined) {
      updates.push('browser_public_client_mode = ?');
      params.push(input.browser_public_client_mode);
    }
    if (input.browser_refresh_token_policy !== undefined) {
      updates.push('browser_refresh_token_policy = ?');
      params.push(input.browser_refresh_token_policy ?? 'disabled');
    }
    if (input.native_sso_enabled !== undefined) {
      updates.push('native_sso_enabled = ?');
      params.push(input.native_sso_enabled === null ? null : input.native_sso_enabled ? 1 : 0);
    }
    if (input.native_channel_allowed !== undefined) {
      updates.push('native_channel_allowed = ?');
      params.push(
        input.native_channel_allowed === null ? null : input.native_channel_allowed ? 1 : 0
      );
    }
    if (input.allowed_channels !== undefined) {
      updates.push('allowed_channels = ?');
      params.push(input.allowed_channels ? JSON.stringify(input.allowed_channels) : null);
    }
    if (input.device_secret_revoke_enabled !== undefined) {
      updates.push('device_secret_revoke_enabled = ?');
      params.push(
        input.device_secret_revoke_enabled === null
          ? null
          : input.device_secret_revoke_enabled
            ? 1
            : 0
      );
    }
    if (input.device_secret_revoke_trust_groups !== undefined) {
      updates.push('device_secret_revoke_trust_groups = ?');
      params.push(
        input.device_secret_revoke_trust_groups
          ? JSON.stringify(input.device_secret_revoke_trust_groups)
          : null
      );
    }
    if (input.device_secret_introspection_enabled !== undefined) {
      updates.push('device_secret_introspection_enabled = ?');
      params.push(
        input.device_secret_introspection_enabled === null
          ? null
          : input.device_secret_introspection_enabled
            ? 1
            : 0
      );
    }
    if (input.device_secret_introspection_trust_groups !== undefined) {
      updates.push('device_secret_introspection_trust_groups = ?');
      params.push(
        input.device_secret_introspection_trust_groups
          ? JSON.stringify(input.device_secret_introspection_trust_groups)
          : null
      );
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
    if (input.default_resource !== undefined) {
      updates.push('default_resource = ?');
      params.push(input.default_resource);
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
    // OIDC Logout
    if (input.backchannel_logout_uri !== undefined) {
      updates.push('backchannel_logout_uri = ?');
      params.push(input.backchannel_logout_uri);
    }
    if (input.backchannel_logout_session_required !== undefined) {
      updates.push('backchannel_logout_session_required = ?');
      params.push(input.backchannel_logout_session_required ? 1 : 0);
    }
    if (input.frontchannel_logout_uri !== undefined) {
      updates.push('frontchannel_logout_uri = ?');
      params.push(input.frontchannel_logout_uri);
    }
    if (input.frontchannel_logout_session_required !== undefined) {
      updates.push('frontchannel_logout_session_required = ?');
      params.push(input.frontchannel_logout_session_required ? 1 : 0);
    }
    // Custom Redirect URIs (Authrim Extension)
    if (input.allowed_redirect_origins !== undefined) {
      updates.push('allowed_redirect_origins = ?');
      params.push(
        input.allowed_redirect_origins ? JSON.stringify(input.allowed_redirect_origins) : null
      );
    }
    // RFC 7591: Dynamic Client Registration
    if (input.software_id !== undefined) {
      updates.push('software_id = ?');
      params.push(input.software_id);
    }
    if (input.software_version !== undefined) {
      updates.push('software_version = ?');
      params.push(input.software_version);
    }
    if (input.requestable_scopes !== undefined) {
      updates.push('requestable_scopes = ?');
      params.push(input.requestable_scopes ? JSON.stringify(input.requestable_scopes) : null);
    }
    // PKCE (RFC 7636)
    if (input.require_pkce !== undefined) {
      updates.push('require_pkce = ?');
      params.push(input.require_pkce ? 1 : 0);
    }
    // OIDC Dynamic Client Registration
    if (input.initiate_login_uri !== undefined) {
      updates.push('initiate_login_uri = ?');
      params.push(input.initiate_login_uri);
    }
    if (input.login_ui_url !== undefined) {
      updates.push('login_ui_url = ?');
      params.push(input.login_ui_url);
    }

    params.push(this.tenantId, clientId);

    await this.adapter.execute(
      `UPDATE oauth_clients SET ${updates.join(', ')} WHERE tenant_id = ? AND client_id = ?`,
      params
    );

    return this.findByClientId(clientId);
  }

  /**
   * Delete a client
   */
  async delete(clientId: string): Promise<boolean> {
    const result = await this.adapter.execute(
      'DELETE FROM oauth_clients WHERE tenant_id = ? AND client_id = ?',
      [this.tenantId, clientId]
    );
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
      conditions.push(
        "(client_name LIKE ? ESCAPE '\\' OR client_id LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')"
      );
      const searchPattern = `%${escapedSearch}%`;
      params.push(searchPattern, searchPattern, searchPattern);
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
      'SELECT client_id FROM oauth_clients WHERE tenant_id = ? AND client_id = ?',
      [this.tenantId, clientId]
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
      application_type: row.application_type ?? 'web',
      browser_refresh_token_policy: row.browser_refresh_token_policy ?? 'disabled',
      is_trusted: Boolean(row.is_trusted),
      skip_consent: Boolean(row.skip_consent),
      allow_claims_without_scope: Boolean(row.allow_claims_without_scope),
      asc_enabled:
        row.asc_enabled === null || row.asc_enabled === undefined ? true : Boolean(row.asc_enabled),
      asc_protected_request_required:
        row.asc_protected_request_required === null ||
        row.asc_protected_request_required === undefined
          ? true
          : Boolean(row.asc_protected_request_required),
      asc_sao_enabled:
        row.asc_sao_enabled === null || row.asc_sao_enabled === undefined
          ? true
          : Boolean(row.asc_sao_enabled),
      asc_transformed_claims_enabled:
        row.asc_transformed_claims_enabled === null ||
        row.asc_transformed_claims_enabled === undefined
          ? true
          : Boolean(row.asc_transformed_claims_enabled),
      native_sso_enabled:
        row.native_sso_enabled === null || row.native_sso_enabled === undefined
          ? null
          : Boolean(row.native_sso_enabled),
      native_channel_allowed:
        row.native_channel_allowed === null || row.native_channel_allowed === undefined
          ? null
          : Boolean(row.native_channel_allowed),
      device_secret_revoke_enabled:
        row.device_secret_revoke_enabled === null || row.device_secret_revoke_enabled === undefined
          ? null
          : Boolean(row.device_secret_revoke_enabled),
      device_secret_introspection_enabled:
        row.device_secret_introspection_enabled === null ||
        row.device_secret_introspection_enabled === undefined
          ? null
          : Boolean(row.device_secret_introspection_enabled),
      token_exchange_allowed: Boolean(row.token_exchange_allowed),
      client_credentials_allowed: Boolean(row.client_credentials_allowed),
      backchannel_user_code_parameter: Boolean(row.backchannel_user_code_parameter),
      // OIDC Logout
      backchannel_logout_session_required: Boolean(row.backchannel_logout_session_required),
      frontchannel_logout_session_required: Boolean(row.frontchannel_logout_session_required),
      // PKCE (RFC 7636)
      require_pkce: Boolean(row.require_pkce),
    };
  }
}
