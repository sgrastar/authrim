import { describe, expect, it } from 'vitest';
import type { PortableSqliteRow } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';
import { buildCoreAccountRouteGenerations } from '../core-route-generations';

function row(
  overrides: Partial<Record<string, readonly [string, string | null]>> = {}
): PortableSqliteRow {
  return {
    tenant_id: ['text', 'tenant-a'],
    id: ['text', 'account:user-a'],
    legacy_user_id: ['text', 'user-a'],
    account_type: ['text', 'user'],
    lifecycle_state: ['text', 'active'],
    directory_publication_state: ['text', 'active'],
    account_route_generation: ['integer', '7'],
    ...overrides,
  };
}

describe('trusted Core route generation extraction', () => {
  it('retains only active published user accounts', () => {
    const map = buildCoreAccountRouteGenerations('tenant-a', [
      row(),
      row({
        id: ['text', 'account:user-b'],
        legacy_user_id: ['text', 'user-b'],
        lifecycle_state: ['text', 'suspended'],
      }),
      row({
        id: ['text', 'account:user-c'],
        legacy_user_id: ['text', 'user-c'],
        directory_publication_state: ['text', 'active_pending_directory'],
      }),
    ]);
    expect(map).toEqual({ 'account:user-a': 7 });
    expect(Object.isFrozen(map)).toBe(true);
  });

  it('rejects cross-tenant, duplicate, malformed and mismatched source rows', () => {
    expect(() =>
      buildCoreAccountRouteGenerations('tenant-a', [row({ tenant_id: ['text', 'tenant-b'] })])
    ).toThrow('aws_snapshot_core_account_invalid');
    expect(() => buildCoreAccountRouteGenerations('tenant-a', [row(), row()])).toThrow(
      'aws_snapshot_core_account_invalid'
    );
    for (const value of [
      ['integer', '0'],
      ['integer', '01'],
      ['text', '7'],
    ] as const) {
      expect(() =>
        buildCoreAccountRouteGenerations('tenant-a', [row({ account_route_generation: value })])
      ).toThrow('aws_snapshot_core_account_invalid');
    }
    expect(() =>
      buildCoreAccountRouteGenerations('tenant-a', [
        row({ legacy_user_id: ['text', 'different-user'] }),
      ])
    ).toThrow('aws_snapshot_core_account_invalid');
  });
});
