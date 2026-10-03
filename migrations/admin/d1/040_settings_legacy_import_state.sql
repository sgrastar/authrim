-- Migration: 040_settings_legacy_import_state.sql
-- Description: The state of the one-time import of the older settings stores into the Settings
--   API (one row). Every change compares and sets the revision, so a step that started from an
--   older state (or an admin's restart or acceptance made meanwhile) cannot be overwritten.
-- Date: 2026-10-01

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

CREATE TABLE settings_legacy_import_state (
  id INTEGER NOT NULL PRIMARY KEY CHECK(id=1),
  state_json TEXT NOT NULL CHECK(
    json_valid(state_json) AND
    json_type(state_json)='object' AND
    length(CAST(state_json AS BLOB))<=262144
  ),
  revision INTEGER NOT NULL CHECK(revision>0),
  updated_at INTEGER NOT NULL CHECK(updated_at>=0)
) STRICT;

-- =============================================================================
-- Down Migration (Rollback) - COMMENTED OUT
-- =============================================================================
-- DROP TABLE IF EXISTS settings_legacy_import_state;
