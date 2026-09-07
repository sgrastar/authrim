import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';
import { PasskeyRepository } from '../core/passkey';

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

  it('mirrors only a monotonic counter without a read-before-write', async () => {
    const execute = vi.fn().mockResolvedValue({ success: true, rowsAffected: 1 });
    const queryOne = vi.fn();
    const repository = new PasskeyRepository(adapterWith({ execute, queryOne }), 'tenant-a');

    await expect(repository.mirrorCounterAfterAuth('pk-1', 8)).resolves.toBe(true);
    expect(queryOne).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('counter < ?'), [
      8,
      expect.any(Number),
      'pk-1',
      'tenant-a',
      8,
      8,
    ]);
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
