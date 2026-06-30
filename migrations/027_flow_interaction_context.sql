-- Store request-time context for Flow runtime condition evaluation.

ALTER TABLE flow_interactions ADD COLUMN context_json TEXT;
