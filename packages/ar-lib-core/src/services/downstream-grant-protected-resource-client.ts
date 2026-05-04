import type {
  DownstreamGrantServiceAuthorizationInput,
  DownstreamGrantServiceEvaluationResult,
} from './downstream-elevation-grant';
import {
  DownstreamGrantClientError,
  exchangeAndEvaluateDownstreamGrant,
  type ExchangeAndEvaluateDownstreamGrantInput,
  type ExchangeAndEvaluateDownstreamGrantResult,
} from './downstream-elevation-grant-client';

export interface FetchDownstreamProtectedResourceInput<
  TResponse = unknown,
  TParsed = TResponse,
> extends ExchangeAndEvaluateDownstreamGrantInput {
  resourceUrl: string;
  resourceFetchImpl?: typeof fetch;
  resourceRequest?: Omit<RequestInit, 'headers' | 'signal'> & {
    headers?: HeadersInit;
  };
  parseResponse?: (response: Response) => Promise<TParsed>;
}

export interface FetchDownstreamProtectedResourceResult<TResponse = unknown> {
  exchange: ExchangeAndEvaluateDownstreamGrantResult;
  authorization: DownstreamGrantServiceEvaluationResult;
  resourceResponse: Response;
  resourceData: TResponse;
}

export class DownstreamGrantProtectedResourceAccessError extends Error {
  readonly status: number;
  readonly authorization: DownstreamGrantServiceEvaluationResult;

  constructor(input: {
    message: string;
    authorization: DownstreamGrantServiceEvaluationResult;
    status?: number;
  }) {
    super(input.message);
    this.name = 'DownstreamGrantProtectedResourceAccessError';
    this.status = input.status ?? 403;
    this.authorization = input.authorization;
  }
}

function getResourceFetchImpl(fetchImpl?: typeof fetch): typeof fetch {
  return fetchImpl ?? fetch;
}

async function parseDefaultProtectedResourceResponse<T>(response: Response): Promise<T> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType.includes('application/json')) {
    return (await response.json()) as T;
  }
  return (await response.text()) as T;
}

export async function fetchProtectedResourceWithDownstreamGrant<
  TResponse = unknown,
  TParsed = TResponse,
>(
  input: FetchDownstreamProtectedResourceInput<TResponse, TParsed>
): Promise<FetchDownstreamProtectedResourceResult<TParsed>> {
  const exchange = await exchangeAndEvaluateDownstreamGrant(input);
  const authorization = exchange.finalAuthorization;
  if (!authorization.allowed) {
    throw new DownstreamGrantProtectedResourceAccessError({
      message: 'Downstream grant authorization failed before resource fetch.',
      authorization,
    });
  }

  const fetchImpl = getResourceFetchImpl(input.resourceFetchImpl);
  const headers = new Headers(input.resourceRequest?.headers);
  headers.set('Authorization', exchange.token.authorizationHeader);
  headers.set('Accept', headers.get('Accept') ?? 'application/json');

  const response = await fetchImpl(input.resourceUrl, {
    ...(input.resourceRequest ?? {}),
    headers,
    signal: input.signal,
  });

  if (!response.ok) {
    throw new DownstreamGrantClientError({
      message: `Downstream protected resource fetch failed with status ${response.status}`,
      status: response.status,
      responseBody: await response.clone().text(),
    });
  }

  const parser = input.parseResponse ?? parseDefaultProtectedResourceResponse<TParsed>;
  const resourceData = await parser(response.clone());

  return {
    exchange,
    authorization,
    resourceResponse: response,
    resourceData,
  };
}
