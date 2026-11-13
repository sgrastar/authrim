-- Migration: 011_saml_sp_release_consent.sql
-- Description: Information release consent for SAML service providers (consent redesign PR2b).
--              - saml_sp_release_consents: a person's current decision on the information an SP
--                is given (item keys only, never values): what was shown, approved and declined,
--                the mode it was asked in, where it came from, whether the SP was refused, and a
--                revision every new decision moves on (a resumed request uses a decision only
--                while it is still the current one). Kept in the account database.
--              - saml_sp_release_consent_revocations: the withdrawal generation per person and SP
--                (as oauth_client_consent_revocations is for OIDC): a decision is written, and an
--                assertion issued, only under the current one.
--              - attribute_release_consents (the SAML release page's record) is dropped. No data
--                is carried over (people are asked again).
--              Holds no personal data beyond attribute names.
-- Author: @authrim
-- Date: 2026-11-13
-- Issue: Consent redesign PR2b (information release consent, SAML)

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

CREATE TABLE saml_sp_release_consents (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  sp_entity_id TEXT NOT NULL,
  presented_json TEXT NOT NULL,
  approved_json TEXT NOT NULL,
  declined_json TEXT NOT NULL,
  mode TEXT NOT NULL,
  basis TEXT NOT NULL,
  refused BIGINT NOT NULL DEFAULT 0,
  decision_revision BIGINT NOT NULL,
  consent_generation BIGINT NOT NULL DEFAULT 0,
  operation_id TEXT,
  decided_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, user_id, sp_entity_id)
);

CREATE TABLE saml_sp_release_consent_revocations (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  sp_entity_id TEXT NOT NULL,
  generation BIGINT NOT NULL DEFAULT 0,
  revoked_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, user_id, sp_entity_id)
);

