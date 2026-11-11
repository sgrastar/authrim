-- Migration: 008_sign_in_flow_challenge_binding.sql
-- Description: What a sign-in that finishes in a later request needs to stay held to its Flow and
--              to the authorization request it answers.
--              - external_idp_auth_states.flow_challenge_id: the authorization request (challenge
--                id) an external sign-in answers, kept from the start to the callback. The Flow
--                interaction it names must have been started for it; with none, the app's own
--                sign-in Flow sets the methods and the session.
--              - directory_auth_migration_transactions.attempt_interaction_id: the Flow
--                interaction a directory sign-in ran in, for the session its migration or
--                recovery makes (that Flow's session profile, and the interaction it is recorded
--                as made in).
--              Neither holds personal data.
-- Author: @authrim
-- Date: 2026-11-11
-- Issue: Bind Flow interactions to their authorization request

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

ALTER TABLE external_idp_auth_states ADD COLUMN flow_challenge_id TEXT;
ALTER TABLE directory_auth_migration_transactions ADD COLUMN attempt_interaction_id TEXT;
