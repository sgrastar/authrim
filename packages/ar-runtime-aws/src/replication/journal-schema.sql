CREATE TABLE IF NOT EXISTS authrim_replication_journal (
  operation_id text PRIMARY KEY,
  pair_id text NOT NULL REFERENCES authrim_replication_authorities(pair_id),
  plan_sha256 text NOT NULL CHECK (plan_sha256 ~ '^[a-f0-9]{64}$'),
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  value_json text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
