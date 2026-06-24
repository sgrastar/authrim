-- Migration: 020_passkeys_aaguid_metadata
-- Description: Store end-user WebAuthn authenticator AAGUID for passkey management display.
-- Note: AAGUID metadata is display-only and must not be used for trust decisions.

ALTER TABLE passkeys ADD COLUMN aaguid TEXT;
