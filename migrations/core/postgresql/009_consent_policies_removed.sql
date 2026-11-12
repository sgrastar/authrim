-- Migration: 009_consent_policies_removed.sql
-- Description: Consent documents are asked by the Flow's consent node itself (PostgreSQL).
--              See migrations/core/d1/009_consent_policies_removed.sql. No data is carried over.
--              Holds no personal data.
-- Author: @authrim
-- Date: 2026-11-12
-- Issue: Consent redesign PR1 (document consent)

ALTER TABLE public.consent_statements ADD COLUMN IF NOT EXISTS required_consent_version TEXT;

-- A statement published before the boundary was kept requires agreement from its current version
-- (what the Flow asked until now); publishing a version without asking again then keeps it there.
UPDATE public.consent_statements
   SET required_consent_version = (
     SELECT v.version FROM public.consent_statement_versions v
      WHERE v.tenant_id = consent_statements.tenant_id
        AND v.statement_id = consent_statements.id
        AND v.is_current = 1
   )
 WHERE required_consent_version IS NULL;

DROP TABLE IF EXISTS public.consent_policy_items;
DROP TABLE IF EXISTS public.consent_policies;
DROP TABLE IF EXISTS public.client_consent_overrides;
DROP TABLE IF EXISTS public.tenant_consent_requirements;
