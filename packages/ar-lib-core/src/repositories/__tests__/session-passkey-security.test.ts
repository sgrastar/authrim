import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';
import { PasskeyRepository } from '../core/passkey';
import { SessionRepository } from '../core/session';

function adapterWith(overrides: Partial<DatabaseAdapter> = {}): DatabaseAdapter {
  return {
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn().mockResolvedValue(null),
    execute: vi.fn().mockResolvedValue({ success: true, rowsAffected: 1 }),
    transaction: vi.fn(),
    batch: vi.fn(),
    isHealthy: vi.fn().mockResolvedValue(true),
    getHealthStatus: vi.fn(),
    close: vi.fn(),
    ...overrides,
  } as unknown as DatabaseAdapter;
}

const passkeyRow = (counter = 5) => ({
  id: 'pk-1',
  tenant_id: 'tenant-a',
  user_id: 'user-1',
  credential_id: 'credential-1',
  public_key: 'public-key',
  counter,
  transports: '["internal"]',
  device_name: 'Laptop',
  aaguid: null,
  created_at: 100,
  last_used_at: null,
});

describe('PasskeyRepository clone-detection invariants', () => {
  it.each([0, 5, 4, -1, 1.5])(
    'rejects a stale or invalid counter (%s) after a positive counter was observed',
    async (newCounter) => {
      const execute = vi.fn();
      const repository = new PasskeyRepository(
        adapterWith({ queryOne: vi.fn().mockResolvedValue(passkeyRow(5)), execute }),
        'tenant-a'
      );

      await expect(repository.updateCounterAfterAuth('pk-1', newCounter)).rejects.toThrow(
        'Invalid counter'
      );
      expect(execute).not.toHaveBeenCalled();
    }
  );

  it('accepts a strictly increasing counter and scopes the write to the tenant', async () => {
    const execute = vi.fn().mockResolvedValue({ success: true, rowsAffected: 1 });
    const repository = new PasskeyRepository(
      adapterWith({ queryOne: vi.fn().mockResolvedValue(passkeyRow(5)), execute }),
      'tenant-a'
    );

    await expect(repository.updateCounterAfterAuth('pk-1', 6)).resolves.toMatchObject({
      counter: 6,
      tenant_id: 'tenant-a',
    });
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('WHERE id = ? AND tenant_id = ?'),
      [6, expect.any(Number), 'pk-1', 'tenant-a']
    );
  });

  it('allows zero only while the authenticator has never advertised counter support', async () => {
    const execute = vi.fn().mockResolvedValue({ success: true, rowsAffected: 1 });
    const repository = new PasskeyRepository(
      adapterWith({ queryOne: vi.fn().mockResolvedValue(passkeyRow(0)), execute }),
      'tenant-a'
    );

    await expect(repository.updateCounterAfterAuth('pk-1', 0)).resolves.toMatchObject({
      counter: 0,
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('does not convert malformed stored transports into trusted authenticator capabilities', async () => {
    const repository = new PasskeyRepository(
      adapterWith({
        queryOne: vi.fn().mockResolvedValue({ ...passkeyRow(), transports: 'not-json' }),
      }),
      'tenant-a'
    );

    await expect(repository.findByCredentialId('credential-1')).resolves.toMatchObject({
      transports: [],
      tenant_id: 'tenant-a',
    });
  });

  it('rejects an empty tenant and includes tenant isolation in credential lookup', async () => {
    expect(() => new PasskeyRepository(adapterWith(), '   ')).toThrow(
      'PasskeyRepository requires tenantId'
    );
    const queryOne = vi.fn().mockResolvedValue(null);
    const repository = new PasskeyRepository(adapterWith({ queryOne }), 'tenant-a');

    await repository.findByCredentialId('shared-credential');
    expect(queryOne).toHaveBeenCalledWith(expect.stringContaining('tenant_id = ?'), [
      'tenant-a',
      'shared-credential',
    ]);
  });
});

describe('SessionRepository expiration boundaries', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses unsafe cleanup age %s without issuing a delete',
    async (maxAgeMs) => {
      const execute = vi.fn();
      const repository = new SessionRepository(adapterWith({ execute }), 'tenant-a');

      await expect(repository.cleanupExpiredOlderThan(maxAgeMs)).resolves.toBe(0);
      expect(execute).not.toHaveBeenCalled();
    }
  );

  it('caps excessive TTL and never creates a session outside the tenant', async () => {
    const execute = vi.fn().mockResolvedValue({ success: true, rowsAffected: 1 });
    const repository = new SessionRepository(adapterWith({ execute }), 'tenant-a');
    const now = Date.now();

    const created = await repository.create({
      user_id: 'user-1',
      ttl_ms: 365 * 24 * 60 * 60 * 1000,
    });

    expect(created).toMatchObject({ tenant_id: 'tenant-a', user_id: 'user-1' });
    expect(created.expires_at).toBe(now + 30 * 24 * 60 * 60 * 1000);
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('tenant_id'),
      expect.arrayContaining(['tenant-a', 'user-1'])
    );
  });

  it('rejects past expiration updates before writing', async () => {
    const execute = vi.fn();
    const queryOne = vi.fn().mockResolvedValue({
      id: 'session-1',
      tenant_id: 'tenant-a',
      user_id: 'user-1',
      expires_at: Date.now() + 60_000,
      created_at: Date.now(),
      external_provider_id: null,
      external_provider_sub: null,
    });
    const repository = new SessionRepository(adapterWith({ queryOne, execute }), 'tenant-a');

    await expect(
      repository.update('session-1', { expires_at: Date.now() - 1 })
    ).resolves.toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });
});
