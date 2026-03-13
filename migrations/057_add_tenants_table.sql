-- =============================================================================
-- Migration 057: Add tenants table
-- =============================================================================

CREATE TABLE tenants (
  id          TEXT PRIMARY KEY,           -- slug形式: ^[a-z0-9-]+$, max 63chars
  name        TEXT NOT NULL,              -- 表示名
  description TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1, -- 0=無効, 1=有効
  is_default  INTEGER NOT NULL DEFAULT 0, -- デフォルトテナント（1つのみ）
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- is_default=1 は1行のみ（SQLite partial unique index）
CREATE UNIQUE INDEX idx_tenants_is_default ON tenants(is_default)
  WHERE is_default = 1;

-- 既存の 'default' テナントを初期挿入（既に存在する場合はスキップ）
INSERT OR IGNORE INTO tenants (id, name, is_active, is_default, created_at, updated_at)
VALUES ('default', 'Default', 1, 1, unixepoch(), unixepoch());
