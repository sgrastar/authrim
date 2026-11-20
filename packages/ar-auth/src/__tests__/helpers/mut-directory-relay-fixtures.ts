import { vi } from 'vitest';
import { DirectoryConnectorRelay } from '../../directory-connector-relay';
import {
  buildDirectoryRelayAuthCanonical,
  signDirectoryRelayCanonical,
} from '../../directory-relay-protocol';

export const TENANT = 'tenant-a';
export const CONNECTOR = 'wwcon_8K4M2Q9F7D3H6P1X';
export const SETTINGS_KEY = `settings:tenant:${TENANT}:directory-connectors`;
export const PROTOCOL = 'authrim.wordwarden.relay.v1';
export const AUTH_FAILURE_KEY = `auth-failure:${TENANT}:${CONNECTOR}`;
export const EVENTS_KEY = `events:${TENANT}:${CONNECTOR}`;
export const STATUS_KEY = `status:${TENANT}:${CONNECTOR}`;

export function createStorage() {
  const values = new Map<string, unknown>();
  return {
    get: vi.fn(async <T>(key: string): Promise<T | undefined> => values.get(key) as T | undefined),
    put: vi.fn(async (key: string, value: unknown) => {
      values.set(key, value);
    }),
    delete: vi.fn(async (key: string) => values.delete(key)),
    _values: values,
  };
}

export function baseConnector(overrides: Record<string, unknown> = {}) {
  return {
    id: 'campus',
    transport: 'relay',
    auth_mode: 'hmac',
    connector_id: CONNECTOR,
    key_id: 'kid-active',
    secret_ref: 'env:WORDWARDEN_SECRET',
    ...overrides,
  };
}

export function createRelay(
  options: {
    connector?: Record<string, unknown>;
    settings?: Record<string, string | null>;
    env?: Record<string, unknown>;
  } = {}
) {
  const storage = createStorage();
  const settings: Record<string, string | null> = {
    [SETTINGS_KEY]: JSON.stringify({ connectors: [baseConnector(options.connector)] }),
    ...options.settings,
  };
  const env = {
    SETTINGS: { get: vi.fn(async (key: string) => settings[key] ?? null) },
    WORDWARDEN_SECRET: 'active-secret',
    ...options.env,
  };
  const ctx = {
    storage,
    getWebSockets: vi.fn((): WebSocket[] => []),
    acceptWebSocket: vi.fn(),
  };
  return {
    relay: new DirectoryConnectorRelay(ctx as unknown as DurableObjectState, env as never),
    ctx,
    storage,
    env,
    settings,
  };
}

export function relayWebSocket(attachment: Record<string, unknown> | null) {
  const sent: Array<Record<string, unknown>> = [];
  const raw = {
    deserializeAttachment: vi.fn(() => attachment),
    serializeAttachment: vi.fn(),
    send: vi.fn((value: string): void => {
      sent.push(JSON.parse(value) as Record<string, unknown>);
    }),
    close: vi.fn(),
  };
  return { ws: raw as unknown as WebSocket, sent, raw };
}

export function attachment(overrides: Record<string, unknown> = {}) {
  return {
    connectionId: 'connection-1',
    tenantId: TENANT,
    connectorId: CONNECTOR,
    challengeId: 'challenge-1',
    nonce: 'nonce-1',
    challengeExpiresAt: Date.now() + 30_000,
    connectedAt: Date.now(),
    ...overrides,
  };
}

export async function authResponse(
  overrides: Record<string, unknown> = {},
  secret = 'active-secret'
) {
  const base = {
    type: 'auth.response',
    protocol: PROTOCOL,
    protocol_version: 1,
    min_supported_version: 1,
    tenant_id: TENANT,
    connector_id: CONNECTOR,
    key_id: 'kid-active',
    challenge_id: 'challenge-1',
    nonce: 'nonce-1',
    timestamp: new Date().toISOString(),
    instance_id: 'wwi_1234567890123456789012',
    ...overrides,
  };
  const canonical = buildDirectoryRelayAuthCanonical({
    tenantId: String(base.tenant_id),
    connectorId: String(base.connector_id),
    keyId: String(base.key_id),
    protocolVersion: Number(base.protocol_version),
    minSupportedVersion: Number(base.min_supported_version),
    challengeId: String(base.challenge_id),
    nonce: String(base.nonce),
    timestamp: String(base.timestamp),
  });
  return { ...base, signature: await signDirectoryRelayCanonical(canonical, secret) };
}

export async function authenticate(
  storage: ReturnType<typeof createStorage>,
  connectionId = 'connection-1',
  keyId = 'kid-active'
) {
  await storage.put(`connection:${connectionId}`, {
    authenticated: true,
    tenantId: TENANT,
    connectorId: CONNECTOR,
    keyId,
    authenticatedAt: Date.now(),
  });
}

export function verifyRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request('https://directory-relay.internal/verify-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

export function verifyBody(overrides: Record<string, unknown> = {}) {
  return {
    request_id: 'req_1',
    tenant_id: TENANT,
    connector_id: CONNECTOR,
    username: 'alice',
    password: 'correct',
    ...overrides,
  };
}

export type PendingEntry = {
  resolve: (response: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  expiresAt: number;
  requestId: string;
  tenantId: string;
  connectorId: string;
};

export function pendingMap(relay: DirectoryConnectorRelay): Map<string, PendingEntry> {
  return (relay as unknown as { pending: Map<string, PendingEntry> }).pending;
}

export function addPending(
  relay: DirectoryConnectorRelay,
  id: string,
  overrides: Partial<PendingEntry> = {}
): PendingEntry {
  const entry: PendingEntry = {
    resolve: vi.fn(),
    reject: vi.fn(),
    timeout: setTimeout(() => undefined, 0),
    expiresAt: Date.now() + 10_000,
    requestId: 'request-1',
    tenantId: TENANT,
    connectorId: CONNECTOR,
    ...overrides,
  };
  pendingMap(relay).set(id, entry);
  return entry;
}

export function events(storage: ReturnType<typeof createStorage>) {
  return (
    (storage._values.get(EVENTS_KEY) as { events: Array<Record<string, unknown>> } | undefined)
      ?.events ?? []
  );
}

/**
 * Node's Response refuses status 101 and has no `webSocket` init; Workers accept both. This
 * subclass lets the upgrade path run under Node without changing the code under test.
 */
export class WorkersLikeResponse extends Response {
  constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: unknown }) {
    const status = init?.status;
    super(body, status === 101 ? { ...init, status: 200 } : init);
    if (status === 101) Object.defineProperty(this, 'status', { value: 101 });
    Object.defineProperty(this, 'webSocket', { value: init?.webSocket ?? null });
  }
}
