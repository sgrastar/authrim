-- Migration: 019_dynamic_publication_unknown_groups.sql
-- Description: dynamic_membership_publications.unknown_groups_json: the service groups whose
--              membership the publication could not decide for the subject (an evaluation result
--              of 'unknown', such as a missing attribute) or left out on purpose (a group decided
--              by an attribute the person writes themselves while it carries authorization), as a
--              JSON array of group ids. Written in the same batch as the subject's dynamic rows;
--              a reader treats those groups as unknown (neither member nor non-member). NULL for
--              records written before it: a reader treats every service group of the tenant as
--              unknown for such a record until it is republished.
--              policy_rules_version: a counter per tenant, raised in the same batch as every
--              policy rule create, update and delete, which the policy service compares with the
--              version its cached rules were read under before using them. Holds no personal data.
-- Author: @authrim
-- Date: 2026-11-28

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

ALTER TABLE dynamic_membership_publications ADD COLUMN unknown_groups_json TEXT;

CREATE TABLE policy_rules_version (
  tenant_id TEXT PRIMARY KEY NOT NULL,
  version INTEGER NOT NULL
);

-- =============================================================================
-- Down Migration (Rollback) - COMMENTED OUT
-- =============================================================================
-- DROP TABLE policy_rules_version;
-- ALTER TABLE dynamic_membership_publications DROP COLUMN unknown_groups_json;

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: 019
-- =============================================================================
