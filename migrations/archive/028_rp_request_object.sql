-- Migration: Add Request Object (JAR - RFC 9101) support for RP functionality
-- Date: 2025-12-31
-- Description: Enables signed request objects for external IdP authentication

-- Add request object fields to upstream_providers table
ALTER TABLE upstream_providers ADD COLUMN use_request_object INTEGER DEFAULT 0;
ALTER TABLE upstream_providers ADD COLUMN request_object_signing_alg TEXT;
ALTER TABLE upstream_providers ADD COLUMN private_key_jwk_encrypted TEXT;
ALTER TABLE upstream_providers ADD COLUMN public_key_jwk TEXT;
