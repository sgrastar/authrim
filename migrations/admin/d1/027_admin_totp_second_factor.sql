-- Migration: 027_admin_totp_second_factor.sql
-- Description: TOTP as an admin second factor (kind 'totp' in admin_second_factors).
--              - secret_encrypted: the shared secret, encrypted at rest (never returned by any
--                API); secret_key_version is the key it was encrypted with.
--              - last_used_time_step: the newest 30-second step a code was accepted for. A code
--                for a step at or before it is refused, so one code verifies once.
--              The code profile is fixed (SHA-1, 6 digits, 30 seconds), as authenticator apps
--              expect, so a row carries no profile columns. credential_id and holder_jkt stay
--              NULL for these rows.
-- Author: @authrim
-- Date: 2026-11-21
-- Issue: Admin step-up second-factor policy and TOTP

ALTER TABLE admin_second_factors ADD COLUMN secret_encrypted TEXT;
ALTER TABLE admin_second_factors ADD COLUMN secret_key_version INTEGER;
ALTER TABLE admin_second_factors ADD COLUMN last_used_time_step INTEGER;
