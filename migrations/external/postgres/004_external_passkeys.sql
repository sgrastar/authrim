-- =============================================================================
-- Authrim External Postgres Migration 004: Passkeys
-- Consolidated for fresh Authrim installs from migrations/external/postgres/004_external_passkeys_aaguid_metadata.sql.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Source: migrations/external/postgres/004_external_passkeys_aaguid_metadata.sql
-- -----------------------------------------------------------------------------

-- Migration: 004_external_passkeys_aaguid_metadata
-- Description: Store end-user WebAuthn authenticator AAGUID for passkey management display.
-- Note: AAGUID metadata is display-only and must not be used for trust decisions.

ALTER TABLE passkeys ADD COLUMN IF NOT EXISTS aaguid TEXT;
