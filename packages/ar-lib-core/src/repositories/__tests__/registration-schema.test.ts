import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderPortableMigrationSql } from '../../migrations/sql-portability';

/** Verify the executable fresh-install sequence, not a hand-maintained schema fixture. */
describe('registration schema', () => {
  it('stores registration separately and exposes only the guest device table', () => {
    const db = new DatabaseSync(':memory:');
    try {
      for (const file of [
        '001_0_4_0_core_baseline.sql',
        '002_guest_account_lifecycle.sql',
        '003_account_registration_state.sql',
      ]) {
        db.exec(
          renderPortableMigrationSql(
            readFileSync(
              new URL(`../../../../../migrations/core/d1/${file}`, import.meta.url),
              'utf8'
            ),
            'sqlite'
          )
        );
      }
      db.prepare(
        `INSERT INTO identity_accounts (id, tenant_id, account_type, created_at, updated_at)
        VALUES ('regular', 'tenant', 'user', 1, 1)`
      ).run();
      expect(
        db
          .prepare('SELECT account_type, registration_state FROM identity_accounts WHERE id = ?')
          .get('regular')
      ).toMatchObject({ account_type: 'user', registration_state: 'registered' });
      db.prepare(
        `UPDATE identity_accounts SET registration_state = 'guest' WHERE id = 'regular'`
      ).run();
      expect(
        db
          .prepare('SELECT account_type, registration_state FROM identity_accounts WHERE id = ?')
          .get('regular')
      ).toMatchObject({ account_type: 'user', registration_state: 'guest' });
      expect(() =>
        db.exec("UPDATE identity_accounts SET registration_state = 'anonymous'")
      ).toThrow();
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('guest_devices', 'anonymous_devices')"
          )
          .all()
      ).toEqual([{ name: 'guest_devices' }]);
      expect(
        db
          .prepare('PRAGMA table_info(guest_account_upgrades)')
          .all()
          .map((row) => row.name)
      ).toContain('guest_user_id');
      expect(
        db
          .prepare('PRAGMA table_info(guest_account_upgrades)')
          .all()
          .map((row) => row.name)
      ).not.toContain('anonymous_user_id');
    } finally {
      db.close();
    }
  });
});
