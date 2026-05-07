import type { IntrospectionResponse, TokenExchangeResponse, TokenTypeURN } from '../types/oidc';
import type {
  DownstreamGrantServiceAuthorizationInput,
  DownstreamGrantServiceEvaluationResult,
} from './downstream-elevation-grant';
import {
  ELEVATION_GRANT_SUBJECT_TOKEN_TYPE,
  evaluateDownstreamGrantServiceAuthorizationHeader,
  evaluateDownstreamGrantServiceIntrospection,
} from './downstream-elevation-grant';
import { readResponseTextWithLimit } from '../utils/url-security';

const DEFAULT_DOWNSTREAM_GRANT_RESPONSE_SIZE = 64 * 1024;

export type DownstreamGrantClientAuthenticationMethod =
  | 'client_secret_basic'
  | 'client_secret_post';

export interface DownstreamGrantClientCredentials {
  clientId: string;
  clientSecret: string;
  authMethod?: DownstreamGrantClientAuthenticationMethod;
}

export interface DownstreamGrantClientRequestOptions {
  fetchImpl?: typeof fetch;
  headers?: HeadersInit;
  signal?: AbortSignal;
  maxResponseSize?: number;
}

export type DownstreamGrantSubjectTokenType =
  | TokenTypeURN
  | typeof ELEVATION_GRANT_SUBJECT_TOKEN_TYPE;

export interface ExchangeDownstreamGrantSubjectTokenInput
  extends DownstreamGrantClientRequestOptions {
  tokenEndpoint: string;
  client: DownstreamGrantClientCredentials;
  subjectToken: string;
  subjectTokenType?: DownstreamGrantSubjectTokenType;
  audience?: string | null;
  resource?: string | null;
  scope?: string | string[] | null;
  requestedTokenType?: TokenTypeURN | null;
}

export interface IntrospectDownstreamGrantTokenInput extends DownstreamGrantClientRequestOptions {
  introspectionEndpoint: string;
  client: DownstreamGrantClientCredentials;
  accessToken: string;
  tokenTypeHint?: 'access_token' | 'refresh_token';
}

export type DownstreamGrantIntrospectionMode = 'never' | 'if_required' | 'always';

export interface ExchangeAndEvaluateDownstreamGrantInput
  extends ExchangeDownstreamGrantSubjectTokenInput {
  introspectionEndpoint?: string | null;
  introspectionMode?: DownstreamGrantIntrospectionMode;
  authorization?: Omit<DownstreamGrantServiceAuthorizationInput, 'decision'>;
}

export interface ExchangedDownstreamGrantToken {
  response: TokenExchangeResponse;
  authorizationHeader: string;
}

export interface ExchangeAndEvaluateDownstreamGrantResult {
  token: ExchangedDownstreamGrantToken;
  offlineAuthorization: DownstreamGrantServiceEvaluationResult;
  finalAuthorization: DownstreamGrantServiceEvaluationResult;
  introspectionResponse: IntrospectionResponse | null;
}

export class DownstreamGrantClientError extends Error {
  readonly status: number;
  readonly errorCode: string | null;
  readonly errorDescription: string | null;
  readonly responseBody: unknown;

  constructor(input: {
    message: string;
    status: number;
    errorCode?: string | null;
    errorDescription?: string | null;
    responseBody?: unknown;
  }) {
    super(input.message);
    this.name = 'DownstreamGrantClientError';
    this.status = input.status;
    this.errorCode = input.errorCode ?? null;
    this.errorDescription = input.errorDescription ?? null;
    this.responseBody = input.responseBody ?? null;
  }
}

function getFetchImpl(fetchImpl?: typeof fetch): typeof fetch {
  return fetchImpl ?? fetch;
}

function normalizeScope(scope: string | string[] | null | undefined): string | null {
  if (Array.isArray(scope)) {
    const normalized = scope.map((entry) => entry.trim()).filter(Boolean);
    return normalized.length > 0 ? normalized.join(' ') : null;
  }
  if (typeof scope === 'string' && scope.trim()) {
    return scope.trim();
  }
  return null;
}

function createAuthHeaders(
  client: DownstreamGrantClientCredentials,
  headers?: HeadersInit
): Headers {
  const resolved = new Headers(headers);
  resolved.set('Accept', 'application/json');

  if ((client.authMethod ?? 'client_secret_basic') === 'client_secret_basic') {
    const token = Buffer.from(`${client.clientId}:${client.clientSecret}`).toString('base64');
    resolved.set('Authorization', `Basic ${token}`);
  }

  return resolved;
}

function applyClientAuthenticationToBody(
  params: URLSearchParams,
  client: DownstreamGrantClientCredentials
): void {
  if ((client.authMethod ?? 'client_secret_basic') === 'client_secret_post') {
    params.set('client_id', client.clientId);
    params.set('client_secret', client.clientSecret);
  }
}

async function parseJsonResponse(response: Response, maxResponseSize: number): Promise<unknown> {
  const text = await readResponseTextWithLimit(response, maxResponseSize);
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function assertOkJsonResponse<T>(
  response: Response,
  operation: string,
  maxResponseSize: number
): Promise<T> {
  const body = await parseJsonResponse(response, maxResponseSize);
  if (!response.ok) {
    const record =
      typeof body === 'object' && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : null;
    throw new DownstreamGrantClientError({
      message: `${operation} failed with status ${response.status}`,
      status: response.status,
      errorCode: typeof record?.error === 'string' ? record.error : null,
      errorDescription:
        typeof record?.error_description === 'string' ? record.error_description : null,
      responseBody: body,
    });
  }

  return body as T;
}

export async function exchangeDownstreamGrantSubjectToken(
  input: ExchangeDownstreamGrantSubjectTokenInput
): Promise<ExchangedDownstreamGrantToken> {
  const fetchImpl = getFetchImpl(input.fetchImpl);
  const params = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    subject_token: input.subjectToken,
    subject_token_type: input.subjectTokenType ?? ELEVATION_GRANT_SUBJECT_TOKEN_TYPE,
  });

  if (input.audience?.trim()) {
    params.set('audience', input.audience.trim());
  }
  if (input.resource?.trim()) {
    params.set('resource', input.resource.trim());
  }
  const scope = normalizeScope(input.scope);
  if (scope) {
    params.set('scope', scope);
  }
  if (input.requestedTokenType?.trim()) {
    params.set('requested_token_type', input.requestedTokenType.trim());
  }
  applyClientAuthenticationToBody(params, input.client);

  const headers = createAuthHeaders(input.client, input.headers);
  headers.set('Content-Type', 'application/x-www-form-urlencoded');

  const response = await fetchImpl(input.tokenEndpoint, {
    method: 'POST',
    headers,
    body: params.toString(),
    signal: input.signal,
  });
  const tokenResponse = await assertOkJsonResponse<TokenExchangeResponse>(
    response,
    'Downstream grant token exchange',
    input.maxResponseSize ?? DEFAULT_DOWNSTREAM_GRANT_RESPONSE_SIZE
  );
  const tokenType = tokenResponse.token_type ?? 'Bearer';

  return {
    response: tokenResponse,
    authorizationHeader: `${tokenType} ${tokenResponse.access_token}`,
  };
}

export async function introspectDownstreamGrantToken(
  input: IntrospectDownstreamGrantTokenInput
): Promise<IntrospectionResponse> {
  const fetchImpl = getFetchImpl(input.fetchImpl);
  const params = new URLSearchParams({
    token: input.accessToken,
  });
  if (input.tokenTypeHint) {
    params.set('token_type_hint', input.tokenTypeHint);
  }
  applyClientAuthenticationToBody(params, input.client);

  const headers = createAuthHeaders(input.client, input.headers);
  headers.set('Content-Type', 'application/x-www-form-urlencoded');

  const response = await fetchImpl(input.introspectionEndpoint, {
    method: 'POST',
    headers,
    body: params.toString(),
    signal: input.signal,
  });
  return assertOkJsonResponse<IntrospectionResponse>(
    response,
    'Downstream grant introspection',
    input.maxResponseSize ?? DEFAULT_DOWNSTREAM_GRANT_RESPONSE_SIZE
  );
}

export async function exchangeAndEvaluateDownstreamGrant(
  input: ExchangeAndEvaluateDownstreamGrantInput
): Promise<ExchangeAndEvaluateDownstreamGrantResult> {
  const exchanged = await exchangeDownstreamGrantSubjectToken(input);
  const authorization = input.authorization ?? {};
  const offlineAuthorization = evaluateDownstreamGrantServiceAuthorizationHeader({
    authorizationHeader: exchanged.authorizationHeader,
    ...authorization,
  });

  const introspectionMode = input.introspectionMode ?? 'if_required';
  const shouldIntrospect =
    introspectionMode === 'always' ||
    (introspectionMode === 'if_required' && offlineAuthorization.requiresOnlineCheck);

  if (!shouldIntrospect) {
    return {
      token: exchanged,
      offlineAuthorization,
      finalAuthorization: offlineAuthorization,
      introspectionResponse: null,
    };
  }

  if (!input.introspectionEndpoint) {
    throw new DownstreamGrantClientError({
      message: 'Downstream grant introspection endpoint is required for online checks',
      status: 500,
      errorCode: 'introspection_endpoint_required',
      errorDescription: 'introspectionEndpoint must be configured when an online check is needed',
    });
  }

  const introspectionResponse = await introspectDownstreamGrantToken({
    introspectionEndpoint: input.introspectionEndpoint,
    client: input.client,
    accessToken: exchanged.response.access_token,
    tokenTypeHint: 'access_token',
    fetchImpl: input.fetchImpl,
    headers: input.headers,
    signal: input.signal,
    maxResponseSize: input.maxResponseSize,
  });
  const finalAuthorization = evaluateDownstreamGrantServiceIntrospection({
    response: introspectionResponse,
    ...authorization,
  });

  return {
    token: exchanged,
    offlineAuthorization,
    finalAuthorization,
    introspectionResponse,
  };
}
