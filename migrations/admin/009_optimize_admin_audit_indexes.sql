-- D1 Write Amplification Optimization for admin_audit_log
-- All queries filter by tenant_id, so idx_admin_audit_log_tenant_time covers most cases
--
-- Redundant: all queries include tenant_id filter
-- idx_admin_audit_log_tenant_time(tenant_id, created_at DESC) covers this
DROP INDEX IF EXISTS idx_admin_audit_log_created_at;

-- Never searched alone - always combined with tenant_id (admin-audit-log.ts:218,347)
DROP INDEX IF EXISTS idx_admin_audit_log_severity;

-- Never searched alone - always combined with tenant_id (admin-audit-log.ts:214,322)
DROP INDEX IF EXISTS idx_admin_audit_log_result;

-- Low-frequency optional admin filter, not on critical path (admin-audit-log.ts:222)
DROP INDEX IF EXISTS idx_admin_audit_log_ip;
