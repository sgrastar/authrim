import { beforeEach, describe, expect, it } from 'vitest';
import { MockDatabaseAdapter } from './mock-adapter';
import { RoleRepository } from '../core/role';

describe('RoleRepository tenant isolation', () => {
  let adapter: MockDatabaseAdapter;

  beforeEach(() => {
    adapter = new MockDatabaseAdapter();
  });

  it('rejects empty repository tenantId', () => {
    expect(() => new RoleRepository(adapter, ' ')).toThrow('RoleRepository requires tenantId');
  });
});
