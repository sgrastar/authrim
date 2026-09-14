-- A successful boundary requires a frozen participant plan and every start receipt.
CREATE TABLE tenant_backup_boundary_plans (
  boundary_id TEXT NOT NULL PRIMARY KEY REFERENCES tenant_backup_mutation_boundaries(id),
  participants_json TEXT NOT NULL CHECK(json_valid(participants_json)),
  participant_count INTEGER NOT NULL CHECK(participant_count BETWEEN 1 AND 64)
);
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

CREATE TABLE tenant_backup_boundary_receipts (
  boundary_id TEXT NOT NULL REFERENCES tenant_backup_boundary_plans(boundary_id),
  resource_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  acknowledged_at INTEGER NOT NULL,
  PRIMARY KEY(boundary_id,resource_id)
);
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
