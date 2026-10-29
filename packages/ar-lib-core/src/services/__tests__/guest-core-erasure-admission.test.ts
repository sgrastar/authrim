import { afterEach, describe, expect, it } from 'vitest';
import { sqliteAdapter } from '../../repositories/__tests__/sqlite-core-schema';
import { createGuestCoreErasureAdmissionGuard } from '../guest-core-erasure-admission';
const stores: ReturnType<typeof sqliteAdapter>[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.db.close()));
function fixture() {
  const f = sqliteAdapter();
  stores.push(f);
  const db = { ...f.adapter, getType: () => 'd1' };
  return { ...f, guard: createGuestCoreErasureAdmissionGuard(db) };
}
describe('Guest Core source admission preflight', () => {
  it('accepts the executable closed migration profile and rereads epoch on each invocation', async () => {
    const f = fixture();
    await f.guard();
    f.db.exec('DELETE FROM guest_core_mutation_epoch');
    await expect(f.guard()).rejects.toThrow('guest_core_admission_unavailable');
  });
  it.each([
    'trg_guest_core_passkeys_insert',
    'trg_guest_core_guest_devices_delete',
    'trg_guest_core_totp_credentials_update',
    'trg_guest_core_totp_backup_codes_insert',
    'trg_guest_core_lifecycle_receipt',
    'trg_guest_core_hold_insert',
    'trg_guest_core_boundary_hold_update',
    'trg_guest_core_subject_update_epoch',
    'trg_guest_core_profile_delete_epoch',
  ])('rejects missing source/hold/freeze guards before a deletion effect: %s', async (name) => {
    const f = fixture();
    f.db.exec(`DROP TRIGGER ${name}`);
    await expect(f.guard()).rejects.toThrow('guest_core_admission_unavailable');
  });
  it('rejects a correct trigger name installed on the wrong table or event', async () => {
    const f = fixture();
    f.db.exec(
      `DROP TRIGGER trg_guest_core_passkeys_insert;CREATE TRIGGER trg_guest_core_passkeys_insert AFTER DELETE ON passkeys BEGIN SELECT 1;END;`
    );
    await expect(f.guard()).rejects.toThrow('guest_core_admission_unavailable');
  });
  it('rejects a missing permit view instead of treating an old source schema as safe', async () => {
    const f = fixture();
    f.db.exec('DROP VIEW guest_core_erasure_permit_rows');
    await expect(f.guard()).rejects.toThrow('guest_core_admission_unavailable');
  });
});
