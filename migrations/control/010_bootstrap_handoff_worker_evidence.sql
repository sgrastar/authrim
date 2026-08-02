-- Per-Worker immutable expectations for the setup-to-Control bootstrap handoff.
-- Settings bodies are never stored; setup and Control independently calculate the digest.

CREATE TABLE IF NOT EXISTS control_bootstrap_worker_evidence (
  environment_id TEXT NOT NULL,
  worker_script_name TEXT NOT NULL,
  expected_deployment_id TEXT NOT NULL,
  expected_version_id TEXT NOT NULL,
  expected_settings_digest TEXT NOT NULL
    CHECK (length(expected_settings_digest) = 64
      AND expected_settings_digest NOT GLOB '*[^0-9a-f]*'),
  observed_settings_digest TEXT
    CHECK (observed_settings_digest IS NULL OR (
      length(observed_settings_digest) = 64
      AND observed_settings_digest NOT GLOB '*[^0-9a-f]*'
    )),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'verified', 'blocked')),
  verification_error_code TEXT,
  observed_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (environment_id, worker_script_name),
  FOREIGN KEY (environment_id, worker_script_name)
    REFERENCES control_desired_worker_inventory(environment_id, worker_script_name)
      ON DELETE CASCADE,
  CHECK ((state = 'verified' AND observed_settings_digest = expected_settings_digest
    AND observed_at IS NOT NULL AND verification_error_code IS NULL) OR state <> 'verified'),
  CHECK ((state = 'blocked' AND verification_error_code IS NOT NULL) OR state <> 'blocked')
);

CREATE TRIGGER IF NOT EXISTS trg_control_bootstrap_worker_evidence_expectations_immutable
BEFORE UPDATE OF expected_deployment_id, expected_version_id, expected_settings_digest
ON control_bootstrap_worker_evidence
BEGIN
  SELECT RAISE(ABORT, 'control_bootstrap_worker_evidence_immutable');
END;

CREATE INDEX IF NOT EXISTS idx_control_bootstrap_worker_evidence_state
  ON control_bootstrap_worker_evidence(environment_id, state, worker_script_name);
