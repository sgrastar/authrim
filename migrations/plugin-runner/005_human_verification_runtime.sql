-- Built-in human-verification runtime configuration and body credential injection.

CREATE TABLE plugin_runner_encrypted_configs_v2 (
  installation_id TEXT NOT NULL,
  config_key TEXT NOT NULL,
  config_version INTEGER NOT NULL CHECK (config_version >= 1),
  injection_kind TEXT NOT NULL
    CHECK (injection_kind IN ('header', 'bearer', 'json_field', 'form_field')),
  injection_name TEXT NOT NULL,
  destination_host TEXT NOT NULL,
  encryption_key_id TEXT NOT NULL
    CHECK (encryption_key_id NOT GLOB '*[^a-z0-9._-]*' AND length(encryption_key_id) BETWEEN 1 AND 64),
  encrypted_value TEXT NOT NULL CHECK (substr(encrypted_value, 1, 7) = 'enc:v1:'),
  nonce_fingerprint TEXT NOT NULL UNIQUE
    CHECK (nonce_fingerprint NOT GLOB '*[^0-9a-f]*' AND length(nonce_fingerprint) = 64),
  reencrypt_state TEXT NOT NULL DEFAULT 'current'
    CHECK (reencrypt_state IN ('current', 'pending', 'verified')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (installation_id, config_key, config_version),
  FOREIGN KEY (installation_id) REFERENCES plugin_runner_installations(installation_id)
    ON DELETE CASCADE,
  CHECK (injection_name NOT GLOB '*[^A-Za-z0-9_.-]*' AND length(injection_name) BETWEEN 1 AND 64),
  CHECK (destination_host = lower(destination_host) AND instr(destination_host, '/') = 0
    AND instr(destination_host, ':') = 0),
  CHECK ((injection_kind = 'bearer' AND lower(injection_name) = 'authorization') OR
         injection_kind <> 'bearer')
);

INSERT INTO plugin_runner_encrypted_configs_v2 (
  installation_id, config_key, config_version, injection_kind, injection_name,
  destination_host, encryption_key_id, encrypted_value, nonce_fingerprint,
  reencrypt_state, created_at, updated_at
)
SELECT installation_id, config_key, config_version, injection_kind, injection_name,
       destination_host, encryption_key_id, encrypted_value, nonce_fingerprint,
       reencrypt_state, created_at, updated_at
  FROM plugin_runner_encrypted_configs;

DROP TABLE plugin_runner_encrypted_configs;
ALTER TABLE plugin_runner_encrypted_configs_v2 RENAME TO plugin_runner_encrypted_configs;

CREATE TABLE plugin_runner_human_verification_configs (
  installation_id TEXT NOT NULL,
  config_version INTEGER NOT NULL CHECK (config_version >= 1),
  provider TEXT NOT NULL CHECK (provider IN ('turnstile', 'hcaptcha', 'recaptcha')),
  site_key TEXT NOT NULL CHECK (length(site_key) BETWEEN 1 AND 2048),
  expected_hostname TEXT,
  widget_mode TEXT NOT NULL CHECK (widget_mode IN ('managed', 'checkbox', 'invisible', 'score')),
  score_threshold REAL NOT NULL CHECK (score_threshold >= 0 AND score_threshold <= 1),
  config_fingerprint TEXT NOT NULL
    CHECK (config_fingerprint NOT GLOB '*[^0-9a-f]*' AND length(config_fingerprint) = 64),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (installation_id, config_version),
  FOREIGN KEY (installation_id) REFERENCES plugin_runner_installations(installation_id)
    ON DELETE CASCADE,
  CHECK (expected_hostname IS NULL OR (
    expected_hostname = lower(expected_hostname) AND
    length(expected_hostname) BETWEEN 1 AND 253 AND
    instr(expected_hostname, '/') = 0 AND instr(expected_hostname, ':') = 0
  ))
);
