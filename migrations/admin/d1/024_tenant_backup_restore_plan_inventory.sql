-- Restore planning follows input validation and therefore cannot append to the sealed input inventory.
CREATE TABLE tenant_backup_restore_plan_inventories (
  operation_id TEXT NOT NULL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  input_inventory_digest TEXT NOT NULL CHECK(length(input_inventory_digest)=64 AND input_inventory_digest NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK(state IN ('building','sealed')),
  item_count INTEGER NOT NULL DEFAULT 0 CHECK(item_count>=0 AND item_count<=4096),
  chain_digest TEXT NOT NULL CHECK(length(chain_digest)=64 AND chain_digest NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  UNIQUE(operation_id,tenant_id),
  FOREIGN KEY(operation_id,tenant_id) REFERENCES tenant_backup_operations(id,tenant_id)
);
CREATE TABLE tenant_backup_restore_plan_inventory_items (
  operation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal>=0 AND ordinal<4096),
  item_id TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND length(CAST(payload_json AS BLOB))<=262144),
  chain_digest TEXT NOT NULL CHECK(length(chain_digest)=64 AND chain_digest NOT GLOB '*[^0-9a-f]*'),
  payload_digest TEXT NOT NULL CHECK(length(payload_digest)=64 AND payload_digest NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY(operation_id,ordinal),
  UNIQUE(operation_id,item_id),
  FOREIGN KEY(operation_id,tenant_id) REFERENCES tenant_backup_restore_plan_inventories(operation_id,tenant_id)
);
CREATE TRIGGER tenant_backup_restore_plan_item_immutable
BEFORE UPDATE ON tenant_backup_restore_plan_inventory_items
BEGIN SELECT RAISE(ABORT,'backup_restore_plan_item_immutable'); END;
CREATE TRIGGER tenant_backup_restore_plan_sealed_immutable
BEFORE UPDATE ON tenant_backup_restore_plan_inventories WHEN OLD.state='sealed'
BEGIN SELECT RAISE(ABORT,'backup_restore_plan_sealed_immutable'); END;
CREATE TRIGGER tenant_backup_restore_plan_append_guard
BEFORE INSERT ON tenant_backup_restore_plan_inventory_items
WHEN NOT EXISTS (SELECT 1 FROM tenant_backup_restore_plan_inventories p
  WHERE p.operation_id=NEW.operation_id AND p.tenant_id=NEW.tenant_id
  AND p.state='building' AND p.item_count=NEW.ordinal)
BEGIN SELECT RAISE(ABORT,'backup_restore_plan_append_conflict'); END;
CREATE TRIGGER tenant_backup_restore_plan_append_progress
AFTER INSERT ON tenant_backup_restore_plan_inventory_items
BEGIN
  UPDATE tenant_backup_restore_plan_inventories SET item_count=item_count+1,chain_digest=NEW.chain_digest
  WHERE operation_id=NEW.operation_id AND tenant_id=NEW.tenant_id;
END;
CREATE TRIGGER tenant_backup_restore_plan_identity_immutable
BEFORE UPDATE OF operation_id,tenant_id,input_inventory_digest,created_at ON tenant_backup_restore_plan_inventories
WHEN NEW.operation_id IS NOT OLD.operation_id OR NEW.tenant_id IS NOT OLD.tenant_id
  OR NEW.input_inventory_digest IS NOT OLD.input_inventory_digest OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'backup_restore_plan_identity_immutable'); END;
