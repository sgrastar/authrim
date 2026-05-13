-- =============================================================================
-- Admin Infrastructure Role Templates
-- =============================================================================
-- Description: Adds built-in Admin roles for storage destinations and platform
-- database connection operations.

INSERT INTO admin_roles (
  id, tenant_id, name, display_name, description,
  permissions_json, hierarchy_level, role_type, is_system,
  created_at, updated_at, inherits_from
) SELECT
  'role_storage_destination_viewer',
  'default',
  'storage_destination_viewer',
  'Storage Destination Viewer',
  'View tenant storage destinations and usage without credential management privileges.',
  '["admin:storage_destinations:list","admin:storage_destinations:read","admin:storage_destinations:usage:read"]',
  32,
  'builtin',
  0,
  __AUTHRIM_NOW_EPOCH_MILLISECONDS__,
  __AUTHRIM_NOW_EPOCH_MILLISECONDS__,
  NULL
WHERE NOT EXISTS (
  SELECT 1 FROM admin_roles WHERE tenant_id = 'default' AND name = 'storage_destination_viewer'
);

INSERT INTO admin_roles (
  id, tenant_id, name, display_name, description,
  permissions_json, hierarchy_level, role_type, is_system,
  created_at, updated_at, inherits_from
) SELECT
  'role_storage_destination_admin',
  'default',
  'storage_destination_admin',
  'Storage Destination Admin',
  'Manage tenant storage destinations and allow feature owners to select approved destinations.',
  '["admin:storage_destinations:list","admin:storage_destinations:read","admin:storage_destinations:create","admin:storage_destinations:update","admin:storage_destinations:delete","admin:storage_destinations:credentials:write","admin:storage_destinations:test","admin:storage_destinations:usage:read","admin:diagnostic_logging:destination:select","admin:jobs:destination:select","admin:dr_backup:destination:select"]',
  55,
  'builtin',
  0,
  __AUTHRIM_NOW_EPOCH_MILLISECONDS__,
  __AUTHRIM_NOW_EPOCH_MILLISECONDS__,
  NULL
WHERE NOT EXISTS (
  SELECT 1 FROM admin_roles WHERE tenant_id = 'default' AND name = 'storage_destination_admin'
);

INSERT INTO admin_roles (
  id, tenant_id, name, display_name, description,
  permissions_json, hierarchy_level, role_type, is_system,
  created_at, updated_at, inherits_from
) SELECT
  'role_platform_database_viewer',
  'default',
  'platform_database_viewer',
  'Platform Database Viewer',
  'View platform database connections and routing state without changing runtime storage.',
  '["admin:database_connections:list","admin:database_connections:read","admin:database_connections:test","admin:database_routing:read"]',
  60,
  'builtin',
  0,
  __AUTHRIM_NOW_EPOCH_MILLISECONDS__,
  __AUTHRIM_NOW_EPOCH_MILLISECONDS__,
  NULL
WHERE NOT EXISTS (
  SELECT 1 FROM admin_roles WHERE tenant_id = 'default' AND name = 'platform_database_viewer'
);

INSERT INTO admin_roles (
  id, tenant_id, name, display_name, description,
  permissions_json, hierarchy_level, role_type, is_system,
  created_at, updated_at, inherits_from
) SELECT
  'role_platform_database_admin',
  'default',
  'platform_database_admin',
  'Platform Database Admin',
  'Manage platform database connections and perform controlled database routing changes.',
  '["admin:database_connections:list","admin:database_connections:read","admin:database_connections:create","admin:database_connections:update","admin:database_connections:delete","admin:database_connections:credentials:write","admin:database_connections:test","admin:database_routing:read","admin:database_routing:write","admin:database_routing:switch","admin:database_routing:rollback"]',
  85,
  'builtin',
  0,
  __AUTHRIM_NOW_EPOCH_MILLISECONDS__,
  __AUTHRIM_NOW_EPOCH_MILLISECONDS__,
  NULL
WHERE NOT EXISTS (
  SELECT 1 FROM admin_roles WHERE tenant_id = 'default' AND name = 'platform_database_admin'
);
