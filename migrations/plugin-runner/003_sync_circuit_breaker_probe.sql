-- Fence half-open synchronous hook probes so only one request tests recovery.

ALTER TABLE plugin_runner_circuit_breakers ADD COLUMN probe_token TEXT;
ALTER TABLE plugin_runner_circuit_breakers ADD COLUMN probe_until INTEGER;

CREATE INDEX IF NOT EXISTS idx_plugin_runner_circuit_breakers_retry
  ON plugin_runner_circuit_breakers(state, retry_after, probe_until);
