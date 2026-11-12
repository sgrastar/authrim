-- Migration: 010_information_release_consent.sql
-- Description: Information release consent for OIDC services (consent redesign PR2a).
--              - oauth_clients.information_release_consent: the service connection's setting
--                ({enabled, ask, show_values, purpose_statement_id}). Replaces
--                attribute_release_consent, which is dropped (no data carried over).
--              - oauth_client_consents.release_*: what the person was shown and decided for the
--                information released to the service (claim names only, never values), with the
--                mode it was asked in and where the approval came from (the person or the
--                service's trust). Written with the scope consent in one statement and deleted
--                with it on withdrawal.
--              Holds no personal data beyond claim names.
-- Author: @authrim
-- Date: 2026-11-12
-- Issue: Consent redesign PR2a (information release consent, OIDC)

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

ALTER TABLE oauth_clients ADD COLUMN information_release_consent TEXT;
ALTER TABLE oauth_clients DROP COLUMN attribute_release_consent;

ALTER TABLE oauth_client_consents ADD COLUMN release_presented_json TEXT;
ALTER TABLE oauth_client_consents ADD COLUMN release_approved_json TEXT;
ALTER TABLE oauth_client_consents ADD COLUMN release_declined_json TEXT;
ALTER TABLE oauth_client_consents ADD COLUMN release_mode TEXT;
ALTER TABLE oauth_client_consents ADD COLUMN release_basis TEXT;
ALTER TABLE oauth_client_consents ADD COLUMN release_decided_at INTEGER;
