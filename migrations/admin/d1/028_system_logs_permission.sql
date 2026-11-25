-- Migration: 028_system_logs_permission.sql
-- Description: The system log (Monitoring → System logs, GET /api/admin/system-logs) has its own
--              read permission, admin:system_logs:read. The standard roles that may read the
--              operational logs may read it too: the tenant administrator (as the wildcard
--              admin:system_logs:*), support and the viewer. Each permission list is the whole
--              list of ar-lib-core's ADMIN_ROLE_DEFINITIONS for that role, as the baseline seeds
--              it, with the system log permission added after admin:operational_logs. Only the
--              canonical built-in rows change; custom roles that inherit from them see the new
--              permission through inheritance, copies made from a template do not.
-- Author: @authrim
-- Date: 2026-11-26
-- Issue: System log for events of the platform itself (cron, outbox, delivery)

UPDATE admin_roles
   SET permissions_json = '["admin:users:*", "admin:sessions:*", "admin:account_support_context:*", "admin:account_legal_holds:*", "admin:account_assurance:*", "admin:clients:*", "admin:scopes:*", "admin:roles:*", "admin:settings:read", "admin:settings:write", "admin:policy:simulate", "admin:policy:rebac:write", "admin:flows:validate", "admin:flows:compile", "admin:flows:publish", "admin:security:*", "admin:ip_allowlist:*", "admin:external_providers:*", "admin:external_token_refresh:*", "admin:directory_auth:*", "admin:saml_attribute_presets:*", "admin:saml_providers:list", "admin:saml_providers:read", "admin:saml_providers:create", "admin:saml_providers:update", "admin:saml_providers:delete", "admin:saml_providers:metadata:import", "admin:saml_providers:metadata:refresh", "admin:saml_providers:signing:publish_next", "admin:saml_providers:signing:promote", "admin:saml_providers:signing:retire_backup", "admin:saml_providers:signing:dr_bundle:export", "admin:saml_providers:signing:dr_bundle:import", "admin:webhooks:*", "admin:vc:*", "admin:auth_config_plans:*", "admin:bulk_plans:*", "admin:machine_access:*", "admin:agent_grants:*", "admin:agent_settings:*", "admin:agent_elevation:reconcile", "admin:agent_task_sets:*", "admin:agent_scope_policies:*", "admin:agent_templates:publish", "admin:agent_baselines:*", "admin:jobs:read", "admin:jobs:write", "admin:jobs:artifact:read", "admin:audit:*", "admin:admin_audit:*", "admin:operational_logs:*", "admin:system_logs:*", "admin:logging:overview:read", "admin:logging:delivery_events:read", "admin:logging:exports:create", "admin:logging:tenant_overrides:read", "admin:logging:tenant_overrides:update", "admin:admin_logging:overview:read", "admin:admin_logging:coverage:read", "admin:admin_logging:repair:read", "admin:email_deliveries:read", "admin:email_deliveries:recipient:masked:read", "admin:email_deliveries:recipient:full:read", "admin:support_ops:registry:read", "admin:support_ops:aggregate:read", "admin:support_ops:cohorts:preview", "admin:support_ops:cohorts:create", "admin:support_ops:actions:request", "admin:support_ops:actions:read", "admin:support_ops:actions:approve", "admin:support_ops:actions:execute", "admin:approvals:read", "admin:approvals:detail:read", "admin:approvals:write", "admin:approvals:approve", "admin:approvals:grant:issue", "admin:admin_users:read", "admin:admin_users:write", "admin:admin_users:delete", "admin:admin_roles:read", "admin:admin_roles:write", "admin:admin_roles:delete"]',
       updated_at = __AUTHRIM_NOW_EPOCH_MILLISECONDS__
 WHERE id = 'role_ar_tenant_admin'
   AND tenant_id = 'default'
   AND is_system = 1
   AND permissions_json NOT LIKE '%admin:system_logs:%';

UPDATE admin_roles
   SET permissions_json = '["admin:users:read", "admin:users:status:read", "admin:sessions:read", "admin:account_support_context:read", "admin:account_legal_holds:read", "admin:account_assurance:read", "admin:users:unlock", "admin:sessions:revoke", "admin:account_support_context:write", "admin:clients:read", "admin:audit:read", "admin:operational_logs:read", "admin:system_logs:read", "admin:support_ops:registry:read", "admin:support_ops:aggregate:read", "admin:support_ops:cohorts:preview", "admin:support_ops:cohorts:create", "admin:support_ops:actions:request", "admin:support_ops:actions:read", "admin:approvals:read"]',
       updated_at = __AUTHRIM_NOW_EPOCH_MILLISECONDS__
 WHERE id = 'role_ar_support'
   AND tenant_id = 'default'
   AND is_system = 1
   AND permissions_json NOT LIKE '%admin:system_logs:%';

UPDATE admin_roles
   SET permissions_json = '["admin:users:read", "admin:users:status:read", "admin:sessions:read", "admin:account_support_context:read", "admin:account_legal_holds:read", "admin:account_assurance:read", "admin:clients:read", "admin:scopes:read", "admin:roles:read", "admin:settings:read", "admin:security:read", "admin:ip_allowlist:read", "admin:external_providers:read", "admin:external_token_refresh:read", "admin:directory_auth:read", "admin:saml_attribute_presets:read", "admin:saml_providers:list", "admin:saml_providers:read", "admin:webhooks:read", "admin:vc:credential_profiles:read", "admin:auth_config_plans:read", "admin:bulk_plans:read", "admin:agent_grants:read", "admin:agent_settings:read", "admin:agent_task_sets:read", "admin:agent_scope_policies:read", "admin:agent_baselines:read", "admin:jobs:read", "admin:audit:read", "admin:admin_audit:read", "admin:operational_logs:read", "admin:system_logs:read", "admin:logging:overview:read", "admin:logging:delivery_events:read", "admin:admin_logging:overview:read", "admin:email_deliveries:read", "admin:email_deliveries:recipient:masked:read", "admin:support_ops:registry:read", "admin:support_ops:aggregate:read", "admin:support_ops:actions:read", "admin:approvals:read"]',
       updated_at = __AUTHRIM_NOW_EPOCH_MILLISECONDS__
 WHERE id = 'role_ar_viewer'
   AND tenant_id = 'default'
   AND is_system = 1
   AND permissions_json NOT LIKE '%admin:system_logs:%';

