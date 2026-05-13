-- Add OpenID Connect Advanced Syntax for Claims client settings.

ALTER TABLE oauth_clients ADD COLUMN claims_parameter_policy TEXT;
ALTER TABLE oauth_clients ADD COLUMN asc_enabled INTEGER DEFAULT 1;
ALTER TABLE oauth_clients ADD COLUMN asc_protected_request_required INTEGER DEFAULT 1;
ALTER TABLE oauth_clients ADD COLUMN asc_sao_enabled INTEGER DEFAULT 1;
ALTER TABLE oauth_clients ADD COLUMN asc_transformed_claims_enabled INTEGER DEFAULT 1;
ALTER TABLE oauth_clients ADD COLUMN asc_allowed_transformed_claims TEXT;
