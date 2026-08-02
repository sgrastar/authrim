import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types/env';

const ROUTE_KEY = 'route';
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;

export interface DeviceSecretRouteHint {
  tenantId: string;
  accountId: string;
  issuedAt: number;
  expiresAt: number;
}

function validateHint(value: unknown): DeviceSecretRouteHint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('device_secret_route_hint_invalid');
  }
  const hint = value as Record<string, unknown>;
  if (
    Object.keys(hint).length !== 4 ||
    typeof hint.tenantId !== 'string' ||
    !SAFE_ID.test(hint.tenantId) ||
    typeof hint.accountId !== 'string' ||
    !SAFE_ID.test(hint.accountId) ||
    !hint.accountId.startsWith('account:') ||
    typeof hint.issuedAt !== 'number' ||
    !Number.isSafeInteger(hint.issuedAt) ||
    hint.issuedAt < 1 ||
    typeof hint.expiresAt !== 'number' ||
    !Number.isSafeInteger(hint.expiresAt) ||
    hint.expiresAt <= hint.issuedAt
  ) {
    throw new Error('device_secret_route_hint_invalid');
  }
  return hint as unknown as DeviceSecretRouteHint;
}

function equalHint(left: DeviceSecretRouteHint, right: DeviceSecretRouteHint): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.accountId === right.accountId &&
    left.issuedAt === right.issuedAt &&
    left.expiresAt === right.expiresAt
  );
}

export class DeviceSecretRouteStore extends DurableObject<Env> {
  async putRouteHintRpc(value: unknown): Promise<{ stored: true }> {
    const hint = validateHint(value);
    const existing = await this.ctx.storage.get<DeviceSecretRouteHint>(ROUTE_KEY);
    if (existing) {
      const validated = validateHint(existing);
      if (!equalHint(validated, hint)) {
        throw new Error('device_secret_route_hint_conflict');
      }
      await this.ctx.storage.setAlarm(hint.expiresAt);
      return { stored: true };
    }
    await this.ctx.storage.put(ROUTE_KEY, hint);
    const reflected = await this.ctx.storage.get<DeviceSecretRouteHint>(ROUTE_KEY);
    if (!reflected || !equalHint(validateHint(reflected), hint)) {
      throw new Error('device_secret_route_hint_write_failed');
    }
    await this.ctx.storage.setAlarm(hint.expiresAt);
    return { stored: true };
  }

  async getRouteHintRpc(input: unknown): Promise<DeviceSecretRouteHint | null> {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).length !== 2
    ) {
      throw new Error('device_secret_route_read_invalid');
    }
    const request = input as Record<string, unknown>;
    if (
      typeof request.tenantId !== 'string' ||
      !SAFE_ID.test(request.tenantId) ||
      typeof request.now !== 'number' ||
      !Number.isSafeInteger(request.now) ||
      request.now < 1
    ) {
      throw new Error('device_secret_route_read_invalid');
    }
    const stored = await this.ctx.storage.get<DeviceSecretRouteHint>(ROUTE_KEY);
    if (!stored) return null;
    const hint = validateHint(stored);
    if (hint.tenantId !== request.tenantId) {
      throw new Error('device_secret_route_tenant_mismatch');
    }
    if (hint.expiresAt <= request.now) {
      await this.ctx.storage.delete(ROUTE_KEY);
      return null;
    }
    return hint;
  }

  async deleteRouteHintRpc(input: unknown): Promise<{ deleted: boolean }> {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).length !== 2
    ) {
      throw new Error('device_secret_route_delete_invalid');
    }
    const request = input as Record<string, unknown>;
    if (
      typeof request.tenantId !== 'string' ||
      !SAFE_ID.test(request.tenantId) ||
      typeof request.accountId !== 'string' ||
      !SAFE_ID.test(request.accountId) ||
      !request.accountId.startsWith('account:')
    ) {
      throw new Error('device_secret_route_delete_invalid');
    }
    const stored = await this.ctx.storage.get<DeviceSecretRouteHint>(ROUTE_KEY);
    if (!stored) return { deleted: false };
    const hint = validateHint(stored);
    if (hint.tenantId !== request.tenantId || hint.accountId !== request.accountId) {
      throw new Error('device_secret_route_delete_mismatch');
    }
    return { deleted: await this.ctx.storage.delete(ROUTE_KEY) };
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.delete(ROUTE_KEY);
  }
}
