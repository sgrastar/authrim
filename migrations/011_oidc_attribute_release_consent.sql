-- Add OIDC claim release consent policy selector to OAuth clients.
-- Stores AttributeReleaseConsentPolicy as JSON:
--   { "enabled": true, "mode": "once" | "every_time" | "until_attributes_change" }

ALTER TABLE oauth_clients ADD COLUMN attribute_release_consent TEXT;
