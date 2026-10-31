-- Experimental AWS bootstrap schema for Direct Auth codes in the narrow SAML profile.
-- The AWS runtime does not expose /token, so there is deliberately no redemption path.
CREATE TABLE IF NOT EXISTS authrim_aws_authorization_codes (
  tenant_id TEXT NOT NULL,
  code_sha256 CHAR(64) NOT NULL,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at_ms BIGINT NOT NULL,
  expires_at_ms BIGINT NOT NULL CHECK (expires_at_ms > created_at_ms),
  PRIMARY KEY (tenant_id, code_sha256)
);

CREATE INDEX IF NOT EXISTS authrim_aws_authorization_codes_user_expiry
  ON authrim_aws_authorization_codes (tenant_id, user_id, expires_at_ms);

-- A VOLATILE PL/pgSQL function obtains a fresh READ COMMITTED snapshot for the
-- count after waiting for the tenant/user advisory lock. A one-statement CTE
-- does not: its snapshot predates any lock wait and can over-issue codes.
CREATE FUNCTION authrim_aws_store_authorization_code(
  p_tenant_id TEXT,
  p_user_id TEXT,
  p_code_sha256 CHAR(64),
  p_client_id TEXT,
  p_payload JSONB,
  p_ttl_seconds INTEGER,
  p_max_codes_per_user INTEGER
) RETURNS BIGINT LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  active_count BIGINT;
  now_ms BIGINT;
  stored_expiry BIGINT;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'aws_authorization_code_isolation_unsupported';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'authrim-auth-code:' || p_tenant_id || ':' || p_user_id, 0
  ));
  now_ms := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  SELECT count(*) INTO active_count
    FROM authrim_aws_authorization_codes
   WHERE tenant_id = p_tenant_id AND user_id = p_user_id AND expires_at_ms > now_ms;
  IF active_count >= p_max_codes_per_user THEN
    RETURN NULL;
  END IF;
  INSERT INTO authrim_aws_authorization_codes
    (tenant_id, code_sha256, user_id, client_id, payload, created_at_ms, expires_at_ms)
  VALUES
    (p_tenant_id, p_code_sha256, p_user_id, p_client_id, p_payload,
     now_ms, now_ms + p_ttl_seconds::bigint * 1000)
  ON CONFLICT (tenant_id, code_sha256) DO NOTHING
  RETURNING expires_at_ms INTO stored_expiry;
  RETURN stored_expiry;
END;
$$;
