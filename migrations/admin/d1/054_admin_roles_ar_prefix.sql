-- Migration: 054_admin_roles_ar_prefix.sql
-- Description: Replace the five standard Admin roles with the four `ar_` roles
--   (ar_super_admin, ar_tenant_admin, ar_support, ar_viewer) and move what points at the old ones.
-- Author: @sgrastar
-- Date: 2026-10-29
-- Issue: Admin roles cleanup (PR-A)
--
-- The 0.4.0 baseline that seeds the old roles is published and stays as it is; this moves the
-- data it left. The role definitions below are kept equal to `ADMIN_ROLE_DEFINITIONS`
-- (ar-lib-core/src/constants/admin-roles.ts) by a test that reads this file.
--
--   super_admin                -> ar_super_admin   (a tenant-scoped assignment becomes ar_tenant_admin:
--                                                   the super admin is held through a global one only)
--   security_admin, admin      -> ar_tenant_admin
--   support                    -> ar_support
--   viewer                     -> ar_viewer

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

-- A custom role that already carries the now-reserved prefix is renamed first: Admin checks read
-- the standard roles' names as authority, and a custom role must not be able to carry one.
-- `custom_<id>` is unique among the renamed roles; a role of the tenant that already has that name
-- (it is a name the API allows) makes it take a random suffix instead of failing the migration.
UPDATE admin_roles
   SET display_name = COALESCE(display_name, name),
       name = CASE
         WHEN EXISTS (
           SELECT 1 FROM admin_roles other
            WHERE other.tenant_id = admin_roles.tenant_id AND other.name = 'custom_' || admin_roles.id
         ) THEN 'custom_' || id || '_' || lower(hex(randomblob(8)))
         ELSE 'custom_' || id
       END
 WHERE is_system = 0
   AND lower(name) LIKE 'ar\_%' ESCAPE '\';

-- An invitation carries the name of its role; a renamed role is followed so that the name still
-- says what the role is (who may resend or cancel an invitation is decided by it).
UPDATE admin_invitations
   SET admin_role_name = (SELECT name FROM admin_roles WHERE id = admin_invitations.admin_role_id)
 WHERE admin_role_id IN (SELECT id FROM admin_roles WHERE is_system = 0 AND name LIKE 'custom\_%' ESCAPE '\')
   AND admin_role_name <> (SELECT name FROM admin_roles WHERE id = admin_invitations.admin_role_id);

INSERT INTO admin_roles VALUES('role_ar_super_admin','default','ar_super_admin','Super Administrator','Every tenant and the platform: all permissions','["*"]',100,'system',1,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,NULL);
INSERT INTO admin_roles VALUES('role_ar_tenant_admin','default','ar_tenant_admin','Tenant Administrator','One tenant: settings, apps, users, support operations, and its admins and roles','["admin:users:*", "admin:sessions:*", "admin:account_support_context:*", "admin:account_legal_holds:*", "admin:account_assurance:*", "admin:clients:*", "admin:scopes:*", "admin:roles:*", "admin:settings:read", "admin:settings:write", "admin:policy:simulate", "admin:policy:rebac:write", "admin:flows:validate", "admin:flows:compile", "admin:flows:publish", "admin:security:*", "admin:ip_allowlist:*", "admin:external_providers:*", "admin:external_token_refresh:*", "admin:directory_auth:*", "admin:saml_attribute_presets:*", "admin:saml_providers:list", "admin:saml_providers:read", "admin:saml_providers:create", "admin:saml_providers:update", "admin:saml_providers:delete", "admin:saml_providers:metadata:import", "admin:saml_providers:metadata:refresh", "admin:saml_providers:signing:publish_next", "admin:saml_providers:signing:promote", "admin:saml_providers:signing:retire_backup", "admin:webhooks:*", "admin:vc:*", "admin:auth_config_plans:*", "admin:bulk_plans:*", "admin:machine_access:*", "admin:agent_grants:*", "admin:agent_settings:*", "admin:agent_elevation:reconcile", "admin:agent_task_sets:*", "admin:agent_scope_policies:*", "admin:agent_templates:publish", "admin:agent_baselines:*", "admin:jobs:read", "admin:jobs:write", "admin:jobs:artifact:read", "admin:audit:*", "admin:admin_audit:*", "admin:operational_logs:*", "admin:logging:overview:read", "admin:logging:delivery_events:read", "admin:logging:exports:create", "admin:logging:tenant_overrides:read", "admin:logging:tenant_overrides:update", "admin:admin_logging:overview:read", "admin:admin_logging:coverage:read", "admin:admin_logging:repair:read", "admin:email_deliveries:read", "admin:email_deliveries:recipient:masked:read", "admin:email_deliveries:recipient:full:read", "admin:support_ops:registry:read", "admin:support_ops:aggregate:read", "admin:support_ops:cohorts:preview", "admin:support_ops:cohorts:create", "admin:support_ops:actions:request", "admin:support_ops:actions:read", "admin:support_ops:actions:approve", "admin:support_ops:actions:execute", "admin:approvals:read", "admin:approvals:detail:read", "admin:approvals:write", "admin:approvals:approve", "admin:approvals:grant:issue", "admin:admin_users:read", "admin:admin_users:write", "admin:admin_users:delete", "admin:admin_roles:read", "admin:admin_roles:write", "admin:admin_roles:delete"]',80,'system',1,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,NULL);
INSERT INTO admin_roles VALUES('role_ar_support','default','ar_support','Support','Looks up users, unlocks accounts, ends sessions and asks for support operations','["admin:users:read", "admin:users:status:read", "admin:sessions:read", "admin:account_support_context:read", "admin:account_legal_holds:read", "admin:account_assurance:read", "admin:users:unlock", "admin:sessions:revoke", "admin:account_support_context:write", "admin:clients:read", "admin:audit:read", "admin:operational_logs:read", "admin:support_ops:registry:read", "admin:support_ops:aggregate:read", "admin:support_ops:cohorts:preview", "admin:support_ops:cohorts:create", "admin:support_ops:actions:request", "admin:support_ops:actions:read", "admin:approvals:read"]',40,'system',1,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,NULL);
INSERT INTO admin_roles VALUES('role_ar_viewer','default','ar_viewer','Viewer','Read-only access to the Admin console, without secrets','["admin:users:read", "admin:users:status:read", "admin:sessions:read", "admin:account_support_context:read", "admin:account_legal_holds:read", "admin:account_assurance:read", "admin:clients:read", "admin:scopes:read", "admin:roles:read", "admin:settings:read", "admin:security:read", "admin:ip_allowlist:read", "admin:external_providers:read", "admin:external_token_refresh:read", "admin:directory_auth:read", "admin:saml_attribute_presets:read", "admin:saml_providers:list", "admin:saml_providers:read", "admin:webhooks:read", "admin:vc:credential_profiles:read", "admin:auth_config_plans:read", "admin:bulk_plans:read", "admin:agent_grants:read", "admin:agent_settings:read", "admin:agent_task_sets:read", "admin:agent_scope_policies:read", "admin:agent_baselines:read", "admin:jobs:read", "admin:audit:read", "admin:admin_audit:read", "admin:operational_logs:read", "admin:logging:overview:read", "admin:logging:delivery_events:read", "admin:admin_logging:overview:read", "admin:email_deliveries:read", "admin:email_deliveries:recipient:masked:read", "admin:support_ops:registry:read", "admin:support_ops:aggregate:read", "admin:support_ops:actions:read", "admin:approvals:read"]',20,'system',1,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,__AUTHRIM_NOW_EPOCH_MILLISECONDS__,NULL);

-- A tenant-scoped (or any non-global) super admin assignment is a tenant admin from now on.
UPDATE OR IGNORE admin_role_assignments
   SET admin_role_id = 'role_ar_tenant_admin'
 WHERE scope_type <> 'global'
   AND admin_role_id IN (SELECT id FROM admin_roles WHERE is_system = 1 AND name = 'super_admin');

UPDATE OR IGNORE admin_role_assignments
   SET admin_role_id = CASE (SELECT name FROM admin_roles WHERE id = admin_role_assignments.admin_role_id)
         WHEN 'super_admin' THEN 'role_ar_super_admin'
         WHEN 'security_admin' THEN 'role_ar_tenant_admin'
         WHEN 'admin' THEN 'role_ar_tenant_admin'
         WHEN 'support' THEN 'role_ar_support'
         WHEN 'viewer' THEN 'role_ar_viewer'
       END
 WHERE NOT (scope_type <> 'global' AND admin_role_id IN (SELECT id FROM admin_roles WHERE is_system = 1 AND name = 'super_admin'))
   AND admin_role_id IN (SELECT id FROM admin_roles WHERE is_system = 1 AND name IN ('super_admin', 'security_admin', 'admin', 'support', 'viewer'));

-- Two old assignments can land on the same new one (admin and security_admin of one account in one
-- scope). Only one of them moved; the account keeps the longer of the two: no expiry beats any
-- expiry, otherwise the later one.
UPDATE admin_role_assignments
   SET expires_at = CASE
         WHEN expires_at IS NULL THEN NULL
         WHEN EXISTS (
           SELECT 1 FROM admin_role_assignments o
             JOIN admin_roles orole ON orole.id = o.admin_role_id
            WHERE o.admin_user_id = admin_role_assignments.admin_user_id
              AND o.scope_type = admin_role_assignments.scope_type
              AND o.scope_id IS admin_role_assignments.scope_id
              AND orole.is_system = 1 AND orole.name IN ('super_admin', 'security_admin', 'admin', 'support', 'viewer')
              AND (CASE orole.name WHEN 'super_admin' THEN (CASE WHEN o.scope_type = 'global' THEN 'role_ar_super_admin' ELSE 'role_ar_tenant_admin' END)
                     WHEN 'security_admin' THEN 'role_ar_tenant_admin'
                     WHEN 'admin' THEN 'role_ar_tenant_admin'
                     WHEN 'support' THEN 'role_ar_support'
                     WHEN 'viewer' THEN 'role_ar_viewer' END) = admin_role_assignments.admin_role_id
              AND o.expires_at IS NULL
         ) THEN NULL
         ELSE MAX(expires_at, COALESCE((
           SELECT MAX(o.expires_at) FROM admin_role_assignments o
             JOIN admin_roles orole ON orole.id = o.admin_role_id
            WHERE o.admin_user_id = admin_role_assignments.admin_user_id
              AND o.scope_type = admin_role_assignments.scope_type
              AND o.scope_id IS admin_role_assignments.scope_id
              AND orole.is_system = 1 AND orole.name IN ('super_admin', 'security_admin', 'admin', 'support', 'viewer')
              AND (CASE orole.name WHEN 'super_admin' THEN (CASE WHEN o.scope_type = 'global' THEN 'role_ar_super_admin' ELSE 'role_ar_tenant_admin' END)
                     WHEN 'security_admin' THEN 'role_ar_tenant_admin'
                     WHEN 'admin' THEN 'role_ar_tenant_admin'
                     WHEN 'support' THEN 'role_ar_support'
                     WHEN 'viewer' THEN 'role_ar_viewer' END) = admin_role_assignments.admin_role_id
         ), expires_at))
       END
 WHERE admin_role_id IN ('role_ar_super_admin', 'role_ar_tenant_admin', 'role_ar_support', 'role_ar_viewer')
   AND EXISTS (
     SELECT 1 FROM admin_role_assignments o
       JOIN admin_roles orole ON orole.id = o.admin_role_id
      WHERE o.admin_user_id = admin_role_assignments.admin_user_id
        AND o.scope_type = admin_role_assignments.scope_type
        AND o.scope_id IS admin_role_assignments.scope_id
        AND orole.is_system = 1 AND orole.name IN ('super_admin', 'security_admin', 'admin', 'support', 'viewer')
   );

-- Pending and past invitations keep the role they were for, under the new name; the same scope
-- rule applies (a tenant-scoped super admin invitation becomes a tenant admin one).
UPDATE admin_invitations
   SET admin_role_id = CASE
         WHEN admin_role_name = 'super_admin' AND scope_type = 'global' THEN 'role_ar_super_admin'
         WHEN admin_role_name = 'super_admin' THEN 'role_ar_tenant_admin'
         WHEN admin_role_name IN ('security_admin', 'admin') THEN 'role_ar_tenant_admin'
         WHEN admin_role_name = 'support' THEN 'role_ar_support'
         WHEN admin_role_name = 'viewer' THEN 'role_ar_viewer'
       END,
       admin_role_name = CASE
         WHEN admin_role_name = 'super_admin' AND scope_type = 'global' THEN 'ar_super_admin'
         WHEN admin_role_name = 'super_admin' THEN 'ar_tenant_admin'
         WHEN admin_role_name IN ('security_admin', 'admin') THEN 'ar_tenant_admin'
         WHEN admin_role_name = 'support' THEN 'ar_support'
         WHEN admin_role_name = 'viewer' THEN 'ar_viewer'
       END
 WHERE admin_role_name IN ('super_admin', 'security_admin', 'admin', 'support', 'viewer')
   AND admin_role_id IN (SELECT id FROM admin_roles WHERE is_system = 1 AND name IN ('super_admin', 'security_admin', 'admin', 'support', 'viewer'));

-- A custom role that inherited an old standard role inherits the new one.
UPDATE admin_roles
   SET inherits_from = CASE (SELECT name FROM admin_roles parent WHERE parent.id = admin_roles.inherits_from)
         WHEN 'super_admin' THEN 'role_ar_super_admin'
         WHEN 'security_admin' THEN 'role_ar_tenant_admin'
         WHEN 'admin' THEN 'role_ar_tenant_admin'
         WHEN 'support' THEN 'role_ar_support'
         WHEN 'viewer' THEN 'role_ar_viewer'
       END
 WHERE inherits_from IN (SELECT id FROM admin_roles WHERE is_system = 1 AND name IN ('super_admin', 'security_admin', 'admin', 'support', 'viewer'));

-- What could not move (the account already held the new role in the same scope) goes with the role.
DELETE FROM admin_role_assignments
 WHERE admin_role_id IN (SELECT id FROM admin_roles WHERE is_system = 1 AND name IN ('super_admin', 'security_admin', 'admin', 'support', 'viewer'));

DELETE FROM admin_roles WHERE is_system = 1 AND name IN ('super_admin', 'security_admin', 'admin', 'support', 'viewer');

-- =============================================================================
-- Down Migration (Rollback) - COMMENTED OUT
-- =============================================================================
-- Not reversible: the old roles are gone and security_admin and admin were merged. Restore from a
-- backup taken before this migration.

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: 054
-- =============================================================================
