-- Preserve the historical deadline variants while new attempts use a five-second fail-safe.
-- The Control schema contains a runtime-substituted clock token in an unrelated trigger. Legacy
-- ALTER behavior prevents SQLite from reparsing that trigger while these three tables are renamed.
PRAGMA legacy_alter_table=ON;
DROP TRIGGER tenant_backup_boundary_plan_insert;
DROP TRIGGER tenant_backup_boundary_plan_immutable;
DROP TRIGGER tenant_backup_boundary_plan_delete;
DROP TRIGGER tenant_backup_boundary_receipt_insert;
DROP TRIGGER tenant_backup_boundary_receipt_immutable;
DROP TRIGGER tenant_backup_boundary_receipt_delete;
DROP TRIGGER tenant_backup_boundary_release_receipts;
DROP TRIGGER tenant_backup_boundary_release_immutable;
DROP TRIGGER tenant_backup_boundary_no_precompleted_insert;
DROP TRIGGER tenant_backup_mutation_boundary_identity;
DROP TRIGGER tenant_backup_mutation_boundary_state;
DROP TRIGGER tenant_backup_mutation_boundary_environment_identity;
DROP TRIGGER tenant_backup_mutation_boundary_held_at_insert;
DROP TRIGGER tenant_backup_mutation_boundary_held_at_update;
DROP INDEX tenant_backup_mutation_environment_boundaries;
DROP INDEX tenant_backup_mutation_boundary_active;

ALTER TABLE tenant_backup_boundary_receipts RENAME TO tenant_backup_boundary_receipts_v1;
ALTER TABLE tenant_backup_boundary_plans RENAME TO tenant_backup_boundary_plans_v1;
ALTER TABLE tenant_backup_mutation_boundaries RENAME TO tenant_backup_mutation_boundaries_v1;

CREATE TABLE tenant_backup_mutation_boundaries (
  id TEXT NOT NULL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  inventory_digest TEXT NOT NULL CHECK(length(inventory_digest)=64),
  state TEXT NOT NULL CHECK(state IN ('draining','held','released','aborted')),
  created_at INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL
    CHECK(deadline_at=created_at+2000 OR deadline_at=created_at+5000
      OR deadline_at=created_at+15000 OR deadline_at=created_at+60000),
  released_at INTEGER,
  environment_id TEXT NOT NULL DEFAULT 'legacy',
  held_at INTEGER,
  CHECK((state='released' AND released_at IS NOT NULL AND released_at>=created_at AND released_at<deadline_at)
    OR (state!='released' AND released_at IS NULL))
);
INSERT INTO tenant_backup_mutation_boundaries
  (id,tenant_id,operation_id,inventory_digest,state,created_at,deadline_at,released_at,environment_id,held_at)
SELECT id,tenant_id,operation_id,inventory_digest,state,created_at,deadline_at,released_at,environment_id,held_at
FROM tenant_backup_mutation_boundaries_v1;

CREATE TABLE tenant_backup_boundary_plans (
  boundary_id TEXT NOT NULL PRIMARY KEY REFERENCES tenant_backup_mutation_boundaries(id),
  participants_json TEXT NOT NULL CHECK(json_valid(participants_json)),
  participant_count INTEGER NOT NULL CHECK(participant_count BETWEEN 1 AND 64)
);
INSERT INTO tenant_backup_boundary_plans(boundary_id,participants_json,participant_count)
SELECT boundary_id,participants_json,participant_count FROM tenant_backup_boundary_plans_v1;

CREATE TABLE tenant_backup_boundary_receipts (
  boundary_id TEXT NOT NULL REFERENCES tenant_backup_boundary_plans(boundary_id),
  resource_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  acknowledged_at INTEGER NOT NULL,
  PRIMARY KEY(boundary_id,resource_id)
);
INSERT INTO tenant_backup_boundary_receipts(boundary_id,resource_id,snapshot_id,acknowledged_at)
SELECT boundary_id,resource_id,snapshot_id,acknowledged_at
FROM tenant_backup_boundary_receipts_v1;

DROP TABLE tenant_backup_boundary_receipts_v1;
DROP TABLE tenant_backup_boundary_plans_v1;
DROP TABLE tenant_backup_mutation_boundaries_v1;

CREATE INDEX tenant_backup_mutation_environment_boundaries
  ON tenant_backup_mutation_boundaries(environment_id,deadline_at)
  WHERE state IN ('draining','held');
CREATE UNIQUE INDEX tenant_backup_mutation_boundary_active
  ON tenant_backup_mutation_boundaries(environment_id,tenant_id)
  WHERE state IN ('draining','held');

CREATE TRIGGER tenant_backup_mutation_boundary_identity
BEFORE UPDATE OF id,tenant_id,operation_id,inventory_digest,created_at,deadline_at ON tenant_backup_mutation_boundaries
BEGIN SELECT RAISE(ABORT,'backup_mutation_boundary_identity'); END;
CREATE TRIGGER tenant_backup_mutation_boundary_state
BEFORE UPDATE ON tenant_backup_mutation_boundaries
WHEN (OLD.state IN ('released','aborted') AND NEW.state!=OLD.state)
  OR (OLD.state='held' AND NEW.state='draining')
BEGIN SELECT RAISE(ABORT,'backup_mutation_boundary_regression'); END;
CREATE TRIGGER tenant_backup_mutation_boundary_environment_identity
BEFORE UPDATE OF environment_id ON tenant_backup_mutation_boundaries
BEGIN SELECT RAISE(ABORT,'backup_mutation_boundary_environment_identity'); END;
CREATE TRIGGER tenant_backup_mutation_boundary_held_at_insert
BEFORE INSERT ON tenant_backup_mutation_boundaries
WHEN NEW.held_at IS NOT NULL
BEGIN SELECT RAISE(ABORT,'backup_mutation_boundary_held_at_invalid'); END;
CREATE TRIGGER tenant_backup_mutation_boundary_held_at_update
BEFORE UPDATE OF state,held_at ON tenant_backup_mutation_boundaries
WHEN (NEW.state IN ('held','released') AND NEW.held_at IS NULL)
  OR (NEW.held_at IS NOT NULL AND (
    NEW.held_at<NEW.created_at OR NEW.held_at>=NEW.deadline_at
    OR (OLD.held_at IS NOT NULL AND NEW.held_at IS NOT OLD.held_at)
    OR (OLD.held_at IS NULL AND NOT (OLD.state='draining' AND NEW.state='held'))
  ))
BEGIN SELECT RAISE(ABORT,'backup_mutation_boundary_held_at_invalid'); END;

CREATE TRIGGER tenant_backup_boundary_plan_insert
BEFORE INSERT ON tenant_backup_boundary_plans
WHEN NOT EXISTS (SELECT 1 FROM tenant_backup_mutation_boundaries
    WHERE id=NEW.boundary_id AND state='draining')
  OR json_type(NEW.participants_json)!='array'
  OR json_array_length(NEW.participants_json)!=NEW.participant_count
  OR EXISTS (SELECT 1 FROM json_each(NEW.participants_json)
    WHERE json_type(value,'$.resourceId') IS NOT 'text'
      OR json_type(value,'$.snapshotId') IS NOT 'text')
  OR (SELECT count(DISTINCT json_extract(value,'$.resourceId'))
    FROM json_each(NEW.participants_json))!=NEW.participant_count
BEGIN SELECT RAISE(ABORT,'backup_boundary_plan_invalid'); END;
CREATE TRIGGER tenant_backup_boundary_plan_immutable
BEFORE UPDATE ON tenant_backup_boundary_plans
BEGIN SELECT RAISE(ABORT,'backup_boundary_plan_immutable'); END;
CREATE TRIGGER tenant_backup_boundary_plan_delete
BEFORE DELETE ON tenant_backup_boundary_plans
WHEN EXISTS (SELECT 1 FROM tenant_backup_mutation_boundaries WHERE id=OLD.boundary_id)
BEGIN SELECT RAISE(ABORT,'backup_boundary_plan_retained'); END;

CREATE TRIGGER tenant_backup_boundary_receipt_insert
BEFORE INSERT ON tenant_backup_boundary_receipts
WHEN NOT EXISTS (SELECT 1 FROM tenant_backup_mutation_boundaries b
  JOIN tenant_backup_boundary_plans p ON p.boundary_id=b.id,
  json_each(p.participants_json) participant
  WHERE b.id=NEW.boundary_id AND b.state='held'
    AND NEW.acknowledged_at>=b.created_at AND NEW.acknowledged_at<b.deadline_at
    AND json_extract(participant.value,'$.resourceId')=NEW.resource_id
    AND json_extract(participant.value,'$.snapshotId')=NEW.snapshot_id)
BEGIN SELECT RAISE(ABORT,'backup_boundary_receipt_invalid'); END;
CREATE TRIGGER tenant_backup_boundary_receipt_immutable
BEFORE UPDATE ON tenant_backup_boundary_receipts
BEGIN SELECT RAISE(ABORT,'backup_boundary_receipt_immutable'); END;
CREATE TRIGGER tenant_backup_boundary_receipt_delete
BEFORE DELETE ON tenant_backup_boundary_receipts
WHEN EXISTS (SELECT 1 FROM tenant_backup_mutation_boundaries WHERE id=OLD.boundary_id)
BEGIN SELECT RAISE(ABORT,'backup_boundary_receipt_retained'); END;

CREATE TRIGGER tenant_backup_boundary_release_receipts
BEFORE UPDATE OF state ON tenant_backup_mutation_boundaries
WHEN NEW.state='released' AND OLD.state!='released' AND
  (OLD.state!='held' OR NOT EXISTS (
    SELECT 1 FROM tenant_backup_boundary_plans p WHERE p.boundary_id=NEW.id
    AND p.participant_count=(SELECT count(*) FROM tenant_backup_boundary_receipts r
      WHERE r.boundary_id=NEW.id)
    AND NOT EXISTS (SELECT 1 FROM tenant_backup_boundary_receipts r
      WHERE r.boundary_id=NEW.id AND r.acknowledged_at>NEW.released_at)))
BEGIN SELECT RAISE(ABORT,'backup_boundary_receipts_incomplete'); END;
CREATE TRIGGER tenant_backup_boundary_release_immutable
BEFORE UPDATE OF released_at ON tenant_backup_mutation_boundaries
WHEN OLD.released_at IS NOT NULL AND NEW.released_at IS NOT OLD.released_at
BEGIN SELECT RAISE(ABORT,'backup_boundary_release_immutable'); END;
CREATE TRIGGER tenant_backup_boundary_no_precompleted_insert
BEFORE INSERT ON tenant_backup_mutation_boundaries
WHEN NEW.state='released'
BEGIN SELECT RAISE(ABORT,'backup_boundary_receipts_incomplete'); END;

PRAGMA legacy_alter_table=OFF;
