-- Migration: 009_consent_policies_removed.sql
-- Description: Consent documents are asked by the Flow's consent node itself.
--              - consent_statements.required_consent_version: the version from which agreement is
--                required. Publishing a version that asks people again moves it to that version;
--                publishing one that does not leaves it where it was.
--              - Dropped: consent policies (consent_policies, consent_policy_items), the tenant and
--                client requirement layer (tenant_consent_requirements, client_consent_overrides)
--                and the legacy privacy/terms/cookie version table (consent_policy_versions). Which
--                statements are asked, and whether each is required, is the Flow consent node's
--                `statements` setting. No data is carried over (no backward compatibility).
--              - consent_statements.reconsent_on_version_change is no longer read or written; the
--                column stays (dropping it would rebuild the table).
--              Holds no personal data.
-- Author: @authrim
-- Date: 2026-11-12
-- Issue: Consent redesign PR1 (document consent)

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

ALTER TABLE consent_statements ADD COLUMN required_consent_version TEXT;

-- A statement published before the boundary was kept requires agreement from its current version
-- (what the Flow asked until now); publishing a version without asking again then keeps it there.
UPDATE consent_statements
   SET required_consent_version = (
     SELECT v.version FROM consent_statement_versions v
      WHERE v.tenant_id = consent_statements.tenant_id
        AND v.statement_id = consent_statements.id
        AND v.is_current = 1
   )
 WHERE required_consent_version IS NULL;

DROP TABLE IF EXISTS consent_policy_items;
DROP TABLE IF EXISTS consent_policies;
DROP TABLE IF EXISTS client_consent_overrides;
DROP TABLE IF EXISTS tenant_consent_requirements;
DROP TABLE IF EXISTS consent_policy_versions;
