-- An environment is one writer domain; tenant IDs remain actual child identities.
CREATE TABLE authrim_replication_environment_authorities (
  pair_id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL UNIQUE,
  definition_json TEXT NOT NULL,
  owner_deployment_id TEXT NOT NULL,
  selected_generation_id TEXT NOT NULL,
  epoch BIGINT NOT NULL CHECK(epoch BETWEEN 1 AND 9007199254740991),
  revision BIGINT NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
  phase TEXT NOT NULL CHECK(phase IN ('active','draining')),
  active_operation_id TEXT,
  drained_at_ms BIGINT CHECK(drained_at_ms > 0),
  UNIQUE(pair_id,environment_id),
  CHECK((phase='draining')=(active_operation_id IS NOT NULL)),
  CHECK(phase='draining' OR drained_at_ms IS NULL)
);
CREATE TABLE authrim_replication_environment_permits (
  pair_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  permit_id TEXT NOT NULL,
  identity_json TEXT NOT NULL,
  completed_at_ms BIGINT CHECK(completed_at_ms > 0),
  PRIMARY KEY(pair_id,permit_id),
  FOREIGN KEY(pair_id,environment_id) REFERENCES authrim_replication_environment_authorities(pair_id,environment_id)
);
CREATE INDEX authrim_replication_environment_open_permits ON authrim_replication_environment_permits(pair_id) WHERE completed_at_ms IS NULL;
CREATE TABLE authrim_replication_environment_operations (
  pair_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  request_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('draining','verified','promoted','cancelled')),
  drain_revision BIGINT NOT NULL CHECK(drain_revision BETWEEN 2 AND 9007199254740991),
  drained_at_ms BIGINT CHECK(drained_at_ms > 0),
  generation_json TEXT,
  promoted_epoch BIGINT CHECK(promoted_epoch BETWEEN 2 AND 9007199254740991),
  PRIMARY KEY(pair_id,operation_id),
  FOREIGN KEY(pair_id,environment_id) REFERENCES authrim_replication_environment_authorities(pair_id,environment_id),
  CHECK((state='promoted')=(promoted_epoch IS NOT NULL)),
  CHECK(state NOT IN ('verified','promoted') OR (generation_json IS NOT NULL AND drained_at_ms IS NOT NULL)),
  CHECK(state <> 'draining' OR generation_json IS NULL)
);
CREATE TABLE authrim_replication_environment_generations (
  pair_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  deployment_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  epoch BIGINT NOT NULL CHECK(epoch BETWEEN 2 AND 9007199254740991),
  source_operation_id TEXT NOT NULL,
  record_json TEXT NOT NULL,
  PRIMARY KEY(pair_id,generation_id),
  UNIQUE(pair_id,source_operation_id),
  FOREIGN KEY(pair_id,environment_id) REFERENCES authrim_replication_environment_authorities(pair_id,environment_id)
);
CREATE TABLE IF NOT EXISTS authrim_replication_environment_journal (
  operation_id text PRIMARY KEY,
  pair_id text NOT NULL REFERENCES authrim_replication_environment_authorities(pair_id),
  plan_sha256 text NOT NULL CHECK (plan_sha256 ~ '^[a-f0-9]{64}$'),
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  value_json text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
