import { describe, expect, it } from 'vitest';
import {
  buildSlotCleanupSql,
  buildSlotRetiredSql,
} from '../cli/commands/tenant-db-slot-reset.js';

const slot = {
  slot_id: 'tdb-slot-0004',
  slot_number: 4,
  state: 'reset_required',
  assigned_tenant_id: 'tenant-a',
  core_binding_ref: 'TDB_SLOT_0004_CORE',
  pii_binding_ref: 'TDB_SLOT_0004_PII',
  core_database_name: 'authrim-dev-tdb-slot-0004-core',
  pii_database_name: 'authrim-dev-tdb-slot-0004-pii',
};

describe('tenant-db-slot-reset SQL builders', () => {
  it('marks a verified reset slot available and clears tenant assignment', () => {
    const sql = buildSlotCleanupSql(slot);

    expect(sql).toContain("SET state = 'available'");
    expect(sql).toContain('assigned_tenant_id = NULL');
    expect(sql).toContain('DELETE FROM tenant_database_active_pointers');
    expect(sql).toContain('DELETE FROM tenant_database_registry');
    expect(sql).toContain("'manual_reset'");
    expect(sql).toContain("'succeeded'");
  });

  it('retires a slot when reset verification fails', () => {
    const sql = buildSlotRetiredSql(slot, 'Reset verification failed');

    expect(sql).toContain("SET state = 'retired'");
    expect(sql).toContain("'manual_reset_verify'");
    expect(sql).toContain("'failed'");
    expect(sql).toContain("'Reset verification failed'");
    expect(sql).not.toContain("SET state = 'available'");
  });
});
