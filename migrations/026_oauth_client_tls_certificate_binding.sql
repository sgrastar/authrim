-- RFC 8705 per-client certificate-bound access token policy.
ALTER TABLE oauth_clients
ADD COLUMN tls_client_certificate_bound_access_tokens INTEGER NOT NULL DEFAULT 0;
