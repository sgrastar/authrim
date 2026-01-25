-- =============================================================================
-- Migration: PII Separation - Core DB (D1_CORE)
-- =============================================================================
-- Created: 2025-12-17
-- Description: Creates users_core table for Non-PII user data.
--              Part of PII/Non-PII database separation architecture.
--
-- IMPORTANT: This migration is for D1_CORE (the main database).
--            PII data migration is in migrations/pii/001_pii_initial.sql
--
-- Architecture:
-- - users_core: Non-PII user data (auth state, password hash, partition info)
-- - users_pii (D1_PII): Personal information (email, name, address)
--
-- Note: The existing `users` table is NOT modified.
--       New code should use users_core + users_pii pattern.
--       Legacy migration from `users` table will be done in Phase 6.
-- =============================================================================

-- =============================================================================
-- users_core Table (Non-PII)
-- =============================================================================
-- Core user data stored in D1_CORE database.
-- Contains authentication-related data without personal information.
--
-- Fields:
-- - id: User ID (UUID, same as users_pii.id for cross-reference)
-- - tenant_id: Tenant ID for multi-tenant support
-- - email_verified: Whether email is verified (no actual email stored here)
-- - phone_number_verified: Whether phone is verified (no phone stored here)
-- - email_domain_hash: Blind index for domain-based rules
-- - password_hash: Hashed password (Argon2)
-- - is_active: Soft delete flag
-- - user_type: end_user | admin | m2m
-- - pii_partition: Which PII DB contains user's PII
-- - pii_status: PII write status (none/pending/active/failed/deleted)
-- - created_at, updated_at, last_login_at: Timestamps
-- =============================================================================

CREATE TABLE IF NOT EXISTS users_core (
  -- Primary key (UUID, same as users_pii.id)
  id TEXT PRIMARY KEY,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- Verification status (not PII - just flags)
  email_verified INTEGER DEFAULT 0,
  phone_number_verified INTEGER DEFAULT 0,

  -- Blind index for domain-based role assignment (Phase 8)
  -- Stored as hash, cannot be reversed to original domain
  email_domain_hash TEXT,

  -- Authentication
  password_hash TEXT,

  -- Soft delete (1 = active, 0 = deleted)
  is_active INTEGER DEFAULT 1,

  -- User type: end_user | admin | m2m
  user_type TEXT NOT NULL DEFAULT 'end_user',

  -- PII partition info
  -- Which database contains this user's PII (e.g., 'default', 'eu', 'tenant-acme')
  pii_partition TEXT NOT NULL DEFAULT 'default',

  -- PII write status
  -- none: No PII (M2M clients)
  -- pending: Core created, PII write in progress
  -- active: Both Core and PII created successfully
  -- failed: PII write failed (requires retry via Admin UI)
  -- deleted: PII deleted (GDPR), tombstone created
  pii_status TEXT NOT NULL DEFAULT 'pending',

  -- Timestamps
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER
);

-- =============================================================================
-- Indexes for users_core
-- =============================================================================

-- Tenant lookup (most queries are tenant-scoped)
CREATE INDEX IF NOT EXISTS idx_users_core_tenant ON users_core(tenant_id);

-- Domain-based role assignment queries
CREATE INDEX IF NOT EXISTS idx_users_core_email_domain ON users_core(email_domain_hash);

-- Partition statistics and routing
CREATE INDEX IF NOT EXISTS idx_users_core_partition ON users_core(pii_partition);

-- Finding users with failed PII writes for retry
CREATE INDEX IF NOT EXISTS idx_users_core_pii_status ON users_core(pii_status);

-- Active users filter (soft delete)
CREATE INDEX IF NOT EXISTS idx_users_core_active ON users_core(is_active);

-- User type filter
CREATE INDEX IF NOT EXISTS idx_users_core_type ON users_core(tenant_id, user_type);

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Next steps:
-- 1. Create D1_PII database: wrangler d1 create authrim-pii
-- 2. Apply PII migration: migrations/pii/001_pii_initial.sql
-- 3. Update wrangler.toml with DB_PII binding
-- 4. Migrate existing users from `users` table (Phase 6)
-- =============================================================================
