-- Logical mutation permits span all selected-store effects, including deferred work.
-- An unresolved permit never expires into an assumed successful completion.
CREATE TABLE tenant_backup_mutation_permits (
  id TEXT NOT NULL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  CHECK(completed_at IS NULL OR completed_at>=created_at)
);
CREATE INDEX tenant_backup_mutation_permits_active ON tenant_backup_mutation_permits(tenant_id,id)
  WHERE completed_at IS NULL;
CREATE TRIGGER tenant_backup_mutation_permit_identity
BEFORE UPDATE OF id,tenant_id,created_at ON tenant_backup_mutation_permits
BEGIN SELECT RAISE(ABORT,'backup_mutation_permit_identity'); END;
CREATE TRIGGER tenant_backup_mutation_permit_completion
BEFORE UPDATE OF completed_at ON tenant_backup_mutation_permits
WHEN OLD.completed_at IS NOT NULL AND NEW.completed_at IS NOT OLD.completed_at
BEGIN SELECT RAISE(ABORT,'backup_mutation_permit_completed'); END;

CREATE TABLE tenant_backup_mutation_boundaries (
  id TEXT NOT NULL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  inventory_digest TEXT NOT NULL CHECK(length(inventory_digest)=64),
  state TEXT NOT NULL CHECK(state IN ('draining','held','released','aborted')),
  created_at INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL CHECK(deadline_at=created_at+2000),
  released_at INTEGER,
  CHECK((state='released' AND released_at IS NOT NULL AND released_at>=created_at AND released_at<deadline_at)
    OR (state!='released' AND released_at IS NULL))
);
CREATE UNIQUE INDEX tenant_backup_mutation_boundary_active ON tenant_backup_mutation_boundaries(tenant_id)
  WHERE state IN ('draining','held');
CREATE TRIGGER tenant_backup_mutation_boundary_identity
BEFORE UPDATE OF id,tenant_id,operation_id,inventory_digest,created_at,deadline_at ON tenant_backup_mutation_boundaries
BEGIN SELECT RAISE(ABORT,'backup_mutation_boundary_identity'); END;
CREATE TRIGGER tenant_backup_mutation_boundary_state
BEFORE UPDATE ON tenant_backup_mutation_boundaries
WHEN (OLD.state IN ('released','aborted') AND NEW.state!=OLD.state)
  OR (OLD.state='held' AND NEW.state='draining')
BEGIN SELECT RAISE(ABORT,'backup_mutation_boundary_regression'); END;
