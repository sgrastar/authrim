-- The Flow interaction an external provider sign-in belongs to, kept with its state once the start
-- step has checked it is a live interaction of the tenant, so the callback records the sign-in's
-- failures with it (flow_audit_events, see 029). Null for a sign-in outside a Flow.
ALTER TABLE external_idp_auth_states ADD COLUMN attempt_interaction_id TEXT;
