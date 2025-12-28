-- Migration: 019_logout_webhook
-- Description: Add Simple Logout Webhook support for clients
-- Date: 2024-12-28
--
-- This migration adds support for a simplified logout webhook mechanism
-- that allows Authrim to notify clients when a user logs out, without
-- requiring the client to implement full OIDC Back-Channel Logout.
--
-- Features:
-- - logout_webhook_uri: HTTP endpoint to receive logout notifications
-- - logout_webhook_secret_encrypted: HMAC secret for signature verification (AES-256-GCM encrypted)
--
-- Security:
-- - Webhook secret is encrypted at rest using RP_TOKEN_ENCRYPTION_KEY
-- - HMAC-SHA256 signature prevents tampering
-- - Timestamp header prevents replay attacks
-- - SSRF protection blocks internal/private IPs

-- Add logout webhook columns to oauth_clients table
ALTER TABLE oauth_clients ADD COLUMN logout_webhook_uri TEXT;
ALTER TABLE oauth_clients ADD COLUMN logout_webhook_secret_encrypted TEXT;

-- Note: The webhook URI is validated at registration time for:
-- 1. HTTPS requirement (except localhost for development)
-- 2. No fragment identifiers
-- 3. SSRF protection (blocks private IPs, cloud metadata endpoints)
--
-- The webhook secret:
-- - Can be client-specified (minimum 32 bytes) or auto-generated
-- - Is encrypted using AES-256-GCM before storage
-- - Is used to sign webhook payloads with HMAC-SHA256
