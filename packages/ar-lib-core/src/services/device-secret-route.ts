import type { Env } from '../types/env';
import type { DeviceSecretRouteHint } from '../durable-objects/DeviceSecretRouteStore';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const DEVICE_SECRET = /^[A-Za-z0-9_-]{32,512}$/u;

interface DeviceSecretRouteStoreStub {
  putRouteHintRpc(value: DeviceSecretRouteHint): Promise<{ stored: true }>;
  getRouteHintRpc(input: { tenantId: string; now: number }): Promise<DeviceSecretRouteHint | null>;
  deleteRouteHintRpc(input: { tenantId: string; accountId: string }): Promise<{ deleted: boolean }>;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function stubForSecret(env: Env, tenantId: string, secret: string) {
  if (!env.DEVICE_SECRET_ROUTE_STORE) throw new Error('device_secret_route_store_unavailable');
  if (!SAFE_ID.test(tenantId) || !DEVICE_SECRET.test(secret)) {
    throw new Error('device_secret_route_input_invalid');
  }
  const digest = await sha256Hex(secret);
  const id = env.DEVICE_SECRET_ROUTE_STORE.idFromName(`${tenantId}:${digest}`);
  return env.DEVICE_SECRET_ROUTE_STORE.get(id) as unknown as DeviceSecretRouteStoreStub;
}

export async function recordDeviceSecretRouteHint(
  env: Env,
  input: {
    secret: string;
    tenantId: string;
    accountId: string;
    issuedAt: number;
    expiresAt: number;
  }
): Promise<void> {
  const stub = await stubForSecret(env, input.tenantId, input.secret);
  const result = await stub.putRouteHintRpc({
    tenantId: input.tenantId,
    accountId: input.accountId,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
  });
  if (result.stored !== true) throw new Error('device_secret_route_hint_write_failed');
}

export async function resolveDeviceSecretRouteHint(
  env: Env,
  input: { secret: string; tenantId: string; now?: number }
): Promise<DeviceSecretRouteHint | null> {
  return (await stubForSecret(env, input.tenantId, input.secret)).getRouteHintRpc({
    tenantId: input.tenantId,
    now: input.now ?? Date.now(),
  });
}

export async function deleteDeviceSecretRouteHint(
  env: Env,
  input: { secret: string; tenantId: string; accountId: string }
): Promise<boolean> {
  return (
    await (
      await stubForSecret(env, input.tenantId, input.secret)
    ).deleteRouteHintRpc({
      tenantId: input.tenantId,
      accountId: input.accountId,
    })
  ).deleted;
}
