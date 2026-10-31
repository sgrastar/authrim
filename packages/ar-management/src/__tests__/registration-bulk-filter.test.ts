// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import { countBulkUserUpdateTargets, validateBulkUserUpdateConfig } from '../admin-job-executor';

const databases: DatabaseSync[] = [];
function fixture(): DatabaseAdapter {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  db.exec(`CREATE TABLE identity_accounts (tenant_id TEXT, legacy_user_id TEXT, account_type TEXT, registration_state TEXT);
    CREATE TABLE guest_account_lifecycle (tenant_id TEXT, user_id TEXT, phase TEXT);
    INSERT INTO identity_accounts VALUES ('a','regular','user','registered'), ('a','guest','user','guest'),
      ('a','staged','user','guest'), ('a','committed','user','registered'), ('a','admin','admin','registered'),
      ('b','guest','user','guest');
    INSERT INTO guest_account_lifecycle VALUES ('a','guest','active'), ('a','staged','upgrading'),
      ('a','committed','registered'), ('b','regular','upgrading');`);
  return {
    queryOne: async (sql: string, params: unknown[] = []) => db.prepare(sql).get(...params),
  } as unknown as DatabaseAdapter;
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
describe('unified registration bulk filters', () => {
  it.each([
    [{ user_type: 'end_user' }, 4],
    [{ registration_state: 'guest' }, 2],
    [{ registration_state: 'registered' }, 2],
    [{ user_type: 'end_user', registration_state: 'guest' }, 2],
    [{ user_type: 'admin', registration_state: 'guest' }, 0],
  ])('counts %j with durable registration and tenant isolation', async (filter, expected) => {
    expect(
      await countBulkUserUpdateTargets(fixture(), 'a', {
        fields: ['status'],
        values: { status: 'active' },
        filter,
      })
    ).toBe(expected);
  });
  it('rejects unsupported registration values and registration mutations', () => {
    expect(() =>
      validateBulkUserUpdateConfig({
        fields: ['status'],
        values: { status: 'active' },
        filter: { registration_state: 'upgrading' },
      })
    ).toThrow('Invalid registration_state');
    expect(() =>
      validateBulkUserUpdateConfig({
        fields: ['registration_state'],
        values: { registration_state: 'registered' },
      })
    ).toThrow('Unsupported user update field');
  });
});
