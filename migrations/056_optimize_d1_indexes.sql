-- D1 Write Amplification Optimization
-- Remove unused/redundant indexes to reduce write costs
--
-- users_core: email_domain_hash_version is never filtered in WHERE clauses
-- Only used in GROUP BY (domain-hash-keys.ts:54-57) which doesn't benefit from an index
DROP INDEX IF EXISTS idx_users_core_hash_version;

-- users_core: is_active has extremely low cardinality (0 or 1)
-- Always paired with PK or tenant_id in queries, never filtered alone
DROP INDEX IF EXISTS idx_users_core_active;

-- audit_log: severity is never filtered in any query
-- Only set as fixed 'info' value on INSERT (event-dispatcher.ts:631)
DROP INDEX IF EXISTS idx_audit_log_severity;
