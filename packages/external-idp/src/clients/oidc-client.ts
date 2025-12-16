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
   */
  static fromProvider(
    provider: UpstreamProvider,
    redirectUri: string,
    clientSecret: string
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
    });
  }

  /**
   * Discover provider metadata from .well-known endpoint
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
   */
  async createAuthorizationUrl(params: {
    state: string;
    nonce: string;
    codeVerifier: string;
    prompt?: string;
    loginHint?: string;
    maxAge?: number;
    acrValues?: string;
  }): Promise<string> {
    const authEndpoint = await this.getAuthorizationEndpoint();
    const codeChallenge = await generateCodeChallenge(params.codeVerifier);

    const url = new URL(authEndpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', this.config.redirectUri);
    url.searchParams.set('scope', this.config.scopes.join(' '));
    url.searchParams.set('state', params.state);
    url.searchParams.set('nonce', params.nonce);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');

    if (params.prompt) {
      url.searchParams.set('prompt', params.prompt);
    }
    if (params.loginHint) {
      url.searchParams.set('login_hint', params.loginHint);
    }
    if (params.maxAge !== undefined) {
      url.searchParams.set('max_age', params.maxAge.toString());
    }
    if (params.acrValues) {
      url.searchParams.set('acr_values', params.acrValues);
    }

    return url.toString();
  }

  /**
   * Exchange authorization code for tokens
   */
  async handleCallback(code: string, codeVerifier: string): Promise<TokenResponse> {
    const tokenEndpoint = await this.getTokenEndpoint();

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.config.redirectUri,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      code_verifier: codeVerifier,
    });

    const response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      // Log full error for debugging but don't include in thrown error
      // errorBody may contain sensitive information from the provider
      console.error(`Token exchange failed: ${response.status}`, {
        status: response.status,
        // Only log first 500 chars to prevent log flooding
        errorPreview: errorBody.substring(0, 500),
      });
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
        console.warn('ID token signature verification failed, refreshing JWKS and retrying...');
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

    // 1. Validate nonce (OIDC Core 3.1.3.7 step 11)
    if (payload.nonce !== options.nonce) {
      throw new Error('ID token nonce mismatch');
    }

    const now = Math.floor(Date.now() / 1000);

    // 2. Validate expiration (OIDC Core 3.1.3.7 step 9)
    if (payload.exp && payload.exp < now) {
      throw new Error('ID token expired');
    }

    // 3. Validate iat (issued at) - should not be in the future (OIDC Core 3.1.3.7 step 10)
    if (payload.iat && payload.iat > now + OIDCRPClient.CLOCK_SKEW_SECONDS) {
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

    return {
      sub: payload.sub as string,
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
      throw new Error(`ID token azp (${azp}) does not match client_id (${this.config.clientId})`);
    }

    // If multiple audiences and no azp, log warning (SHOULD have azp per spec)
    if (isMultipleAudience && azp === undefined) {
      console.warn(
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
    console.warn(`ACR validation passed: returned=${returnedAcr}, requested=${requestedAcrValues}`);
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
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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
      const errorBody = await response.text();
      // Log full error for debugging but don't include in thrown error
      // errorBody may contain sensitive information from the provider
      console.error(`Token refresh failed: ${response.status}`, {
        status: response.status,
        // Only log first 500 chars to prevent log flooding
        errorPreview: errorBody.substring(0, 500),
      });
      throw new Error(`Token refresh failed: HTTP ${response.status}`);
    }

    const tokens: TokenResponse = await response.json();
    return tokens;
  }
}
