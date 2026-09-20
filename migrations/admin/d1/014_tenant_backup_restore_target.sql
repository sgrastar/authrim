-- Local guard for an isolated, unpublished restore target. Never an application activation record.
CREATE TABLE tenant_backup_restore_targets (
  id TEXT NOT NULL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  plan_digest TEXT NOT NULL CHECK(length(plan_digest)=64),
  seed_fingerprint TEXT NOT NULL CHECK(length(seed_fingerprint)=64),
  owner TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK(fencing_token>0),
  lease_expires_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('loading','sealed','invalid'))
);
CREATE UNIQUE INDEX tenant_backup_restore_target_exclusive ON tenant_backup_restore_targets((1));
CREATE TRIGGER tenant_backup_restore_target_identity
BEFORE UPDATE OF id,tenant_id,operation_id,resource_id,plan_digest,seed_fingerprint ON tenant_backup_restore_targets
BEGIN SELECT RAISE(ABORT,'backup_restore_target_identity'); END;
CREATE TRIGGER tenant_backup_restore_target_monotonic
BEFORE UPDATE ON tenant_backup_restore_targets
WHEN NEW.fencing_token<OLD.fencing_token
  OR (NEW.fencing_token=OLD.fencing_token AND NEW.owner!=OLD.owner)
  OR (OLD.state!='loading' AND NEW.state!=OLD.state)
BEGIN SELECT RAISE(ABORT,'backup_restore_target_regression'); END;
