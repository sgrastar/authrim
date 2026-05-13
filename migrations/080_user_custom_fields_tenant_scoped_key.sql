-- Migration: 080_user_custom_fields_tenant_scoped_key.sql
-- Description: Make user_custom_fields keys tenant-scoped for duplicated user IDs.

CREATE TABLE user_custom_fields_new (
  user_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  field_value TEXT,
  field_type TEXT,
  searchable INTEGER DEFAULT 1,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  PRIMARY KEY (tenant_id, user_id, field_name),
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE
);

INSERT INTO user_custom_fields_new (
  user_id,
  field_name,
  field_value,
  field_type,
  searchable,
  tenant_id
)
SELECT
  user_id,
  field_name,
  field_value,
  field_type,
  searchable,
  tenant_id
FROM user_custom_fields;

DROP TABLE user_custom_fields;

ALTER TABLE user_custom_fields_new RENAME TO user_custom_fields;

CREATE INDEX idx_user_custom_fields_search
  ON user_custom_fields(tenant_id, field_name, field_value);
