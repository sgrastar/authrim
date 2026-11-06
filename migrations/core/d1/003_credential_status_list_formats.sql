-- Migration: 003_credential_status_list_formats.sql
-- Description: Token Status List (bits=2) support: list format/bits/version/last_operation_id on status_lists and a unique (list, index) constraint on issued_credentials
-- Author: @authrim
-- Date: 2026-11-03
-- Issue: OpenID4VCI admin credential, stage 3

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

-- Existing lists keep their encoding: 'w3c_bitstring_v1' (gzip, MSB-first, 1 bit per entry).
-- New lists are 'ietf_tsl_v1' (zlib, LSB-first, 2 bits per entry).
-- version: optimistic-concurrency counter for status changes; last_operation_id: ties the paired
-- issued_credentials update of one batch to the status_lists update that won.
ALTER TABLE status_lists ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE status_lists ADD COLUMN format TEXT NOT NULL DEFAULT 'w3c_bitstring_v1';
ALTER TABLE status_lists ADD COLUMN bits INTEGER NOT NULL DEFAULT 1;
ALTER TABLE status_lists ADD COLUMN last_operation_id TEXT;

-- One credential per list slot. Existing allocation was sequential per list, so no duplicates exist.
CREATE UNIQUE INDEX IF NOT EXISTS idx_issued_credentials_status_slot
  ON issued_credentials(status_list_internal_id, status_list_index)
  WHERE status_list_internal_id IS NOT NULL AND status_list_index IS NOT NULL;

-- =============================================================================
-- Down Migration (Rollback) - COMMENTED OUT
-- =============================================================================
-- This section documents how to rollback this migration if needed.
-- Uncomment and execute manually if rollback is required.

-- DROP INDEX IF EXISTS idx_issued_credentials_status_slot;
-- ALTER TABLE status_lists DROP COLUMN last_operation_id;
-- ALTER TABLE status_lists DROP COLUMN bits;
-- ALTER TABLE status_lists DROP COLUMN format;
-- ALTER TABLE status_lists DROP COLUMN version;
-- DELETE FROM schema_migrations WHERE version = 3;

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: 003
-- =============================================================================
