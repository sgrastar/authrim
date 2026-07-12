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

export interface DirectoryPasswordGroupFact {
  id: string;
  dn: string;
  display: string;
  source: string;
  depth: number;
}

export interface DirectoryPasswordSuccess {
  result: 'success';
  request_id: string;
  tenant_id: string;
  connector_id: string;
  subject: DirectoryPasswordSubject;
  attributes?: Record<string, string[]>;
  group_facts?: DirectoryPasswordGroupFact[];
  directory_status: 'ok';
}

export interface DirectoryPasswordFailure {
  result: 'failure' | 'policy_required';
  request_id: string;
  tenant_id: string;
  connector_id: string;
  reason?: string;
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

  async verifyPassword(
    input: DirectoryPasswordVerifyInput
  ): Promise<DirectoryPasswordVerifyResult> {
    const requestId = input.requestId || crypto.randomUUID();
    const nonce = input.nonce || crypto.randomUUID();
    const timestamp = input.timestamp || new Date();
    const endpoint = parseDirectoryPasswordEndpoint(this.config.endpoint);
    if (!endpoint) {
      throw new DirectoryPasswordError({
        requestId,
        tenantId: this.config.tenantId,
        connectorId: this.config.connectorId,
        code: 'invalid_connector_endpoint',
        retryable: false,
        status: 0,
      });
    }
    const url = new URL('/v1/auth/verify-password', endpoint);
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
    const headers = new Headers({
      'Content-Type': 'application/json',
      'X-Authrim-Connector-Id': this.config.connectorId,
      'X-Authrim-Key-Id': this.config.keyId,
      'X-Authrim-Request-Id': requestId,
      'X-Authrim-Timestamp': timestampValue,
      'X-Authrim-Nonce': nonce,
      'X-Authrim-Signed-Headers': signedHeaders.join(';'),
    });
    const canonical = await buildDirectoryPasswordCanonicalRequest({
      method: 'POST',
      url,
      body,
      headers,
      signedHeaders,
      timestamp: timestampValue,
      nonce,
    });
    const signature = await signDirectoryPasswordCanonicalRequest(canonical, this.config.secret);

    headers.set('X-Authrim-Signature', signature);

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
        code:
          error instanceof DOMException && error.name === 'AbortError' ? 'timeout' : 'fetch_error',
        retryable: true,
        status: 0,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const parsed = await safeParseWordwardenError(response);
      if (
        (parsed.request_id && parsed.request_id !== requestId) ||
        (parsed.tenant_id && parsed.tenant_id !== this.config.tenantId) ||
        (parsed.connector_id && parsed.connector_id !== this.config.connectorId)
      ) {
        throw new DirectoryPasswordError({
          requestId,
          tenantId: this.config.tenantId,
          connectorId: this.config.connectorId,
          code: 'connector_error_response_mismatch',
          retryable: false,
          status: response.status,
        });
      }
      throw new DirectoryPasswordError({
        requestId,
        tenantId: this.config.tenantId,
        connectorId: this.config.connectorId,
        code: parsed.error?.code || 'wordwarden_error',
        retryable: parsed.error?.retryable ?? response.status >= 500,
        status: response.status,
      });
    }

    return validateDirectoryPasswordVerifyResult(
      await safeParseJson(response),
      this.config,
      requestId
    );
  }
}

export interface DirectoryPasswordCanonicalRequestInput {
  method: string;
  url: URL;
  body: string;
  headers: Headers;
  signedHeaders: string[];
  timestamp: string;
  nonce: string;
}

export async function buildDirectoryPasswordCanonicalRequest(
  input: DirectoryPasswordCanonicalRequestInput
): Promise<string> {
  const bodyHash = await sha256Hex(input.body);
  const signedHeaders = canonicalSignedHeaders(input.signedHeaders);
  const canonicalHeadersValue = canonicalHeaders(input.headers, signedHeaders);
  return [
    HMAC_ALGORITHM,
    input.timestamp,
    input.nonce,
    input.method,
    input.url.pathname,
    canonicalQuery(input.url.searchParams),
    canonicalHeadersValue,
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

function canonicalSignedHeaders(signedHeaders: string[]): string {
  return [...new Set(signedHeaders.map((header) => header.trim().toLowerCase()).filter(Boolean))]
    .sort()
    .join(';');
}

function canonicalHeaders(headers: Headers, signedHeaders: string): string {
  return signedHeaders
    .split(';')
    .map((header) => {
      const value = headers.get(header);
      if (!value) {
        throw new Error(`missing signed header ${header}`);
      }
      const normalized = value.trim().replace(/\s+/g, ' ');
      if (!normalized) {
        throw new Error(`empty signed header ${header}`);
      }
      return `${header}:${normalized}`;
    })
    .join('\n');
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

function parseDirectoryPasswordEndpoint(endpoint: string): URL | null {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return url;
  return null;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

async function safeParseWordwardenError(response: Response): Promise<WordwardenErrorResponse> {
  try {
    return (await response.json()) as WordwardenErrorResponse;
  } catch {
    return {};
  }
}

async function safeParseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function validateDirectoryPasswordVerifyResult(
  value: unknown,
  config: DirectoryPasswordConnectorConfig,
  requestId: string
): DirectoryPasswordVerifyResult {
  if (!isRecord(value)) {
    throw connectorResponseError(config, requestId, 'invalid_connector_response');
  }

  const responseRequestId = stringField(value, 'request_id');
  const responseTenantId = stringField(value, 'tenant_id');
  const responseConnectorId = stringField(value, 'connector_id');
  if (
    responseRequestId !== requestId ||
    responseTenantId !== config.tenantId ||
    responseConnectorId !== config.connectorId
  ) {
    throw connectorResponseError(config, requestId, 'connector_response_mismatch');
  }

  const result = stringField(value, 'result');
  const directoryStatus = stringField(value, 'directory_status') || 'ok';
  if (directoryStatus !== 'ok') {
    throw connectorResponseError(config, requestId, 'unexpected_directory_status');
  }
  if (result === 'success') {
    const subject = value.subject;
    if (!isRecord(subject)) {
      throw connectorResponseError(config, requestId, 'invalid_connector_response');
    }
    const directoryId = stringField(subject, 'directory_id');
    const username = stringField(subject, 'username');
    if (!directoryId || !username) {
      throw connectorResponseError(config, requestId, 'invalid_connector_response');
    }

    return {
      result,
      request_id: responseRequestId,
      tenant_id: responseTenantId,
      connector_id: responseConnectorId,
      subject: {
        directory_id: directoryId,
        username,
      },
      attributes: normalizeAttributes(value.attributes),
      group_facts: normalizeGroupFacts(value.group_facts),
      directory_status: directoryStatus,
    };
  }

  if (result === 'failure' || result === 'policy_required') {
    return {
      result,
      request_id: responseRequestId,
      tenant_id: responseTenantId,
      connector_id: responseConnectorId,
      reason: stringField(value, 'reason') || result,
      directory_status: directoryStatus,
    };
  }

  throw connectorResponseError(config, requestId, 'unexpected_connector_result');
}

function connectorResponseError(
  config: DirectoryPasswordConnectorConfig,
  requestId: string,
  code: string
): DirectoryPasswordError {
  return new DirectoryPasswordError({
    requestId,
    tenantId: config.tenantId,
    connectorId: config.connectorId,
    code,
    retryable: false,
    status: 502,
  });
}

function normalizeAttributes(value: unknown): Record<string, string[]> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, string[]> = {};
  for (const [key, rawValues] of Object.entries(value)) {
    if (!Array.isArray(rawValues)) continue;
    const values = rawValues.filter((item): item is string => typeof item === 'string');
    if (values.length > 0) {
      result[key] = values;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeGroupFacts(value: unknown): DirectoryPasswordGroupFact[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const facts: DirectoryPasswordGroupFact[] = [];
  for (const item of value.slice(0, 1000)) {
    if (!isRecord(item)) continue;
    const id = stringField(item, 'id');
    const dn = stringField(item, 'dn');
    const display = stringField(item, 'display');
    const source = stringField(item, 'source');
    const depth = numberField(item, 'depth');
    if (
      !id ||
      !dn ||
      !display ||
      !source ||
      typeof depth !== 'number' ||
      !Number.isInteger(depth) ||
      depth < 0 ||
      depth > 20
    ) {
      continue;
    }
    facts.push({
      id: id.slice(0, 512),
      dn: dn.slice(0, 2048),
      display: display.slice(0, 512),
      source: source.slice(0, 128),
      depth,
    });
  }
  return facts.length > 0 ? facts : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === 'string' && field.length > 0 ? field : undefined;
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key];
  return typeof field === 'number' && Number.isFinite(field) ? field : undefined;
}
