-- Migration: Token Exchange (RFC 8693) and Client Credentials (RFC 6749) Support
-- Date: 2024-12-13
-- Description: Add columns to oauth_clients for Token Exchange and Client Credentials grant support

-- Token Exchange (RFC 8693) settings
-- token_exchange_allowed: Whether the client can use Token Exchange grant
ALTER TABLE oauth_clients ADD COLUMN token_exchange_allowed INTEGER DEFAULT 0;

-- allowed_subject_token_clients: JSON array of client IDs whose tokens can be exchanged
ALTER TABLE oauth_clients ADD COLUMN allowed_subject_token_clients TEXT;

-- allowed_token_exchange_resources: JSON array of resource URIs allowed for Token Exchange
ALTER TABLE oauth_clients ADD COLUMN allowed_token_exchange_resources TEXT;

-- delegation_mode: 'none' | 'delegation' | 'impersonation'
-- - 'none': Token Exchange disabled
-- - 'delegation': Include 'act' claim (recommended, default)
-- - 'impersonation': No 'act' claim (dangerous, requires audit)
ALTER TABLE oauth_clients ADD COLUMN delegation_mode TEXT DEFAULT 'delegation';

-- Client Credentials (RFC 6749 Section 4.4) settings
-- client_credentials_allowed: Whether the client can use Client Credentials grant
ALTER TABLE oauth_clients ADD COLUMN client_credentials_allowed INTEGER DEFAULT 0;

-- allowed_scopes: JSON array of scopes allowed for this client (for M2M)
ALTER TABLE oauth_clients ADD COLUMN allowed_scopes TEXT;

-- default_scope: Default scope when scope parameter is omitted
ALTER TABLE oauth_clients ADD COLUMN default_scope TEXT;

-- default_audience: Default audience when audience parameter is omitted
ALTER TABLE oauth_clients ADD COLUMN default_audience TEXT;
