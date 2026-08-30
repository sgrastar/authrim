-- Migration: 005_account_predictive_scale_out.sql
-- Description: Persist predictive tenant Core/PII capacity observations and decisions.
-- Date: 2026-08-30

ALTER TABLE control_environment_resource_policies
  ADD COLUMN account_forecast_horizon_seconds INTEGER NOT NULL DEFAULT 900
    CHECK (account_forecast_horizon_seconds BETWEEN 60 AND 2592000);

ALTER TABLE control_environment_resource_policies
  ADD COLUMN account_scale_out_headroom_bps INTEGER NOT NULL DEFAULT 2000
    CHECK (account_scale_out_headroom_bps BETWEEN 0 AND 9000);

ALTER TABLE control_environment_resource_policies
  ADD COLUMN account_registration_ewma_alpha_bps INTEGER NOT NULL DEFAULT 5000
    CHECK (account_registration_ewma_alpha_bps BETWEEN 1 AND 10000);

ALTER TABLE control_environment_resource_policies
  ADD COLUMN account_scale_out_policy_generation INTEGER NOT NULL DEFAULT 1
    CHECK (account_scale_out_policy_generation >= 1);

CREATE TABLE control_account_scale_out_forecasts (
  environment_id TEXT NOT NULL,
  allocation_scope TEXT NOT NULL
    CHECK (allocation_scope IN ('shared_pool', 'tenant_exclusive')),
  owner_tenant_key TEXT NOT NULL CHECK (length(owner_tenant_key) <= 128),
  owner_tenant_id TEXT,
  data_role TEXT NOT NULL CHECK (data_role IN ('tenant_core/users', 'tenant_pii')),
  residency_policy_id TEXT NOT NULL,
  residency_partition TEXT NOT NULL,
  policy_generation INTEGER NOT NULL CHECK (policy_generation >= 1),
  successful_allocation_count INTEGER NOT NULL DEFAULT 0
    CHECK (successful_allocation_count >= 0),
  observed_at INTEGER NOT NULL CHECK (observed_at >= 1),
  observed_successful_allocation_count INTEGER NOT NULL DEFAULT 0
    CHECK (observed_successful_allocation_count >= 0),
  sample_interval_seconds INTEGER NOT NULL DEFAULT 0
    CHECK (sample_interval_seconds >= 0),
  sample_rate_microaccounts_per_second INTEGER NOT NULL DEFAULT 0
    CHECK (sample_rate_microaccounts_per_second >= 0),
  ewma_rate_microaccounts_per_second INTEGER NOT NULL DEFAULT 0
    CHECK (ewma_rate_microaccounts_per_second >= 0),
  forecast_horizon_seconds INTEGER NOT NULL
    CHECK (forecast_horizon_seconds BETWEEN 60 AND 2592000),
  forecast_new_account_count INTEGER NOT NULL DEFAULT 0
    CHECK (forecast_new_account_count >= 0),
  observed_allocated_account_count INTEGER NOT NULL DEFAULT 0
    CHECK (observed_allocated_account_count >= 0),
  projected_account_count INTEGER NOT NULL DEFAULT 0
    CHECK (projected_account_count >= 0),
  usable_capacity_account_count INTEGER NOT NULL DEFAULT 0
    CHECK (usable_capacity_account_count >= 0),
  capacity_unit_count INTEGER NOT NULL DEFAULT 0
    CHECK (capacity_unit_count >= 0),
  decision_generation INTEGER NOT NULL DEFAULT 0 CHECK (decision_generation >= 0),
  decision_state TEXT NOT NULL DEFAULT 'warming'
    CHECK (decision_state IN ('warming', 'stable', 'provisioning', 'blocked')),
  snapshot_digest TEXT NOT NULL
    CHECK (length(snapshot_digest) = 64 AND snapshot_digest NOT GLOB '*[^0-9a-f]*'),
  capacity_request_idempotency_key TEXT
    CHECK (capacity_request_idempotency_key IS NULL OR
           length(capacity_request_idempotency_key) BETWEEN 1 AND 128),
  requested_operation_id TEXT,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (
    environment_id, allocation_scope, owner_tenant_key, data_role,
    residency_policy_id, residency_partition
  ),
  FOREIGN KEY (environment_id)
    REFERENCES control_environments(environment_id) ON DELETE CASCADE,
  FOREIGN KEY (requested_operation_id, environment_id)
    REFERENCES control_operations(operation_id, environment_id),
  CHECK (
    (allocation_scope = 'shared_pool' AND owner_tenant_key = '' AND owner_tenant_id IS NULL) OR
    (allocation_scope = 'tenant_exclusive' AND owner_tenant_key = owner_tenant_id AND
     owner_tenant_id IS NOT NULL)
  ),
  CHECK (observed_successful_allocation_count <= successful_allocation_count),
  CHECK (projected_account_count >= observed_allocated_account_count),
  CHECK ((decision_state IN ('warming', 'stable') AND requested_operation_id IS NULL) OR
         decision_state NOT IN ('warming', 'stable'))
);

CREATE INDEX idx_control_account_scale_out_forecasts_state
  ON control_account_scale_out_forecasts(environment_id, decision_state, updated_at);

