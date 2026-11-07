-- Migration: 005_flow_interaction_submit_claim.sql
-- Description: The claim a Flow runtime step submit holds on its interaction (PostgreSQL), as the
--              D1 migration of the same name: taken with a conditional UPDATE before anything is
--              recorded, so two submits of one step cannot both advance it.
-- Author: @authrim
-- Date: 2026-11-08
-- Issue: Flow runtime step submit without mutual exclusion

-- The submit holding the interaction (an id of its own), and until when (epoch seconds). No
-- claim: NULL expiry. A completed submit leaves its id with the expiry cleared.
ALTER TABLE public.flow_interactions
  ADD COLUMN IF NOT EXISTS submit_claim_id text;

ALTER TABLE public.flow_interactions
  ADD COLUMN IF NOT EXISTS submit_claim_expires_at bigint;

-- Rollback (manual):
-- ALTER TABLE public.flow_interactions DROP COLUMN IF EXISTS submit_claim_expires_at;
-- ALTER TABLE public.flow_interactions DROP COLUMN IF EXISTS submit_claim_id;
