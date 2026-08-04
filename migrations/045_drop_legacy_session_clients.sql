-- Migration: 045_drop_legacy_session_clients.sql
-- Description: Remove the obsolete D1 session-client mirror; SessionClientStore DO is authoritative
-- Author: Authrim maintainers
-- Date: 2026-08-04

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

DROP TABLE IF EXISTS session_clients;

-- =============================================================================
-- Down Migration (Rollback) - COMMENTED OUT
-- =============================================================================
-- No rollback is provided. New installations use SessionClientStore Durable Objects as the sole
-- session-client association authority and do not read or write this D1 table.

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: 045
-- =============================================================================
