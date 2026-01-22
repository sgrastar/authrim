/**
 * OIDC Relying Party Client
 * Implements OIDC Core 1.0 client functionality for external IdP authentication
 *
 * Compliance: OpenID Connect Core 1.0
 * - Section 3.1.3.7: ID Token Validation
 * - Section 3.3.2.11: at_hash validation
 * - Section 3.3.2.12: c_hash validation
 * - RFC 7636: PKCE
 */

import * as jose from 'jose';
import type { ProviderMetadata, TokenResponse, UserInfo, UpstreamProvider } from '../types';
import { generateCodeChallenge } from '../utils/pkce';
import { createLogger } from '@authrim/ar-lib-core';

const log = createLogger().module('OIDC-CLIENT');

export interface OIDCRPClientConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
  // Optional overrides for non-standard providers
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  userinfoEndpoint?: string;
  jwksUri?: string;
  // Provider-specific quirks
  providerQuirks?: Record<string, unknown>;
  // Request Object (JAR - RFC 9101) settings
  /** Whether to use request objects */
  useRequestObject?: boolean;
  /** Algorithm for signing request objects (e.g., RS256) */
  requestObjectSigningAlg?: string;
  /** Private key JWK for signing request objects */
  privateKeyJwk?: jose.JWK;
  /** Key ID for the signing key */
  keyId?: string;
}

/**
 * ID Token validation options
 */
export interface ValidateIdTokenOptions {
  nonce: string;
  /** Access token for at_hash validation (optional, required for implicit/hybrid flow) */
  accessToken?: string;
  /** Authorization code for c_hash validation (optional, required for hybrid flow) */
  code?: string;
  /** max_age parameter sent in authorization request, for auth_time validation */
  maxAge?: number;
  /** acr_values parameter sent in authorization request, for acr validation (space-separated) */
  acrValues?: string;
}

/**
 * OIDC Relying Party Client
 */
export class OIDCRPClient {
  private config: OIDCRPClientConfig;
  private metadata?: ProviderMetadata;
  private jwks?: jose.JSONWebKeySet;
  private jwksLastFetch?: number;

  /** JWKS cache duration: 1 hour */
  private static readonly JWKS_CACHE_TTL = 3600000;
  /** Clock skew tolerance: 60 seconds */
  private static readonly CLOCK_SKEW_SECONDS = 60;

  constructor(config: OIDCRPClientConfig) {
    this.config = config;
  }

  /**
   * Create client from UpstreamProvider configuration
   *
   * @param provider - Upstream provider configuration
   * @param redirectUri - Callback URI for this flow
   * @param clientSecret - Decrypted client secret
   * @param privateKeyJwk - Optional decrypted private key JWK for request object signing
   */
  static fromProvider(
    provider: UpstreamProvider,
    redirectUri: string,
    clientSecret: string,
    privateKeyJwk?: jose.JWK
  ): OIDCRPClient {
    return new OIDCRPClient({
      issuer: provider.issuer || '',
      clientId: provider.clientId,
      clientSecret,
      redirectUri,
      scopes: provider.scopes.split(/[\s,]+/),
      authorizationEndpoint: provider.authorizationEndpoint,
      tokenEndpoint: provider.tokenEndpoint,
      userinfoEndpoint: provider.userinfoEndpoint,
      jwksUri: provider.jwksUri,
      providerQuirks: provider.providerQuirks,
      // Request Object settings
      useRequestObject: provider.useRequestObject,
      requestObjectSigningAlg: provider.requestObjectSigningAlg,
      privateKeyJwk,
      keyId: privateKeyJwk?.kid as string | undefined,
    });
  }

  /**
   * Discover provider metadata from .well-known endpoint
   * Implements OIDC Discovery 1.0 Section 4.3 validation requirements
   */
  async discover(): Promise<ProviderMetadata> {
    if (this.metadata) {
      return this.metadata;
    }

    const discoveryUrl = `${this.config.issuer}/.well-known/openid-configuration`;
    const response = await fetch(discoveryUrl);

    if (!response.ok) {
      throw new Error(`Failed to fetch OIDC discovery document: ${response.status}`);
    }

    const metadata: ProviderMetadata = await response.json();

    // OIDC Discovery 1.0 Section 4.3: Validate issuer
    // The issuer value returned MUST be identical to the Issuer URL used to retrieve the configuration
    if (metadata.issuer !== this.config.issuer) {
      throw new Error(
        `Discovery document issuer mismatch: expected ${this.config.issuer}, got ${metadata.issuer}`
      );
    }

    // Validate required fields (OIDC Discovery 1.0 Section 3)
    if (!metadata.authorization_endpoint) {
      throw new Error('Discovery document missing required authorization_endpoint');
    }
    if (!metadata.token_endpoint) {
      throw new Error('Discovery document missing required token_endpoint');
    }
    if (!metadata.jwks_uri) {
      throw new Error('Discovery document missing required jwks_uri');
    }
    if (!metadata.response_types_supported || metadata.response_types_supported.length === 0) {
      throw new Error('Discovery document missing required response_types_supported');
    }

    this.metadata = metadata;
    return this.metadata;
  }

  /**
   * Get authorization endpoint URL
   */
  private async getAuthorizationEndpoint(): Promise<string> {
    if (this.config.authorizationEndpoint) {
      return this.config.authorizationEndpoint;
    }
    const metadata = await this.discover();
    return metadata.authorization_endpoint;
  }

  /**
   * Get token endpoint URL
   */
  private async getTokenEndpoint(): Promise<string> {
    if (this.config.tokenEndpoint) {
      return this.config.tokenEndpoint;
    }
    const metadata = await this.discover();
    return metadata.token_endpoint;
  }

  /**
   * Get userinfo endpoint URL
   */
  private async getUserinfoEndpoint(): Promise<string | undefined> {
    if (this.config.userinfoEndpoint) {
      return this.config.userinfoEndpoint;
    }
    const metadata = await this.discover();
    return metadata.userinfo_endpoint;
  }

  /**
   * Get JWKS URI
   */
  private async getJwksUri(): Promise<string> {
    if (this.config.jwksUri) {
      return this.config.jwksUri;
    }
    const metadata = await this.discover();
    return metadata.jwks_uri;
  }

  /**
   * Create authorization URL with PKCE
   * Supports both plain query parameters and signed request objects (JAR - RFC 9101)
   */
  async createAuthorizationUrl(params: {
    state: string;
    nonce: string;
    codeVerifier: string;
    prompt?: string;
    loginHint?: string;
    maxAge?: number;
    acrValues?: string;
    responseMode?: string; // 'query' | 'fragment' | 'form_post'
  }): Promise<string> {
    const authEndpoint = await this.getAuthorizationEndpoint();
    const codeChallenge = await generateCodeChallenge(params.codeVerifier);

    // Build authorization parameters
    const authParams: Record<string, string> = {
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      scope: this.config.scopes.join(' '),
      state: params.state,
      nonce: params.nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    };

    if (params.prompt) {
      authParams.prompt = params.prompt;
    }
    if (params.loginHint) {
      authParams.login_hint = params.loginHint;
    }
    if (params.maxAge !== undefined) {
      authParams.max_age = params.maxAge.toString();
    }
    if (params.acrValues) {
      authParams.acr_values = params.acrValues;
    }
    if (params.responseMode) {
      authParams.response_mode = params.responseMode;
    }

    // If request object is enabled, create a signed JWT
    if (this.config.useRequestObject && this.config.privateKeyJwk) {
      const requestObject = await this.createRequestObject(authParams);
      const url = new URL(authEndpoint);
      // RFC 9101: When using request parameter, client_id is still required in URL
      url.searchParams.set('client_id', this.config.clientId);
      url.searchParams.set('request', requestObject);
      return url.toString();
    }

    // Standard: Use query parameters
    const url = new URL(authEndpoint);
    for (const [key, value] of Object.entries(authParams)) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  /**
   * Create a signed Request Object JWT (RFC 9101 - JAR)
   *
   * The request object contains all authorization request parameters
   * as JWT claims, signed by the client's private key.
   *
   * @param params - Authorization request parameters to include in the JWT
   * @returns Signed JWT string
   */
  private async createRequestObject(params: Record<string, string>): Promise<string> {
    if (!this.config.privateKeyJwk) {
      throw new Error('Private key required for request object signing');
    }

    const alg = this.config.requestObjectSigningAlg || 'RS256';
    const privateKey = await jose.importJWK(this.config.privateKeyJwk, alg);

    // Build JWT payload from authorization parameters
    const payload: Record<string, unknown> = {
      ...params,
      // RFC 9101 Section 4: iss MUST be the client_id
      iss: this.config.clientId,
      // RFC 9101 Section 4: aud MUST be the OP's issuer
      aud: this.config.issuer,
      // Add timestamps for security
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300, // 5 minutes validity
      // Optional: Add jti for replay protection
      jti: crypto.randomUUID(),
    };

    // Build protected header
    const header: jose.JWTHeaderParameters = {
      alg,
      typ: 'oauth-authz-req+jwt', // RFC 9101 Section 5.1
    };

    // Add kid if available
    if (this.config.keyId) {
      header.kid = this.config.keyId;
    }

    // Sign the JWT
    const jwt = await new jose.SignJWT(payload).setProtectedHeader(header).sign(privateKey);

    return jwt;
  }

  /**
   * Exchange authorization code for tokens
   *
   * Supports two authentication modes:
   * 1. Standard: client_id and client_secret in request body (default)
   * 2. Basic Auth: Base64-encoded credentials in Authorization header (Twitter/X)
   *
   * The authentication mode is determined by providerQuirks.useBasicAuth
   */
  async handleCallback(code: string, codeVerifier: string): Promise<TokenResponse> {
    const tokenEndpoint = await this.getTokenEndpoint();

    // Check if provider requires Basic authentication (e.g., Twitter)
    const quirks = this.config.providerQuirks as { useBasicAuth?: boolean } | undefined;
    const useBasicAuth = quirks?.useBasicAuth === true;

    // Build request body
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.config.redirectUri,
      code_verifier: codeVerifier,
    });

    // Build headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
    };

    if (useBasicAuth) {
      // RFC 6749 Section 2.3.1: HTTP Basic authentication
      // The client_id and client_secret MUST be URL-encoded BEFORE Base64 encoding
      // (per RFC 6749 Appendix B: application/x-www-form-urlencoded encoding)
      // IMPORTANT: Do NOT include client_id in body when using Basic auth
      // (RFC 6749 Section 2.3: "The client MUST NOT use more than one authentication method")
      const encodedClientId = encodeURIComponent(this.config.clientId);
      const encodedClientSecret = encodeURIComponent(this.config.clientSecret);
      const credentials = btoa(`${encodedClientId}:${encodedClientSecret}`);
      headers['Authorization'] = `Basic ${credentials}`;
    } else {
      // Standard: Include credentials in request body
      body.set('client_id', this.config.clientId);
      body.set('client_secret', this.config.clientSecret);
    }

    const response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers,
      body: body.toString(),
    });

    if (!response.ok) {
      // PII Protection: Do not log response body (may contain sensitive information from provider)
      // Only log HTTP status code for debugging
      log.error('Token exchange failed', { status: response.status });
      throw new Error(`Token exchange failed: HTTP ${response.status}`);
    }

    const tokens: TokenResponse = await response.json();
    return tokens;
  }

  /**
   * Fetch JWKS for ID token validation
   * @param forceRefresh - Force refresh even if cache is valid (for key rotation)
   */
  private async fetchJWKS(forceRefresh = false): Promise<jose.JSONWebKeySet> {
    const now = Date.now();

    // Return cached JWKS if still valid and not forcing refresh
    if (
      !forceRefresh &&
      this.jwks &&
      this.jwksLastFetch &&
      now - this.jwksLastFetch < OIDCRPClient.JWKS_CACHE_TTL
    ) {
      return this.jwks;
    }

    const jwksUri = await this.getJwksUri();
    const response = await fetch(jwksUri);

    if (!response.ok) {
      throw new Error(`Failed to fetch JWKS: ${response.status}`);
    }

    const jwks: jose.JSONWebKeySet = await response.json();
    this.jwks = jwks;
    this.jwksLastFetch = now;
    return this.jwks;
  }

  /**
   * Force refresh JWKS cache
   * Call this after signature verification failure to handle key rotation
   */
  clearJWKSCache(): void {
    this.jwks = undefined;
    this.jwksLastFetch = undefined;
  }

  /**
   * Validate ID Token signature and claims
   * Implements OIDC Core 1.0 Section 3.1.3.7 (ID Token Validation)
   *
   * @param idToken - The ID token to validate
   * @param options - Validation options including nonce, accessToken, code, maxAge
   */
  async validateIdToken(idToken: string, options: ValidateIdTokenOptions): Promise<UserInfo>;
  /**
   * @deprecated Use validateIdToken(idToken, options) instead
   */
  async validateIdToken(idToken: string, nonce: string): Promise<UserInfo>;
  async validateIdToken(
    idToken: string,
    optionsOrNonce: ValidateIdTokenOptions | string
  ): Promise<UserInfo> {
    // Support legacy signature for backwards compatibility
    const options: ValidateIdTokenOptions =
      typeof optionsOrNonce === 'string' ? { nonce: optionsOrNonce } : optionsOrNonce;

    try {
      return await this.validateIdTokenInternal(idToken, options, false);
    } catch (error) {
      // If signature verification fails, try refreshing JWKS (key rotation support)
      if (
        error instanceof Error &&
        (error.message.includes('signature') ||
          error.message.includes('JWS') ||
          error.message.includes('key'))
      ) {
        log.warn('ID token signature verification failed, refreshing JWKS and retrying...');
        this.clearJWKSCache();
        return await this.validateIdTokenInternal(idToken, options, true);
      }
      throw error;
    }
  }

  /**
   * Internal ID token validation implementation
   */
  private async validateIdTokenInternal(
    idToken: string,
    options: ValidateIdTokenOptions,
    forceJwksRefresh: boolean
  ): Promise<UserInfo> {
    const jwks = await this.fetchJWKS(forceJwksRefresh);
    const JWKS = jose.createLocalJWKSet(jwks);

    // Check if we need pattern-based issuer validation (e.g., Microsoft multi-tenant)
    const usePatternValidation = this.requiresPatternIssuerValidation();

    const { payload, protectedHeader } = await jose.jwtVerify(idToken, JWKS, {
      // Skip issuer validation here if using pattern-based validation
      issuer: usePatternValidation ? undefined : this.config.issuer,
      audience: this.config.clientId,
    });

    // Perform pattern-based issuer validation for Microsoft multi-tenant
    if (usePatternValidation) {
      this.validateMicrosoftIssuer(payload.iss);
    }

    // Explicit validation of REQUIRED claims (OIDC Core Section 2)
    // Note: jose.jwtVerify validates iss/aud match, but we add explicit presence checks
    // for defense in depth and clearer error messages
    if (!payload.iss || typeof payload.iss !== 'string') {
      throw new Error('ID token missing required iss claim');
    }
    if (!payload.aud) {
      throw new Error('ID token missing required aud claim');
    }

    // 1. Validate nonce (OIDC Core 3.1.3.7 step 11)
    if (payload.nonce !== options.nonce) {
      throw new Error('ID token nonce mismatch');
    }

    const now = Math.floor(Date.now() / 1000);

    // 2. Validate expiration - REQUIRED claim (OIDC Core Section 2)
    if (payload.exp === undefined || payload.exp === null) {
      throw new Error('ID token missing required exp claim');
    }
    // Token must not be expired (OIDC Core 3.1.3.7 step 9)
    if (payload.exp < now) {
      throw new Error('ID token expired');
    }

    // 3. Validate iat (issued at) - REQUIRED claim (OIDC Core Section 2)
    if (payload.iat === undefined || payload.iat === null) {
      throw new Error('ID token missing required iat claim');
    }
    // Should not be in the future (OIDC Core 3.1.3.7 step 10)
    if (payload.iat > now + OIDCRPClient.CLOCK_SKEW_SECONDS) {
      throw new Error('ID token issued in the future');
    }

    // 4. Validate azp (authorized party) - OIDC Core 3.1.3.7 step 5, 6
    this.validateAzp(payload);

    // 5. Validate auth_time if max_age was requested (OIDC Core 3.1.3.7 step 11)
    if (options.maxAge !== undefined) {
      this.validateAuthTime(payload, options.maxAge, now);
    }

    // 6. Validate at_hash if access_token provided (OIDC Core 3.3.2.11)
    if (options.accessToken && payload.at_hash) {
      await this.validateTokenHash(
        payload.at_hash as string,
        options.accessToken,
        protectedHeader.alg,
        'at_hash'
      );
    }

    // 7. Validate c_hash if code provided (OIDC Core 3.3.2.12)
    if (options.code && payload.c_hash) {
      await this.validateTokenHash(
        payload.c_hash as string,
        options.code,
        protectedHeader.alg,
        'c_hash'
      );
    }

    // 8. Validate acr if acr_values was requested (OIDC Core 3.1.2.1)
    if (options.acrValues) {
      this.validateAcr(payload, options.acrValues);
    }

    // 9. Validate sub claim is present (OIDC Core Section 2 - REQUIRED)
    if (!payload.sub || typeof payload.sub !== 'string' || payload.sub.trim() === '') {
      throw new Error('ID token missing required sub claim');
    }

    return {
      sub: payload.sub,
      email: payload.email as string | undefined,
      email_verified: payload.email_verified as boolean | undefined,
      name: payload.name as string | undefined,
      given_name: payload.given_name as string | undefined,
      family_name: payload.family_name as string | undefined,
      picture: payload.picture as string | undefined,
      locale: payload.locale as string | undefined,
      auth_time: payload.auth_time as number | undefined,
      acr: payload.acr as string | undefined,
      amr: payload.amr as string[] | undefined,
      ...payload,
    };
  }

  /**
   * Validate azp (authorized party) claim
   * OIDC Core 3.1.3.7 steps 5 and 6:
   * - If aud contains multiple values, azp SHOULD be present
   * - If azp is present, it MUST match the client_id
   */
  private validateAzp(payload: jose.JWTPayload): void {
    const aud = payload.aud;
    const azp = payload.azp as string | undefined;

    // Check if aud is an array with multiple values
    const isMultipleAudience = Array.isArray(aud) && aud.length > 1;

    // If azp is present, it MUST match client_id
    if (azp !== undefined && azp !== this.config.clientId) {
      // SECURITY: Do not expose azp or client_id values in error
      throw new Error('ID token azp does not match expected client_id');
    }

    // If multiple audiences and no azp, log warning (SHOULD have azp per spec)
    if (isMultipleAudience && azp === undefined) {
      log.warn(
        'ID token has multiple audiences but no azp claim. ' +
          'This is allowed but not recommended per OIDC Core 3.1.3.7 step 5.'
      );
    }
  }

  /**
   * Validate auth_time claim when max_age was requested
   * OIDC Core 3.1.3.7 step 11:
   * If max_age was sent, auth_time MUST be present and the elapsed time
   * since authentication MUST NOT exceed max_age seconds
   */
  private validateAuthTime(payload: jose.JWTPayload, maxAge: number, now: number): void {
    const authTime = payload.auth_time as number | undefined;

    if (authTime === undefined) {
      throw new Error('ID token missing auth_time claim (required when max_age is requested)');
    }

    // Check if authentication is too old
    const authAge = now - authTime;
    // Allow clock skew tolerance
    if (authAge > maxAge + OIDCRPClient.CLOCK_SKEW_SECONDS) {
      throw new Error(
        `Authentication is too old: auth_time was ${authAge} seconds ago, max_age is ${maxAge}`
      );
    }
  }

  /**
   * Validate acr (Authentication Context Class Reference) claim
   * OIDC Core 3.1.2.1:
   * - acr_values is a voluntary claim request (space-separated list)
   * - If the IdP returns an acr that doesn't match any requested value,
   *   the RP decides whether to accept the authentication
   * - For security, we reject if acr_values was requested but not satisfied
   *
   * @param payload - JWT payload
   * @param requestedAcrValues - Space-separated list of requested acr values
   */
  private validateAcr(payload: jose.JWTPayload, requestedAcrValues: string): void {
    const returnedAcr = payload.acr as string | undefined;
    const requestedValues = requestedAcrValues.split(/\s+/).filter((v) => v.length > 0);

    // If no acr_values were actually requested, nothing to validate
    if (requestedValues.length === 0) {
      return;
    }

    // If IdP didn't return an acr claim, reject the authentication
    // (acr_values was requested, indicating the RP requires a specific authentication level)
    if (!returnedAcr) {
      throw new Error(
        `ID token missing acr claim. Requested acr_values: ${requestedValues.join(', ')}`
      );
    }

    // Check if the returned acr matches any of the requested values
    if (!requestedValues.includes(returnedAcr)) {
      throw new Error(
        `ID token acr (${returnedAcr}) does not match any requested acr_values: ${requestedValues.join(', ')}`
      );
    }

    // ACR is valid - log for audit purposes
    log.info('ACR validation passed', { returnedAcr, requestedAcrValues });
  }

  /**
   * Validate token hash (at_hash or c_hash)
   * OIDC Core 3.3.2.11 (at_hash) and 3.3.2.12 (c_hash):
   * Hash is the left-most half of the hash of the octets of the ASCII representation
   * of the token/code value, using the hash algorithm from the alg header.
   *
   * @param expectedHash - The hash value from the ID token
   * @param tokenValue - The access_token or code to hash
   * @param alg - The algorithm from the JWT header (e.g., RS256)
   * @param hashName - Name for error messages ('at_hash' or 'c_hash')
   */
  private async validateTokenHash(
    expectedHash: string,
    tokenValue: string,
    alg: string,
    hashName: string
  ): Promise<void> {
    // Determine hash algorithm based on signing algorithm
    // RS256, ES256, PS256 -> SHA-256
    // RS384, ES384, PS384 -> SHA-384
    // RS512, ES512, PS512 -> SHA-512
    const hashAlg = this.getHashAlgorithm(alg);

    // Hash the token value
    const encoder = new TextEncoder();
    const data = encoder.encode(tokenValue);
    const hashBuffer = await crypto.subtle.digest(hashAlg, data);

    // Take the left-most half
    const hashArray = new Uint8Array(hashBuffer);
    const leftHalf = hashArray.slice(0, hashArray.length / 2);

    // Base64url encode
    const computedHash = this.base64UrlEncode(leftHalf);

    if (computedHash !== expectedHash) {
      throw new Error(
        `${hashName} validation failed: computed ${computedHash}, expected ${expectedHash}`
      );
    }
  }

  /**
   * Get the hash algorithm corresponding to the JWT signing algorithm
   */
  private getHashAlgorithm(alg: string): string {
    // Extract the bit size from the algorithm name
    const match = alg.match(/(\d{3})$/);
    if (!match) {
      // Default to SHA-256 for unknown algorithms
      return 'SHA-256';
    }

    const bits = match[1];
    switch (bits) {
      case '256':
        return 'SHA-256';
      case '384':
        return 'SHA-384';
      case '512':
        return 'SHA-512';
      default:
        return 'SHA-256';
    }
  }

  /**
   * Base64URL encode a Uint8Array
   */
  private base64UrlEncode(buffer: Uint8Array): string {
    const base64 = btoa(String.fromCharCode(...buffer));
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/[=]+$/, '');
  }

  /**
   * Check if pattern-based issuer validation is needed
   *
   * Microsoft "common", "consumers", and "organizations" endpoints return tokens
   * with tenant-specific issuers, not the generic endpoint issuer.
   */
  private requiresPatternIssuerValidation(): boolean {
    const quirks = this.config.providerQuirks as { tenantType?: string } | undefined;
    const tenantType = quirks?.tenantType;

    // SECURITY: Use startsWith to prevent subdomain/path attacks
    // e.g., "https://evil.com/login.microsoftonline.com/..." would fail
    const isMicrosoftIssuer = this.config.issuer.startsWith('https://login.microsoftonline.com/');

    return (
      isMicrosoftIssuer &&
      (tenantType === 'common' || tenantType === 'consumers' || tenantType === 'organizations')
    );
  }

  /**
   * Validate Microsoft issuer pattern
   * For multi-tenant endpoints, the token issuer contains the actual tenant ID
   */
  private validateMicrosoftIssuer(issuer: string | undefined): void {
    if (!issuer) {
      throw new Error('Missing issuer claim in ID token');
    }

    // Token issuer must be a valid Microsoft issuer URL
    // Pattern: https://login.microsoftonline.com/{tenant-id}/v2.0
    const microsoftIssuerPattern = /^https:\/\/login\.microsoftonline\.com\/[a-f0-9-]+\/v2\.0$/i;

    if (!microsoftIssuerPattern.test(issuer)) {
      throw new Error(`Invalid Microsoft issuer: ${issuer}`);
    }
  }

  /**
   * Fetch user info from userinfo endpoint
   */
  async fetchUserInfo(accessToken: string): Promise<UserInfo> {
    const userinfoEndpoint = await this.getUserinfoEndpoint();

    if (!userinfoEndpoint) {
      throw new Error('Userinfo endpoint not available');
    }

    const response = await fetch(userinfoEndpoint, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Userinfo request failed: ${response.status}`);
    }

    const userInfo: Record<string, unknown> = await response.json();

    // Validate sub claim is present (OIDC Core Section 5.3.2 - REQUIRED)
    if (
      !userInfo.sub ||
      typeof userInfo.sub !== 'string' ||
      (userInfo.sub as string).trim() === ''
    ) {
      throw new Error('Userinfo response missing required sub claim');
    }

    return {
      sub: userInfo.sub as string,
      email: userInfo.email as string | undefined,
      email_verified: userInfo.email_verified as boolean | undefined,
      name: userInfo.name as string | undefined,
      given_name: userInfo.given_name as string | undefined,
      family_name: userInfo.family_name as string | undefined,
      picture: userInfo.picture as string | undefined,
      locale: userInfo.locale as string | undefined,
      ...userInfo,
    };
  }

  /**
   * Refresh tokens using refresh token
   */
  async refreshTokens(refreshToken: string): Promise<TokenResponse> {
    const tokenEndpoint = await this.getTokenEndpoint();

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    });

    const response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    if (!response.ok) {
      // Consume body to properly close connection (body may contain sensitive data from provider)
      await response.text();
      // Security: Only log HTTP status code (safe), not response body
      log.error('Token refresh failed', { status: response.status });
      throw new Error(`Token refresh failed: HTTP ${response.status}`);
    }

    const tokens: TokenResponse = await response.json();
    return tokens;
  }
}
