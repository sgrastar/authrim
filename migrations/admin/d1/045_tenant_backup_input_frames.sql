-- One row per data frame of a v2 input, recorded while decode_input authenticates the container.
-- Later import steps range-read and decrypt only the frame that holds the rows they need.
CREATE TABLE tenant_backup_input_frames (
  operation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  bundle_id TEXT NOT NULL CHECK (length(bundle_id)=32 AND bundle_id NOT GLOB '*[^0-9a-f]*'),
  sequence INTEGER NOT NULL CHECK (sequence>=0),
  object_offset INTEGER NOT NULL CHECK (object_offset>=133),
  frame_bytes INTEGER NOT NULL CHECK (frame_bytes>=25),
  plain_offset INTEGER NOT NULL CHECK (plain_offset>=0),
  plain_bytes INTEGER NOT NULL CHECK (plain_bytes=frame_bytes-25),
  PRIMARY KEY (operation_id,bundle_id,sequence),
  FOREIGN KEY (operation_id,tenant_id) REFERENCES tenant_backup_operations(id,tenant_id)
);

CREATE TRIGGER tenant_backup_input_frames_immutable
BEFORE UPDATE ON tenant_backup_input_frames
BEGIN SELECT RAISE(ABORT,'tenant_backup_input_frame_immutable'); END;
