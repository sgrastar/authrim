-- Migration: 003_screen_responses.sql
-- Description: Response records of login screens (PostgreSQL), as the D1 migration of the same
--              name: a signed-in person's answers to the parts whose answers go to the record.
-- Author: @authrim
-- Date: 2026-11-07
-- Issue: Admin console screens (answer storage)

CREATE TABLE IF NOT EXISTS public.screen_responses (
    id text NOT NULL,
    tenant_id text NOT NULL,
    user_id text NOT NULL,
    screen_id text NOT NULL,
    screen_key text NOT NULL,
    flow_id text,
    flow_version_id text,
    interaction_id text,
    step_id text,
    answers_json text NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    CONSTRAINT screen_responses_pkey PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_screen_responses_screen
  ON public.screen_responses USING btree (tenant_id, screen_id, created_at, id);

CREATE INDEX IF NOT EXISTS idx_screen_responses_user
  ON public.screen_responses USING btree (tenant_id, user_id, created_at);

-- Rollback (manual):
-- DROP INDEX IF EXISTS public.idx_screen_responses_user;
-- DROP INDEX IF EXISTS public.idx_screen_responses_screen;
-- DROP TABLE IF EXISTS public.screen_responses;
