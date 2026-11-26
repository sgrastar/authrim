-- Migration: 029_drop_logging_key_registry.sql
-- Description: Removes the log-encryption key registry and its rewrap jobs. Nothing ever created
--              a row in logging_key_registry or logging_key_versions (the only writers were the
--              baseline migrations and tests), so no rewrap job could be queued and the three
--              tables are empty. The admin-logging key registry and rewrap job routes, the rewrap
--              queue payload and the rewrap scheduler are removed in the same release. Tables are
--              dropped child first: logging_rewrap_jobs and logging_key_versions reference
--              logging_key_registry. logging_key_material_bodies (the credential and key-material
--              backends) is a different table and stays.
-- Author: @authrim
-- Date: 2026-11-26
-- Issue: Admin logging rebuild, PR1 (removal)

DROP TABLE IF EXISTS logging_rewrap_jobs;
DROP TABLE IF EXISTS logging_key_versions;
DROP TABLE IF EXISTS logging_key_registry;
