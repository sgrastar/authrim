/**
 * OIDC Relying Party Client
 * Implements OIDC Core 1.0 client functionality for external IdP authentication
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
}

/**
 * OIDC Relying Party Client
 */
export class OIDCRPClient {
  private config: OIDCRPClientConfig;
  private metadata?: ProviderMetadata;
  private jwks?: jose.JSONWebKeySet;
  private jwksLastFetch?: number;

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

    this.metadata = (await response.json()) as ProviderMetadata;
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
      throw new Error(`Token exchange failed: ${response.status} - ${errorBody}`);
    }

    return (await response.json()) as TokenResponse;
  }

  /**
   * Fetch JWKS for ID token validation
   */
  private async fetchJWKS(): Promise<jose.JSONWebKeySet> {
    const now = Date.now();
    // Cache JWKS for 1 hour
    if (this.jwks && this.jwksLastFetch && now - this.jwksLastFetch < 3600000) {
      return this.jwks;
    }

    const jwksUri = await this.getJwksUri();
    const response = await fetch(jwksUri);

    if (!response.ok) {
      throw new Error(`Failed to fetch JWKS: ${response.status}`);
    }

    this.jwks = (await response.json()) as jose.JSONWebKeySet;
    this.jwksLastFetch = now;
    return this.jwks;
  }

  /**
   * Validate ID Token signature and claims
   */
  async validateIdToken(idToken: string, nonce: string): Promise<UserInfo> {
    const jwks = await this.fetchJWKS();
    const JWKS = jose.createLocalJWKSet(jwks);

    try {
      const { payload } = await jose.jwtVerify(idToken, JWKS, {
        issuer: this.config.issuer,
        audience: this.config.clientId,
      });

      // Validate nonce
      if (payload.nonce !== nonce) {
        throw new Error('ID token nonce mismatch');
      }

      // Validate expiration
      const now = Math.floor(Date.now() / 1000);
      if (payload.exp && payload.exp < now) {
        throw new Error('ID token expired');
      }

      // Validate iat (issued at) - should not be in the future
      if (payload.iat && payload.iat > now + 60) {
        // Allow 60s clock skew
        throw new Error('ID token issued in the future');
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
        ...payload,
      };
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`ID token validation failed: ${error.message}`);
      }
      throw error;
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

    const userInfo = (await response.json()) as Record<string, unknown>;

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
      throw new Error(`Token refresh failed: ${response.status} - ${errorBody}`);
    }

    return (await response.json()) as TokenResponse;
  }
}
