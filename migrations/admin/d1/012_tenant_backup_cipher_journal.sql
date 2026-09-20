-- Non-secret stream header and write-ahead nonce reservations. Never store plaintext or DEKs.
CREATE TABLE tenant_backup_cipher_streams (
  attempt_id TEXT NOT NULL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  header_hex TEXT NOT NULL UNIQUE CHECK(length(header_hex)=250 AND header_hex NOT GLOB '*[^0-9a-f]*'),
  next_sequence INTEGER NOT NULL DEFAULT 0 CHECK(next_sequence>=0 AND next_sequence<=1000000),
  plain_bytes INTEGER NOT NULL DEFAULT 0 CHECK(plain_bytes>=0),
  finished INTEGER NOT NULL DEFAULT 0 CHECK(finished IN (0,1)),
  checkpoint_json TEXT CHECK(checkpoint_json IS NULL OR (json_valid(checkpoint_json) AND length(CAST(checkpoint_json AS BLOB))<=16384)),
  FOREIGN KEY(attempt_id,tenant_id) REFERENCES tenant_backup_artifact_attempts(id,tenant_id)
);
CREATE TABLE tenant_backup_cipher_frames (
  attempt_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence>=0 AND sequence<1000000),
  frame_type INTEGER NOT NULL CHECK(frame_type IN (1,2)),
  plain_sha256 TEXT NOT NULL CHECK(length(plain_sha256)=64 AND plain_sha256 NOT GLOB '*[^0-9a-f]*'),
  plain_length INTEGER NOT NULL CHECK(plain_length>0 AND plain_length<=1048576),
  checkpoint_json TEXT NOT NULL CHECK(json_valid(checkpoint_json) AND length(CAST(checkpoint_json AS BLOB))<=16384),
  PRIMARY KEY(attempt_id,sequence),
  FOREIGN KEY(attempt_id) REFERENCES tenant_backup_cipher_streams(attempt_id)
);
CREATE TRIGGER tenant_backup_cipher_header_immutable
BEFORE UPDATE OF attempt_id,tenant_id,header_hex ON tenant_backup_cipher_streams
BEGIN SELECT RAISE(ABORT,'backup_cipher_header_immutable'); END;
CREATE TRIGGER tenant_backup_cipher_reservation_immutable
BEFORE UPDATE ON tenant_backup_cipher_frames
BEGIN SELECT RAISE(ABORT,'backup_cipher_reservation_immutable'); END;
