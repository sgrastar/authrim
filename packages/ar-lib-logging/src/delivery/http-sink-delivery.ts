import { buildHttpSinkAuthHeaders, type HttpSinkAuthConfig } from './http-sink-auth';
import { classifyHttpSinkStatus, computeHttpSinkRetryDelayMs } from './http-sink-retry';

export interface HttpSinkDeliveryRequest {
  endpointUrl: string;
  method?: 'POST' | 'PUT';
  body: string;
  contentType?: string;
  deliveryId?: string;
  auth?: HttpSinkAuthConfig;
  allowHttp?: boolean;
  allowPrivateNetwork?: boolean;
  attempt?: number;
  fetcher?: typeof fetch;
}

export interface HttpSinkDeliveryResult {
  status: 'delivered' | 'retrying' | 'failed';
  httpStatus: number;
  retryDelayMs?: number;
  redactedHeaders: Record<string, string>;
}

function resolvePathForSignature(url: URL): string {
  return `${url.pathname}${url.search}`;
}

function isBlockedHttpSinkHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  if (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.localdomain') ||
    normalized.endsWith('.internal') ||
    normalized === 'metadata.google.internal'
  ) {
    return true;
  }

  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized);
  if (ipv4Match) {
    const octets = ipv4Match.slice(1).map((part) => Number.parseInt(part, 10));
    if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
      return true;
    }
    const [a, b] = octets;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 168 && b === 63 && octets[2] === 129 && octets[3] === 16) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && b === 51) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 203 && b === 0) ||
      a >= 224
    );
  }

  if (normalized === '::1' || normalized === '[::1]') {
    return true;
  }
  const ipv6 = normalized.replace(/^\[|\]$/g, '');
  return (
    ipv6 === '::' ||
    ipv6.includes(':ffff:') ||
    ipv6.startsWith('fc') ||
    ipv6.startsWith('fd') ||
    ipv6.startsWith('fe80:') ||
    ipv6.startsWith('ff')
  );
}

export async function deliverHttpSinkBatch(
  request: HttpSinkDeliveryRequest
): Promise<HttpSinkDeliveryResult> {
  const url = new URL(request.endpointUrl);
  if (url.protocol !== 'https:' && !(request.allowHttp && url.protocol === 'http:')) {
    throw new Error('http_sink_url_must_use_https');
  }
  if (!request.allowPrivateNetwork && isBlockedHttpSinkHostname(url.hostname)) {
    throw new Error('http_sink_url_private_network_blocked');
  }

  const method = request.method ?? 'POST';
  const auth =
    request.auth?.mode === 'hmac' && request.auth.hmac
      ? {
          ...request.auth,
          hmac: {
            ...request.auth.hmac,
            method,
            path: resolvePathForSignature(url),
            body: request.body,
            deliveryId: request.auth.hmac?.deliveryId ?? request.deliveryId,
          },
        }
      : request.auth;
  const authHeaders = auth
    ? await buildHttpSinkAuthHeaders(auth)
    : { headers: {}, redactedHeaders: {} };
  const headers = {
    'Content-Type': request.contentType ?? 'application/json',
    ...authHeaders.headers,
  };
  const response = await (request.fetcher ?? fetch)(url.toString(), {
    method,
    headers,
    body: request.body,
    redirect: 'manual',
  });
  const statusClass = classifyHttpSinkStatus(response.status);
  if (statusClass === 'success') {
    return {
      status: 'delivered',
      httpStatus: response.status,
      redactedHeaders: authHeaders.redactedHeaders,
    };
  }
  if (statusClass === 'retry') {
    return {
      status: 'retrying',
      httpStatus: response.status,
      retryDelayMs: computeHttpSinkRetryDelayMs({
        attempt: request.attempt ?? 1,
        retryAfter: response.headers.get('Retry-After'),
      }),
      redactedHeaders: authHeaders.redactedHeaders,
    };
  }
  return {
    status: 'failed',
    httpStatus: response.status,
    redactedHeaders: authHeaders.redactedHeaders,
  };
}
