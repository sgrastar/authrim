import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db';
import {
  ensureAdminDatabaseAdapter,
  requireDedicatedAdminDatabaseAdapter,
  requireAdminDatabaseAdapter,
  resolveAdminDatabaseSource,
} from '../admin-database-adapter';

function createMockAdapter(label: string): DatabaseAdapter {
  return {
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
    batch: vi.fn(),
    isHealthy: vi.fn(),
    getType: vi.fn().mockReturnValue(label),
    close: vi.fn(),
  };
}

describe('admin-database-adapter', () => {
  it('prefers DB_ADMIN when both admin and core sources exist', () => {
    const coreAdapter = createMockAdapter('core');
    const adminAdapter = createMockAdapter('admin');

    expect(
      resolveAdminDatabaseSource({ DB: coreAdapter as never, DB_ADMIN: adminAdapter as never })
    ).toBe(adminAdapter);
    expect(
      ensureAdminDatabaseAdapter({ DB: coreAdapter as never, DB_ADMIN: adminAdapter as never })
    ).toBe(adminAdapter);
  });

  it('falls back to DB when DB_ADMIN is unavailable', () => {
    const coreAdapter = createMockAdapter('core');

    expect(resolveAdminDatabaseSource({ DB: coreAdapter as never })).toBe(coreAdapter);
    expect(ensureAdminDatabaseAdapter({ DB: coreAdapter as never })).toBe(coreAdapter);
  });

  it('throws when no admin-capable database source exists', () => {
    expect(() => requireAdminDatabaseAdapter({})).toThrow('Admin database is not configured');
  });

  it('requires DB_ADMIN when strict admin separation is requested', () => {
    const adminAdapter = createMockAdapter('admin');

    expect(requireDedicatedAdminDatabaseAdapter({ DB_ADMIN: adminAdapter as never })).toBe(
      adminAdapter
    );
    expect(() => requireDedicatedAdminDatabaseAdapter({})).toThrow('DB_ADMIN is not configured');
  });
});
