-- Migration: 007_account_registration_pending.sql
-- Description: An account a sign-up created before the person proved anything (PostgreSQL), as
--              the D1 migration of the same name: marked until the sign-up completes, with when
--              it may be cleaned up. It holds no personal data.
-- Author: @authrim
-- Date: 2026-11-08
-- Issue: Abandoned sign-up clean-up (lite Login UI PR6b)

CREATE TABLE IF NOT EXISTS public.account_registration_pending (
    tenant_id text NOT NULL,
    user_id text NOT NULL,
    flow text NOT NULL,
    created_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    CONSTRAINT account_registration_pending_pkey PRIMARY KEY (tenant_id, user_id),
    CONSTRAINT account_registration_pending_flow_check CHECK ((flow = ANY (ARRAY['email_code'::text, 'passkey'::text]))),
    CONSTRAINT account_registration_pending_created_check CHECK ((created_at >= 0)),
    CONSTRAINT account_registration_pending_expires_check CHECK ((expires_at >= created_at))
);

CREATE INDEX IF NOT EXISTS idx_account_registration_pending_expires
  ON public.account_registration_pending (tenant_id, expires_at, user_id);

-- Rollback (manual):
-- DROP INDEX IF EXISTS public.idx_account_registration_pending_expires;
-- DROP TABLE IF EXISTS public.account_registration_pending;
