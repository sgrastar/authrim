-- Store the source template for saved Flow drafts.
-- Template labels and descriptions are localized at display time unless admins
-- override the Flow description explicitly.

ALTER TABLE flows ADD COLUMN template_id TEXT;

CREATE INDEX IF NOT EXISTS idx_flows_template_id ON flows(tenant_id, template_id);
