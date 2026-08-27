-- Migration: 002_lookup_scale_out_publication_metrics.sql
-- Description: Add monotonic per-bucket route publication telemetry for predictive scale-out.
-- Date: 2026-08-26

ALTER TABLE lookup_bucket_counters
  ADD COLUMN successful_route_publication_count INTEGER NOT NULL DEFAULT 0
    CHECK (successful_route_publication_count >= 0);

ALTER TABLE lookup_bucket_counters
  ADD COLUMN publication_counter_updated_at INTEGER NOT NULL DEFAULT 0
    CHECK (publication_counter_updated_at >= 0);

UPDATE lookup_bucket_counters
   SET publication_counter_updated_at = updated_at
 WHERE publication_counter_updated_at = 0;
