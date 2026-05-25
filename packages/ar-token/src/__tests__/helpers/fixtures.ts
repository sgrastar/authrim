/**
 * Test Fixtures for ar-token Tests
 *
 * Provides reusable test data for:
 * - Client metadata
 * - User data
 * - Token payloads
 * - Authorization code data
 * - Request bodies
 */

import type {
  ClientMetadata,
  TokenTypeURN,
  ActClaim,
  DelegationMode,
  JWKS,
} from '@authrim/ar-lib-core';

// ============================================================================
// Client Metadata Fixtures
// ============================================================================

/**
 * Base client metadata with common fields
 */
export interface TestClientMetadata extends Partial<ClientMetadata> {
  client_id: string;
  tenant_id?: string;
  client_secret_hash?: string;
  redirect_uris?: string[];
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
  trust_group?: string;
  trust_group_id?: string;
  native_channel_allowed?: boolean;
  allowed_channels?: Array<'browser' | 'native' | 'server'>;
  allowed_scopes?: string[];
  default_scope?: string;
  default_audience?: string;
  client_credentials_allowed?: boolean;
  dpop_bound_access_tokens?: boolean;
  require_pkce?: boolean;
  id_token_signed_response_alg?: string;
  id_token_encrypted_response_alg?: string;
  id_token_encrypted_response_enc?: string;
  jwks_uri?: string;
  jwks?: JWKS;
}

/**
 * Create a confidential client with client_secret_basic auth
 */
export function createConfidentialClient(
  overrides?: Partial<TestClientMetadata>
): TestClientMetadata {
  return {
    client_id: 'confidential-client-001',
    tenant_id: 'default',
    client_secret_hash: 'hashed-secret-value',
    redirect_uris: ['https://app.example.com/callback'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'client_secret_basic',
    allowed_scopes: ['openid', 'profile', 'email'],
    default_scope: 'openid',
    default_resource: 'svc://confidential-api',
    require_pkce: true,
    ...overrides,
  };
}

/**
 * Create a public client (SPA/Mobile)
 */
export function createPublicClient(overrides?: Partial<TestClientMetadata>): TestClientMetadata {
  return {
    client_id: 'public-client-001',
    tenant_id: 'default',
    redirect_uris: ['https://spa.example.com/callback', 'myapp://callback'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    allowed_scopes: ['openid', 'profile'],
    default_scope: 'openid',
    default_resource: 'svc://public-api',
    require_pkce: true, // PKCE is mandatory for public clients
    ...overrides,
  };
}

/**
 * Create an M2M client for client_credentials grant
 */
export function createM2MClient(overrides?: Partial<TestClientMetadata>): TestClientMetadata {
  return {
    client_id: 'm2m-service-client-001',
    tenant_id: 'default',
    client_secret_hash: 'hashed-m2m-secret',
    grant_types: ['client_credentials'],
    response_types: [],
    token_endpoint_auth_method: 'client_secret_basic',
    allowed_scopes: ['api:read', 'api:write', 'admin'],
    default_scope: 'api:read',
    default_resource: 'svc://m2m-api',
    client_credentials_allowed: true,
    ...overrides,
  };
}

/**
 * Create a client with private_key_jwt authentication
 */
export function createPrivateKeyJwtClient(
  overrides?: Partial<TestClientMetadata>
): TestClientMetadata {
  return {
    client_id: 'private-key-jwt-client-001',
    tenant_id: 'default',
    redirect_uris: ['https://secure-app.example.com/callback'],
    grant_types: ['authorization_code', 'refresh_token', 'client_credentials'],
    response_types: ['code'],
    token_endpoint_auth_method: 'private_key_jwt',
    allowed_scopes: ['openid', 'profile', 'email', 'api:admin'],
    default_resource: 'svc://private-key-jwt-api',
    require_pkce: true,
    jwks_uri: 'https://secure-app.example.com/.well-known/jwks.json',
    ...overrides,
  };
}

/**
 * Create a FAPI-compliant client (DPoP required)
 */
export function createFAPIClient(overrides?: Partial<TestClientMetadata>): TestClientMetadata {
  return {
    client_id: 'fapi-client-001',
    tenant_id: 'default',
    client_secret_hash: 'hashed-fapi-secret',
    redirect_uris: ['https://fapi-app.example.com/callback'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'private_key_jwt',
    allowed_scopes: ['openid', 'profile', 'accounts', 'payments'],
    default_resource: 'svc://fapi-api',
    require_pkce: true,
    dpop_bound_access_tokens: true, // Sender-constrained tokens
    id_token_signed_response_alg: 'PS256',
    ...overrides,
  };
}

/**
 * Create a client configured for token exchange
 */
export function createTokenExchangeClient(
  overrides?: Partial<TestClientMetadata>
): TestClientMetadata {
  return {
    client_id: 'token-exchange-client-001',
    tenant_id: 'default',
    client_secret_hash: 'hashed-te-secret',
    grant_types: ['urn:ietf:params:oauth:grant-type:token-exchange'],
    response_types: [],
    token_endpoint_auth_method: 'client_secret_basic',
    allowed_scopes: ['openid', 'profile', 'api:read'],
    default_resource: 'svc://token-exchange-api',
    ...overrides,
  };
}

/**
 * Create a client configured for device flow
 */
export function createDeviceFlowClient(
  overrides?: Partial<TestClientMetadata>
): TestClientMetadata {
  return {
    client_id: 'device-client-001',
    tenant_id: 'default',
    grant_types: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
    response_types: [],
    token_endpoint_auth_method: 'none', // Browserless devices often don't have secrets
    allowed_scopes: ['openid', 'profile', 'tv:watch'],
    default_resource: 'svc://device-api',
    ...overrides,
  };
}

/**
 * Create a client configured for CIBA
 */
export function createCIBAClient(overrides?: Partial<TestClientMetadata>): TestClientMetadata {
  return {
    client_id: 'ciba-client-001',
    tenant_id: 'default',
    client_secret_hash: 'hashed-ciba-secret',
    grant_types: ['urn:openid:params:grant-type:ciba'],
    response_types: [],
    token_endpoint_auth_method: 'client_secret_basic',
    allowed_scopes: ['openid', 'profile', 'payment'],
    default_resource: 'svc://ciba-api',
    ...overrides,
  };
}

/**
 * Create a client with ID token encryption enabled
 */
export function createEncryptedIdTokenClient(
  overrides?: Partial<TestClientMetadata>
): TestClientMetadata {
  return {
    client_id: 'encrypted-client-001',
    tenant_id: 'default',
    client_secret_hash: 'hashed-enc-secret',
    redirect_uris: ['https://encrypted-app.example.com/callback'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'client_secret_basic',
    allowed_scopes: ['openid', 'profile'],
    default_resource: 'svc://encrypted-api',
    id_token_encrypted_response_alg: 'RSA-OAEP-256',
    id_token_encrypted_response_enc: 'A256GCM',
    jwks_uri: 'https://encrypted-app.example.com/.well-known/jwks.json',
    ...overrides,
  };
}

// ============================================================================
// User Data Fixtures
// ============================================================================

/**
 * User data structure for tests
 */
export interface TestUserData {
  id: string;
  email: string;
  email_verified: boolean;
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
  locale?: string;
  roles?: string[];
  permissions?: string[];
  created_at?: number;
  updated_at?: number;
}

/**
 * Create a basic user
 */
export function createBasicUser(overrides?: Partial<TestUserData>): TestUserData {
  return {
    id: 'user-001',
    email: 'user@example.com',
    email_verified: true,
    name: 'Test User',
    given_name: 'Test',
    family_name: 'User',
    locale: 'en-US',
    created_at: Math.floor(Date.now() / 1000) - 86400,
    updated_at: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

/**
 * Create an admin user with elevated permissions
 */
export function createAdminUser(overrides?: Partial<TestUserData>): TestUserData {
  return {
    id: 'admin-001',
    email: 'admin@example.com',
    email_verified: true,
    name: 'Admin User',
    given_name: 'Admin',
    family_name: 'User',
    roles: ['admin', 'user'],
    permissions: ['users:read', 'users:write', 'system:admin'],
    ...overrides,
  };
}

/**
 * Create an unverified user
 */
export function createUnverifiedUser(overrides?: Partial<TestUserData>): TestUserData {
  return {
    id: 'unverified-001',
    email: 'unverified@example.com',
    email_verified: false,
    name: 'Unverified User',
    ...overrides,
  };
}

// ============================================================================
// Authorization Code Data Fixtures
// ============================================================================

/**
 * Authorization code store response structure
 */
export interface TestAuthCodeData {
  userId: string;
  scope: string;
  redirectUri: string;
  nonce?: string;
  state?: string;
  createdAt?: number;
  claims?: string; // JSON string
  authTime?: number;
  acr?: string;
  amr?: string[];
  cHash?: string;
  dpopJkt?: string;
  sid?: string;
  authorizationDetails?: string; // JSON string
  replayAttack?: {
    accessTokenJti?: string;
    refreshTokenJti?: string;
  };
}

/**
 * Create a basic authorization code data
 */
export function createAuthCodeData(overrides?: Partial<TestAuthCodeData>): TestAuthCodeData {
  const now = Math.floor(Date.now() / 1000);
  return {
    userId: 'user-001',
    scope: 'openid profile',
    redirectUri: 'https://app.example.com/callback',
    nonce: 'nonce-' + Math.random().toString(36).substring(7),
    state: 'state-' + Math.random().toString(36).substring(7),
    createdAt: now,
    authTime: now - 60, // Authenticated 1 minute ago
    acr: 'urn:mace:incommon:iap:silver',
    sid: 'session-' + Math.random().toString(36).substring(7),
    ...overrides,
  };
}

/**
 * Create authorization code data with DPoP binding
 */
export function createDPoPBoundAuthCodeData(
  overrides?: Partial<TestAuthCodeData>
): TestAuthCodeData {
  return createAuthCodeData({
    dpopJkt: 'dpop-thumbprint-' + Math.random().toString(36).substring(7),
    ...overrides,
  });
}

/**
 * Create authorization code data for replay attack scenario
 */
export function createReplayAttackAuthCodeData(
  overrides?: Partial<TestAuthCodeData>
): TestAuthCodeData {
  return createAuthCodeData({
    replayAttack: {
      accessTokenJti: 'at-jti-already-issued',
      refreshTokenJti: 'rt-jti-already-issued',
    },
    ...overrides,
  });
}

// ============================================================================
// Token Payload Fixtures
// ============================================================================

/**
 * Access token payload structure
 */
export interface TestAccessTokenPayload {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  jti: string;
  scope?: string;
  client_id?: string;
  azp?: string;
  cnf?: { jkt?: string };
  act?: ActClaim;
  permissions?: string[];
  roles?: string[];
}

/**
 * Create a basic access token payload
 */
export function createAccessTokenPayload(
  overrides?: Partial<TestAccessTokenPayload>
): TestAccessTokenPayload {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: 'https://auth.example.com',
    sub: 'user-001',
    aud: 'https://api.example.com',
    exp: now + 3600, // 1 hour
    iat: now,
    jti: 'at-' + Math.random().toString(36).substring(7),
    scope: 'openid profile',
    client_id: 'confidential-client-001',
    ...overrides,
  };
}

/**
 * Create a DPoP-bound access token payload
 */
export function createDPoPBoundAccessTokenPayload(
  overrides?: Partial<TestAccessTokenPayload>
): TestAccessTokenPayload {
  return createAccessTokenPayload({
    cnf: { jkt: 'dpop-thumbprint-value' },
    ...overrides,
  });
}

/**
 * Create a delegated access token payload (Token Exchange)
 */
export function createDelegatedAccessTokenPayload(
  overrides?: Partial<TestAccessTokenPayload>
): TestAccessTokenPayload {
  return createAccessTokenPayload({
    act: {
      sub: 'client:service-a',
      client_id: 'service-a',
    },
    ...overrides,
  });
}

/**
 * ID token payload structure
 */
export interface TestIDTokenPayload {
  iss: string;
  sub: string;
  aud: string;
  exp: number;
  iat: number;
  auth_time?: number;
  nonce?: string;
  acr?: string;
  amr?: string[];
  azp?: string;
  at_hash?: string;
  c_hash?: string;
  ds_hash?: string;
  sid?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
  locale?: string;
}

/**
 * Create a basic ID token payload
 */
export function createIDTokenPayload(overrides?: Partial<TestIDTokenPayload>): TestIDTokenPayload {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: 'https://auth.example.com',
    sub: 'user-001',
    aud: 'confidential-client-001',
    exp: now + 3600,
    iat: now,
    auth_time: now - 60,
    nonce: 'test-nonce',
    acr: 'urn:mace:incommon:iap:silver',
    sid: 'session-id-001',
    ...overrides,
  };
}

/**
 * Refresh token payload structure
 */
export interface TestRefreshTokenPayload {
  iss: string;
  sub: string;
  aud: string;
  exp: number;
  iat: number;
  jti: string;
  scope?: string;
  client_id?: string;
  resource_aud?: string | string[];
  family_id?: string;
  version?: number;
  cnf?: { jkt?: string };
}

/**
 * Create a basic refresh token payload
 */
export function createRefreshTokenPayload(
  overrides?: Partial<TestRefreshTokenPayload>
): TestRefreshTokenPayload {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: 'https://auth.example.com',
    sub: 'user-001',
    aud: 'https://auth.example.com',
    exp: now + 86400 * 30, // 30 days
    iat: now,
    jti: 'rt-' + Math.random().toString(36).substring(7),
    scope: 'openid profile offline_access',
    client_id: 'confidential-client-001',
    family_id: 'family-' + Math.random().toString(36).substring(7),
    version: 1,
    ...overrides,
  };
}

/**
 * Create a test refresh token JWT string (for handler tests)
 * Uses test-kid-001 to match the mock public key
 */
export function createTestRefreshTokenJWT(
  payloadOverrides?: Partial<TestRefreshTokenPayload>,
  headerOverrides?: { kid?: string; alg?: string }
): string {
  const header = {
    alg: 'RS256',
    typ: 'JWT',
    kid: 'test-kid-001', // Must match getMockPublicJWK().kid
    ...headerOverrides,
  };
  const payload = createRefreshTokenPayload(payloadOverrides);

  // Base64URL encode
  const base64UrlEncode = (obj: object): string => {
    const json = JSON.stringify(obj);
    const base64 = Buffer.from(json).toString('base64');
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/[=]/g, '');
  };

  const headerB64 = base64UrlEncode(header);
  const payloadB64 = base64UrlEncode(payload);
  const signatureB64 = base64UrlEncode({ sig: 'test-signature' });

  return `${headerB64}.${payloadB64}.${signatureB64}`;
}

// ============================================================================
// Request Body Fixtures
// ============================================================================

/**
 * Authorization code grant request body
 */
export interface AuthCodeGrantRequest {
  grant_type: 'authorization_code';
  code: string;
  redirect_uri: string;
  client_id?: string;
  client_secret?: string;
  code_verifier?: string;
  client_assertion_type?: string;
  client_assertion?: string;
}

/**
 * Create an authorization code grant request
 */
export function createAuthCodeGrantRequest(
  overrides?: Partial<AuthCodeGrantRequest>
): AuthCodeGrantRequest {
  return {
    grant_type: 'authorization_code',
    code: 'auth-code-' + Math.random().toString(36).substring(7),
    redirect_uri: 'https://app.example.com/callback',
    client_id: 'confidential-client-001',
    code_verifier: 'pkce-verifier-' + Math.random().toString(36).substring(7).repeat(6),
    ...overrides,
  };
}

/**
 * Refresh token grant request body
 */
export interface RefreshTokenGrantRequest {
  grant_type: 'refresh_token';
  refresh_token: string;
  client_id?: string;
  client_secret?: string;
  scope?: string;
}

/**
 * Create a refresh token grant request
 */
export function createRefreshTokenGrantRequest(
  overrides?: Partial<RefreshTokenGrantRequest>
): RefreshTokenGrantRequest {
  return {
    grant_type: 'refresh_token',
    refresh_token: 'rt-' + Math.random().toString(36).substring(7),
    client_id: 'confidential-client-001',
    ...overrides,
  };
}

/**
 * Client credentials grant request body
 */
export interface ClientCredentialsGrantRequest {
  grant_type: 'client_credentials';
  client_id?: string;
  client_secret?: string;
  scope?: string;
  audience?: string;
  client_assertion_type?: string;
  client_assertion?: string;
}

/**
 * Create a client credentials grant request
 */
export function createClientCredentialsGrantRequest(
  overrides?: Partial<ClientCredentialsGrantRequest>
): ClientCredentialsGrantRequest {
  return {
    grant_type: 'client_credentials',
    client_id: 'm2m-service-client-001',
    scope: 'api:read',
    ...overrides,
  };
}

/**
 * Token exchange grant request body
 */
export interface TokenExchangeGrantRequest {
  grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange';
  subject_token: string;
  subject_token_type: TokenTypeURN;
  requested_token_type?: TokenTypeURN;
  actor_token?: string;
  actor_token_type?: TokenTypeURN;
  scope?: string;
  audience?: string;
  resource?: string;
}

/**
 * Create a token exchange grant request
 */
export function createTokenExchangeGrantRequest(
  overrides?: Partial<TokenExchangeGrantRequest>
): TokenExchangeGrantRequest {
  return {
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    subject_token: 'subject-jwt-token',
    subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    scope: 'openid profile',
    ...overrides,
  };
}

/**
 * Device code grant request body
 */
export interface DeviceCodeGrantRequest {
  grant_type: 'urn:ietf:params:oauth:grant-type:device_code';
  device_code: string;
  client_id: string;
}

/**
 * Create a device code grant request
 */
export function createDeviceCodeGrantRequest(
  overrides?: Partial<DeviceCodeGrantRequest>
): DeviceCodeGrantRequest {
  return {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: 'device-code-' + Math.random().toString(36).substring(7),
    client_id: 'device-client-001',
    ...overrides,
  };
}

/**
 * CIBA grant request body
 */
export interface CIBAGrantRequest {
  grant_type: 'urn:openid:params:grant-type:ciba';
  auth_req_id: string;
  client_id?: string;
  client_secret?: string;
}

/**
 * Create a CIBA grant request
 */
export function createCIBAGrantRequest(overrides?: Partial<CIBAGrantRequest>): CIBAGrantRequest {
  return {
    grant_type: 'urn:openid:params:grant-type:ciba',
    auth_req_id: 'ciba-req-' + Math.random().toString(36).substring(7),
    client_id: 'ciba-client-001',
    ...overrides,
  };
}

/**
 * JWT Bearer grant request body
 */
export interface JWTBearerGrantRequest {
  grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer';
  assertion: string;
  scope?: string;
  client_id?: string;
}

/**
 * Create a JWT Bearer grant request
 */
export function createJWTBearerGrantRequest(
  overrides?: Partial<JWTBearerGrantRequest>
): JWTBearerGrantRequest {
  return {
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: 'jwt-assertion-token',
    scope: 'openid profile',
    ...overrides,
  };
}

// ============================================================================
// PKCE Fixtures
// ============================================================================

/**
 * PKCE test values
 */
export interface PKCEValues {
  verifier: string;
  challenge: string;
  method: 'S256' | 'plain';
}

/**
 * Create valid PKCE values for testing
 * Note: These are pre-computed for deterministic testing
 */
export function createPKCEValues(): PKCEValues {
  // Pre-computed valid PKCE pair
  // verifier: 43-128 characters, [A-Z a-z 0-9 - . _ ~]
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  // challenge: SHA256(verifier) base64url-encoded
  const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

  return {
    verifier,
    challenge,
    method: 'S256',
  };
}

/**
 * Create an invalid PKCE verifier (too short)
 */
export function createInvalidPKCEVerifierShort(): string {
  return 'too-short'; // Less than 43 characters
}

/**
 * Create an invalid PKCE verifier (too long)
 */
export function createInvalidPKCEVerifierLong(): string {
  return 'a'.repeat(129); // More than 128 characters
}

/**
 * Create an invalid PKCE verifier (invalid characters)
 */
export function createInvalidPKCEVerifierChars(): string {
  return 'valid-length-but-has-invalid-chars-!@#$%^&*()+='.padEnd(43, 'x');
}

// ============================================================================
// DPoP Fixtures
// ============================================================================

/**
 * DPoP proof structure
 */
export interface DPoPProof {
  typ: 'dpop+jwt';
  alg: 'ES256' | 'RS256';
  jwk: {
    kty: string;
    crv?: string;
    x?: string;
    y?: string;
    n?: string;
    e?: string;
  };
}

/**
 * Create a DPoP proof header
 */
export function createDPoPProofHeader(): DPoPProof {
  return {
    typ: 'dpop+jwt',
    alg: 'ES256',
    jwk: {
      kty: 'EC',
      crv: 'P-256',
      x: 'test-x-coordinate',
      y: 'test-y-coordinate',
    },
  };
}

/**
 * DPoP proof payload
 */
export interface DPoPProofPayload {
  jti: string;
  htm: string;
  htu: string;
  iat: number;
  exp?: number;
  ath?: string; // Access token hash
  nonce?: string;
}

/**
 * Create a DPoP proof payload
 */
export function createDPoPProofPayload(overrides?: Partial<DPoPProofPayload>): DPoPProofPayload {
  const now = Math.floor(Date.now() / 1000);
  return {
    jti: 'dpop-jti-' + Math.random().toString(36).substring(7),
    htm: 'POST',
    htu: 'https://auth.example.com/oauth/token',
    iat: now,
    exp: now + 300, // 5 minutes
    ...overrides,
  };
}

// ============================================================================
// Tenant Profile Fixtures
// ============================================================================

/**
 * Tenant profile structure
 */
export interface TestTenantProfile {
  tenant_id: string;
  name: string;
  issuer_url?: string;
  access_token_ttl?: number;
  id_token_ttl?: number;
  refresh_token_ttl?: number;
  refresh_token_rotation?: boolean;
  refresh_token_reuse_interval?: number;
  fapi_enabled?: boolean;
  native_sso_enabled?: boolean;
  policy_embedding_enabled?: boolean;
}

/**
 * Create a basic tenant profile
 */
export function createTenantProfile(overrides?: Partial<TestTenantProfile>): TestTenantProfile {
  return {
    tenant_id: 'default',
    name: 'Default Tenant',
    issuer_url: 'https://auth.example.com',
    access_token_ttl: 3600, // 1 hour
    id_token_ttl: 3600,
    refresh_token_ttl: 86400 * 30, // 30 days
    refresh_token_rotation: true,
    refresh_token_reuse_interval: 0, // No grace period
    ...overrides,
  };
}

/**
 * Create a FAPI-compliant tenant profile
 */
export function createFAPITenantProfile(overrides?: Partial<TestTenantProfile>): TestTenantProfile {
  return createTenantProfile({
    fapi_enabled: true,
    access_token_ttl: 300, // 5 minutes (FAPI requires short-lived tokens)
    refresh_token_rotation: true,
    ...overrides,
  });
}

// ============================================================================
// System Settings Fixtures
// ============================================================================

/**
 * System settings structure
 */
export interface TestSystemSettings {
  fapi?: {
    enabled?: boolean;
    requireDpop?: boolean;
    requireJarmSignedResponse?: boolean;
  };
  tokenExchange?: {
    enabled?: boolean;
    maxDelegationDepth?: number;
  };
  nativeSso?: {
    enabled?: boolean;
    deviceSecretTtl?: number;
    maxDeviceSecretUses?: number;
  };
  ciba?: {
    enabled?: boolean;
    pollingInterval?: number;
    requestTimeout?: number;
  };
  refreshToken?: {
    rotationEnabled?: boolean;
    reuseInterval?: number;
    detectTheft?: boolean;
  };
}

/**
 * Create default system settings
 */
export function createSystemSettings(overrides?: Partial<TestSystemSettings>): TestSystemSettings {
  return {
    fapi: {
      enabled: false,
      requireDpop: false,
    },
    tokenExchange: {
      enabled: false,
      maxDelegationDepth: 2,
    },
    nativeSso: {
      enabled: false,
      deviceSecretTtl: 86400 * 30,
      maxDeviceSecretUses: 10,
    },
    ciba: {
      enabled: false,
      pollingInterval: 5,
      requestTimeout: 120,
    },
    refreshToken: {
      rotationEnabled: true,
      reuseInterval: 0,
      detectTheft: true,
    },
    ...overrides,
  };
}

// ============================================================================
// Error Response Fixtures
// ============================================================================

/**
 * OAuth error response structure
 */
export interface OAuthErrorResponse {
  error: string;
  error_description?: string;
  error_uri?: string;
}

/**
 * Create common OAuth error responses
 */
export const OAuthErrors = {
  invalidRequest: (description?: string): OAuthErrorResponse => ({
    error: 'invalid_request',
    error_description: description ?? 'The request is missing a required parameter',
  }),
  invalidClient: (description?: string): OAuthErrorResponse => ({
    error: 'invalid_client',
    error_description: description ?? 'Client authentication failed',
  }),
  invalidGrant: (description?: string): OAuthErrorResponse => ({
    error: 'invalid_grant',
    error_description: description ?? 'The provided authorization grant is invalid',
  }),
  unauthorizedClient: (description?: string): OAuthErrorResponse => ({
    error: 'unauthorized_client',
    error_description: description ?? 'The client is not authorized',
  }),
  unsupportedGrantType: (description?: string): OAuthErrorResponse => ({
    error: 'unsupported_grant_type',
    error_description: description ?? 'The authorization grant type is not supported',
  }),
  invalidScope: (description?: string): OAuthErrorResponse => ({
    error: 'invalid_scope',
    error_description: description ?? 'The requested scope is invalid',
  }),
  invalidTarget: (description?: string): OAuthErrorResponse => ({
    error: 'invalid_target',
    error_description: description ?? 'The requested resource is invalid',
  }),
  authorizationPending: (): OAuthErrorResponse => ({
    error: 'authorization_pending',
    error_description: 'The authorization request is still pending',
  }),
  slowDown: (): OAuthErrorResponse => ({
    error: 'slow_down',
    error_description: 'Polling too frequently',
  }),
  expiredToken: (): OAuthErrorResponse => ({
    error: 'expired_token',
    error_description: 'The token has expired',
  }),
  accessDenied: (): OAuthErrorResponse => ({
    error: 'access_denied',
    error_description: 'The resource owner denied the request',
  }),
};

// ============================================================================
// Native SSO Fixtures
// ============================================================================

/**
 * Device secret data structure
 */
export interface TestDeviceSecretData {
  device_secret: string;
  user_id: string;
  client_id: string;
  created_at: number;
  last_used_at: number;
  use_count: number;
  max_uses: number;
  expires_at: number;
}

/**
 * Create device secret data
 */
export function createDeviceSecretData(
  overrides?: Partial<TestDeviceSecretData>
): TestDeviceSecretData {
  const now = Math.floor(Date.now() / 1000);
  return {
    device_secret: 'ds-' + Math.random().toString(36).substring(7),
    user_id: 'user-001',
    client_id: 'confidential-client-001',
    created_at: now,
    last_used_at: now,
    use_count: 0,
    max_uses: 10,
    expires_at: now + 86400 * 30, // 30 days
    ...overrides,
  };
}
