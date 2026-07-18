import type {
  AgentRateLimiterPort,
  AgentBulkChildExecutorPort,
  AgentBulkChildOperationRequest,
  AgentRateLimitRequest,
  AgentRateLimitResult,
  ManagementApiPort,
  ManagementOperationRequest,
  ManagementOperationResult,
  SecretKeyProviderPort,
} from '../ports';
import type { AgentDownscopeExchangeRequest, AgentDownscopeExchangeResult } from '../../core';
import type { AgentBulkChildTokenRequest } from '../../core';
import type { JsonValue } from '../../core';
import { getCloudflareAgentAccessCurrentRequest } from './mcp-request-context';

export interface CloudflareFetcherBinding {
  fetch(request: Request): Promise<Response>;
}

const MAX_MANAGEMENT_RESPONSE_BYTES = 1024 * 1024;

async function readBoundedResponseText(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_MANAGEMENT_RESPONSE_BYTES) {
        await reader.cancel('Management response is too large').catch(() => undefined);
        throw new RangeError('Management response is too large');
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function readBoundedManagementResponse(response: Response): Promise<JsonValue> {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_MANAGEMENT_RESPONSE_BYTES) {
      throw new RangeError('Management response size is invalid');
    }
  }
  const text = await readBoundedResponseText(response);
  const contentType = response.headers.get('content-type') ?? '';
  return /(?:^|[+/])json(?:;|$)/iu.test(contentType) ? (JSON.parse(text) as JsonValue) : { text };
}

export interface ManagementOperationRoute {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** A trusted, operation-specific builder may encode validated IDs/query values. */
  path:
    | string
    | ((
        input: ManagementOperationRequest['input'],
        context: { readonly tenantId: string }
      ) => string);
  /** Optional trusted body projection prevents path-only fields from reaching the owner handler. */
  body?: (input: ManagementOperationRequest['input']) => ManagementOperationRequest['input'];
  /** Optional trusted precondition headers derived from validated Tool input. */
  headers?: (input: ManagementOperationRequest['input']) => Readonly<Record<string, string>>;
  /** Optional owner-response projection used to enforce a smaller public Tool contract. */
  response?: (body: JsonValue) => JsonValue;
}

export interface AgentDownscopeTokenProvider {
  getToken(request: ManagementOperationRequest): Promise<string>;
}

export interface CloudflareAgentDownscopeExchangeBinding {
  exchangeAgentAccessToken(
    input: AgentDownscopeExchangeRequest
  ): Promise<AgentDownscopeExchangeResult>;
  issueAgentBulkChildToken(
    input: AgentBulkChildTokenRequest
  ): Promise<AgentDownscopeExchangeResult>;
}

function managementTarget(
  routes: Readonly<Record<string, ManagementOperationRoute>>,
  operation: string,
  input: ManagementOperationRequest['input'],
  tenantId: string
): { route: ManagementOperationRoute; target: URL } {
  const route = routes[operation];
  if (!route) throw new TypeError(`Unknown Management operation: ${operation}`);
  const path = typeof route.path === 'function' ? route.path(input, { tenantId }) : route.path;
  const target = new URL(path, 'https://ar-management.internal');
  if (
    target.origin !== 'https://ar-management.internal' ||
    !target.pathname.startsWith('/api/admin/')
  ) {
    throw new TypeError('Agent Management routes must stay under /api/admin/');
  }
  return { route, target };
}

function issuerOrigin(value: string): URL {
  let issuer: URL;
  try {
    issuer = new URL(value);
  } catch {
    throw new TypeError('Agent issuer origin is invalid');
  }
  if (
    issuer.origin !== value ||
    (issuer.protocol !== 'https:' &&
      issuer.hostname !== 'localhost' &&
      issuer.hostname !== '127.0.0.1' &&
      issuer.hostname !== '[::1]') ||
    issuer.username ||
    issuer.password
  ) {
    throw new TypeError('Agent issuer origin is invalid');
  }
  return issuer;
}

async function invokeManagement(
  binding: CloudflareFetcherBinding,
  routes: Readonly<Record<string, ManagementOperationRoute>>,
  input: {
    operation: string;
    tenantId: string;
    body: ManagementOperationRequest['input'];
    issuerOrigin: string;
    correlationId: string;
    idempotencyKey?: string;
    token: string;
  }
): Promise<ManagementOperationResult> {
  const { route, target } = managementTarget(routes, input.operation, input.body, input.tenantId);
  const issuer = issuerOrigin(input.issuerOrigin);
  const response = await binding.fetch(
    new Request(target, {
      method: route.method,
      headers: {
        ...(route.headers ? route.headers(input.body) : {}),
        authorization: `Bearer ${input.token}`,
        'content-type': 'application/json',
        'x-correlation-id': input.correlationId,
        'x-authrim-forwarded-host': issuer.host,
        'x-tenant-id': input.tenantId,
        ...(input.idempotencyKey ? { 'idempotency-key': input.idempotencyKey } : {}),
      },
      body:
        route.method === 'GET'
          ? undefined
          : JSON.stringify(route.body ? route.body(input.body) : input.body),
    })
  );
  const ownerBody = await readBoundedManagementResponse(response);
  const body = route.response ? route.response(ownerBody) : ownerBody;
  return {
    status: response.status,
    body: body as ManagementOperationResult['body'],
    requestId: response.headers.get('x-request-id') ?? undefined,
    executionStatus:
      response.headers.get('x-authrim-execution-indeterminate') === 'true'
        ? 'indeterminate'
        : 'definite',
  };
}

/** Cloudflare Service Binding RPC adapter for the RFC 8693 internal downscope exchange. */
export class CloudflareServiceBindingDownscopeTokenProvider implements AgentDownscopeTokenProvider {
  constructor(
    private readonly binding: CloudflareAgentDownscopeExchangeBinding,
    private readonly getSourceAccessToken: () => string | undefined,
    private readonly now: () => number = () => Date.now()
  ) {}

  async getToken(request: ManagementOperationRequest): Promise<string> {
    const subjectToken = this.getSourceAccessToken();
    if (!subjectToken) throw new Error('Agent Access source token is unavailable');
    const exchanged = await this.binding.exchangeAgentAccessToken({
      subjectToken,
      tenantId: request.tenantId,
      issuerOrigin: request.authorization.issuerOrigin,
      audience: request.authorization.audience,
      permissions: request.authorization.effectivePermissions,
      grantId: request.authorization.grantId,
      grantGeneration: request.authorization.grantGeneration,
      delegatorId: request.authorization.delegatorId,
      consentVersion: request.authorization.consentVersion,
      actorSub: request.authorization.actor.sub,
      actorMode: request.authorization.actor.mode,
      actorAssurance: request.authorization.actor.assurance,
      machinePrincipalId: request.authorization.actor.machinePrincipalId,
      machineCredentialId: request.authorization.actor.machineCredentialId,
      clientId: request.authorization.actor.clientId,
      correlationId: request.authorization.correlationId,
    });
    if (!exchanged.accessToken || exchanged.expiresAt <= this.now()) {
      throw new Error('Agent Access downscope exchange returned an invalid token');
    }
    return exchanged.accessToken;
  }
}

/** Production factory: raw source tokens may only come from the current DO request context. */
export function createCloudflareRequestScopedDownscopeTokenProvider(
  binding: CloudflareAgentDownscopeExchangeBinding,
  now?: () => number
): CloudflareServiceBindingDownscopeTokenProvider {
  return new CloudflareServiceBindingDownscopeTokenProvider(
    binding,
    () => getCloudflareAgentAccessCurrentRequest()?.sourceAccessToken,
    now
  );
}

/** Trusted operation IDs are mapped to fixed Management API routes by the composition root. */
export class CloudflareServiceBindingManagementApi implements ManagementApiPort {
  constructor(
    private readonly binding: CloudflareFetcherBinding,
    private readonly routes: Readonly<Record<string, ManagementOperationRoute>>,
    private readonly tokenProvider: AgentDownscopeTokenProvider
  ) {}

  async execute(request: ManagementOperationRequest): Promise<ManagementOperationResult> {
    const token = await this.tokenProvider.getToken(request);
    return invokeManagement(this.binding, this.routes, {
      operation: request.operation,
      tenantId: request.tenantId,
      body: request.input,
      issuerOrigin: request.authorization.issuerOrigin,
      correlationId: request.authorization.correlationId,
      idempotencyKey: request.idempotencyKey,
      token,
    });
  }
}

/** Cloudflare-only child credential issuance plus fixed Management Service Binding invocation. */
export class CloudflareServiceBindingBulkChildExecutor implements AgentBulkChildExecutorPort {
  constructor(
    private readonly management: CloudflareFetcherBinding,
    private readonly routes: Readonly<Record<string, ManagementOperationRoute>>,
    private readonly tokenService: CloudflareAgentDownscopeExchangeBinding,
    private readonly now: () => number = () => Date.now()
  ) {}

  async execute(request: AgentBulkChildOperationRequest): Promise<ManagementOperationResult> {
    const issued = await this.tokenService.issueAgentBulkChildToken({
      issuerOrigin: request.issuerOrigin,
      audience: 'authrim:admin-api',
      controlTenantId: request.binding.controlTenantId,
      targetTenantId: request.binding.targetTenantId,
      bulkPlanId: request.binding.bulkPlanId,
      bulkPlanVersion: request.binding.bulkPlanVersion,
      executionId: request.binding.executionId,
      executionAttempt: request.binding.executionAttempt,
      executionFence: request.binding.executionFence,
      stage: request.binding.stage,
      planDigest: request.binding.planDigest,
      approvalDigest: request.binding.approvalDigest,
      childCapabilityDigest: request.childCapabilityDigest,
      correlationId: request.correlationId,
    });
    if (!issued.accessToken || issued.expiresAt <= this.now()) {
      throw new Error('Agent Bulk child token is unavailable');
    }
    return invokeManagement(this.management, this.routes, {
      operation: request.operation,
      tenantId: request.binding.targetTenantId,
      body: request.input,
      issuerOrigin: request.issuerOrigin,
      correlationId: request.correlationId,
      idempotencyKey: request.idempotencyKey,
      token: issued.accessToken,
    });
  }
}

export interface CloudflareRateLimiterBinding {
  consume(request: AgentRateLimitRequest): Promise<AgentRateLimitResult>;
}

export class CloudflareServiceBindingRateLimiter implements AgentRateLimiterPort {
  constructor(private readonly binding: CloudflareRateLimiterBinding) {}

  consume(request: AgentRateLimitRequest): Promise<AgentRateLimitResult> {
    return this.binding.consume(request);
  }
}

export interface CloudflareKeyProviderBinding {
  getSigningKey(keyId: string): Promise<CryptoKey>;
  getEncryptionKey(keyId: string): Promise<CryptoKey>;
}

export class CloudflareServiceBindingSecretKeyProvider implements SecretKeyProviderPort {
  constructor(private readonly binding: CloudflareKeyProviderBinding) {}

  getSigningKey(keyId: string): Promise<CryptoKey> {
    return this.binding.getSigningKey(keyId);
  }

  getEncryptionKey(keyId: string): Promise<CryptoKey> {
    return this.binding.getEncryptionKey(keyId);
  }
}

function decodeHexKey(value: string): ArrayBuffer {
  if (!/^[0-9a-f]{64}$/iu.test(value)) {
    throw new TypeError('Agent elevation encryption key must be 32-byte hexadecimal data');
  }
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes.buffer as ArrayBuffer;
}

/** Imports versioned Worker secret text without exposing key material outside the adapter. */
export class CloudflareSecretTextKeyProvider implements SecretKeyProviderPort {
  constructor(private readonly encryptionKeys: Readonly<Record<string, string | undefined>>) {}

  getSigningKey(_keyId: string): Promise<CryptoKey> {
    return Promise.reject(new TypeError('Signing keys are not configured by this provider'));
  }

  async getEncryptionKey(keyId: string): Promise<CryptoKey> {
    const encoded = this.encryptionKeys[keyId];
    if (!encoded) throw new TypeError('Agent elevation encryption key is unavailable');
    return crypto.subtle.importKey('raw', decodeHexKey(encoded), { name: 'AES-GCM' }, false, [
      'encrypt',
      'decrypt',
    ]);
  }
}
