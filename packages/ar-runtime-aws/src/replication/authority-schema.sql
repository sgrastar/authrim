-- Standalone coordination schema; not an Authrim release migration. No permit expires by age.
CREATE TABLE IF NOT EXISTS authrim_replication_authorities (
  pair_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  owner_deployment_id TEXT NOT NULL,
  selected_generation_id TEXT NOT NULL,
  epoch BIGINT NOT NULL CHECK (epoch BETWEEN 1 AND 9007199254740991),
  revision BIGINT NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  phase TEXT NOT NULL CHECK (phase IN ('active', 'draining')),
  active_operation_id TEXT,
  drained_at_ms BIGINT,
  CHECK ((phase = 'draining') = (active_operation_id IS NOT NULL)),
  CHECK (phase = 'draining' OR drained_at_ms IS NULL),
  CHECK (drained_at_ms IS NULL OR drained_at_ms > 0),
  UNIQUE (pair_id, tenant_id)
);

-- A deployment/tenant cannot be registered in competing independently active pairs.
CREATE TABLE IF NOT EXISTS authrim_replication_members (
  tenant_id TEXT NOT NULL,
  deployment_id TEXT NOT NULL,
  pair_id TEXT NOT NULL,
  PRIMARY KEY (tenant_id, deployment_id),
  UNIQUE (pair_id, tenant_id, deployment_id),
  FOREIGN KEY (pair_id, tenant_id) REFERENCES authrim_replication_authorities(pair_id, tenant_id)
);

CREATE TABLE IF NOT EXISTS authrim_replication_permits (
  pair_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  permit_id TEXT NOT NULL,
  identity_json TEXT NOT NULL,
  completed_at_ms BIGINT CHECK (completed_at_ms > 0),
  PRIMARY KEY (pair_id, permit_id),
  FOREIGN KEY (pair_id, tenant_id) REFERENCES authrim_replication_authorities(pair_id, tenant_id)
);
CREATE INDEX IF NOT EXISTS authrim_replication_open_permits
  ON authrim_replication_permits(pair_id) WHERE completed_at_ms IS NULL;

CREATE TABLE IF NOT EXISTS authrim_replication_operations (
  pair_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  request_json TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'planned' CHECK (kind IN ('planned', 'failover')),
  accepted_data_loss_json TEXT,
  state TEXT NOT NULL CHECK (state IN ('draining', 'verified', 'promoted')),
  drain_revision BIGINT NOT NULL CHECK (drain_revision BETWEEN 1 AND 9007199254740991),
  drained_at_ms BIGINT CHECK (drained_at_ms > 0),
  generation_json TEXT,
  promoted_epoch BIGINT CHECK (promoted_epoch BETWEEN 2 AND 9007199254740991),
  PRIMARY KEY (pair_id, operation_id),
  FOREIGN KEY (pair_id, tenant_id) REFERENCES authrim_replication_authorities(pair_id, tenant_id),
  CHECK ((state = 'draining') = (generation_json IS NULL)),
  CHECK ((kind = 'failover' AND state <> 'draining') = (accepted_data_loss_json IS NOT NULL)),
  CHECK ((state = 'promoted') = (promoted_epoch IS NOT NULL)),
  CHECK (state = 'draining' OR drained_at_ms IS NOT NULL)
);


-- Verified periodic copies are immutable, and never confer writer ownership themselves.
CREATE TABLE IF NOT EXISTS authrim_replication_standby_generations (
  pair_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  source_sync_operation_id TEXT NOT NULL,
  source_sync_plan_sha256 TEXT NOT NULL CHECK (source_sync_plan_sha256 ~ '^[a-f0-9]{64}$'),
  proof_json TEXT NOT NULL,
  registered_at_ms BIGINT NOT NULL CHECK (registered_at_ms > 0),
  PRIMARY KEY (pair_id, generation_id),
  UNIQUE (pair_id, source_sync_operation_id),
  FOREIGN KEY (pair_id, tenant_id) REFERENCES authrim_replication_authorities(pair_id, tenant_id)
);

-- Shared reservation namespace, checked under identical deployment advisory locks in both APIs.
CREATE TABLE IF NOT EXISTS authrim_replication_environment_reservations (
  deployment_id TEXT PRIMARY KEY,
  pair_id TEXT NOT NULL,
  environment_id TEXT NOT NULL
);
