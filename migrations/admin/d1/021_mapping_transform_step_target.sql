-- Migration: 021_mapping_transform_step_target.sql
-- Description: A transform step that takes no input edge (the persistent_identifier step) names
--              where its value goes itself.
--              - Added: mapping_transform_steps.target_ref_json, the step's own output target.
--                Null for every other step, whose target is its edge's target.
-- Author: @authrim
-- Date: 2026-11-14
-- Issue: Persistent identifier step PR-3 (steps without an input edge)

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

ALTER TABLE mapping_transform_steps ADD COLUMN target_ref_json TEXT;

-- =============================================================================
-- Down Migration (Rollback) - COMMENTED OUT
-- =============================================================================
-- ALTER TABLE mapping_transform_steps DROP COLUMN target_ref_json;
-- DELETE FROM schema_migrations WHERE version = 21;

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: 021
-- =============================================================================
