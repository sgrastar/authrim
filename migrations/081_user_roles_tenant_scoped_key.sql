-- Tenant-scope user role assignment identity.
-- Backward compatibility is intentionally not preserved during the tenant hardening pass.

PRAGMA foreign_keys=off;

CREATE TABLE user_roles_new (
  user_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  PRIMARY KEY (tenant_id, user_id, role_id),
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE,
  FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
);

INSERT INTO user_roles_new (user_id, role_id, created_at, tenant_id)
SELECT user_id, role_id, created_at, tenant_id
FROM user_roles;

DROP TABLE user_roles;
ALTER TABLE user_roles_new RENAME TO user_roles;

CREATE INDEX idx_user_roles_role ON user_roles(tenant_id, role_id, created_at);

PRAGMA foreign_keys=on;
