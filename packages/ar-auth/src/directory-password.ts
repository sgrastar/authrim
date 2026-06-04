const HMAC_ALGORITHM = 'AUTHRIM-HMAC-SHA256';
const DEFAULT_TIMEOUT_MS = 3000;

export interface DirectoryPasswordConnectorConfig {
  endpoint: string;
  tenantId: string;
  connectorId: string;
  keyId: string;
  secret: string;
  timeoutMs?: number;
}

export interface DirectoryPasswordVerifyInput {
  username: string;
  password: string;
  attributeNames?: string[];
  requestId?: string;
  nonce?: string;
  timestamp?: Date;
}

export interface DirectoryPasswordSubject {
  directory_id: string;
  username: string;
}

export interface DirectoryPasswordSuccess {
  result: 'success';
  request_id: string;
  tenant_id: string;
  connector_id: string;
  subject: DirectoryPasswordSubject;
  attributes?: Record<string, string[]>;
  directory_status: 'ok';
}

export interface DirectoryPasswordFailure {
  result: 'failure';
  request_id: string;
  tenant_id: string;
  connector_id: string;
  reason: 'invalid_credentials';
  directory_status: 'ok';
}

export type DirectoryPasswordVerifyResult = DirectoryPasswordSuccess | DirectoryPasswordFailure;

export interface DirectoryPasswordConnectorError {
  requestId?: string;
  tenantId?: string;
  connectorId?: string;
  code: string;
  retryable: boolean;
  status: number;
}

export type DirectoryPasswordFetch = typeof fetch;

interface WordwardenErrorResponse {
  request_id?: string;
  tenant_id?: string;
  connector_id?: string;
  error?: {
    code?: string;
    retryable?: boolean;
  };
}

export class DirectoryPasswordError extends Error {
  readonly details: DirectoryPasswordConnectorError;

  constructor(details: DirectoryPasswordConnectorError) {
    super(details.code);
    this.name = 'DirectoryPasswordError';
    this.details = details;
  }
}

export class DirectoryPasswordClient {
  private readonly fetcher: DirectoryPasswordFetch;

  constructor(
    private readonly config: DirectoryPasswordConnectorConfig,
    fetcher: DirectoryPasswordFetch = fetch
  ) {
    this.fetcher = fetcher;
  }

  async verifyPassword(input: DirectoryPasswordVerifyInput): Promise<DirectoryPasswordVerifyResult> {
    const requestId = input.requestId || crypto.randomUUID();
    const nonce = input.nonce || crypto.randomUUID();
    const timestamp = input.timestamp || new Date();
    const url = new URL('/v1/auth/verify-password', this.config.endpoint);
    const body = JSON.stringify({
      request_id: requestId,
      tenant_id: this.config.tenantId,
      connector_id: this.config.connectorId,
      username: input.username,
      password: input.password,
      attribute_names: input.attributeNames || [],
    });

    const signedHeaders = [
      'content-type',
      'x-authrim-connector-id',
      'x-authrim-key-id',
      'x-authrim-nonce',
      'x-authrim-request-id',
      'x-authrim-timestamp',
    ];
    const timestampValue = timestamp.toISOString();
    const canonical = await buildDirectoryPasswordCanonicalRequest({
      method: 'POST',
      url,
      body,
      signedHeaders,
      timestamp: timestampValue,
      nonce,
    });
    const signature = await signDirectoryPasswordCanonicalRequest(canonical, this.config.secret);

    const headers = new Headers({
      'Content-Type': 'application/json',
      'X-Authrim-Connector-Id': this.config.connectorId,
      'X-Authrim-Key-Id': this.config.keyId,
      'X-Authrim-Request-Id': requestId,
      'X-Authrim-Timestamp': timestampValue,
      'X-Authrim-Nonce': nonce,
      'X-Authrim-Signed-Headers': signedHeaders.join(';'),
      'X-Authrim-Signature': signature,
    });

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs || DEFAULT_TIMEOUT_MS
    );

    let response: Response;
    try {
      response = await this.fetcher(url.toString(), {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
    } catch (error) {
      throw new DirectoryPasswordError({
        requestId,
        tenantId: this.config.tenantId,
        connectorId: this.config.connectorId,
        code: error instanceof DOMException && error.name === 'AbortError' ? 'timeout' : 'fetch_error',
        retryable: true,
        status: 0,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const parsed = await safeParseWordwardenError(response);
      throw new DirectoryPasswordError({
        requestId: parsed.request_id || requestId,
        tenantId: parsed.tenant_id || this.config.tenantId,
        connectorId: parsed.connector_id || this.config.connectorId,
        code: parsed.error?.code || 'wordwarden_error',
        retryable: parsed.error?.retryable ?? response.status >= 500,
        status: response.status,
      });
    }

    return response.json() as Promise<DirectoryPasswordVerifyResult>;
  }
}

export interface DirectoryPasswordCanonicalRequestInput {
  method: string;
  url: URL;
  body: string;
  signedHeaders: string[];
  timestamp: string;
  nonce: string;
}

export async function buildDirectoryPasswordCanonicalRequest(
  input: DirectoryPasswordCanonicalRequestInput
): Promise<string> {
  const bodyHash = await sha256Hex(input.body);
  const signedHeaders = input.signedHeaders.map((header) => header.toLowerCase()).sort().join(';');
  return [
    HMAC_ALGORITHM,
    input.timestamp,
    input.nonce,
    input.method,
    input.url.pathname,
    canonicalQuery(input.url.searchParams),
    signedHeaders,
    bodyHash,
  ].join('\n');
}

export async function signDirectoryPasswordCanonicalRequest(
  canonical: string,
  secret: string
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonical));
  return bytesToHex(new Uint8Array(signature));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function canonicalQuery(params: URLSearchParams): string {
  const keys = [...new Set(params.keys())].sort();
  const parts: string[] = [];
  for (const key of keys) {
    const values = params.getAll(key).sort();
    for (const value of values) {
      parts.push(new URLSearchParams([[key, value]]).toString());
    }
  }
  return parts.join('&');
}

async function safeParseWordwardenError(response: Response): Promise<WordwardenErrorResponse> {
  try {
    return (await response.json()) as WordwardenErrorResponse;
  } catch {
    return {};
  }
}
