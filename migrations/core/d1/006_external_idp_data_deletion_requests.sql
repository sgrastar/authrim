-- Migration: 006_external_idp_data_deletion_requests.sql
-- Description: The status of a data deletion request an identity provider sent for one of its
--              users (Facebook's Data Deletion Request Callback). The provider shows the person a
--              status URL and a confirmation code; this record answers that URL. It holds no
--              personal data: no provider user id, no email. While the unlink's cleanup is still
--              running it names the account and the unlink operation (to look the outcome up);
--              both are cleared once the request is completed.
-- Author: @authrim
-- Date: 2026-11-08
-- Issue: Facebook data deletion and deauthorize callbacks

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

CREATE TABLE IF NOT EXISTS external_idp_data_deletion_requests (
  tenant_id TEXT NOT NULL,
  -- Random, unguessable: the person's handle to the status (shown by the provider).
  confirmation_code TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  -- pending: the link is removed, its cleanup (the lookup directory) still runs.
  -- completed: Authrim holds no data received from the provider for the person.
  -- retained: a legal hold on the account keeps the data; nothing was erased.
  state TEXT NOT NULL CHECK (state IN ('pending', 'completed', 'retained')),
  account_id TEXT,
  unlink_operation_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  PRIMARY KEY (tenant_id, confirmation_code),
  CHECK (
    (state = 'pending' AND account_id IS NOT NULL AND unlink_operation_id IS NOT NULL
      AND completed_at IS NULL)
    OR (state = 'completed' AND account_id IS NULL AND unlink_operation_id IS NULL
      AND completed_at IS NOT NULL)
    OR (state = 'retained' AND account_id IS NULL AND unlink_operation_id IS NULL
      AND completed_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_external_idp_data_deletion_requests_created
  ON external_idp_data_deletion_requests (tenant_id, created_at);

-- =============================================================================
-- Down Migration (Rollback) - COMMENTED OUT
-- =============================================================================
-- This section documents how to rollback this migration if needed.
-- Uncomment and execute manually if rollback is required.

-- DROP INDEX IF EXISTS idx_external_idp_data_deletion_requests_created;
-- DROP TABLE IF EXISTS external_idp_data_deletion_requests;

-- =============================================================================
-- Migration Complete
-- =============================================================================
