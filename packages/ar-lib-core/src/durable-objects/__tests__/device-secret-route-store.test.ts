import { describe, expect, it } from 'vitest';
import type { DurableObjectState } from '@cloudflare/workers-types';
import { DeviceSecretRouteStore } from '../DeviceSecretRouteStore';

class Storage {
  readonly data = new Map<string, unknown>();
  alarmAt: number | null = null;
  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.data.set(key, structuredClone(value));
  }
  async delete(key: string): Promise<boolean> {
    return this.data.delete(key);
  }
  async setAlarm(scheduledTime: number): Promise<void> {
    this.alarmAt = scheduledTime;
  }
}

function store() {
  const storage = new Storage();
  return {
    subject: new DeviceSecretRouteStore({ storage } as unknown as DurableObjectState, {} as never),
    storage,
  };
}

const hint = {
  tenantId: 'tenant-a',
  accountId: 'account:user-a',
  issuedAt: 1_800_000_000_000,
  expiresAt: 1_800_086_400_000,
};

describe('DeviceSecretRouteStore', () => {
  it('stores one immutable tenant/account hint and adopts an exact retry', async () => {
    const { subject, storage } = store();
    await expect(subject.putRouteHintRpc(hint)).resolves.toEqual({ stored: true });
    await expect(subject.putRouteHintRpc(hint)).resolves.toEqual({ stored: true });
    expect(storage.alarmAt).toBe(hint.expiresAt);
    await expect(
      subject.getRouteHintRpc({ tenantId: 'tenant-a', now: hint.issuedAt + 1 })
    ).resolves.toEqual(hint);
  });

  it('rejects conflicting, cross-tenant, and malformed records', async () => {
    const { subject } = store();
    await subject.putRouteHintRpc(hint);
    await expect(subject.putRouteHintRpc({ ...hint, accountId: 'account:user-b' })).rejects.toThrow(
      'device_secret_route_hint_conflict'
    );
    await expect(
      subject.getRouteHintRpc({ tenantId: 'tenant-b', now: hint.issuedAt + 1 })
    ).rejects.toThrow('device_secret_route_tenant_mismatch');
    await expect(subject.putRouteHintRpc({ ...hint, rawSecret: 'secret' })).rejects.toThrow(
      'device_secret_route_hint_invalid'
    );
  });

  it('deletes expired hints and fences explicit deletion by tenant and account', async () => {
    const { subject: expired } = store();
    await expired.putRouteHintRpc(hint);
    await expect(
      expired.getRouteHintRpc({ tenantId: 'tenant-a', now: hint.expiresAt })
    ).resolves.toBeNull();

    const { subject } = store();
    await subject.putRouteHintRpc(hint);
    await expect(
      subject.deleteRouteHintRpc({ tenantId: 'tenant-a', accountId: 'account:user-b' })
    ).rejects.toThrow('device_secret_route_delete_mismatch');
    await expect(
      subject.deleteRouteHintRpc({ tenantId: 'tenant-a', accountId: 'account:user-a' })
    ).resolves.toEqual({ deleted: true });
  });

  it('removes an unused route hint when its expiration alarm fires', async () => {
    const { subject, storage } = store();
    await subject.putRouteHintRpc(hint);

    await subject.alarm();

    expect(storage.data.has('route')).toBe(false);
  });
});
