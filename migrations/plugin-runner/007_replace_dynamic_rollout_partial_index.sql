DROP INDEX IF EXISTS idx_plugin_runner_dynamic_rollout_active_plugin;

CREATE TRIGGER IF NOT EXISTS trg_plugin_runner_dynamic_rollout_running_insert
BEFORE INSERT ON plugin_runner_dynamic_worker_rollouts
WHEN NEW.state = 'running'
BEGIN
  SELECT RAISE(ABORT, 'plugin_dynamic_rollout_in_progress')
  WHERE EXISTS (
    SELECT 1 FROM plugin_runner_dynamic_worker_rollouts
     WHERE plugin_id = NEW.plugin_id AND state = 'running'
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_plugin_runner_dynamic_rollout_running_update
BEFORE UPDATE OF plugin_id, state ON plugin_runner_dynamic_worker_rollouts
WHEN NEW.state = 'running'
BEGIN
  SELECT RAISE(ABORT, 'plugin_dynamic_rollout_in_progress')
  WHERE EXISTS (
    SELECT 1 FROM plugin_runner_dynamic_worker_rollouts
     WHERE plugin_id = NEW.plugin_id
       AND state = 'running'
       AND operation_id <> OLD.operation_id
  );
END;
