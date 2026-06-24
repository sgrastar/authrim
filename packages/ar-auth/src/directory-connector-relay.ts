import { DurableObject } from 'cloudflare:workers';
import {
  ensureDatabaseAdapter,
  recordDirectoryConnectorHeartbeat,
  type Env,
} from '@authrim/ar-lib-core';
import {
  constantTimeHexEqual,
  DIRECTORY_RELAY_PROTOCOL,
  DIRECTORY_RELAY_MIN_SUPPORTED_VERSION,
  DIRECTORY_RELAY_PROTOCOL_VERSION,
  buildDirectoryRelayAuthCanonical,
  isDirectoryRelayClientMessage,
  relayProtocolVersionsCompatible,
  signDirectoryRelayCanonical,
  type DirectoryRelayAuthResponseMessage,
  type DirectoryRelayVerifyErrorMessage,
  type DirectoryRelayChallengeMessage,
  type DirectoryRelayVerifyResponseMessage,
} from './directory-relay-protocol';

const CONNECTOR_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const DEFAULT_RELAY_CHALLENGE_TTL_MS = 30_000;
const DEFAULT_RELAY_VERIFY_TIMEOUT_MS = 5000;
const DEFAULT_MAX_PENDING_REQUESTS = 16;
const DEFAULT_AUTH_FAILURE_RATE_LIMIT_PER_MINUTE = 10;
const DEFAULT_AUTH_FAILURE_BLOCK_MS = 5 * 60_000;
const DEFAULT_SECRET_ROTATION_GRACE_MS = 5 * 60_000;
const MIN_RELAY_CHALLENGE_TTL_MS = 5_000;
const MAX_RELAY_CHALLENGE_TTL_MS = 5 * 60_000;
const MIN_RELAY_VERIFY_TIMEOUT_MS = 100;
const MAX_RELAY_VERIFY_TIMEOUT_MS = 30_000;
const MIN_MAX_PENDING_REQUESTS = 1;
const MAX_MAX_PENDING_REQUESTS = 256;
const MIN_AUTH_FAILURE_RATE_LIMIT_PER_MINUTE = 1;
const MAX_AUTH_FAILURE_RATE_LIMIT_PER_MINUTE = 100;
const MIN_AUTH_FAILURE_BLOCK_MS = 1_000;
const MAX_AUTH_FAILURE_BLOCK_MS = 60 * 60_000;
const MIN_SECRET_ROTATION_GRACE_MS = 0;
const MAX_SECRET_ROTATION_GRACE_MS = 24 * 60 * 60_000;
const MAX_VERIFY_BODY_BYTES = 64 * 1024;
const ALLOWED_CONNECTOR_SECRET_ENV_PREFIXES = ['AUTHRIM_WORDWARDEN_', 'WORDWARDEN_'];
const MAX_RELAY_EVENT_RECORDS = 100;
const MAX_RELAY_EVENT_FIELD_LENGTH = 256;
const RELAY_ERROR_CODE_PATTERN = /^[a-zA-Z0-9_.:-]{1,128}$/;
const WORDWARDEN_INSTANCE_ID_PATTERN = /^wwi_[a-zA-Z0-9_-]{22,64}$/;
const MAX_RELAY_METADATA_FIELD_LENGTH = 128;

interface DirectoryRelayAttachment {
  connectionId: string;
  tenantId: string;
  connectorId: string;
  challengeId: string;
  nonce: string;
  challengeExpiresAt: number;
  connectedAt: number;
}

interface DirectoryRelayConnectionRecord {
  authenticated: true;
  tenantId: string;
  connectorId: string;
  keyId: string;
  authenticatedAt: number;
}

interface DirectoryRelayPendingRequest {
  resolve: (response: DirectoryRelayVerifyResponseMessage) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  requestId: string;
  tenantId: string;
  connectorId: string;
}

interface DirectoryConnectorSettingsItem {
  id: string;
  transport: 'direct' | 'relay';
  auth_mode: string;
  connector_id: string;
  key_id: string;
  secret_ref: string;
  timeouts?: {
    request_ms?: number;
  };
  relay?: {
    verify_timeout_ms?: number;
    max_pending_requests?: number;
    challenge_ttl_ms?: number;
    auth_failure_rate_limit_per_minute?: number;
    auth_failure_block_ms?: number;
    secret_rotation_grace_ms?: number;
  };
}

interface DirectoryRelayRuntimeSettings {
  verifyTimeoutMs: number;
  maxPendingRequests: number;
  challengeTtlMs: number;
  authFailureRateLimitPerMinute: number;
  authFailureBlockMs: number;
  secretRotationGraceMs: number;
}

interface DirectoryRelayStatusRecord {
  tenantId: string;
  connectorId: string;
  relayProtocol: string;
  lastConnectedAt?: string;
  lastAuthenticatedAt?: string;
  authenticatedKeyId?: string;
  lastVerifyStartedAt?: string;
  lastVerifySucceededAt?: string;
  lastVerifyFailedAt?: string;
  lastDisconnectAt?: string;
  lastDisconnectReason?: string;
}

interface DirectoryRelayEventRecord {
  id: string;
  timestamp: string;
  tenantId: string;
  connectorId: string;
  type: string;
  requestId?: string;
  keyId?: string;
  code?: string;
  result?: string;
  retryable?: boolean;
}

interface DirectoryRelayEventListRecord {
  events: DirectoryRelayEventRecord[];
}

interface DirectoryRelayAuthFailureRecord {
  windowStartedAt: number;
  count: number;
  blockedUntil?: number;
}

interface DirectoryRelayUsedNonceRecord {
  expiresAt: number;
}

interface DirectoryRelayManagedSecretVersion {
  keyId: string;
  secret: string;
  createdAt: string;
}

interface DirectoryRelayManagedPreviousSecretVersion extends DirectoryRelayManagedSecretVersion {
  retireAfter: string;
}

interface DirectoryRelayManagedSecretRecord {
  active: DirectoryRelayManagedSecretVersion;
  previous?: DirectoryRelayManagedPreviousSecretVersion;
}

interface DirectoryRelayResolvedSecret {
  secret: string;
  keyId: string;
  active: boolean;
  retireAfter?: number;
}

class DirectoryRelayVerifyFailure extends Error {
  constructor(
    code: string,
    readonly retryable: boolean
  ) {
    super(code);
    this.name = 'DirectoryRelayVerifyFailure';
  }
}

export class DirectoryConnectorRelay extends DurableObject<Env> {
  private readonly pending = new Map<string, DirectoryRelayPendingRequest>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      return this.handleWebSocketUpgrade(request);
    }

    if (request.method === 'POST' && url.pathname === '/verify-password') {
      return this.handleVerifyPassword(request);
    }

    if (request.method === 'GET' && url.pathname === '/status') {
      return this.handleStatus(request);
    }

    if (request.method === 'GET' && url.pathname === '/events') {
      return this.handleEvents(request);
    }

    return jsonResponse({ error: 'not_found' }, 404);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    let parsed: unknown;
    try {
      const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
      parsed = JSON.parse(text);
    } catch {
      this.sendError(ws, 'invalid_json', 'Message must be valid JSON');
      return;
    }

    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      (parsed as { protocol?: unknown }).protocol === DIRECTORY_RELAY_PROTOCOL &&
      !relayProtocolVersionsCompatible(parsed as Record<string, unknown>)
    ) {
      this.sendError(ws, 'incompatible_relay_protocol', 'Relay protocol version is not compatible');
      ws.close(1008, 'incompatible relay protocol');
      return;
    }

    if (!isDirectoryRelayClientMessage(parsed)) {
      this.sendError(ws, 'unknown_message_type', 'Unknown relay message type');
      return;
    }

    if (parsed.type === 'auth.response') {
      await this.handleAuthResponse(ws, parsed);
      return;
    }

    if (parsed.type === 'verify.error') {
      await this.handleVerifyError(ws, parsed);
      return;
    }

    await this.handleVerifyResponse(ws, parsed);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.deleteConnectionRecord(ws, 'closed');
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.deleteConnectionRecord(ws, 'error');
  }

  private async handleWebSocketUpgrade(request: Request): Promise<Response> {
    const route = parseRelayRoute(new URL(request.url).pathname);
    if (!route) {
      return new Response('Invalid relay route', { status: 404 });
    }

    const settings = await findConnectorSettings(this.env, route.tenantId, route.connectorId);
    if (!settings || settings.transport !== 'relay' || settings.auth_mode !== 'hmac') {
      return new Response('Relay connector is not configured', { status: 404 });
    }
    const runtime = relayRuntimeSettings(settings);
    const blockedUntil = await this.authFailureBlockedUntil(route.tenantId, route.connectorId);
    if (blockedUntil && blockedUntil > Date.now()) {
      return jsonResponse(
        {
          error: 'relay_auth_rate_limited',
          retry_after_seconds: Math.ceil((blockedUntil - Date.now()) / 1000),
        },
        429
      );
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const now = Date.now();
    const attachment: DirectoryRelayAttachment = {
      connectionId: crypto.randomUUID(),
      tenantId: route.tenantId,
      connectorId: route.connectorId,
      challengeId: crypto.randomUUID(),
      nonce: crypto.randomUUID(),
      challengeExpiresAt: now + runtime.challengeTtlMs,
      connectedAt: now,
    };

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(attachment);
    this.scheduleAuthenticationTimeout(server, attachment);
    await this.updateStatus(route.tenantId, route.connectorId, {
      lastConnectedAt: new Date(now).toISOString(),
    });
    await this.recordEvent(route.tenantId, route.connectorId, {
      type: 'directory_relay.connection.challenge_issued',
    });

    const challenge: DirectoryRelayChallengeMessage = {
      type: 'auth.challenge',
      protocol: DIRECTORY_RELAY_PROTOCOL,
      protocol_version: DIRECTORY_RELAY_PROTOCOL_VERSION,
      min_supported_version: DIRECTORY_RELAY_MIN_SUPPORTED_VERSION,
      challenge_id: attachment.challengeId,
      nonce: attachment.nonce,
      issued_at: new Date(now).toISOString(),
      expires_at: new Date(attachment.challengeExpiresAt).toISOString(),
    };
    server.send(JSON.stringify(challenge));

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  private async handleAuthResponse(
    ws: WebSocket,
    message: DirectoryRelayAuthResponseMessage
  ): Promise<void> {
    const attachment = this.getAttachment(ws);
    if (!attachment) {
      this.sendError(ws, 'missing_connection_state', 'Connection state is missing');
      ws.close(1011, 'missing connection state');
      return;
    }

    if (
      message.tenant_id !== attachment.tenantId ||
      message.connector_id !== attachment.connectorId ||
      message.challenge_id !== attachment.challengeId ||
      message.nonce !== attachment.nonce
    ) {
      this.sendError(ws, 'auth_context_mismatch', 'Authentication context mismatch');
      await this.recordEvent(attachment.tenantId, attachment.connectorId, {
        type: 'directory_relay.connection.rejected',
        code: 'auth_context_mismatch',
      });
      await this.recordAuthenticationFailure(attachment.tenantId, attachment.connectorId);
      ws.close(1008, 'auth context mismatch');
      return;
    }
    if (Date.now() > attachment.challengeExpiresAt || !validRecentTimestamp(message.timestamp)) {
      this.sendError(ws, 'stale_auth_challenge', 'Authentication challenge expired');
      await this.recordEvent(attachment.tenantId, attachment.connectorId, {
        type: 'directory_relay.connection.rejected',
        code: 'stale_auth_challenge',
      });
      await this.recordAuthenticationFailure(attachment.tenantId, attachment.connectorId);
      ws.close(1008, 'stale auth challenge');
      return;
    }
    if (await this.usedNonceExists(attachment.tenantId, attachment.connectorId, message.nonce)) {
      this.sendError(ws, 'replayed_auth_challenge', 'Authentication challenge replayed');
      await this.recordEvent(attachment.tenantId, attachment.connectorId, {
        type: 'directory_relay.connection.rejected',
        code: 'replayed_auth_challenge',
      });
      await this.recordAuthenticationFailure(attachment.tenantId, attachment.connectorId);
      ws.close(1008, 'replayed auth challenge');
      return;
    }

    const settings = await findConnectorSettings(
      this.env,
      attachment.tenantId,
      attachment.connectorId
    );
    const resolvedSecret = settings
      ? await resolveConnectorSecret(
          this.env,
          attachment.tenantId,
          attachment.connectorId,
          settings,
          message.key_id
        )
      : undefined;
    if (!settings || settings.transport !== 'relay' || !resolvedSecret) {
      this.sendError(ws, 'relay_auth_failed', 'Relay authentication failed');
      await this.recordEvent(attachment.tenantId, attachment.connectorId, {
        type: 'directory_relay.connection.rejected',
        code: 'relay_auth_failed',
        keyId: message.key_id,
      });
      await this.recordAuthenticationFailure(attachment.tenantId, attachment.connectorId);
      ws.close(1008, 'relay authentication failed');
      return;
    }

    const canonical = buildDirectoryRelayAuthCanonical({
      tenantId: message.tenant_id,
      connectorId: message.connector_id,
      keyId: message.key_id,
      protocolVersion: message.protocol_version,
      minSupportedVersion: message.min_supported_version,
      challengeId: message.challenge_id,
      nonce: message.nonce,
      timestamp: message.timestamp,
    });
    const expected = await signDirectoryRelayCanonical(canonical, resolvedSecret.secret);
    if (!constantTimeHexEqual(expected, message.signature)) {
      this.sendError(ws, 'relay_auth_failed', 'Relay authentication failed');
      await this.recordEvent(attachment.tenantId, attachment.connectorId, {
        type: 'directory_relay.connection.rejected',
        code: 'relay_auth_failed',
        keyId: message.key_id,
      });
      await this.recordAuthenticationFailure(attachment.tenantId, attachment.connectorId);
      ws.close(1008, 'relay authentication failed');
      return;
    }

    const accepted = await this.recordFleetRegistration(attachment, message);
    if (!accepted) {
      this.sendError(ws, 'relay_auth_failed', 'Relay authentication failed');
      await this.recordEvent(attachment.tenantId, attachment.connectorId, {
        type: 'directory_relay.connection.rejected',
        code: 'relay_instance_rejected',
        keyId: message.key_id,
      });
      ws.close(1008, 'relay authentication failed');
      return;
    }

    await this.markNonceUsed(attachment.tenantId, attachment.connectorId, message.nonce, settings);
    await this.closeOtherAuthenticatedSockets(ws, attachment);
    await this.clearAuthenticationFailures(attachment.tenantId, attachment.connectorId);
    await this.ctx.storage.put<DirectoryRelayConnectionRecord>(
      connectionRecordKey(attachment.connectionId),
      {
        authenticated: true,
        tenantId: attachment.tenantId,
        connectorId: attachment.connectorId,
        keyId: message.key_id,
        authenticatedAt: Date.now(),
      }
    );
    await this.updateStatus(attachment.tenantId, attachment.connectorId, {
      lastAuthenticatedAt: new Date().toISOString(),
      authenticatedKeyId: message.key_id,
    });
    await this.recordEvent(attachment.tenantId, attachment.connectorId, {
      type: 'directory_relay.connection.authenticated',
      keyId: message.key_id,
    });
    ws.send(
      JSON.stringify({
        type: 'auth.ok',
        protocol: DIRECTORY_RELAY_PROTOCOL,
        protocol_version: DIRECTORY_RELAY_PROTOCOL_VERSION,
        min_supported_version: DIRECTORY_RELAY_MIN_SUPPORTED_VERSION,
        tenant_id: attachment.tenantId,
        connector_id: attachment.connectorId,
      })
    );
  }

  private scheduleAuthenticationTimeout(ws: WebSocket, attachment: DirectoryRelayAttachment): void {
    setTimeout(
      () => {
        this.isAuthenticated(ws)
          .then(async (authenticated) => {
            if (!authenticated) {
              await this.recordAuthenticationFailure(attachment.tenantId, attachment.connectorId);
              await this.recordEvent(attachment.tenantId, attachment.connectorId, {
                type: 'directory_relay.connection.rejected',
                code: 'auth_timeout',
              });
              ws.close(1008, 'relay authentication timeout');
              await this.deleteConnectionRecord(ws, 'auth_timeout');
              return undefined;
            }
            return undefined;
          })
          .catch(async () => {
            ws.close(1011, 'relay authentication check failed');
            await this.deleteConnectionRecord(ws, 'auth_check_failed');
          });
      },
      Math.max(0, attachment.challengeExpiresAt - Date.now() + 1000)
    );
  }

  private async recordFleetRegistration(
    attachment: DirectoryRelayAttachment,
    message: DirectoryRelayAuthResponseMessage
  ): Promise<boolean> {
    const instanceId = sanitizeRelayInstanceId(message.instance_id);
    if (!instanceId) return false;
    const adapter = ensureDatabaseAdapter(this.env.DB, 'core');
    const result = await recordDirectoryConnectorHeartbeat(adapter, {
      tenantId: attachment.tenantId,
      connectorId: attachment.connectorId,
      instanceId,
      displayName: sanitizeRelayMetadata(message.display_name),
      transport: 'relay',
      version: sanitizeRelayMetadata(message.version) || 'unknown',
      startedAt: validISODate(message.started_at) ? message.started_at! : new Date().toISOString(),
      healthStatus: 'healthy',
      healthSummary: { relay: 'authenticated' },
      configFingerprint: sanitizeRelayFingerprint(message.config_fingerprint),
      configCategories: sanitizeRelayCategories(message.config_categories),
      driftSeverity: sanitizeRelayDriftSeverity(message.drift_severity),
    });
    return result.accepted;
  }

  private async handleVerifyPassword(request: Request): Promise<Response> {
    if (!request.body) {
      return connectorError('invalid_relay_request', false, 400);
    }
    const contentLength = Number(request.headers.get('content-length') || '0');
    if (contentLength > MAX_VERIFY_BODY_BYTES) {
      return connectorError('relay_request_too_large', false, 413);
    }

    const bodyText = await readRequestTextWithLimit(request, MAX_VERIFY_BODY_BYTES);
    if (bodyText === 'too_large') {
      return connectorError('relay_request_too_large', false, 413);
    }
    if (bodyText === null) {
      return connectorError('invalid_relay_request', false, 400);
    }

    let body: {
      request_id?: unknown;
      tenant_id?: unknown;
      connector_id?: unknown;
      username?: unknown;
      password?: unknown;
      attribute_names?: unknown;
    };
    try {
      body = JSON.parse(bodyText) as typeof body;
    } catch {
      return connectorError('invalid_relay_request', false, 400);
    }

    const requestId = stringValue(body.request_id);
    const tenantId = stringValue(body.tenant_id);
    const connectorId = stringValue(body.connector_id);
    const username = stringValue(body.username);
    const password = passwordValue(body.password);
    if (!requestId || !tenantId || !connectorId || !username || !password) {
      return connectorError('invalid_relay_request', false, 400);
    }

    const settings = await findConnectorSettings(this.env, tenantId, connectorId);
    if (!settings || settings.transport !== 'relay') {
      return connectorError('relay_connector_not_configured', false, 404);
    }
    const runtime = relayRuntimeSettings(settings);
    if (this.pendingCount(tenantId, connectorId) >= runtime.maxPendingRequests) {
      await this.updateStatus(tenantId, connectorId, {
        lastVerifyFailedAt: new Date().toISOString(),
      });
      await this.recordEvent(tenantId, connectorId, {
        type: 'directory_relay.overloaded',
        requestId,
        code: 'relay_overloaded',
        retryable: true,
      });
      return connectorError('relay_overloaded', true, 429);
    }

    const ws = await this.authenticatedWebSocket(tenantId, connectorId);
    if (!ws) {
      return connectorError('relay_connector_offline', true, 503);
    }

    const id = crypto.randomUUID();
    await this.updateStatus(tenantId, connectorId, {
      lastVerifyStartedAt: new Date().toISOString(),
    });
    await this.recordEvent(tenantId, connectorId, {
      type: 'directory_relay.verify.forwarded',
      requestId,
    });
    const responsePromise = new Promise<DirectoryRelayVerifyResponseMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new DirectoryRelayVerifyFailure('relay_verify_timeout', true));
      }, runtime.verifyTimeoutMs);
      this.pending.set(id, { resolve, reject, timeout, requestId, tenantId, connectorId });
    });

    try {
      ws.send(
        JSON.stringify({
          type: 'verify.request',
          protocol: DIRECTORY_RELAY_PROTOCOL,
          protocol_version: DIRECTORY_RELAY_PROTOCOL_VERSION,
          min_supported_version: DIRECTORY_RELAY_MIN_SUPPORTED_VERSION,
          id,
          request_id: requestId,
          tenant_id: tenantId,
          connector_id: connectorId,
          username,
          password,
          attribute_names: stringArrayValue(body.attribute_names),
        })
      );
    } catch {
      const pending = this.pending.get(id);
      if (pending) clearTimeout(pending.timeout);
      this.pending.delete(id);
      await this.updateStatus(tenantId, connectorId, {
        lastVerifyFailedAt: new Date().toISOString(),
      });
      await this.recordEvent(tenantId, connectorId, {
        type: 'directory_relay.verify.failed',
        requestId,
        code: 'relay_send_failed',
        retryable: true,
      });
      return connectorError('relay_send_failed', true, 503);
    }

    try {
      const response = await responsePromise;
      await this.updateStatus(tenantId, connectorId, {
        lastVerifySucceededAt: new Date().toISOString(),
      });
      await this.recordEvent(tenantId, connectorId, {
        type: 'directory_relay.verify.succeeded',
        requestId,
        result: response.result,
      });
      return jsonResponse(response);
    } catch (error) {
      const code = error instanceof Error ? error.message : 'relay_verify_error';
      const retryable = error instanceof DirectoryRelayVerifyFailure ? error.retryable : true;
      await this.updateStatus(tenantId, connectorId, {
        lastVerifyFailedAt: new Date().toISOString(),
      });
      await this.recordEvent(tenantId, connectorId, {
        type:
          code === 'relay_verify_timeout'
            ? 'directory_relay.verify.timeout'
            : 'directory_relay.verify.failed',
        requestId,
        code,
        retryable,
      });
      if (code === 'relay_verify_timeout') {
        return connectorError('relay_verify_timeout', true, 504);
      }
      return connectorError(code, retryable, retryable ? 503 : 400);
    }
  }

  private async handleVerifyResponse(
    ws: WebSocket,
    message: DirectoryRelayVerifyResponseMessage
  ): Promise<void> {
    if (!(await this.isAuthenticated(ws))) {
      this.sendError(ws, 'unauthenticated', 'Relay connection is not authenticated');
      ws.close(1008, 'unauthenticated');
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      this.sendError(ws, 'unknown_request_id', 'Unknown relay verification request');
      return;
    }
    if (
      message.request_id !== pending.requestId ||
      message.tenant_id !== pending.tenantId ||
      message.connector_id !== pending.connectorId
    ) {
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      await this.recordEvent(pending.tenantId, pending.connectorId, {
        type: 'directory_relay.verify.failed',
        requestId: pending.requestId,
        code: 'relay_response_mismatch',
        retryable: false,
      });
      pending.reject(new DirectoryRelayVerifyFailure('relay_response_mismatch', false));
      ws.close(1008, 'relay response mismatch');
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timeout);
    pending.resolve(message);
  }

  private async handleVerifyError(
    ws: WebSocket,
    message: DirectoryRelayVerifyErrorMessage
  ): Promise<void> {
    if (!(await this.isAuthenticated(ws))) {
      this.sendError(ws, 'unauthenticated', 'Relay connection is not authenticated');
      ws.close(1008, 'unauthenticated');
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      this.sendError(ws, 'unknown_request_id', 'Unknown relay verification request');
      return;
    }
    if (
      (message.request_id && message.request_id !== pending.requestId) ||
      (message.tenant_id && message.tenant_id !== pending.tenantId) ||
      (message.connector_id && message.connector_id !== pending.connectorId)
    ) {
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      await this.recordEvent(pending.tenantId, pending.connectorId, {
        type: 'directory_relay.verify.failed',
        requestId: pending.requestId,
        code: 'relay_response_mismatch',
        retryable: false,
      });
      pending.reject(new DirectoryRelayVerifyFailure('relay_response_mismatch', false));
      ws.close(1008, 'relay response mismatch');
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timeout);
    const relayCode = relayVerifyErrorCode(message.error);
    await this.recordEvent(pending.tenantId, pending.connectorId, {
      type: 'directory_relay.verify.failed',
      requestId: pending.requestId,
      code: relayCode,
      retryable: relayVerifyErrorRetryable(message.error),
    });
    pending.reject(
      new DirectoryRelayVerifyFailure(relayCode, relayVerifyErrorRetryable(message.error))
    );
  }

  private async handleStatus(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const tenantId = stringValue(url.searchParams.get('tenant_id'));
    const connectorId = stringValue(url.searchParams.get('connector_id'));
    const settings =
      tenantId && connectorId ? await findConnectorSettings(this.env, tenantId, connectorId) : null;
    const runtime = settings ? relayRuntimeSettings(settings) : defaultRelayRuntimeSettings();
    const storedStatus =
      tenantId && connectorId
        ? await this.ctx.storage.get<DirectoryRelayStatusRecord>(
            statusRecordKey(tenantId, connectorId)
          )
        : null;
    const websockets = this.ctx.getWebSockets();
    let authenticated = 0;
    for (const ws of websockets) {
      if (await this.isAuthenticated(ws, true)) authenticated += 1;
    }
    return jsonResponse({
      ok: true,
      connections: websockets.length,
      authenticated_connections: authenticated,
      pending_requests:
        tenantId && connectorId ? this.pendingCount(tenantId, connectorId) : this.pending.size,
      max_pending_requests: runtime.maxPendingRequests,
      verify_timeout_ms: runtime.verifyTimeoutMs,
      challenge_ttl_ms: runtime.challengeTtlMs,
      relay_protocol: DIRECTORY_RELAY_PROTOCOL,
      protocol_version: DIRECTORY_RELAY_PROTOCOL_VERSION,
      min_supported_version: DIRECTORY_RELAY_MIN_SUPPORTED_VERSION,
      last_connected_at: storedStatus?.lastConnectedAt,
      last_authenticated_at: storedStatus?.lastAuthenticatedAt,
      authenticated_key_id: storedStatus?.authenticatedKeyId,
      last_verify_started_at: storedStatus?.lastVerifyStartedAt,
      last_verify_succeeded_at: storedStatus?.lastVerifySucceededAt,
      last_verify_failed_at: storedStatus?.lastVerifyFailedAt,
      last_disconnect_at: storedStatus?.lastDisconnectAt,
      last_disconnect_reason: storedStatus?.lastDisconnectReason,
    });
  }

  private async authenticatedWebSocket(
    tenantId: string,
    connectorId: string
  ): Promise<WebSocket | null> {
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = this.getAttachment(ws);
      if (
        !attachment ||
        attachment.tenantId !== tenantId ||
        attachment.connectorId !== connectorId
      ) {
        continue;
      }
      if (await this.isAuthenticated(ws, true)) return ws;
    }
    return null;
  }

  private async handleEvents(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const tenantId = stringValue(url.searchParams.get('tenant_id'));
    const connectorId = stringValue(url.searchParams.get('connector_id'));
    if (!tenantId || !connectorId) {
      return connectorError('invalid_relay_request', false, 400);
    }
    const record = await this.ctx.storage.get<DirectoryRelayEventListRecord>(
      eventListRecordKey(tenantId, connectorId)
    );
    return jsonResponse({
      tenant_id: tenantId,
      connector_id: connectorId,
      events: record?.events ?? [],
    });
  }

  private async isAuthenticated(ws: WebSocket, validateKey = false): Promise<boolean> {
    const attachment = this.getAttachment(ws);
    if (!attachment) return false;
    const record = await this.ctx.storage.get<DirectoryRelayConnectionRecord>(
      connectionRecordKey(attachment.connectionId)
    );
    const authenticated = Boolean(
      record?.authenticated &&
      record.tenantId === attachment.tenantId &&
      record.connectorId === attachment.connectorId
    );
    if (!authenticated || !record || !validateKey) return authenticated;

    const settings = await findConnectorSettings(
      this.env,
      attachment.tenantId,
      attachment.connectorId
    );
    const resolvedSecret = settings
      ? await resolveConnectorSecret(
          this.env,
          attachment.tenantId,
          attachment.connectorId,
          settings,
          record.keyId
        )
      : undefined;
    if (resolvedSecret) return true;
    await this.deleteConnectionRecord(ws, 'authenticated_key_expired');
    ws.close(1008, 'authenticated key expired');
    return false;
  }

  private pendingCount(tenantId: string, connectorId: string): number {
    let count = 0;
    for (const pending of this.pending.values()) {
      if (pending.tenantId === tenantId && pending.connectorId === connectorId) count += 1;
    }
    return count;
  }

  private async updateStatus(
    tenantId: string,
    connectorId: string,
    patch: Partial<DirectoryRelayStatusRecord>
  ): Promise<void> {
    const key = statusRecordKey(tenantId, connectorId);
    const current = await this.ctx.storage.get<DirectoryRelayStatusRecord>(key);
    await this.ctx.storage.put<DirectoryRelayStatusRecord>(key, {
      tenantId,
      connectorId,
      relayProtocol: DIRECTORY_RELAY_PROTOCOL,
      ...current,
      ...patch,
    });
  }

  private async authFailureBlockedUntil(
    tenantId: string,
    connectorId: string
  ): Promise<number | undefined> {
    const record = await this.ctx.storage.get<DirectoryRelayAuthFailureRecord>(
      authFailureRecordKey(tenantId, connectorId)
    );
    if (!record?.blockedUntil) return undefined;
    if (record.blockedUntil > Date.now()) return record.blockedUntil;
    await this.ctx.storage.delete(authFailureRecordKey(tenantId, connectorId));
    return undefined;
  }

  private async recordAuthenticationFailure(tenantId: string, connectorId: string): Promise<void> {
    const settings = await findConnectorSettings(this.env, tenantId, connectorId);
    const runtime = settings ? relayRuntimeSettings(settings) : defaultRelayRuntimeSettings();
    const key = authFailureRecordKey(tenantId, connectorId);
    const now = Date.now();
    const current = await this.ctx.storage.get<DirectoryRelayAuthFailureRecord>(key);
    const windowStartedAt =
      current && now - current.windowStartedAt < 60_000 ? current.windowStartedAt : now;
    const count = current && windowStartedAt === current.windowStartedAt ? current.count + 1 : 1;
    const blockedUntil =
      count >= runtime.authFailureRateLimitPerMinute ? now + runtime.authFailureBlockMs : undefined;
    await this.ctx.storage.put<DirectoryRelayAuthFailureRecord>(key, {
      windowStartedAt,
      count,
      blockedUntil,
    });
  }

  private async clearAuthenticationFailures(tenantId: string, connectorId: string): Promise<void> {
    await this.ctx.storage.delete(authFailureRecordKey(tenantId, connectorId));
  }

  private async usedNonceExists(
    tenantId: string,
    connectorId: string,
    nonce: string
  ): Promise<boolean> {
    const key = usedNonceRecordKey(tenantId, connectorId, nonce);
    const record = await this.ctx.storage.get<DirectoryRelayUsedNonceRecord>(key);
    if (!record) return false;
    if (record.expiresAt > Date.now()) return true;
    await this.ctx.storage.delete(key);
    return false;
  }

  private async markNonceUsed(
    tenantId: string,
    connectorId: string,
    nonce: string,
    settings: DirectoryConnectorSettingsItem
  ): Promise<void> {
    const runtime = relayRuntimeSettings(settings);
    await this.ctx.storage.put<DirectoryRelayUsedNonceRecord>(
      usedNonceRecordKey(tenantId, connectorId, nonce),
      {
        expiresAt: Date.now() + runtime.challengeTtlMs * 2,
      }
    );
  }

  private async closeOtherAuthenticatedSockets(
    current: WebSocket,
    currentAttachment: DirectoryRelayAttachment
  ): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === current) continue;
      const attachment = this.getAttachment(ws);
      if (
        attachment?.tenantId === currentAttachment.tenantId &&
        attachment.connectorId === currentAttachment.connectorId &&
        (await this.isAuthenticated(ws))
      ) {
        await this.deleteConnectionRecord(ws, 'replaced');
        ws.close(1000, 'replaced by newer relay connection');
      }
    }
  }

  private async deleteConnectionRecord(ws: WebSocket, reason: string): Promise<void> {
    const attachment = this.getAttachment(ws);
    if (attachment) {
      const key = connectionRecordKey(attachment.connectionId);
      const record = await this.ctx.storage.get<DirectoryRelayConnectionRecord>(key);
      await this.ctx.storage.delete(key);
      if (record?.authenticated) {
        this.rejectPendingForConnector(
          attachment.tenantId,
          attachment.connectorId,
          'relay_connection_closed'
        );
      }
      await this.updateStatus(attachment.tenantId, attachment.connectorId, {
        lastDisconnectAt: new Date().toISOString(),
        lastDisconnectReason: reason,
      });
      await this.recordEvent(attachment.tenantId, attachment.connectorId, {
        type: 'directory_relay.connection.closed',
        code: reason,
        keyId: record?.keyId,
      });
    }
  }

  private async recordEvent(
    tenantId: string,
    connectorId: string,
    event: Omit<DirectoryRelayEventRecord, 'id' | 'timestamp' | 'tenantId' | 'connectorId'>
  ): Promise<void> {
    const key = eventListRecordKey(tenantId, connectorId);
    const current = await this.ctx.storage.get<DirectoryRelayEventListRecord>(key);
    const next: DirectoryRelayEventRecord = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      tenantId,
      connectorId,
      ...event,
      requestId: safeRelayEventString(event.requestId),
      keyId: safeRelayEventString(event.keyId),
      code: safeRelayEventString(event.code),
      result: safeRelayEventString(event.result),
    };
    const events = [next, ...(current?.events ?? [])].slice(0, MAX_RELAY_EVENT_RECORDS);
    await this.ctx.storage.put<DirectoryRelayEventListRecord>(key, { events });
  }

  private rejectPendingForConnector(tenantId: string, connectorId: string, code: string): void {
    for (const [id, pending] of this.pending.entries()) {
      if (pending.tenantId !== tenantId || pending.connectorId !== connectorId) continue;
      this.pending.delete(id);
      clearTimeout(pending.timeout);
      pending.reject(new DirectoryRelayVerifyFailure(code, true));
    }
  }

  private getAttachment(ws: WebSocket): DirectoryRelayAttachment | null {
    try {
      return ws.deserializeAttachment() as DirectoryRelayAttachment | null;
    } catch {
      // Ignore malformed attachments.
    }
    return null;
  }

  private sendError(ws: WebSocket, code: string, message: string): void {
    ws.send(
      JSON.stringify({
        type: 'error',
        protocol: DIRECTORY_RELAY_PROTOCOL,
        protocol_version: DIRECTORY_RELAY_PROTOCOL_VERSION,
        min_supported_version: DIRECTORY_RELAY_MIN_SUPPORTED_VERSION,
        code,
        message,
      })
    );
  }
}

function parseRelayRoute(pathname: string): { tenantId: string; connectorId: string } | null {
  const match = pathname.match(/^\/api\/auth\/directory-relay\/connect\/([^/]+)\/([^/]+)$/);
  if (!match) return null;
  const tenantId = decodeURIComponent(match[1] ?? '');
  const connectorId = decodeURIComponent(match[2] ?? '');
  if (!CONNECTOR_ID_PATTERN.test(connectorId) || tenantId.length < 1 || tenantId.length > 128) {
    return null;
  }
  return { tenantId, connectorId };
}

async function findConnectorSettings(
  env: Env,
  tenantId: string,
  relayConnectorId: string
): Promise<DirectoryConnectorSettingsItem | null> {
  const raw = await env.SETTINGS?.get(`settings:tenant:${tenantId}:directory-connectors`).catch(
    () => null
  );
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const connectors = (parsed as { connectors?: unknown }).connectors;
  if (!Array.isArray(connectors)) return null;
  for (const value of connectors) {
    const connector = normalizeConnector(value);
    if (connector && connector.connector_id === relayConnectorId) return connector;
  }
  return null;
}

function normalizeConnector(value: unknown): DirectoryConnectorSettingsItem | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = stringValue(record.id);
  const connectorID = stringValue(record.connector_id) || id;
  const keyID = stringValue(record.key_id);
  const secretRef = stringValue(record.secret_ref);
  if (!id || !connectorID || !keyID || !secretRef) return null;
  const transport = stringValue(record.transport) === 'relay' ? 'relay' : 'direct';
  const authMode = stringValue(record.auth_mode) || 'hmac';
  const timeoutRecord =
    record.timeouts && typeof record.timeouts === 'object' && !Array.isArray(record.timeouts)
      ? (record.timeouts as Record<string, unknown>)
      : {};
  const requestMS =
    typeof timeoutRecord.request_ms === 'number' &&
    Number.isFinite(timeoutRecord.request_ms) &&
    timeoutRecord.request_ms > 0
      ? timeoutRecord.request_ms
      : undefined;
  const relayRecord =
    record.relay && typeof record.relay === 'object' && !Array.isArray(record.relay)
      ? (record.relay as Record<string, unknown>)
      : {};
  return {
    id,
    transport,
    auth_mode: authMode,
    connector_id: connectorID,
    key_id: keyID,
    secret_ref: secretRef,
    timeouts: requestMS ? { request_ms: requestMS } : undefined,
    relay: {
      verify_timeout_ms: numberValue(relayRecord.verify_timeout_ms),
      max_pending_requests: numberValue(relayRecord.max_pending_requests),
      challenge_ttl_ms: numberValue(relayRecord.challenge_ttl_ms),
      auth_failure_rate_limit_per_minute: numberValue(
        relayRecord.auth_failure_rate_limit_per_minute
      ),
      auth_failure_block_ms: numberValue(relayRecord.auth_failure_block_ms),
      secret_rotation_grace_ms: numberValue(relayRecord.secret_rotation_grace_ms),
    },
  };
}

function relayRuntimeSettings(
  settings: DirectoryConnectorSettingsItem
): DirectoryRelayRuntimeSettings {
  return {
    verifyTimeoutMs: clampInteger(
      settings.relay?.verify_timeout_ms,
      MIN_RELAY_VERIFY_TIMEOUT_MS,
      MAX_RELAY_VERIFY_TIMEOUT_MS,
      DEFAULT_RELAY_VERIFY_TIMEOUT_MS
    ),
    maxPendingRequests: clampInteger(
      settings.relay?.max_pending_requests,
      MIN_MAX_PENDING_REQUESTS,
      MAX_MAX_PENDING_REQUESTS,
      DEFAULT_MAX_PENDING_REQUESTS
    ),
    challengeTtlMs: clampInteger(
      settings.relay?.challenge_ttl_ms,
      MIN_RELAY_CHALLENGE_TTL_MS,
      MAX_RELAY_CHALLENGE_TTL_MS,
      DEFAULT_RELAY_CHALLENGE_TTL_MS
    ),
    authFailureRateLimitPerMinute: clampInteger(
      settings.relay?.auth_failure_rate_limit_per_minute,
      MIN_AUTH_FAILURE_RATE_LIMIT_PER_MINUTE,
      MAX_AUTH_FAILURE_RATE_LIMIT_PER_MINUTE,
      DEFAULT_AUTH_FAILURE_RATE_LIMIT_PER_MINUTE
    ),
    authFailureBlockMs: clampInteger(
      settings.relay?.auth_failure_block_ms,
      MIN_AUTH_FAILURE_BLOCK_MS,
      MAX_AUTH_FAILURE_BLOCK_MS,
      DEFAULT_AUTH_FAILURE_BLOCK_MS
    ),
    secretRotationGraceMs: clampInteger(
      settings.relay?.secret_rotation_grace_ms,
      MIN_SECRET_ROTATION_GRACE_MS,
      MAX_SECRET_ROTATION_GRACE_MS,
      DEFAULT_SECRET_ROTATION_GRACE_MS
    ),
  };
}

function defaultRelayRuntimeSettings(): DirectoryRelayRuntimeSettings {
  return {
    verifyTimeoutMs: DEFAULT_RELAY_VERIFY_TIMEOUT_MS,
    maxPendingRequests: DEFAULT_MAX_PENDING_REQUESTS,
    challengeTtlMs: DEFAULT_RELAY_CHALLENGE_TTL_MS,
    authFailureRateLimitPerMinute: DEFAULT_AUTH_FAILURE_RATE_LIMIT_PER_MINUTE,
    authFailureBlockMs: DEFAULT_AUTH_FAILURE_BLOCK_MS,
    secretRotationGraceMs: DEFAULT_SECRET_ROTATION_GRACE_MS,
  };
}

function clampInteger(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number
): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

async function resolveConnectorSecret(
  env: Env,
  tenantId: string,
  connectorId: string,
  settings: DirectoryConnectorSettingsItem,
  keyId: string
): Promise<DirectoryRelayResolvedSecret | undefined> {
  if (settings.secret_ref.startsWith('managed:')) {
    const refConnectorId = settings.secret_ref.slice('managed:'.length);
    if (refConnectorId !== settings.id && refConnectorId !== connectorId) return undefined;
    const record = await readManagedSecretRecord(env, tenantId, settings.id);
    if (record?.active.keyId === keyId) {
      return { secret: record.active.secret, keyId, active: true };
    }
    if (record?.previous?.keyId === keyId) {
      const retireAfter = Date.parse(record.previous.retireAfter);
      if (Number.isFinite(retireAfter) && retireAfter >= Date.now()) {
        return { secret: record.previous.secret, keyId, active: false, retireAfter };
      }
    }
    return undefined;
  }
  if (settings.key_id !== keyId) return undefined;
  const secret = resolveEnvConnectorSecret(env, settings.secret_ref);
  return secret ? { secret, keyId, active: true } : undefined;
}

async function readManagedSecretRecord(
  env: Env,
  tenantId: string,
  connectorId: string
): Promise<DirectoryRelayManagedSecretRecord | null> {
  const raw = await env.SETTINGS?.get(managedSecretRecordKey(tenantId, connectorId)).catch(
    () => null
  );
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DirectoryRelayManagedSecretRecord;
    if (!parsed?.active?.keyId || !parsed.active.secret) return null;
    return parsed;
  } catch {
    return null;
  }
}

function resolveEnvConnectorSecret(env: Env, secretRef: string): string | undefined {
  const envPrefix = 'env:';
  const envName = secretRef.startsWith(envPrefix) ? secretRef.slice(envPrefix.length) : secretRef;
  if (
    !/^[A-Z0-9_]+$/.test(envName) ||
    !ALLOWED_CONNECTOR_SECRET_ENV_PREFIXES.some((prefix) => envName.startsWith(prefix))
  ) {
    return undefined;
  }
  const value = (env as unknown as Record<string, unknown>)[envName];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function validRecentTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  return Math.abs(Date.now() - parsed) <= MAX_RELAY_CHALLENGE_TTL_MS;
}

function connectionRecordKey(connectionId: string): string {
  return `connection:${connectionId}`;
}

function statusRecordKey(tenantId: string, connectorId: string): string {
  return `status:${tenantId}:${connectorId}`;
}

function eventListRecordKey(tenantId: string, connectorId: string): string {
  return `events:${tenantId}:${connectorId}`;
}

function authFailureRecordKey(tenantId: string, connectorId: string): string {
  return `auth-failure:${tenantId}:${connectorId}`;
}

function usedNonceRecordKey(tenantId: string, connectorId: string, nonce: string): string {
  return `used-nonce:${tenantId}:${connectorId}:${nonce}`;
}

function managedSecretRecordKey(tenantId: string, connectorId: string): string {
  return `settings:tenant:${tenantId}:directory-connector-secret:${connectorId}`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function safeRelayEventString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  return normalized.slice(0, MAX_RELAY_EVENT_FIELD_LENGTH);
}

function relayVerifyErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object' || Array.isArray(error)) return 'relay_verify_error';
  const code = safeRelayEventString((error as { code?: unknown }).code);
  return code && RELAY_ERROR_CODE_PATTERN.test(code) ? code : 'relay_verify_error';
}

function relayVerifyErrorRetryable(error: unknown): boolean {
  if (!error || typeof error !== 'object' || Array.isArray(error)) return true;
  const retryable = (error as { retryable?: unknown }).retryable;
  return typeof retryable === 'boolean' ? retryable : true;
}

function sanitizeRelayInstanceId(value: unknown): string | undefined {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!WORDWARDEN_INSTANCE_ID_PATTERN.test(raw)) return undefined;
  return raw;
}

function sanitizeRelayMetadata(value: unknown): string | undefined {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return undefined;
  return raw.slice(0, MAX_RELAY_METADATA_FIELD_LENGTH);
}

function sanitizeRelayFingerprint(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  return /^sha256:[a-f0-9]{64}$/.test(raw) ? raw : 'sha256:' + '0'.repeat(64);
}

function sanitizeRelayCategories(value: unknown): string[] {
  if (!Array.isArray(value)) return ['relay'];
  const categories = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => /^[a-zA-Z0-9_.:-]{1,64}$/.test(item))
    .slice(0, 32);
  return categories.length > 0 ? categories : ['relay'];
}

function sanitizeRelayDriftSeverity(value: unknown): 'none' | 'warning' | 'critical' {
  return value === 'warning' || value === 'critical' ? value : 'none';
}

function validISODate(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false;
  return Number.isFinite(Date.parse(value));
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

async function readRequestTextWithLimit(
  request: Request,
  maxBytes: number
): Promise<string | 'too_large' | null> {
  const reader = request.body?.getReader();
  if (!reader) return null;

  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return 'too_large';
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch {
    return null;
  }
}

function passwordValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringArrayValue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function connectorError(code: string, retryable: boolean, status: number): Response {
  return jsonResponse(
    {
      error: {
        code,
        retryable,
      },
    },
    status
  );
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}
