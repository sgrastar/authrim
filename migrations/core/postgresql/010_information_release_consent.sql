-- Migration: 010_information_release_consent.sql
-- Description: Information release consent for OIDC services (consent redesign PR2a). See the D1
--              migration of the same name.
-- Author: @authrim
-- Date: 2026-11-12
-- Issue: Consent redesign PR2a (information release consent, OIDC)

ALTER TABLE oauth_clients ADD COLUMN information_release_consent TEXT;
ALTER TABLE oauth_clients DROP COLUMN attribute_release_consent;

ALTER TABLE oauth_client_consents ADD COLUMN release_presented_json TEXT;
ALTER TABLE oauth_client_consents ADD COLUMN release_approved_json TEXT;
ALTER TABLE oauth_client_consents ADD COLUMN release_declined_json TEXT;
ALTER TABLE oauth_client_consents ADD COLUMN release_mode TEXT;
ALTER TABLE oauth_client_consents ADD COLUMN release_basis TEXT;
ALTER TABLE oauth_client_consents ADD COLUMN release_decided_at BIGINT;
