-- Normalize tenant-scoped Admin role assignment scope IDs.
--
-- Older Admin assignment paths created tenant-scoped records with NULL/empty scope_id.
-- New AdminUI/API paths store scope_id explicitly as tenant_id so duplicate checks and
-- future scope enforcement can use one canonical representation.

UPDATE admin_role_assignments
SET scope_id = tenant_id,
    updated_at = strftime('%s', 'now') * 1000
WHERE scope_type = 'tenant'
  AND (scope_id IS NULL OR scope_id = '');
