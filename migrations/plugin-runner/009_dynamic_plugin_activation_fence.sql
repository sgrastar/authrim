-- Fence delayed resource-provisioning finalizers against a newer disable request.

ALTER TABLE plugin_runner_installations
  ADD COLUMN pending_activation_request_id TEXT
    CHECK (
      pending_activation_request_id IS NULL OR (
        length(pending_activation_request_id) BETWEEN 1 AND 256 AND
        pending_activation_request_id NOT GLOB '*[^A-Za-z0-9._:-]*'
      )
    );

CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_runner_pending_activation_request
  ON plugin_runner_installations(pending_activation_request_id);
