import { describe, expect, it } from 'vitest';
import { buildTenantDatabaseSlotDeploymentStateSql } from '../core/tenant-d1-bootstrap.js';
import type { AuthrimLock } from '../core/lock.js';

const lock = {
  d1: {
    TDB_SLOT_0001_CORE: {
      id: 'core-1',
      name: 'authrim-prod-tdb-slot-0001-core',
    },
    TDB_SLOT_0001_PII: {
      id: 'pii-1',
      name: 'authrim-prod-tdb-slot-0001-pii',
    },
  },
} as unknown as AuthrimLock;

describe('tenant D1 bootstrap slot inventory SQL', () => {
  it('marks deployment-created slots pending_binding without overwriting assigned slots', () => {
    const sql = buildTenantDatabaseSlotDeploymentStateSql({
      lock,
      env: 'prod',
      slotCount: 1,
      state: 'pending_binding',
      stage: 'worker_deploy',
      errorCode: 'ar-auth deploy failed',
    });

    expect(sql).toContain("'pending_binding'");
    expect(sql).toContain("'worker_deploy'");
    expect(sql).toContain("'ar-auth deploy failed'");
    expect(sql).toContain("WHEN tenant_database_slots.state IN ('assigned', 'reserved', 'reset_required', 'retired')");
    expect(sql).toContain('ELSE excluded.state');
  });

  it('marks health check failures unavailable and writes an audit event', () => {
    const sql = buildTenantDatabaseSlotDeploymentStateSql({
      lock,
      env: 'prod',
      slotCount: 1,
      state: 'unavailable',
      stage: 'worker_http_health',
      errorCode: '503',
    });

    expect(sql).toContain("'unavailable'");
    expect(sql).toContain('tenant_database_slot_audit_events');
    expect(sql).toContain("'worker_http_health'");
    expect(sql).toContain("'failed'");
  });
});
