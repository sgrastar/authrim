-- Migration: 005_flow_interaction_submit_claim.sql
-- Description: A submit of a Flow runtime step holds its interaction while it runs: the claim is
--              taken with a conditional UPDATE before anything is recorded, and the step's state
--              is written only under it, so two submits of one step (two tabs, a retried request)
--              cannot both advance it. A claim that is not released lapses at its expiry.
-- Author: @authrim
-- Date: 2026-11-08
-- Issue: Flow runtime step submit without mutual exclusion

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

-- The submit holding the interaction (an id of its own), and until when (epoch seconds). No
-- claim: NULL expiry. A completed submit leaves its id with the expiry cleared.
ALTER TABLE flow_interactions ADD COLUMN submit_claim_id TEXT;
ALTER TABLE flow_interactions ADD COLUMN submit_claim_expires_at INTEGER;

-- =============================================================================
-- Down Migration (Rollback) - COMMENTED OUT
-- =============================================================================
-- This section documents how to rollback this migration if needed.
-- Uncomment and execute manually if rollback is required.

-- ALTER TABLE flow_interactions DROP COLUMN submit_claim_expires_at;
-- ALTER TABLE flow_interactions DROP COLUMN submit_claim_id;

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: 005
-- =============================================================================
