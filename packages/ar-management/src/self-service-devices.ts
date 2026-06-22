import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Env, DeviceInstallation, DeviceSecret, Session } from '@authrim/ar-lib-core';
import {
  DeviceInstallationRepository,
  DeviceSecretRepository,
  createAuthContextFromHono,
  createPhase1ErrorDetails,
  getDeviceSecretInstallationId,
  getLogger,
  getSessionStoreBySessionId,
  getTenantIdFromContext,
  introspectTokenFromContext,
  isShardedSessionId,
} from '@authrim/ar-lib-core';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_DISPLAY_NAME_LENGTH = 64;
const CURSOR_PREFIX = 'cur_';

type SelfServiceAccess = {
  sub: string;
  clientId?: string;
  sessionId?: string;
  currentInstallationId?: string;
};

type DeviceInventoryItem = {
  id: string;
  display_name: string;
  fallback_display_name?: string;
  platform: string;
  current: boolean;
  last_seen_at: string | null;
  last_seen_at_unix: number | null;
  client_id?: string;
  app_display_name?: string;
};

type CursorPayload = {
  offset: number;
  sub: string;
  tenant_id: string;
};

type ClientDisplayNameRepository = {
  findByClientId(clientId: string): Promise<{ client_name?: string | null } | null>;
};

function base64UrlEncode(input: string): string {
  return btoa(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(input: string): string {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  return atob(padded);
}

async function signCursorPayload(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return base64UrlEncode(String.fromCharCode(...new Uint8Array(signature)));
}

async function buildCursor(
  payload: CursorPayload,
  secret: string | undefined
): Promise<string | undefined> {
  if (!secret) {
    return undefined;
  }

  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = await signCursorPayload(encodedPayload, secret);
  return `${CURSOR_PREFIX}${encodedPayload}.${signature}`;
}

async function parseCursor(
  cursor: string | undefined,
  secret: string | undefined,
  expectedSub: string,
  expectedTenantId: string
): Promise<CursorPayload | null> {
  if (!cursor) {
    return { offset: 0, sub: expectedSub, tenant_id: expectedTenantId };
  }

  if (!secret || !cursor.startsWith(CURSOR_PREFIX)) {
    return null;
  }

  const token = cursor.slice(CURSOR_PREFIX.length);
  const [encodedPayload, signature] = token.split('.');
  if (!encodedPayload || !signature) {
    return null;
  }

  const expectedSignature = await signCursorPayload(encodedPayload, secret);
  if (signature !== expectedSignature) {
    return null;
  }

  try {
    const parsed = JSON.parse(base64UrlDecode(encodedPayload)) as CursorPayload;
    if (
      !Number.isInteger(parsed.offset) ||
      parsed.offset < 0 ||
      parsed.sub !== expectedSub ||
      parsed.tenant_id !== expectedTenantId
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function invalidCursorResponse(c: Context<{ Bindings: Env }>): Response {
  setNoStore(c);
  return c.json(
    {
      error: 'invalid_request',
      error_description: 'Cursor is invalid',
      error_details: createPhase1ErrorDetails('invalid_cursor'),
    },
    400
  );
}

function validationError(c: Context<{ Bindings: Env }>, description: string): Response {
  setNoStore(c);
  return c.json(
    {
      error: 'invalid_request',
      error_description: description,
    },
    400
  );
}

function setNoStore(c: Context<{ Bindings: Env }>): void {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
}

async function requireSelfServiceAccess(
  c: Context<{ Bindings: Env }>
): Promise<SelfServiceAccess | Response> {
  const pathname = new URL(c.req.url).pathname;
  if (pathname.startsWith('/api/account/')) {
    return requireSessionSelfServiceAccess(c);
  }

  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return bearerTokenRequired(c);
  }

  const introspection = await introspectTokenFromContext(c);
  if (!introspection.valid || !introspection.claims) {
    const error = introspection.error;
    if (error) {
      c.header('WWW-Authenticate', error.wwwAuthenticate);
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      return c.json(
        {
          error: error.error,
          error_description: error.error_description,
        },
        error.statusCode as 400 | 401 | 403
      );
    }
    return c.json({ error: 'invalid_token', error_description: 'Access token is invalid' }, 401);
  }

  const sub = introspection.claims.sub;
  if (typeof sub !== 'string' || sub.length === 0) {
    return c.json(
      { error: 'invalid_token', error_description: 'Access token subject is missing' },
      401
    );
  }

  return {
    sub,
    clientId:
      typeof introspection.claims.client_id === 'string'
        ? introspection.claims.client_id
        : undefined,
    sessionId: typeof introspection.claims.sid === 'string' ? introspection.claims.sid : undefined,
    currentInstallationId:
      typeof introspection.claims.authrim_installation_id === 'string'
        ? introspection.claims.authrim_installation_id
        : undefined,
  };
}

function bearerTokenRequired(c: Context<{ Bindings: Env }>): Response {
  setNoStore(c);
  c.header('WWW-Authenticate', 'Bearer error="invalid_token"');
  return c.json(
    {
      error: 'invalid_token',
      error_description: 'Access token is required',
    },
    401
  );
}

async function requireSessionSelfServiceAccess(
  c: Context<{ Bindings: Env }>
): Promise<SelfServiceAccess | Response> {
  const sessionId = getCookie(c, 'authrim_session');
  if (!sessionId || !isShardedSessionId(sessionId)) {
    setNoStore(c);
    return c.json({ error: 'unauthorized', error_description: 'Authentication required' }, 401);
  }

  try {
    const tenantId = getTenantIdFromContext(c);
    const { stub: sessionStore } = getSessionStoreBySessionId(c.env, sessionId, tenantId);
    const session = (await sessionStore.getSessionRpc(sessionId)) as Session | null;
    if (
      !session ||
      !session.userId ||
      session.expiresAt <= Date.now() ||
      (session.tenantId !== undefined && session.tenantId !== tenantId)
    ) {
      setNoStore(c);
      return c.json(
        { error: 'unauthorized', error_description: 'Session has expired or is invalid' },
        401
      );
    }

    return {
      sub: session.userId,
      sessionId: session.id,
    };
  } catch (error) {
    const log = getLogger(c).module('SELF-SERVICE-DEVICES');
    log.error('Session validation failed', { action: 'session_validate' }, error as Error);
    setNoStore(c);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to validate session',
      },
      500
    );
  }
}

function normalizePlatform(platform: unknown): string {
  if (typeof platform !== 'string' || platform.length === 0) {
    return 'unknown';
  }
  return platform;
}

function formatTime(ms: number | undefined): { rfc3339: string | null; unix: number | null } {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) {
    return { rfc3339: null, unix: null };
  }

  const unix = Math.floor(ms / 1000);
  return {
    rfc3339: new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    unix,
  };
}

function toDeviceInventoryItem(
  entity: DeviceSecret,
  access: SelfServiceAccess,
  appDisplayName?: string
): DeviceInventoryItem {
  const platform = normalizePlatform(entity.device_platform);
  const displayName = entity.device_name ?? '';
  const lastSeen = formatTime(entity.last_used_at);
  const current = isDeviceSecretCurrent(entity, access);
  const clientId = getDeviceSecretInventoryClientId(entity, access);

  return {
    id: getDeviceSecretInstallationId(entity),
    display_name: displayName,
    ...(displayName.length === 0 && {
      fallback_display_name: platform === 'unknown' ? 'Native device' : `${platform} device`,
    }),
    platform,
    current,
    last_seen_at: lastSeen.rfc3339,
    last_seen_at_unix: lastSeen.unix,
    ...(clientId && { client_id: clientId }),
    ...(appDisplayName && { app_display_name: appDisplayName }),
  };
}

function toInstallationInventoryItem(
  entity: DeviceInstallation,
  access: SelfServiceAccess,
  appDisplayName?: string
): DeviceInventoryItem {
  const platform = normalizePlatform(entity.device_platform);
  const displayName = entity.display_name ?? '';
  const lastSeen = formatTime(entity.last_seen_at);
  const current = isInstallationCurrent(entity, access);
  const clientId = getInstallationInventoryClientId(entity, access);

  return {
    id: entity.id,
    display_name: displayName,
    ...(displayName.length === 0 && {
      fallback_display_name: platform === 'unknown' ? 'Native device' : `${platform} device`,
    }),
    platform,
    current,
    last_seen_at: lastSeen.rfc3339,
    last_seen_at_unix: lastSeen.unix,
    ...(clientId && { client_id: clientId }),
    ...(appDisplayName && { app_display_name: appDisplayName }),
  };
}

function isDeviceSecretCurrent(entity: DeviceSecret, access: SelfServiceAccess): boolean {
  return (
    getDeviceSecretInstallationId(entity) === access.currentInstallationId ||
    (!access.currentInstallationId &&
      access.sessionId !== undefined &&
      entity.session_id === access.sessionId)
  );
}

function isInstallationCurrent(entity: DeviceInstallation, access: SelfServiceAccess): boolean {
  return (
    entity.id === access.currentInstallationId ||
    (!access.currentInstallationId &&
      access.sessionId !== undefined &&
      entity.session_id === access.sessionId)
  );
}

function getDeviceSecretInventoryClientId(
  entity: DeviceSecret,
  access: SelfServiceAccess
): string | undefined {
  return entity.client_id ?? (isDeviceSecretCurrent(entity, access) ? access.clientId : undefined);
}

function getInstallationInventoryClientId(
  entity: DeviceInstallation,
  access: SelfServiceAccess
): string | undefined {
  return entity.client_id ?? (isInstallationCurrent(entity, access) ? access.clientId : undefined);
}

async function buildAppDisplayNameMap(
  repo: ClientDisplayNameRepository,
  clientIds: Iterable<string | undefined>
): Promise<Map<string, string>> {
  const uniqueClientIds = [
    ...new Set([...clientIds].filter((value): value is string => Boolean(value))),
  ];
  const entries = await Promise.all(
    uniqueClientIds.map(async (clientId) => {
      const client = await repo.findByClientId(clientId);
      const clientName =
        typeof client?.client_name === 'string' && client.client_name.length > 0
          ? client.client_name
          : undefined;
      return [clientId, clientName] as const;
    })
  );

  const names = new Map<string, string>();
  for (const [clientId, clientName] of entries) {
    if (clientName) {
      names.set(clientId, clientName);
    }
  }
  return names;
}

function mergeInstallations(
  installations: Array<DeviceInstallation | null | undefined>
): DeviceInstallation[] {
  const byId = new Map<string, DeviceInstallation>();
  for (const installation of installations) {
    if (!installation) {
      continue;
    }
    const existing = byId.get(installation.id);
    if (!existing || (installation.updated_at ?? 0) > (existing.updated_at ?? 0)) {
      byId.set(installation.id, installation);
    }
  }
  return [...byId.values()];
}

function isInstallationVisible(
  installation: DeviceInstallation,
  input: {
    trustGroupId?: string;
    clientId?: string;
  }
): boolean {
  if (input.trustGroupId) {
    return installation.trust_group_id === input.trustGroupId;
  }
  if (input.clientId) {
    return installation.client_id === input.clientId;
  }
  return true;
}

function sortDevices(a: DeviceInventoryItem, b: DeviceInventoryItem): number {
  if (a.current !== b.current) {
    return a.current ? -1 : 1;
  }
  return (b.last_seen_at_unix ?? 0) - (a.last_seen_at_unix ?? 0);
}

function normalizeLimit(raw: string | undefined): number {
  const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_LIMIT;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(parsed, MAX_LIMIT);
}

async function findOwnedDevice(
  repo: DeviceSecretRepository,
  userId: string,
  deviceId: string
): Promise<DeviceSecret | null> {
  const device = await repo.findByInstallationId(deviceId);
  if (
    !device ||
    device.user_id !== userId ||
    device.is_active !== 1 ||
    device.revoked_at ||
    device.expires_at <= Date.now()
  ) {
    return null;
  }
  return device;
}

async function findOwnedInstallation(
  repo: DeviceInstallationRepository,
  userId: string,
  tenantId: string,
  installationId: string
): Promise<DeviceInstallation | null> {
  const installation = await repo.findById(installationId, tenantId);
  if (
    !installation ||
    installation.user_id !== userId ||
    installation.is_active !== 1 ||
    installation.revoked_at
  ) {
    return null;
  }
  return installation;
}

export async function listMyDevicesHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  setNoStore(c);
  const access = await requireSelfServiceAccess(c);
  if (access instanceof Response) {
    return access;
  }

  const tenantId = getTenantIdFromContext(c);
  const cursor = await parseCursor(
    c.req.query('cursor'),
    c.env.KEY_MANAGER_SECRET,
    access.sub,
    tenantId
  );
  if (!cursor) {
    return invalidCursorResponse(c);
  }

  const limit = normalizeLimit(c.req.query('limit'));
  const authCtx = createAuthContextFromHono(c, tenantId);
  const repo = new DeviceSecretRepository(authCtx.coreAdapter, tenantId);
  const installationRepo = new DeviceInstallationRepository(authCtx.coreAdapter, tenantId);
  const legacySecrets = await repo.findByUserId(access.sub, tenantId, true);
  const migratedInstallations = await Promise.all(
    legacySecrets.map((device) => installationRepo.ensureForDeviceSecret(device))
  );
  const currentInstallation = access.currentInstallationId
    ? await installationRepo.findById(access.currentInstallationId, tenantId)
    : undefined;
  const visibility = {
    trustGroupId: currentInstallation?.trust_group_id,
    clientId: currentInstallation?.trust_group_id ? undefined : currentInstallation?.client_id,
  };
  const canonicalInstallations = await installationRepo.findByUserId(access.sub, tenantId, {
    validOnly: true,
    trustGroupId: visibility.trustGroupId,
    clientId: visibility.clientId,
  });
  const installations = mergeInstallations([...canonicalInstallations, ...migratedInstallations]);
  const appDisplayNames = await buildAppDisplayNameMap(authCtx.repositories.client, [
    ...installations.map((installation) => getInstallationInventoryClientId(installation, access)),
    ...legacySecrets.map((device) => getDeviceSecretInventoryClientId(device, access)),
  ]);
  const devices =
    installations.length > 0
      ? installations
          .filter((installation) => isInstallationVisible(installation, visibility))
          .map((installation) => {
            const clientId = getInstallationInventoryClientId(installation, access);
            return toInstallationInventoryItem(
              installation,
              access,
              clientId ? appDisplayNames.get(clientId) : undefined
            );
          })
          .sort(sortDevices)
      : legacySecrets
          .map((device) => {
            const clientId = getDeviceSecretInventoryClientId(device, access);
            return toDeviceInventoryItem(
              device,
              access,
              clientId ? appDisplayNames.get(clientId) : undefined
            );
          })
          .sort(sortDevices);

  const page = devices.slice(cursor.offset, cursor.offset + limit);
  const nextOffset = cursor.offset + page.length;
  const nextCursor =
    nextOffset < devices.length
      ? await buildCursor(
          { offset: nextOffset, sub: access.sub, tenant_id: tenantId },
          c.env.KEY_MANAGER_SECRET
        )
      : undefined;

  return c.json({
    devices: page,
    ...(nextCursor && { next_cursor: nextCursor }),
  });
}

export async function updateMyDeviceHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  setNoStore(c);
  const access = await requireSelfServiceAccess(c);
  if (access instanceof Response) {
    return access;
  }

  let body: { display_name?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return validationError(c, 'Request body must be JSON');
  }

  const rawDisplayName = body.display_name;
  if (typeof rawDisplayName !== 'string') {
    return validationError(c, 'display_name is required');
  }

  const displayName = rawDisplayName.trim().replace(/\s+/g, ' ');
  if (displayName.length === 0) {
    return validationError(c, 'display_name must not be empty');
  }
  if (displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    return validationError(c, 'display_name must not exceed 64 characters');
  }

  const tenantId = getTenantIdFromContext(c);
  const deviceId = c.req.param('id');
  if (!deviceId) {
    return c.json({ error: 'not_found', error_description: 'Device was not found' }, 404);
  }
  const authCtx = createAuthContextFromHono(c, tenantId);
  const repo = new DeviceSecretRepository(authCtx.coreAdapter, tenantId);
  const installationRepo = new DeviceInstallationRepository(authCtx.coreAdapter, tenantId);
  const existingInstallation = await findOwnedInstallation(
    installationRepo,
    access.sub,
    tenantId,
    deviceId
  );
  if (existingInstallation) {
    const updated =
      (await installationRepo.updateDisplayName(existingInstallation.id, tenantId, displayName)) ??
      existingInstallation;
    if (updated.linked_device_secret_id) {
      await repo.update(updated.linked_device_secret_id, { device_name: displayName }, tenantId);
    }
    const clientId = getInstallationInventoryClientId(updated, access);
    const appDisplayNames = await buildAppDisplayNameMap(authCtx.repositories.client, [clientId]);
    return c.json({
      device: toInstallationInventoryItem(
        updated,
        access,
        clientId ? appDisplayNames.get(clientId) : undefined
      ),
    });
  }

  const existing = await findOwnedDevice(repo, access.sub, deviceId);
  if (!existing) {
    return c.json({ error: 'not_found', error_description: 'Device was not found' }, 404);
  }

  const updated =
    (await repo.update(existing.id, { device_name: displayName }, tenantId)) ?? existing;
  await installationRepo.ensureForDeviceSecret(updated);
  const clientId = getDeviceSecretInventoryClientId(updated, access);
  const appDisplayNames = await buildAppDisplayNameMap(authCtx.repositories.client, [clientId]);
  return c.json({
    device: toDeviceInventoryItem(
      updated,
      access,
      clientId ? appDisplayNames.get(clientId) : undefined
    ),
  });
}

export async function deleteMyDeviceHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  setNoStore(c);
  const access = await requireSelfServiceAccess(c);
  if (access instanceof Response) {
    return access;
  }

  const tenantId = getTenantIdFromContext(c);
  const deviceId = c.req.param('id');
  if (!deviceId) {
    return c.json({ error: 'not_found', error_description: 'Device was not found' }, 404);
  }
  const authCtx = createAuthContextFromHono(c, tenantId);
  const repo = new DeviceSecretRepository(authCtx.coreAdapter, tenantId);
  const installationRepo = new DeviceInstallationRepository(authCtx.coreAdapter, tenantId);
  const existingInstallation = await findOwnedInstallation(
    installationRepo,
    access.sub,
    tenantId,
    deviceId
  );
  if (existingInstallation) {
    const isCurrent =
      existingInstallation.id === access.currentInstallationId ||
      (!access.currentInstallationId &&
        access.sessionId !== undefined &&
        existingInstallation.session_id === access.sessionId);
    const installationRevoked = await installationRepo.revoke(
      existingInstallation.id,
      tenantId,
      'device_unlink'
    );
    if (existingInstallation.linked_device_secret_id) {
      await repo.revoke(existingInstallation.linked_device_secret_id, 'device_unlink', tenantId);
    }

    return c.json({
      ok: true,
      device_unlink_result: {
        action: 'device_unlinked',
        target_id: existingInstallation.id,
        signed_out_required: isCurrent,
        status: installationRevoked ? 'completed' : 'already_applied',
      },
    });
  }

  const existing = await findOwnedDevice(repo, access.sub, deviceId);
  if (!existing) {
    return c.json({ error: 'not_found', error_description: 'Device was not found' }, 404);
  }

  const isCurrent =
    getDeviceSecretInstallationId(existing) === access.currentInstallationId ||
    (!access.currentInstallationId &&
      access.sessionId !== undefined &&
      existing.session_id === access.sessionId);

  const revoked = await repo.revoke(existing.id, 'device_unlink', tenantId);
  const legacyInstallation = await installationRepo.ensureForDeviceSecret(existing);
  if (legacyInstallation) {
    await installationRepo.revoke(legacyInstallation.id, tenantId, 'device_unlink');
  }

  return c.json({
    ok: true,
    device_unlink_result: {
      action: 'device_unlinked',
      target_id: getDeviceSecretInstallationId(existing),
      signed_out_required: isCurrent,
      status: revoked ? 'completed' : 'already_applied',
    },
  });
}
