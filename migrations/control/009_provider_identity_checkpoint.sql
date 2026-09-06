-- Persist immutable provider identity before post-create work or retry.

ALTER TABLE control_desired_resources
  ADD COLUMN provider_create_state TEXT NOT NULL DEFAULT 'not_started'
    CHECK (provider_create_state IN ('not_started', 'issued', 'identified'));
ALTER TABLE control_desired_resources ADD COLUMN provider_resource_id TEXT;
ALTER TABLE control_desired_resources ADD COLUMN provider_identity_checkpointed_at INTEGER;

UPDATE control_desired_resources AS desired
   SET provider_create_state = 'identified',
       provider_resource_id = (
         SELECT observed.provider_resource_id
           FROM control_observed_resources observed
          WHERE observed.observed_resource_id = desired.observed_resource_id
            AND observed.desired_resource_id = desired.desired_resource_id
            AND observed.environment_id = desired.environment_id
       ),
       provider_identity_checkpointed_at = desired.updated_at
 WHERE desired.observed_resource_id IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM control_observed_resources observed
      WHERE observed.observed_resource_id = desired.observed_resource_id
        AND observed.desired_resource_id = desired.desired_resource_id
        AND observed.environment_id = desired.environment_id
        AND observed.provider_resource_id IS NOT NULL
   );

UPDATE control_desired_resources
   SET provisioning_state = 'failed', updated_at = unixepoch()
 WHERE resource_kind = 'd1' AND provisioning_state IN ('ready', 'active')
   AND provider_create_state <> 'identified';

CREATE INDEX idx_control_desired_resources_provider_create_state
  ON control_desired_resources(environment_id, provider_create_state, updated_at);

-- A short-lived row in this table is used as the last statement of a D1 batch assertion. Writing
-- valid = 0 raises a named SQL error inside the provider transaction, rolling every earlier
-- projection in that batch back. Successful batches delete their assertion row before commit.
CREATE TABLE control_provider_identity_projection_assertions (
  assertion_id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL,
  desired_resource_id TEXT NOT NULL,
  valid INTEGER NOT NULL CHECK (valid IN (0, 1)),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (desired_resource_id, environment_id)
    REFERENCES control_desired_resources(desired_resource_id, environment_id) ON DELETE CASCADE
);

CREATE TRIGGER trg_control_provider_identity_projection_assertion
BEFORE INSERT ON control_provider_identity_projection_assertions
WHEN NEW.valid <> 1
BEGIN
  SELECT RAISE(ABORT, 'control_d1_provider_identity_projection_mismatch');
END;

-- General short-lived assertion for fenced multi-row operation transitions. Unlike the provider
-- projection tables, this deliberately has no foreign key: it must still insert valid = 0 and
-- abort when a required operation, step, or projection row is missing.
CREATE TABLE control_operation_transition_assertions (
  assertion_id TEXT PRIMARY KEY,
  valid INTEGER NOT NULL CHECK (valid IN (0, 1)),
  created_at INTEGER NOT NULL
);

CREATE TRIGGER trg_control_operation_transition_assertion
BEFORE INSERT ON control_operation_transition_assertions
WHEN NEW.valid <> 1
BEGIN
  SELECT RAISE(ABORT, 'control_operation_transition_mismatch');
END;

CREATE TRIGGER trg_control_desired_resources_provider_identity_insert
BEFORE INSERT ON control_desired_resources
WHEN (NEW.provider_create_state = 'identified' AND
      (NEW.provider_resource_id IS NULL OR NEW.provider_identity_checkpointed_at IS NULL))
  OR (NEW.provider_create_state = 'issued' AND
      (NEW.provider_resource_id IS NOT NULL OR NEW.provider_identity_checkpointed_at IS NOT NULL))
  OR (NEW.resource_kind = 'd1' AND NEW.provisioning_state IN ('ready', 'active') AND
      NEW.provider_create_state <> 'identified' AND NOT (
        NEW.provider_create_state = 'not_started' AND NEW.observed_resource_id IS NOT NULL AND
        EXISTS (
          SELECT 1 FROM control_observed_resources observed
           WHERE observed.observed_resource_id = NEW.observed_resource_id
             AND observed.desired_resource_id = NEW.desired_resource_id
             AND observed.environment_id = NEW.environment_id
             AND observed.provider_resource_id IS NOT NULL
        )
      ))
BEGIN
  SELECT RAISE(ABORT, 'control_desired_resource_provider_identity_invalid');
END;

CREATE TRIGGER trg_control_desired_resources_provider_identity_update
BEFORE UPDATE OF provider_create_state, provider_resource_id,
  provider_identity_checkpointed_at, provisioning_state ON control_desired_resources
WHEN (NEW.provider_create_state = 'identified' AND
      (NEW.provider_resource_id IS NULL OR NEW.provider_identity_checkpointed_at IS NULL))
  OR (NEW.provider_create_state = 'issued' AND
      (NEW.provider_resource_id IS NOT NULL OR NEW.provider_identity_checkpointed_at IS NOT NULL))
  OR (OLD.provider_create_state = 'identified' AND
      (NEW.provider_create_state <> 'identified' OR
       NEW.provider_resource_id <> OLD.provider_resource_id OR
       NEW.provider_identity_checkpointed_at <> OLD.provider_identity_checkpointed_at))
  OR (OLD.provider_create_state <> 'issued' AND OLD.provider_create_state <> 'identified' AND
      NEW.provider_create_state = 'identified' AND NOT EXISTS (
        SELECT 1 FROM control_observed_resources observed
         WHERE observed.observed_resource_id = NEW.observed_resource_id
           AND observed.desired_resource_id = NEW.desired_resource_id
           AND observed.environment_id = NEW.environment_id
           AND observed.provider_resource_id = NEW.provider_resource_id
      ))
  OR (OLD.provider_create_state <> 'not_started' AND NEW.provider_create_state = 'issued')
  OR (NEW.resource_kind = 'd1' AND NEW.provisioning_state IN ('ready', 'active') AND
      NEW.provider_create_state <> 'identified' AND NOT (
        NEW.provider_create_state = 'not_started' AND NEW.observed_resource_id IS NOT NULL AND
        EXISTS (
          SELECT 1 FROM control_observed_resources observed
           WHERE observed.observed_resource_id = NEW.observed_resource_id
             AND observed.desired_resource_id = NEW.desired_resource_id
             AND observed.environment_id = NEW.environment_id
             AND observed.provider_resource_id IS NOT NULL
        )
      ))
BEGIN
  SELECT RAISE(ABORT, 'control_desired_resource_provider_identity_invalid');
END;

-- During the expand-to-coordinator-cutover window, the previous Control version records an exact
-- observed UUID but does not know the new checkpoint columns. Promote only that joined immutable
-- UUID; a mutable deterministic name is never sufficient evidence.
CREATE TRIGGER trg_control_desired_resources_provider_identity_from_observed
AFTER UPDATE OF observed_resource_id ON control_desired_resources
WHEN NEW.provider_create_state = 'not_started' AND NEW.observed_resource_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM control_observed_resources observed
     WHERE observed.observed_resource_id = NEW.observed_resource_id
       AND observed.desired_resource_id = NEW.desired_resource_id
       AND observed.environment_id = NEW.environment_id
       AND observed.provider_resource_id IS NOT NULL
  )
BEGIN
  UPDATE control_desired_resources
     SET provider_create_state = 'identified',
         provider_resource_id = (
           SELECT observed.provider_resource_id
             FROM control_observed_resources observed
            WHERE observed.observed_resource_id = NEW.observed_resource_id
              AND observed.desired_resource_id = NEW.desired_resource_id
              AND observed.environment_id = NEW.environment_id
         ),
         provider_identity_checkpointed_at = NEW.updated_at
   WHERE desired_resource_id = NEW.desired_resource_id
     AND environment_id = NEW.environment_id
     AND provider_create_state = 'not_started';
END;

ALTER TABLE control_plugin_desired_resources
  ADD COLUMN provider_create_state TEXT NOT NULL DEFAULT 'not_started'
    CHECK (provider_create_state IN ('not_started', 'issued', 'identified', 'legacy_unverified'));
ALTER TABLE control_plugin_desired_resources ADD COLUMN provider_creation_date TEXT;
ALTER TABLE control_plugin_desired_resources ADD COLUMN provider_ownership_marker_key TEXT;
ALTER TABLE control_plugin_desired_resources ADD COLUMN provider_ownership_id TEXT;
ALTER TABLE control_plugin_desired_resources
  ADD COLUMN provider_identity_checkpointed_at INTEGER;

UPDATE control_plugin_desired_resources
   SET provider_create_state = 'identified',
       provider_identity_checkpointed_at = updated_at
 WHERE lifecycle_mode = 'managed' AND resource_kind IN ('d1', 'kv_namespace')
   AND provider_resource_id IS NOT NULL AND provider_name IS NOT NULL;

-- Older R2 rows have only a mutable bucket name. Preserve the reference for explicit recovery,
-- but remove it from deployment projection until an operator establishes creation-date + marker
-- ownership using the hardened setup path.
UPDATE control_plugin_desired_resources
   SET provider_create_state = 'legacy_unverified', status = 'failed', updated_at = unixepoch()
 WHERE lifecycle_mode = 'managed' AND resource_kind = 'r2_bucket'
   AND provider_resource_id IS NOT NULL AND provider_name IS NOT NULL;

CREATE INDEX idx_control_plugin_resources_provider_create_state
  ON control_plugin_desired_resources(environment_id, provider_create_state, updated_at);

CREATE TABLE control_plugin_provider_projection_assertions (
  assertion_id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL,
  plugin_resource_id TEXT NOT NULL,
  valid INTEGER NOT NULL CHECK (valid IN (0, 1)),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (plugin_resource_id)
    REFERENCES control_plugin_desired_resources(plugin_resource_id) ON DELETE CASCADE
);

CREATE TRIGGER trg_control_plugin_provider_projection_assertion
BEFORE INSERT ON control_plugin_provider_projection_assertions
WHEN NEW.valid <> 1
BEGIN
  SELECT RAISE(ABORT, 'plugin_resource_provider_projection_mismatch');
END;

CREATE TRIGGER trg_control_plugin_resources_provider_identity_insert
BEFORE INSERT ON control_plugin_desired_resources
WHEN (NEW.lifecycle_mode = 'managed' AND NEW.provider_create_state = 'identified' AND
      (NEW.provider_resource_id IS NULL OR NEW.provider_name IS NULL OR
       NEW.provider_identity_checkpointed_at IS NULL))
  OR (NEW.lifecycle_mode = 'managed' AND NEW.provider_create_state = 'issued' AND
      (NEW.provider_resource_id IS NOT NULL OR NEW.provider_name IS NOT NULL OR
       NEW.provider_creation_date IS NOT NULL OR NEW.provider_identity_checkpointed_at IS NOT NULL))
  OR (NEW.lifecycle_mode = 'managed' AND NEW.resource_kind = 'r2_bucket' AND
      NEW.provider_create_state = 'issued' AND
      ((NEW.provider_ownership_marker_key IS NULL) <> (NEW.provider_ownership_id IS NULL)))
  OR (NEW.lifecycle_mode = 'managed' AND NEW.resource_kind = 'r2_bucket' AND
      NEW.provider_create_state = 'identified' AND
      (NEW.provider_creation_date IS NULL OR NEW.provider_ownership_marker_key IS NULL OR
       NEW.provider_ownership_id IS NULL))
  OR (NEW.lifecycle_mode = 'managed' AND NEW.resource_kind <> 'r2_bucket' AND
      (NEW.provider_creation_date IS NOT NULL OR NEW.provider_ownership_marker_key IS NOT NULL OR
       NEW.provider_ownership_id IS NOT NULL))
  OR (NEW.lifecycle_mode = 'managed' AND NEW.provider_create_state = 'legacy_unverified' AND
      (NEW.resource_kind <> 'r2_bucket' OR NEW.status <> 'failed' OR
       NEW.provider_resource_id IS NULL OR NEW.provider_name IS NULL OR
       NEW.provider_creation_date IS NOT NULL OR NEW.provider_ownership_marker_key IS NOT NULL OR
       NEW.provider_ownership_id IS NOT NULL OR NEW.provider_identity_checkpointed_at IS NOT NULL))
  OR (NEW.lifecycle_mode = 'managed' AND NEW.status IN ('ready', 'active') AND
      NEW.provider_create_state <> 'identified' AND NOT (
        NEW.resource_kind IN ('d1', 'kv_namespace') AND
        NEW.provider_create_state = 'not_started' AND
        NEW.provider_resource_id IS NOT NULL AND NEW.provider_name IS NOT NULL
      ))
BEGIN
  SELECT RAISE(ABORT, 'control_plugin_resource_provider_identity_invalid');
END;

CREATE TRIGGER trg_control_plugin_resources_provider_identity_update
BEFORE UPDATE OF provider_create_state, provider_resource_id, provider_name,
  provider_creation_date, provider_ownership_marker_key, provider_ownership_id,
  provider_identity_checkpointed_at, status ON control_plugin_desired_resources
WHEN (NEW.lifecycle_mode = 'managed' AND NEW.provider_create_state = 'identified' AND
      (NEW.provider_resource_id IS NULL OR NEW.provider_name IS NULL OR
       NEW.provider_identity_checkpointed_at IS NULL))
  OR (NEW.lifecycle_mode = 'managed' AND NEW.provider_create_state = 'issued' AND
      (NEW.provider_resource_id IS NOT NULL OR NEW.provider_name IS NOT NULL OR
       NEW.provider_creation_date IS NOT NULL OR NEW.provider_identity_checkpointed_at IS NOT NULL))
  OR (NEW.lifecycle_mode = 'managed' AND NEW.resource_kind = 'r2_bucket' AND
      NEW.provider_create_state = 'issued' AND
      ((NEW.provider_ownership_marker_key IS NULL) <> (NEW.provider_ownership_id IS NULL)))
  OR (NEW.lifecycle_mode = 'managed' AND NEW.resource_kind = 'r2_bucket' AND
      NEW.provider_create_state = 'identified' AND
      (NEW.provider_creation_date IS NULL OR NEW.provider_ownership_marker_key IS NULL OR
       NEW.provider_ownership_id IS NULL))
  OR (NEW.lifecycle_mode = 'managed' AND NEW.resource_kind <> 'r2_bucket' AND
      (NEW.provider_creation_date IS NOT NULL OR NEW.provider_ownership_marker_key IS NOT NULL OR
       NEW.provider_ownership_id IS NOT NULL))
  OR (NEW.lifecycle_mode = 'managed' AND NEW.provider_create_state = 'legacy_unverified' AND
      (NEW.resource_kind <> 'r2_bucket' OR NEW.status <> 'failed' OR
       NEW.provider_resource_id IS NULL OR NEW.provider_name IS NULL OR
       NEW.provider_creation_date IS NOT NULL OR NEW.provider_ownership_marker_key IS NOT NULL OR
       NEW.provider_ownership_id IS NOT NULL OR NEW.provider_identity_checkpointed_at IS NOT NULL))
  OR (OLD.lifecycle_mode = 'managed' AND OLD.provider_create_state = 'identified' AND
      (NEW.provider_create_state <> 'identified' OR
       NEW.provider_resource_id <> OLD.provider_resource_id OR
       NEW.provider_name <> OLD.provider_name OR
       COALESCE(NEW.provider_creation_date, '') <> COALESCE(OLD.provider_creation_date, '') OR
       COALESCE(NEW.provider_ownership_marker_key, '') <>
         COALESCE(OLD.provider_ownership_marker_key, '') OR
       COALESCE(NEW.provider_ownership_id, '') <> COALESCE(OLD.provider_ownership_id, '') OR
       NEW.provider_identity_checkpointed_at <> OLD.provider_identity_checkpointed_at))
  OR (NEW.lifecycle_mode = 'managed' AND NEW.status IN ('ready', 'active') AND
      NEW.provider_create_state <> 'identified' AND NOT (
        NEW.resource_kind IN ('d1', 'kv_namespace') AND
        NEW.provider_create_state = 'not_started' AND
        NEW.provider_resource_id IS NOT NULL AND NEW.provider_name IS NOT NULL
      ))
BEGIN
  SELECT RAISE(ABORT, 'control_plugin_resource_provider_identity_invalid');
END;

-- The previous coordinator records an immutable D1/KV provider identifier and name but does not
-- know the checkpoint columns. During the migration-to-coordinator cutover, promote that exact
-- identifier pair. R2 is deliberately excluded because a bucket name is not ownership evidence.
CREATE TRIGGER trg_control_plugin_resources_provider_identity_from_old_insert
AFTER INSERT ON control_plugin_desired_resources
WHEN NEW.lifecycle_mode = 'managed' AND NEW.resource_kind IN ('d1', 'kv_namespace')
  AND NEW.provider_create_state = 'not_started'
  AND NEW.provider_resource_id IS NOT NULL AND NEW.provider_name IS NOT NULL
BEGIN
  UPDATE control_plugin_desired_resources
     SET provider_create_state = 'identified',
         provider_identity_checkpointed_at = NEW.updated_at
   WHERE plugin_resource_id = NEW.plugin_resource_id
     AND environment_id = NEW.environment_id
     AND provider_create_state = 'not_started';
END;

CREATE TRIGGER trg_control_plugin_resources_provider_identity_from_old_update
AFTER UPDATE OF provider_resource_id, provider_name ON control_plugin_desired_resources
WHEN NEW.lifecycle_mode = 'managed' AND NEW.resource_kind IN ('d1', 'kv_namespace')
  AND NEW.provider_create_state = 'not_started'
  AND NEW.provider_resource_id IS NOT NULL AND NEW.provider_name IS NOT NULL
BEGIN
  UPDATE control_plugin_desired_resources
     SET provider_create_state = 'identified',
         provider_identity_checkpointed_at = NEW.updated_at
   WHERE plugin_resource_id = NEW.plugin_resource_id
     AND environment_id = NEW.environment_id
     AND provider_create_state = 'not_started';
END;
