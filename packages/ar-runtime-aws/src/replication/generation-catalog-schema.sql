CREATE TABLE IF NOT EXISTS authrim_replication_generation_locations (
  pair_id text NOT NULL,
  tenant_id text NOT NULL,
  deployment_id text NOT NULL,
  generation_id text NOT NULL,
  epoch bigint NOT NULL CHECK (epoch BETWEEN 1 AND 9007199254740991),
  location_json text NOT NULL,
  PRIMARY KEY (pair_id, generation_id),
  FOREIGN KEY (pair_id,tenant_id,deployment_id)
    REFERENCES authrim_replication_members(pair_id,tenant_id,deployment_id)
);
