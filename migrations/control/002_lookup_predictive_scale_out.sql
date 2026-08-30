-- Migration: 002_lookup_predictive_scale_out.sql
-- Description: Persist deterministic Lookup growth forecasts and provisioning decisions.
-- Date: 2026-08-26

ALTER TABLE control_environment_resource_policies
  ADD COLUMN lookup_target_active_route_count INTEGER NOT NULL DEFAULT 100000
    CHECK (lookup_target_active_route_count >= 1);

ALTER TABLE control_environment_resource_policies
  ADD COLUMN lookup_scale_out_headroom_bps INTEGER NOT NULL DEFAULT 2000
    CHECK (lookup_scale_out_headroom_bps BETWEEN 0 AND 9000);

ALTER TABLE control_environment_resource_policies
  ADD COLUMN lookup_registration_ewma_alpha_bps INTEGER NOT NULL DEFAULT 2500
    CHECK (lookup_registration_ewma_alpha_bps BETWEEN 1 AND 10000);

ALTER TABLE control_environment_resource_policies
  ADD COLUMN lookup_scale_out_policy_generation INTEGER NOT NULL DEFAULT 1
    CHECK (lookup_scale_out_policy_generation >= 1);

ALTER TABLE control_residency_partitions
  ADD COLUMN lookup_capacity_domain_id TEXT
    CHECK (lookup_capacity_domain_id IS NULL OR
           (length(lookup_capacity_domain_id) BETWEEN 1 AND 128));

-- The built-in default partition can already exist when this forward migration is applied.
-- Its capacity domain is deterministic, so backfill it without guessing how operator-defined
-- residency partitions should share or isolate Lookup capacity.
UPDATE control_residency_partitions
   SET lookup_capacity_domain_id = 'lookup:builtin:residency:default:default',
       updated_at = unixepoch()
 WHERE residency_policy_id = 'builtin:residency:default'
   AND residency_partition = 'default'
   AND lookup_capacity_domain_id IS NULL;

CREATE TABLE control_lookup_scale_out_forecasts (
  environment_id TEXT NOT NULL,
  lookup_capacity_domain_id TEXT NOT NULL
    CHECK (length(lookup_capacity_domain_id) BETWEEN 1 AND 128),
  residency_policy_id TEXT NOT NULL,
  residency_partition TEXT NOT NULL,
  policy_generation INTEGER NOT NULL CHECK (policy_generation >= 1),
  observed_at INTEGER NOT NULL CHECK (observed_at >= 1),
  observed_active_route_count INTEGER NOT NULL CHECK (observed_active_route_count >= 0),
  observed_successful_publication_count INTEGER NOT NULL
    CHECK (observed_successful_publication_count >= 0),
  sample_interval_seconds INTEGER NOT NULL CHECK (sample_interval_seconds >= 0),
  sample_rate_microrows_per_second INTEGER NOT NULL
    CHECK (sample_rate_microrows_per_second >= 0),
  ewma_rate_microrows_per_second INTEGER NOT NULL
    CHECK (ewma_rate_microrows_per_second >= 0),
  forecast_horizon_seconds INTEGER NOT NULL
    CHECK (forecast_horizon_seconds BETWEEN 300 AND 2592000),
  forecast_new_route_count INTEGER NOT NULL CHECK (forecast_new_route_count >= 0),
  projected_active_route_count INTEGER NOT NULL CHECK (projected_active_route_count >= 0),
  usable_capacity_route_count INTEGER NOT NULL CHECK (usable_capacity_route_count >= 0),
  capacity_unit_count INTEGER NOT NULL CHECK (capacity_unit_count >= 0),
  decision_generation INTEGER NOT NULL CHECK (decision_generation >= 0),
  decision_state TEXT NOT NULL
    CHECK (decision_state IN ('warming', 'stable', 'provisioning', 'blocked')),
  snapshot_digest TEXT NOT NULL
    CHECK (length(snapshot_digest) = 64 AND snapshot_digest NOT GLOB '*[^0-9a-f]*'),
  capacity_request_idempotency_key TEXT
    CHECK (capacity_request_idempotency_key IS NULL OR
           (length(capacity_request_idempotency_key) BETWEEN 1 AND 128)),
  requested_operation_id TEXT,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (environment_id, lookup_capacity_domain_id),
  FOREIGN KEY (environment_id)
    REFERENCES control_environments(environment_id) ON DELETE CASCADE,
  FOREIGN KEY (requested_operation_id, environment_id)
    REFERENCES control_operations(operation_id, environment_id),
  CHECK (projected_active_route_count >= observed_active_route_count),
  CHECK ((decision_state IN ('warming', 'stable') AND requested_operation_id IS NULL) OR
         decision_state NOT IN ('warming', 'stable'))
);

CREATE INDEX idx_control_lookup_scale_out_forecasts_state
  ON control_lookup_scale_out_forecasts(environment_id, decision_state, updated_at);
