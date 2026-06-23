import { DurableObject } from 'cloudflare:workers';
import type { Env } from '@authrim/ar-lib-core';
import {
  constantTimeHexEqual,
  DIRECTORY_RELAY_PROTOCOL,
  buildDirectoryRelayAuthCanonical,
  isDirectoryRelayClientMessage,
  signDirectoryRelayCanonical,
  type DirectoryRelayAuthResponseMessage,
  type DirectoryRelayVerifyErrorMessage,
  type DirectoryRelayChallengeMessage,
  type DirectoryRelayVerifyResponseMessage,
} from './directory-relay-protocol';

const CONNECTOR_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const RELAY_CHALLENGE_TTL_MS = 60_000;
const RELAY_VERIFY_TIMEOUT_MS = 3000;
const MAX_VERIFY_BODY_BYTES = 64 * 1024;
const ALLOWED_CONNECTOR_SECRET_ENV_PREFIXES = ['AUTHRIM_WORDWARDEN_', 'WORDWARDEN_'];

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
      return this.handleStatus();
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
    await this.deleteConnectionRecord(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.deleteConnectionRecord(ws);
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

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const now = Date.now();
    const attachment: DirectoryRelayAttachment = {
      connectionId: crypto.randomUUID(),
      tenantId: route.tenantId,
      connectorId: route.connectorId,
      challengeId: crypto.randomUUID(),
      nonce: crypto.randomUUID(),
      challengeExpiresAt: now + RELAY_CHALLENGE_TTL_MS,
      connectedAt: now,
    };

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(attachment);
    this.scheduleAuthenticationTimeout(server, attachment);

    const challenge: DirectoryRelayChallengeMessage = {
      type: 'auth.challenge',
      protocol: DIRECTORY_RELAY_PROTOCOL,
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
      ws.close(1008, 'auth context mismatch');
      return;
    }
    if (Date.now() > attachment.challengeExpiresAt || !validRecentTimestamp(message.timestamp)) {
      this.sendError(ws, 'stale_auth_challenge', 'Authentication challenge expired');
      ws.close(1008, 'stale auth challenge');
      return;
    }

    const settings = await findConnectorSettings(this.env, attachment.tenantId, attachment.connectorId);
    const secret = settings?.secret_ref ? resolveConnectorSecret(this.env, settings.secret_ref) : undefined;
    if (!settings || settings.transport !== 'relay' || settings.key_id !== message.key_id || !secret) {
      this.sendError(ws, 'relay_auth_failed', 'Relay authentication failed');
      ws.close(1008, 'relay authentication failed');
      return;
    }

    const canonical = buildDirectoryRelayAuthCanonical({
      tenantId: message.tenant_id,
      connectorId: message.connector_id,
      keyId: message.key_id,
      challengeId: message.challenge_id,
      nonce: message.nonce,
      timestamp: message.timestamp,
    });
    const expected = await signDirectoryRelayCanonical(canonical, secret);
    if (!constantTimeHexEqual(expected, message.signature)) {
      this.sendError(ws, 'relay_auth_failed', 'Relay authentication failed');
      ws.close(1008, 'relay authentication failed');
      return;
    }

    await this.closeOtherAuthenticatedSockets(ws, attachment);
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
    ws.send(
      JSON.stringify({
        type: 'auth.ok',
        protocol: DIRECTORY_RELAY_PROTOCOL,
        tenant_id: attachment.tenantId,
        connector_id: attachment.connectorId,
      })
    );
  }

  private scheduleAuthenticationTimeout(
    ws: WebSocket,
    attachment: DirectoryRelayAttachment
  ): void {
    setTimeout(() => {
      this.isAuthenticated(ws)
        .then((authenticated) => {
          if (!authenticated) {
            ws.close(1008, 'relay authentication timeout');
            return this.ctx.storage.delete(connectionRecordKey(attachment.connectionId));
          }
          return undefined;
        })
        .catch(() => {
          ws.close(1011, 'relay authentication check failed');
        });
    }, Math.max(0, attachment.challengeExpiresAt - Date.now() + 1000));
  }

  private async handleVerifyPassword(request: Request): Promise<Response> {
    if (!request.body) {
      return connectorError('invalid_relay_request', false, 400);
    }
    const contentLength = Number(request.headers.get('content-length') || '0');
    if (contentLength > MAX_VERIFY_BODY_BYTES) {
      return connectorError('relay_request_too_large', false, 413);
    }

    let bodyText: string;
    try {
      bodyText = await request.text();
    } catch {
      return connectorError('invalid_relay_request', false, 400);
    }
    if (new TextEncoder().encode(bodyText).byteLength > MAX_VERIFY_BODY_BYTES) {
      return connectorError('relay_request_too_large', false, 413);
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

    const ws = await this.authenticatedWebSocket(tenantId, connectorId);
    if (!ws) {
      return connectorError('relay_connector_offline', true, 503);
    }

    const id = crypto.randomUUID();
    const responsePromise = new Promise<DirectoryRelayVerifyResponseMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('relay_verify_timeout'));
      }, RELAY_VERIFY_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timeout, requestId, tenantId, connectorId });
    });

    try {
      ws.send(
        JSON.stringify({
          type: 'verify.request',
          protocol: DIRECTORY_RELAY_PROTOCOL,
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
      this.pending.delete(id);
      return connectorError('relay_send_failed', true, 503);
    }

    try {
      const response = await responsePromise;
      return jsonResponse(response);
    } catch (error) {
      const code = error instanceof Error ? error.message : 'relay_verify_error';
      if (code === 'relay_verify_timeout') {
        return connectorError('relay_verify_timeout', true, 504);
      }
      return connectorError(code, true, 503);
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
      pending.reject(new Error('relay_response_mismatch'));
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
      pending.reject(new Error('relay_response_mismatch'));
      ws.close(1008, 'relay response mismatch');
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timeout);
    pending.reject(new Error(message.error?.code || 'relay_verify_error'));
  }

  private async handleStatus(): Promise<Response> {
    const websockets = this.ctx.getWebSockets();
    let authenticated = 0;
    for (const ws of websockets) {
      if (await this.isAuthenticated(ws)) authenticated += 1;
    }
    return jsonResponse({
      ok: true,
      connections: websockets.length,
      authenticated_connections: authenticated,
    });
  }

  private async authenticatedWebSocket(
    tenantId: string,
    connectorId: string
  ): Promise<WebSocket | null> {
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = this.getAttachment(ws);
      if (!attachment || attachment.tenantId !== tenantId || attachment.connectorId !== connectorId) {
        continue;
      }
      if (await this.isAuthenticated(ws)) return ws;
    }
    return null;
  }

  private async isAuthenticated(ws: WebSocket): Promise<boolean> {
    const attachment = this.getAttachment(ws);
    if (!attachment) return false;
    const record = await this.ctx.storage.get<DirectoryRelayConnectionRecord>(
      connectionRecordKey(attachment.connectionId)
    );
    return Boolean(
      record?.authenticated &&
        record.tenantId === attachment.tenantId &&
        record.connectorId === attachment.connectorId
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
        await this.deleteConnectionRecord(ws);
        ws.close(1000, 'replaced by newer relay connection');
      }
    }
  }

  private async deleteConnectionRecord(ws: WebSocket): Promise<void> {
    const attachment = this.getAttachment(ws);
    if (attachment) {
      await this.ctx.storage.delete(connectionRecordKey(attachment.connectionId));
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
        code,
        message,
      })
    );
  }
}

function parseRelayRoute(pathname: string): { tenantId: string; connectorId: string } | null {
  const match = pathname.match(
    /^\/api\/auth\/directory-relay\/connect\/([^/]+)\/([^/]+)$/
  );
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
  return {
    id,
    transport,
    auth_mode: authMode,
    connector_id: connectorID,
    key_id: keyID,
    secret_ref: secretRef,
    timeouts: requestMS ? { request_ms: requestMS } : undefined,
  };
}

function resolveConnectorSecret(env: Env, secretRef: string): string | undefined {
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
  return Math.abs(Date.now() - parsed) <= RELAY_CHALLENGE_TTL_MS;
}

function connectionRecordKey(connectionId: string): string {
  return `connection:${connectionId}`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
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
