-- Authrim Phase 5: Seed Default Data
-- Created: 2025-11-13
-- Description: Insert default roles, branding settings, and test data
-- Documentation: docs/architecture/database-schema.md

-- =============================================================================
-- Default Roles (RBAC)
-- =============================================================================

-- Super Admin: Full system access
INSERT INTO roles (id, name, description, permissions_json, created_at) VALUES (
  'role_super_admin',
  'super_admin',
  'Super Administrator with full system access',
  '["*"]',
  strftime('%s', 'now')
);

-- Admin: User and client management
INSERT INTO roles (id, name, description, permissions_json, created_at) VALUES (
  'role_admin',
  'admin',
  'Administrator with user and client management permissions',
  '["users:read","users:write","users:delete","clients:read","clients:write","clients:delete","sessions:read","sessions:revoke","stats:read","audit:read"]',
  strftime('%s', 'now')
);

-- Viewer: Read-only access
INSERT INTO roles (id, name, description, permissions_json, created_at) VALUES (
  'role_viewer',
  'viewer',
  'Viewer with read-only access to system data',
  '["users:read","clients:read","stats:read","audit:read"]',
  strftime('%s', 'now')
);

-- Support: User support operations
INSERT INTO roles (id, name, description, permissions_json, created_at) VALUES (
  'role_support',
  'support',
  'Support user with limited user management permissions',
  '["users:read","users:write","sessions:read","sessions:revoke"]',
  strftime('%s', 'now')
);

-- =============================================================================
-- Default Branding Settings
-- =============================================================================

INSERT INTO branding_settings (id, primary_color, secondary_color, font_family, updated_at) VALUES (
  'default',
  '#3B82F6',
  '#10B981',
  'Inter',
  strftime('%s', 'now')
);

-- =============================================================================
-- Default Scope Mappings (OIDC Standard Claims)
-- =============================================================================

-- Profile scope mappings
INSERT INTO scope_mappings (scope, claim_name, source_table, source_column, transformation, condition, created_at) VALUES
  ('profile', 'name', 'users', 'name', NULL, NULL, strftime('%s', 'now')),
  ('profile', 'given_name', 'users', 'given_name', NULL, NULL, strftime('%s', 'now')),
  ('profile', 'family_name', 'users', 'family_name', NULL, NULL, strftime('%s', 'now')),
  ('profile', 'middle_name', 'users', 'middle_name', NULL, NULL, strftime('%s', 'now')),
  ('profile', 'nickname', 'users', 'nickname', NULL, NULL, strftime('%s', 'now')),
  ('profile', 'preferred_username', 'users', 'preferred_username', NULL, NULL, strftime('%s', 'now')),
  ('profile', 'profile', 'users', 'profile', NULL, NULL, strftime('%s', 'now')),
  ('profile', 'picture', 'users', 'picture', NULL, NULL, strftime('%s', 'now')),
  ('profile', 'website', 'users', 'website', NULL, NULL, strftime('%s', 'now')),
  ('profile', 'gender', 'users', 'gender', NULL, NULL, strftime('%s', 'now')),
  ('profile', 'birthdate', 'users', 'birthdate', NULL, NULL, strftime('%s', 'now')),
  ('profile', 'zoneinfo', 'users', 'zoneinfo', NULL, NULL, strftime('%s', 'now')),
  ('profile', 'locale', 'users', 'locale', NULL, NULL, strftime('%s', 'now')),
  ('profile', 'updated_at', 'users', 'updated_at', NULL, NULL, strftime('%s', 'now'));

-- Email scope mapping
INSERT INTO scope_mappings (scope, claim_name, source_table, source_column, transformation, condition, created_at) VALUES
  ('email', 'email', 'users', 'email', NULL, NULL, strftime('%s', 'now')),
  ('email', 'email_verified', 'users', 'email_verified', NULL, NULL, strftime('%s', 'now'));

-- Phone scope mapping
INSERT INTO scope_mappings (scope, claim_name, source_table, source_column, transformation, condition, created_at) VALUES
  ('phone', 'phone_number', 'users', 'phone_number', NULL, NULL, strftime('%s', 'now')),
  ('phone', 'phone_number_verified', 'users', 'phone_number_verified', NULL, NULL, strftime('%s', 'now'));

-- Address scope mapping
INSERT INTO scope_mappings (scope, claim_name, source_table, source_column, transformation, condition, created_at) VALUES
  ('address', 'address', 'users', 'address_json', NULL, NULL, strftime('%s', 'now'));

-- =============================================================================
-- Test Data (Development/Staging Only)
-- NOTE: Remove this section before deploying to production!
-- =============================================================================

-- Test Admin User
INSERT INTO users (
  id,
  email,
  email_verified,
  name,
  given_name,
  family_name,
  picture,
  created_at,
  updated_at,
  last_login_at
) VALUES (
  'user_test_admin',
  'admin@test.authrim.org',
  1,
  'Test Admin',
  'Test',
  'Admin',
  'https://ui-avatars.com/api/?name=Test+Admin&background=3B82F6&color=fff',
  strftime('%s', 'now'),
  strftime('%s', 'now'),
  NULL
);

-- Assign super_admin role to test admin
INSERT INTO user_roles (user_id, role_id, created_at) VALUES (
  'user_test_admin',
  'role_super_admin',
  strftime('%s', 'now')
);

-- Test Regular User
INSERT INTO users (
  id,
  email,
  email_verified,
  name,
  given_name,
  family_name,
  picture,
  created_at,
  updated_at,
  last_login_at
) VALUES (
  'user_test_user',
  'user@test.authrim.org',
  1,
  'Test User',
  'Test',
  'User',
  'https://ui-avatars.com/api/?name=Test+User&background=10B981&color=fff',
  strftime('%s', 'now'),
  strftime('%s', 'now'),
  NULL
);

-- Test Support User
INSERT INTO users (
  id,
  email,
  email_verified,
  name,
  given_name,
  family_name,
  picture,
  created_at,
  updated_at,
  last_login_at
) VALUES (
  'user_test_support',
  'support@test.authrim.org',
  1,
  'Test Support',
  'Test',
  'Support',
  'https://ui-avatars.com/api/?name=Test+Support&background=F59E0B&color=fff',
  strftime('%s', 'now'),
  strftime('%s', 'now'),
  NULL
);

-- Assign support role
INSERT INTO user_roles (user_id, role_id, created_at) VALUES (
  'user_test_support',
  'role_support',
  strftime('%s', 'now')
);

-- Test OAuth Client (for development)
INSERT INTO oauth_clients (
  client_id,
  client_secret,
  client_name,
  redirect_uris,
  grant_types,
  response_types,
  scope,
  logo_uri,
  client_uri,
  policy_uri,
  tos_uri,
  subject_type,
  token_endpoint_auth_method,
  created_at,
  updated_at
) VALUES (
  'test_client_app',
  '$2a$10$YourHashedSecretHere',
  'Test Application',
  '["http://localhost:3000/callback","http://localhost:3000/auth/callback"]',
  '["authorization_code","refresh_token"]',
  '["code"]',
  'openid profile email',
  'https://ui-avatars.com/api/?name=Test+App&background=6366F1&color=fff',
  'http://localhost:3000',
  'http://localhost:3000/privacy',
  'http://localhost:3000/terms',
  'public',
  'client_secret_basic',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

-- Test OAuth Client (SPA - no secret)
INSERT INTO oauth_clients (
  client_id,
  client_secret,
  client_name,
  redirect_uris,
  grant_types,
  response_types,
  scope,
  logo_uri,
  client_uri,
  subject_type,
  token_endpoint_auth_method,
  created_at,
  updated_at
) VALUES (
  'test_spa_app',
  NULL,
  'Test SPA Application',
  '["http://localhost:5173/callback","http://localhost:5173/auth/callback"]',
  '["authorization_code","refresh_token"]',
  '["code"]',
  'openid profile email',
  'https://ui-avatars.com/api/?name=SPA&background=EC4899&color=fff',
  'http://localhost:5173',
  'public',
  'none',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

-- Sample Custom Field for Test User
INSERT INTO user_custom_fields (user_id, field_name, field_value, field_type, searchable) VALUES (
  'user_test_user',
  'employee_id',
  'EMP-12345',
  'string',
  1
);

INSERT INTO user_custom_fields (user_id, field_name, field_value, field_type, searchable) VALUES (
  'user_test_user',
  'department',
  'Engineering',
  'string',
  1
);

-- Sample Audit Log Entries
INSERT INTO audit_log (id, user_id, action, resource_type, resource_id, ip_address, user_agent, created_at) VALUES (
  'audit_' || lower(hex(randomblob(16))),
  'user_test_admin',
  'user.created',
  'user',
  'user_test_user',
  '127.0.0.1',
  'Mozilla/5.0 (Test)',
  strftime('%s', 'now')
);

INSERT INTO audit_log (id, user_id, action, resource_type, resource_id, ip_address, user_agent, created_at) VALUES (
  'audit_' || lower(hex(randomblob(16))),
  'user_test_admin',
  'client.created',
  'oauth_client',
  'test_client_app',
  '127.0.0.1',
  'Mozilla/5.0 (Test)',
  strftime('%s', 'now')
);

-- =============================================================================
-- Seed Complete
-- =============================================================================
-- Default roles: 4
-- Default scope mappings: 19
-- Test users: 3
-- Test clients: 2
-- Version: 002
-- =============================================================================
