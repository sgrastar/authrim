-- =============================================================================
-- Migration 057: Add tenants table
-- =============================================================================

CREATE TABLE tenants (
  id          TEXT PRIMARY KEY,           -- slug形式: ^[a-z0-9-]+$, max 63chars
  name        TEXT NOT NULL,              -- 表示名
  description TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1, -- 0=無効, 1=有効
  is_default  INTEGER NOT NULL DEFAULT 0, -- デフォルトテナント（1つのみ）
  default_tenant_guard TEXT,              -- 'default' when is_default=1, NULL otherwise
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Portable uniqueness: only the default tenant materializes a shared sentinel
CREATE UNIQUE INDEX idx_tenants_is_default ON tenants(default_tenant_guard);

-- 既存の 'default' テナントを初期挿入（既に存在する場合はスキップ）
INSERT INTO tenants (id, name, is_active, is_default, default_tenant_guard, created_at, updated_at)
SELECT 'default', 'Default', 1, 1, 'default',
       __AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_SECONDS__
WHERE NOT EXISTS (
  SELECT 1
  FROM tenants
  WHERE id = 'default'
);
