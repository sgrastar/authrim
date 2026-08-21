import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateAccountSupportContext } from '../admin-account-governance';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

describe('account governance schema', () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec('PRAGMA foreign_keys = ON');
    database.exec(
      readFileSync(resolve(REPO_ROOT, 'migrations/001_pre_1_0_core_baseline.sql'), 'utf8')
        .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '(unixepoch() * 1000)')
        .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', 'unixepoch()')
    );
    database.exec(
      `INSERT INTO identity_accounts (
         id, tenant_id, account_type, lifecycle_state, legacy_user_id, created_at, updated_at
       ) VALUES
         ('account-a', 'tenant-a', 'person', 'active', 'user-a', 100, 100),
         ('account-b', 'tenant-b', 'person', 'active', 'user-b', 100, 100);`
    );
  });

  afterEach(() => database.close());

  it('backfills and provisions the bounded default Lookup retention policy', () => {
    expect(
      database
        .prepare(
          `SELECT retention_days, policy_generation, updated_by
             FROM lookup_retention_policies WHERE tenant_id = 'default'`
        )
        .get()
    ).toEqual({ retention_days: 180, policy_generation: 1, updated_by: 'migration:051' });
    expect(
      database
        .prepare(
          `SELECT status, policy_generation, retention_days
             FROM lookup_retention_policy_projection_outbox WHERE tenant_id = 'default'`
        )
        .get()
    ).toEqual({ status: 'pending', policy_generation: 1, retention_days: 180 });

    database.exec(
      `INSERT INTO tenants (
         id, tenant_code, tenant_key, name, created_at, updated_at
       ) VALUES ('tenant-new', 'tenant-new', 'tenant-key-new', 'Tenant New', 200, 200)`
    );
    expect(
      database
        .prepare(
          `SELECT policy.retention_days, policy.policy_generation, outbox.status
             FROM lookup_retention_policies policy
             JOIN lookup_retention_policy_projection_outbox outbox
               ON outbox.tenant_id = policy.tenant_id
              AND outbox.policy_generation = policy.policy_generation
            WHERE policy.tenant_id = 'tenant-new'`
        )
        .get()
    ).toEqual({ retention_days: 180, policy_generation: 1, status: 'pending' });
  });

  it('enforces tenant ownership and optimistic support-context versions', () => {
    const context = JSON.stringify({
      schema_version: 1,
      summary: 'Recovery assistance requested.',
      external_references: [{ system: 'zendesk', kind: 'ticket', reference: '12345' }],
    });
    expect(() =>
      database
        .prepare(
          `INSERT INTO account_support_contexts (
             tenant_id, account_id, context_json, version, created_by, updated_by,
             created_at, updated_at
           ) VALUES ('tenant-a', 'account-b', ?, 1, 'admin-a', 'admin-a', 101, 101)`
        )
        .run(context)
    ).toThrow(/account_support_context_account_not_found/u);

    database
      .prepare(
        `INSERT INTO account_support_contexts (
           tenant_id, account_id, context_json, version, created_by, updated_by,
           created_at, updated_at
         ) VALUES ('tenant-a', 'account-a', ?, 1, 'admin-a', 'admin-a', 101, 101)`
      )
      .run(context);
    expect(() =>
      database
        .prepare(
          `UPDATE account_support_contexts
              SET context_json = ?, version = 3, updated_by = 'admin-b', updated_at = 102
            WHERE tenant_id = 'tenant-a' AND account_id = 'account-a'`
        )
        .run(context)
    ).toThrow(/account_support_context_version_invalid/u);
    database
      .prepare(
        `UPDATE account_support_contexts
            SET context_json = ?, version = 2, updated_by = 'admin-b', updated_at = 102
          WHERE tenant_id = 'tenant-a' AND account_id = 'account-a'`
      )
      .run(context);
    expect(
      database
        .prepare(
          `SELECT version, updated_by FROM account_support_contexts
            WHERE tenant_id = 'tenant-a' AND account_id = 'account-a'`
        )
        .get()
    ).toEqual({ version: 2, updated_by: 'admin-b' });
  });

  it('keeps an active hold fail-closed until an audited terminal transition', () => {
    database.exec(
      `INSERT INTO legal_holds (
         id, tenant_id, subject_type, subject_id, state, reason_code, version,
         created_by, created_at, updated_at
       ) VALUES (
         'hold-a', 'tenant-a', 'account', 'account-a', 'active', 'litigation', 1,
         'admin-a', 100, 100
       );
       INSERT INTO legal_hold_events (
         event_id, hold_id, tenant_id, account_id, event_type, hold_version,
         projection_generation, actor_id, reason_code, effective_at, created_at
       ) VALUES (
         'event-a-1', 'hold-a', 'tenant-a', 'account-a', 'created', 1,
         2, 'admin-a', 'litigation', 100, 100
       );`
    );

    expect(() => database.exec(`DELETE FROM identity_accounts WHERE id = 'account-a'`)).toThrow(
      /account_legal_hold_active/u
    );
    expect(() => database.exec(`DELETE FROM legal_holds WHERE id = 'hold-a'`)).toThrow(
      /legal_hold_delete_forbidden/u
    );
    expect(() =>
      database.exec(
        `UPDATE legal_hold_events SET reason_code = 'changed' WHERE event_id = 'event-a-1'`
      )
    ).toThrow(/legal_hold_event_immutable/u);

    database.exec(
      `UPDATE legal_holds
          SET state = 'released', released_by = 'admin-b', released_at = 200,
              release_reason = 'case_closed', version = 2, updated_at = 200
        WHERE id = 'hold-a';
       INSERT INTO legal_hold_events (
         event_id, hold_id, tenant_id, account_id, event_type, hold_version,
         projection_generation, actor_id, reason_code, effective_at, created_at
       ) VALUES (
         'event-a-2', 'hold-a', 'tenant-a', 'account-a', 'released', 2,
         3, 'admin-b', 'case_closed', 200, 200
       );`
    );
    expect(() =>
      database.exec(
        `UPDATE legal_holds SET release_reason = 'rewritten', version = 3, updated_at = 201
          WHERE id = 'hold-a'`
      )
    ).toThrow(/legal_hold_transition_invalid/u);

    database.exec(`DELETE FROM identity_accounts WHERE id = 'account-a'`);
    expect(
      database.prepare(`SELECT state, version FROM legal_holds WHERE id = 'hold-a'`).get()
    ).toEqual({ state: 'released', version: 2 });
  });
});

describe('account support context validation', () => {
  it('accepts bounded support references without treating the resource as an arbitrary metadata bag', () => {
    expect(
      validateAccountSupportContext({
        schema_version: 1,
        summary: 'Customer requested account recovery help.',
        external_references: [{ system: 'zendesk', kind: 'ticket', reference: 'ZD-12345' }],
      })
    ).toEqual({
      schema_version: 1,
      summary: 'Customer requested account recovery help.',
      external_references: [{ system: 'zendesk', kind: 'ticket', reference: 'ZD-12345' }],
    });
  });

  it.each([
    { schema_version: 1, arbitrary: 'value' },
    { schema_version: 2, external_references: [] },
    {
      schema_version: 1,
      external_references: [{ system: 'https://example.com', kind: 'ticket', reference: '1' }],
    },
    {
      schema_version: 1,
      external_references: [
        { system: 'zendesk', kind: 'ticket', reference: 'same' },
        { system: 'zendesk', kind: 'ticket', reference: 'same' },
      ],
    },
  ])('rejects invalid or unbounded shapes', (value) => {
    expect(validateAccountSupportContext(value)).toBeNull();
  });
});
