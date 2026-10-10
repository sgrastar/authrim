-- Bind a release rollout to the set of managed databases that Setup verified before the handoff.
--
-- A same-version draft append applies only the unapplied tail of an unpublished migration release.
-- Setup proves from lock evidence that every managed database holds an exact prefix of the draft,
-- but Control snapshots its own target set later. A tenant database provisioned in between has no
-- such evidence, so Control must compare its snapshot with the set Setup verified and fail closed
-- on any difference. NULL means the rollout carries no such binding (every other rollout kind).
--
-- The value is a JSON array of {"streamId": "...", "databaseId": "..."} objects.
ALTER TABLE control_release_migration_rollouts ADD COLUMN expected_targets_json TEXT
  CHECK (
    expected_targets_json IS NULL OR (
      json_valid(expected_targets_json) AND
      json_type(expected_targets_json) = 'array' AND
      length(expected_targets_json) <= 1048576
    )
  );

-- The expected set is fixed when the rollout is created, like the other pins. The one exception is
-- the re-arm of a rollout that Control blocked with release_target_set_mismatch: a fresh Setup run
-- that recomputed and re-verified the set may replace it while returning the rollout to
-- 'requested'. Control itself never re-arms such a rollout.
CREATE TRIGGER trg_control_release_migration_rollout_expected_targets_immutable
BEFORE UPDATE OF expected_targets_json ON control_release_migration_rollouts
WHEN OLD.expected_targets_json IS NOT NEW.expected_targets_json AND NOT (
  OLD.handoff_state = 'blocked' AND NEW.handoff_state = 'requested' AND
  EXISTS (
    SELECT 1 FROM control_operations operation
     WHERE operation.operation_id = OLD.operation_id
       AND operation.environment_id = OLD.environment_id
       AND operation.status = 'blocked'
       AND operation.last_error_code = 'release_target_set_mismatch'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'control_release_migration_rollout_immutable');
END;
