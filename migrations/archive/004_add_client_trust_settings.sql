-- Migration: 004_add_client_trust_settings.sql
-- Description: Add Trusted Client support to enable First-Party clients to skip consent screens
-- Author: @claude
-- Date: 2025-01-20
-- Issue: Trusted Client implementation
-- Spec: packages/op-auth/TRUSTED_CLIENT_SPEC.md

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

-- Add trusted client flags to oauth_clients table
-- is_trusted: 1 = Trusted (First-Party) Client, 0 = Third-Party Client
-- skip_consent: 1 = Skip consent screen, 0 = Show consent screen
-- Trusted clients can automatically grant consent without user interaction

ALTER TABLE oauth_clients ADD COLUMN is_trusted INTEGER DEFAULT 0;
ALTER TABLE oauth_clients ADD COLUMN skip_consent INTEGER DEFAULT 0;

-- Index for faster lookup of trusted clients
CREATE INDEX IF NOT EXISTS idx_clients_trusted ON oauth_clients(is_trusted);

-- =============================================================================
-- Down Migration (Rollback) - COMMENTED OUT
-- =============================================================================
-- This section documents how to rollback this migration if needed.
-- Uncomment and execute manually if rollback is required.

-- Drop index:
-- DROP INDEX IF EXISTS idx_clients_trusted;

-- Remove columns:
-- ALTER TABLE oauth_clients DROP COLUMN skip_consent;
-- ALTER TABLE oauth_clients DROP COLUMN is_trusted;

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: 004
-- =============================================================================
