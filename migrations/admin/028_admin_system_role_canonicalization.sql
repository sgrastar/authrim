-- =============================================================================
-- Migration: Canonicalize Admin System Roles
-- =============================================================================
-- Created: 2026-05-23
-- Description: Removes legacy tenant-scoped copies of built-in Admin system
--              roles. System roles are canonical under tenant `default`; tenant
--              membership lives in admin_role_assignments. Existing assignments
--              are repointed before the stale role rows are deleted.
-- =============================================================================

-- If a user already has both the legacy copy and the canonical role assigned for
-- the same scope, delete the duplicate legacy assignment first to avoid the
-- unique constraint during the update below.
DELETE FROM admin_role_assignments
WHERE admin_role_id IN (
  SELECT copy.id
  FROM admin_roles copy
  JOIN admin_roles canonical
    ON canonical.tenant_id = 'default'
   AND canonical.is_system = 1
   AND canonical.name = copy.name
  WHERE copy.tenant_id <> 'default'
    AND copy.is_system = 1
)
AND EXISTS (
  SELECT 1
  FROM admin_role_assignments existing
  JOIN admin_roles copy
    ON copy.id = admin_role_assignments.admin_role_id
  JOIN admin_roles canonical
    ON canonical.tenant_id = 'default'
   AND canonical.is_system = 1
   AND canonical.name = copy.name
  WHERE existing.tenant_id = admin_role_assignments.tenant_id
    AND existing.admin_user_id = admin_role_assignments.admin_user_id
    AND existing.admin_role_id = canonical.id
    AND existing.scope_type = admin_role_assignments.scope_type
    AND COALESCE(existing.scope_id, '') = COALESCE(admin_role_assignments.scope_id, '')
);

UPDATE admin_role_assignments
SET admin_role_id = (
  SELECT canonical.id
  FROM admin_roles copy
  JOIN admin_roles canonical
    ON canonical.tenant_id = 'default'
   AND canonical.is_system = 1
   AND canonical.name = copy.name
  WHERE copy.id = admin_role_assignments.admin_role_id
  LIMIT 1
)
WHERE admin_role_id IN (
  SELECT copy.id
  FROM admin_roles copy
  JOIN admin_roles canonical
    ON canonical.tenant_id = 'default'
   AND canonical.is_system = 1
   AND canonical.name = copy.name
  WHERE copy.tenant_id <> 'default'
    AND copy.is_system = 1
);

DELETE FROM admin_roles
WHERE tenant_id <> 'default'
  AND is_system = 1
  AND EXISTS (
    SELECT 1
    FROM admin_roles canonical
    WHERE canonical.tenant_id = 'default'
      AND canonical.is_system = 1
      AND canonical.name = admin_roles.name
  );
