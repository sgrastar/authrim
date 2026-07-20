import { createHash, randomUUID } from 'node:crypto';
import * as jose from 'jose';
import { readResponseTextWithLimit, safeFetch, validateWebhookUrl } from '@authrim/ar-lib-core';

const MAX_RESPONSE_BYTES = 64 * 1024;

export interface Fapi2ClientConfig {
  issuer: string;
  clientId: string;
  redirectUri: string;
  clientAssertionPrivateJwk: jose.JWK;
  dpopPrivateJwk: jose.JWK;
  clientAssertionAlg?: 'ES256' | 'PS256';
}

export interface Fapi2TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
}

export interface Fapi2ParResponse {
  request_uri: string;
  expires_in: number;
}

export interface Fapi2JarmResponse {
  code?: string;
  state: string;
  iss: string;
  error?: string;
  error_description?: string;
}

function assertSafeUrl(value: string, field: string): void {
  const result = validateWebhookUrl(value);
  if (!result.valid) throw new Error(`${field} is not safe to fetch`);
}

function canonicalHtu(value: string): string {
  const url = new URL(value);
  url.search = '';
  url.hash = '';
  return url.toString();
}

function accessTokenHash(accessToken: string): string {
  return createHash('sha256').update(accessToken, 'ascii').digest('base64url');
}

function publicJwk(privateJwk: jose.JWK): jose.JWK {
  const { d: _privateExponent, p: _p, q: _q, dp: _dp, dq: _dq, qi: _qi, ...publicKey } = privateJwk;
  return publicKey;
}

export class Fapi2Client {
  constructor(private readonly config: Fapi2ClientConfig) {}

  async createClientAssertion(audience: string, now = Math.floor(Date.now() / 1000)) {
    const alg = this.config.clientAssertionAlg ?? 'ES256';
    const key = await jose.importJWK(this.config.clientAssertionPrivateJwk, alg);
    return new jose.SignJWT({})
      .setProtectedHeader({
        alg,
        typ: 'JWT',
        ...(this.config.clientAssertionPrivateJwk.kid
          ? { kid: this.config.clientAssertionPrivateJwk.kid }
          : {}),
      })
      .setIssuer(this.config.clientId)
      .setSubject(this.config.clientId)
      .setAudience(audience)
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .setJti(randomUUID())
      .sign(key);
  }

  async createDpopProof(options: {
    url: string;
    method: string;
    accessToken?: string;
    nonce?: string;
    now?: number;
  }): Promise<string> {
    const alg = 'ES256';
    const key = await jose.importJWK(this.config.dpopPrivateJwk, alg);
    const now = options.now ?? Math.floor(Date.now() / 1000);
    return new jose.SignJWT({
      htm: options.method.toUpperCase(),
      htu: canonicalHtu(options.url),
      ...(options.accessToken ? { ath: accessTokenHash(options.accessToken) } : {}),
      ...(options.nonce ? { nonce: options.nonce } : {}),
    })
      .setProtectedHeader({
        typ: 'dpop+jwt',
        alg,
        jwk: publicJwk(this.config.dpopPrivateJwk),
      })
      .setIssuedAt(now)
      .setJti(randomUUID())
      .sign(key);
  }

  async createAuthorizationRequestObject(
    authorizationParams: Record<string, string>,
    now = Math.floor(Date.now() / 1000)
  ): Promise<string> {
    const alg = this.config.clientAssertionAlg ?? 'ES256';
    const key = await jose.importJWK(this.config.clientAssertionPrivateJwk, alg);
    return new jose.SignJWT({
      ...authorizationParams,
      iss: this.config.clientId,
      aud: this.config.issuer,
      jti: randomUUID(),
    })
      .setProtectedHeader({
        alg,
        typ: 'oauth-authz-req+jwt',
        ...(this.config.clientAssertionPrivateJwk.kid
          ? { kid: this.config.clientAssertionPrivateJwk.kid }
          : {}),
      })
      .setIssuedAt(now)
      .setNotBefore(now)
      .setExpirationTime(now + 60)
      .sign(key);
  }

  async validateJarmResponse(options: {
    responseJwt: string;
    jwks: jose.JSONWebKeySet;
    expectedState: string;
    signingAlgorithm: 'ES256' | 'PS256';
  }): Promise<Fapi2JarmResponse> {
    const { payload } = await jose.jwtVerify(
      options.responseJwt,
      jose.createLocalJWKSet(options.jwks),
      {
        issuer: this.config.issuer,
        audience: this.config.clientId,
        algorithms: [options.signingAlgorithm],
        requiredClaims: ['exp'],
        clockTolerance: 60,
      }
    );
    const audience = payload.aud;
    if (
      audience !== this.config.clientId &&
      (!Array.isArray(audience) || audience.length !== 1 || audience[0] !== this.config.clientId)
    ) {
      throw new Error('JARM response audience must contain only the client_id');
    }
    if (payload.state !== options.expectedState) {
      throw new Error('JARM response state mismatch');
    }
    if (typeof payload.iss !== 'string') throw new Error('JARM response missing iss');
    if (typeof payload.state !== 'string') throw new Error('JARM response missing state');
    if (payload.code !== undefined && typeof payload.code !== 'string') {
      throw new Error('JARM response has invalid code');
    }
    if (payload.error !== undefined && typeof payload.error !== 'string') {
      throw new Error('JARM response has invalid error');
    }
    if (typeof payload.code !== 'string' && typeof payload.error !== 'string') {
      throw new Error('JARM response contains neither code nor error');
    }
    return {
      code: payload.code as string | undefined,
      state: payload.state,
      iss: payload.iss,
      error: payload.error as string | undefined,
      error_description: payload.error_description as string | undefined,
    };
  }

  async pushAuthorizationRequest(
    endpoint: string,
    authorizationParams: Record<string, string>
  ): Promise<Fapi2ParResponse> {
    const payload = await this.postAuthenticatedForm(endpoint, authorizationParams);
    if (
      typeof payload.request_uri !== 'string' ||
      !payload.request_uri.startsWith('urn:ietf:params:oauth:request_uri:')
    ) {
      throw new Error('PAR response missing valid request_uri');
    }
    if (typeof payload.expires_in !== 'number' || payload.expires_in <= 0) {
      throw new Error('PAR response missing valid expires_in');
    }
    return payload as unknown as Fapi2ParResponse;
  }

  async exchangeCode(options: {
    tokenEndpoint: string;
    code: string;
    codeVerifier: string;
  }): Promise<Fapi2TokenResponse> {
    const payload = await this.postAuthenticatedForm(options.tokenEndpoint, {
      grant_type: 'authorization_code',
      code: options.code,
      redirect_uri: this.config.redirectUri,
      code_verifier: options.codeVerifier,
    });
    return this.validateTokenResponse(payload);
  }

  async refreshToken(options: {
    tokenEndpoint: string;
    refreshToken: string;
  }): Promise<Fapi2TokenResponse> {
    const payload = await this.postAuthenticatedForm(options.tokenEndpoint, {
      grant_type: 'refresh_token',
      refresh_token: options.refreshToken,
    });
    return this.validateTokenResponse(payload);
  }

  async fetchResource(options: {
    resourceUrl: string;
    accessToken: string;
  }): Promise<Record<string, unknown>> {
    assertSafeUrl(options.resourceUrl, 'resource_endpoint');
    let nonce: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const proof = await this.createDpopProof({
        url: options.resourceUrl,
        method: 'GET',
        accessToken: options.accessToken,
        nonce,
      });
      const response = await safeFetch(options.resourceUrl, {
        headers: {
          Authorization: `DPoP ${options.accessToken}`,
          DPoP: proof,
        },
        timeoutMs: 10_000,
        maxResponseSize: MAX_RESPONSE_BYTES,
      });
      const challengeNonce = response.headers.get('DPoP-Nonce') ?? undefined;
      if (!response.ok && challengeNonce && attempt === 0) {
        nonce = challengeNonce;
        await readResponseTextWithLimit(response, MAX_RESPONSE_BYTES).catch(() => undefined);
        continue;
      }
      if (!response.ok) throw new Error(`FAPI resource request failed: HTTP ${response.status}`);
      return JSON.parse(await readResponseTextWithLimit(response, MAX_RESPONSE_BYTES)) as Record<
        string,
        unknown
      >;
    }
    throw new Error('FAPI resource DPoP nonce retry failed');
  }

  private async postAuthenticatedForm(
    endpoint: string,
    parameters: Record<string, string>
  ): Promise<Record<string, unknown>> {
    assertSafeUrl(endpoint, 'FAPI endpoint');
    let nonce: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const body = new URLSearchParams(parameters);
      body.set('client_id', this.config.clientId);
      body.set('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
      // FAPI 2.0 Security Profile Final requires the authorization server
      // issuer identifier as the private_key_jwt audience for PAR and token.
      body.set('client_assertion', await this.createClientAssertion(this.config.issuer));
      const proof = await this.createDpopProof({ url: endpoint, method: 'POST', nonce });
      const response = await safeFetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          DPoP: proof,
        },
        body: body.toString(),
        timeoutMs: 10_000,
        maxResponseSize: MAX_RESPONSE_BYTES,
      });
      const challengeNonce = response.headers.get('DPoP-Nonce') ?? undefined;
      if (!response.ok && challengeNonce && attempt === 0) {
        nonce = challengeNonce;
        await readResponseTextWithLimit(response, MAX_RESPONSE_BYTES).catch(() => undefined);
        continue;
      }
      if (!response.ok) throw new Error(`FAPI endpoint request failed: HTTP ${response.status}`);
      return JSON.parse(await readResponseTextWithLimit(response, MAX_RESPONSE_BYTES)) as Record<
        string,
        unknown
      >;
    }
    throw new Error('FAPI endpoint DPoP nonce retry failed');
  }

  private validateTokenResponse(payload: Record<string, unknown>): Fapi2TokenResponse {
    if (typeof payload.access_token !== 'string' || payload.access_token.length === 0) {
      throw new Error('Token response missing access_token');
    }
    if (typeof payload.token_type !== 'string' || payload.token_type.toLowerCase() !== 'dpop') {
      throw new Error('Token response token_type must be DPoP');
    }
    if (
      payload.expires_in !== undefined &&
      (typeof payload.expires_in !== 'number' || payload.expires_in <= 0)
    ) {
      throw new Error('Token response has invalid expires_in');
    }
    return payload as unknown as Fapi2TokenResponse;
  }
}
