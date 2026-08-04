-- Migration: 044_drop_legacy_session_revocation_epochs.sql
-- Description: Remove the obsolete D1 session revocation authority from fresh-install schemas
-- Author: Authrim
-- Date: 2026-08-04

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

DROP TABLE IF EXISTS session_revocation_epochs;

-- =============================================================================
-- Down Migration (Rollback) - COMMENTED OUT
-- =============================================================================
-- No rollback is provided. SessionRevocationStore Durable Objects are the sole session revocation
-- authority, and recreating this table would reintroduce an unsupported persistence path.

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: 044
-- =============================================================================
