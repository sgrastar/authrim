-- Shared configuration mutations must drain before any tenant boundary in the environment.
ALTER TABLE tenant_backup_mutation_permits ADD COLUMN environment_id TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE tenant_backup_mutation_permits ADD COLUMN scope TEXT NOT NULL DEFAULT 'tenant' CHECK(scope IN ('tenant','environment'));
ALTER TABLE tenant_backup_mutation_boundaries ADD COLUMN environment_id TEXT NOT NULL DEFAULT 'legacy';
CREATE INDEX tenant_backup_mutation_environment_permits
  ON tenant_backup_mutation_permits(environment_id,scope,tenant_id) WHERE completed_at IS NULL;
CREATE INDEX tenant_backup_mutation_environment_boundaries
  ON tenant_backup_mutation_boundaries(environment_id,deadline_at) WHERE state IN ('draining','held');
CREATE TRIGGER tenant_backup_mutation_permit_scope_identity
BEFORE UPDATE OF environment_id,scope ON tenant_backup_mutation_permits
BEGIN SELECT RAISE(ABORT,'backup_mutation_permit_scope_identity'); END;
CREATE TRIGGER tenant_backup_mutation_boundary_environment_identity
BEFORE UPDATE OF environment_id ON tenant_backup_mutation_boundaries
BEGIN SELECT RAISE(ABORT,'backup_mutation_boundary_environment_identity'); END;
DROP INDEX tenant_backup_mutation_boundary_active;
CREATE UNIQUE INDEX tenant_backup_mutation_boundary_active ON tenant_backup_mutation_boundaries(environment_id,tenant_id)
  WHERE state IN ('draining','held');
