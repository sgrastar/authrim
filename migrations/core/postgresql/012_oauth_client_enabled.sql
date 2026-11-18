-- Migration: 012_oauth_client_enabled.sql
-- Description: Allow OAuth clients to remain drafts until trust is activated.
-- Author: @authrim
-- Date: 2026-11-18

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

ALTER TABLE oauth_clients ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
