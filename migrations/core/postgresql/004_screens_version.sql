-- Migration: 004_screens_version.sql
-- Description: Optimistic-concurrency version on screens (PostgreSQL), as the D1 migration of the
--              same name: a change names the version it was made from (If-Match) and raises it.
-- Author: @authrim
-- Date: 2026-11-06
-- Issue: Admin console screens (list and screen builder)

-- Existing screens start at version 1, as new ones do.
ALTER TABLE public.screens
  ADD COLUMN IF NOT EXISTS version integer DEFAULT 1 NOT NULL;

ALTER TABLE public.screens
  DROP CONSTRAINT IF EXISTS screens_version_check;

ALTER TABLE public.screens
  ADD CONSTRAINT screens_version_check CHECK ((version >= 1));

-- Rollback (manual):
-- ALTER TABLE public.screens DROP CONSTRAINT IF EXISTS screens_version_check;
-- ALTER TABLE public.screens DROP COLUMN IF EXISTS version;
