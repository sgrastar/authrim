-- Persist explicit rule graphs. Run through the manifest-aware setup runner: it prints the
-- refusal inventory and appends graph recompilation/reactivation in the same D1 transaction.
-- The SQL guard also protects callers bypassing setup. A bad JSON path contains the full list.
CREATE VIEW __mapping_graph_refusals AS
SELECT r.tenant_id, v.field_mapping_set_id AS set_id,
       r.field_mapping_version_id AS version_id, r.id AS rule_id
FROM mapping_rules r JOIN field_mapping_versions v
  ON v.tenant_id = r.tenant_id AND v.id = r.field_mapping_version_id
WHERE (SELECT count(*) FROM mapping_rule_edges e WHERE e.tenant_id = r.tenant_id AND e.rule_id = r.id) > 1
   OR (SELECT count(*) FROM mapping_transform_steps t WHERE t.tenant_id = r.tenant_id AND t.rule_id = r.id) > 1
   OR EXISTS (
     SELECT 1 FROM mapping_transform_steps t
     LEFT JOIN mapping_rule_edges e ON e.tenant_id = t.tenant_id AND e.id = t.edge_id AND e.rule_id = t.rule_id
     WHERE t.tenant_id = r.tenant_id AND t.rule_id = r.id
       AND ((t.edge_id IS NOT NULL AND (e.id IS NULL OR t.operation = 'persistent_identifier'))
         OR (t.edge_id IS NULL AND (t.operation <> 'persistent_identifier' OR t.target_ref_json IS NULL))
         OR (t.target_ref_json IS NOT NULL AND EXISTS (
           SELECT 1 FROM mapping_rule_edges re WHERE re.tenant_id = r.tenant_id AND re.rule_id = r.id
             AND (COALESCE(CASE WHEN json_type(re.target_ref_json, '$.namespace') = 'text' THEN NULLIF(json_extract(re.target_ref_json, '$.namespace'), '') END, 'unknown') IS NOT COALESCE(CASE WHEN json_type(t.target_ref_json, '$.namespace') = 'text' THEN NULLIF(json_extract(t.target_ref_json, '$.namespace'), '') END, 'unknown')
               OR COALESCE(CASE WHEN json_type(re.target_ref_json, '$.path') = 'text' THEN NULLIF(json_extract(re.target_ref_json, '$.path'), '') END, CASE WHEN json_type(re.target_ref_json, '$.fieldKey') = 'text' THEN NULLIF(json_extract(re.target_ref_json, '$.fieldKey'), '') END, CASE WHEN json_type(re.target_ref_json, '$.nodeId') = 'text' THEN NULLIF(json_extract(re.target_ref_json, '$.nodeId'), '') END, 'unknown') IS NOT COALESCE(CASE WHEN json_type(t.target_ref_json, '$.path') = 'text' THEN NULLIF(json_extract(t.target_ref_json, '$.path'), '') END, CASE WHEN json_type(t.target_ref_json, '$.fieldKey') = 'text' THEN NULLIF(json_extract(t.target_ref_json, '$.fieldKey'), '') END, CASE WHEN json_type(t.target_ref_json, '$.nodeId') = 'text' THEN NULLIF(json_extract(t.target_ref_json, '$.nodeId'), '') END, 'unknown'))))))
   OR EXISTS (
     SELECT 1 FROM mapping_conflict_rules c
     WHERE c.tenant_id = r.tenant_id AND c.field_mapping_version_id = r.field_mapping_version_id
       AND EXISTS (
         SELECT 1 FROM mapping_rule_edges e WHERE e.tenant_id = r.tenant_id AND e.rule_id = r.id
          AND COALESCE(CASE WHEN json_type(e.target_ref_json, '$.namespace') = 'text' THEN NULLIF(json_extract(e.target_ref_json, '$.namespace'), '') END, 'unknown') IS COALESCE(CASE WHEN json_type(c.target_ref_json, '$.namespace') = 'text' THEN NULLIF(json_extract(c.target_ref_json, '$.namespace'), '') END, 'unknown')
          AND COALESCE(CASE WHEN json_type(e.target_ref_json, '$.path') = 'text' THEN NULLIF(json_extract(e.target_ref_json, '$.path'), '') END, CASE WHEN json_type(e.target_ref_json, '$.fieldKey') = 'text' THEN NULLIF(json_extract(e.target_ref_json, '$.fieldKey'), '') END, CASE WHEN json_type(e.target_ref_json, '$.nodeId') = 'text' THEN NULLIF(json_extract(e.target_ref_json, '$.nodeId'), '') END, 'unknown') IS COALESCE(CASE WHEN json_type(c.target_ref_json, '$.path') = 'text' THEN NULLIF(json_extract(c.target_ref_json, '$.path'), '') END, CASE WHEN json_type(c.target_ref_json, '$.fieldKey') = 'text' THEN NULLIF(json_extract(c.target_ref_json, '$.fieldKey'), '') END, CASE WHEN json_type(c.target_ref_json, '$.nodeId') = 'text' THEN NULLIF(json_extract(c.target_ref_json, '$.nodeId'), '') END, 'unknown')
         UNION ALL
         SELECT 1 FROM mapping_transform_steps t WHERE t.tenant_id = r.tenant_id AND t.rule_id = r.id
          AND COALESCE(CASE WHEN json_type(t.target_ref_json, '$.namespace') = 'text' THEN NULLIF(json_extract(t.target_ref_json, '$.namespace'), '') END, 'unknown') IS COALESCE(CASE WHEN json_type(c.target_ref_json, '$.namespace') = 'text' THEN NULLIF(json_extract(c.target_ref_json, '$.namespace'), '') END, 'unknown')
          AND COALESCE(CASE WHEN json_type(t.target_ref_json, '$.path') = 'text' THEN NULLIF(json_extract(t.target_ref_json, '$.path'), '') END, CASE WHEN json_type(t.target_ref_json, '$.fieldKey') = 'text' THEN NULLIF(json_extract(t.target_ref_json, '$.fieldKey'), '') END, CASE WHEN json_type(t.target_ref_json, '$.nodeId') = 'text' THEN NULLIF(json_extract(t.target_ref_json, '$.nodeId'), '') END, 'unknown') IS COALESCE(CASE WHEN json_type(c.target_ref_json, '$.path') = 'text' THEN NULLIF(json_extract(c.target_ref_json, '$.path'), '') END, CASE WHEN json_type(c.target_ref_json, '$.fieldKey') = 'text' THEN NULLIF(json_extract(c.target_ref_json, '$.fieldKey'), '') END, CASE WHEN json_type(c.target_ref_json, '$.nodeId') = 'text' THEN NULLIF(json_extract(c.target_ref_json, '$.nodeId'), '') END, 'unknown'))
       AND EXISTS (
         SELECT 1 FROM mapping_rules other WHERE other.tenant_id = r.tenant_id
           AND other.field_mapping_version_id = r.field_mapping_version_id AND other.id <> r.id
           AND (EXISTS (SELECT 1 FROM mapping_rule_edges e WHERE e.tenant_id = other.tenant_id AND e.rule_id = other.id
             AND COALESCE(CASE WHEN json_type(e.target_ref_json, '$.namespace') = 'text' THEN NULLIF(json_extract(e.target_ref_json, '$.namespace'), '') END, 'unknown') IS COALESCE(CASE WHEN json_type(c.target_ref_json, '$.namespace') = 'text' THEN NULLIF(json_extract(c.target_ref_json, '$.namespace'), '') END, 'unknown')
             AND COALESCE(CASE WHEN json_type(e.target_ref_json, '$.path') = 'text' THEN NULLIF(json_extract(e.target_ref_json, '$.path'), '') END, CASE WHEN json_type(e.target_ref_json, '$.fieldKey') = 'text' THEN NULLIF(json_extract(e.target_ref_json, '$.fieldKey'), '') END, CASE WHEN json_type(e.target_ref_json, '$.nodeId') = 'text' THEN NULLIF(json_extract(e.target_ref_json, '$.nodeId'), '') END, 'unknown') IS COALESCE(CASE WHEN json_type(c.target_ref_json, '$.path') = 'text' THEN NULLIF(json_extract(c.target_ref_json, '$.path'), '') END, CASE WHEN json_type(c.target_ref_json, '$.fieldKey') = 'text' THEN NULLIF(json_extract(c.target_ref_json, '$.fieldKey'), '') END, CASE WHEN json_type(c.target_ref_json, '$.nodeId') = 'text' THEN NULLIF(json_extract(c.target_ref_json, '$.nodeId'), '') END, 'unknown'))
           OR EXISTS (SELECT 1 FROM mapping_transform_steps t WHERE t.tenant_id = other.tenant_id AND t.rule_id = other.id
             AND COALESCE(CASE WHEN json_type(t.target_ref_json, '$.namespace') = 'text' THEN NULLIF(json_extract(t.target_ref_json, '$.namespace'), '') END, 'unknown') IS COALESCE(CASE WHEN json_type(c.target_ref_json, '$.namespace') = 'text' THEN NULLIF(json_extract(c.target_ref_json, '$.namespace'), '') END, 'unknown')
             AND COALESCE(CASE WHEN json_type(t.target_ref_json, '$.path') = 'text' THEN NULLIF(json_extract(t.target_ref_json, '$.path'), '') END, CASE WHEN json_type(t.target_ref_json, '$.fieldKey') = 'text' THEN NULLIF(json_extract(t.target_ref_json, '$.fieldKey'), '') END, CASE WHEN json_type(t.target_ref_json, '$.nodeId') = 'text' THEN NULLIF(json_extract(t.target_ref_json, '$.nodeId'), '') END, 'unknown') IS COALESCE(CASE WHEN json_type(c.target_ref_json, '$.path') = 'text' THEN NULLIF(json_extract(c.target_ref_json, '$.path'), '') END, CASE WHEN json_type(c.target_ref_json, '$.fieldKey') = 'text' THEN NULLIF(json_extract(c.target_ref_json, '$.fieldKey'), '') END, CASE WHEN json_type(c.target_ref_json, '$.nodeId') = 'text' THEN NULLIF(json_extract(c.target_ref_json, '$.nodeId'), '') END, 'unknown')))));

SELECT CASE WHEN count(*) > 0 THEN json_extract('{}',
  'Mapping graph migration refused (tenant, set, version, rule): ' ||
  json_group_array(json_array(tenant_id, set_id, version_id, rule_id))) ELSE 1 END
FROM __mapping_graph_refusals;
DROP VIEW __mapping_graph_refusals;

ALTER TABLE mapping_rules ADD COLUMN output_edge_id TEXT;
ALTER TABLE mapping_rules ADD COLUMN output_step_id TEXT;
ALTER TABLE mapping_rules ADD COLUMN target_ref_json TEXT;

UPDATE mapping_rules SET
  output_step_id = (SELECT t.id FROM mapping_transform_steps t WHERE t.tenant_id = mapping_rules.tenant_id AND t.rule_id = mapping_rules.id),
  output_edge_id = CASE WHEN NOT EXISTS (SELECT 1 FROM mapping_transform_steps t WHERE t.tenant_id = mapping_rules.tenant_id AND t.rule_id = mapping_rules.id)
    THEN (SELECT e.id FROM mapping_rule_edges e WHERE e.tenant_id = mapping_rules.tenant_id AND e.rule_id = mapping_rules.id) END,
  target_ref_json = COALESCE(
    (SELECT t.target_ref_json FROM mapping_transform_steps t WHERE t.tenant_id = mapping_rules.tenant_id AND t.rule_id = mapping_rules.id),
    (SELECT e.target_ref_json FROM mapping_rule_edges e WHERE e.tenant_id = mapping_rules.tenant_id AND e.rule_id = mapping_rules.id));

CREATE TABLE mapping_transform_step_inputs (
  tenant_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  edge_id TEXT,
  input_step_id TEXT,
  name TEXT CHECK (name IS NULL OR length(trim(name)) > 0),
  CHECK ((edge_id IS NOT NULL) <> (input_step_id IS NOT NULL)),
  PRIMARY KEY (tenant_id, step_id, position)
);
INSERT INTO mapping_transform_step_inputs (tenant_id, step_id, position, edge_id)
  SELECT tenant_id, id, 0, edge_id FROM mapping_transform_steps WHERE edge_id IS NOT NULL;

-- Rebuild to remove the legacy UNIQUE/FK on edge_id. Input ownership is checked at both SQL
-- boundaries by the control plane/runtime and by tenant portability reference validation.
CREATE TABLE __mapping_transform_steps_graph (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  rule_id TEXT NOT NULL,
  step_order INTEGER NOT NULL,
  operation TEXT NOT NULL,
  parameters_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, rule_id, step_order),
  FOREIGN KEY (rule_id) REFERENCES mapping_rules(id) ON DELETE CASCADE
);
INSERT INTO __mapping_transform_steps_graph
  SELECT id, tenant_id, rule_id, step_order, operation, parameters_json, created_at, updated_at FROM mapping_transform_steps;
DROP TABLE mapping_transform_steps;
ALTER TABLE __mapping_transform_steps_graph RENAME TO mapping_transform_steps;
CREATE INDEX idx_mapping_transform_steps_rule ON mapping_transform_steps(tenant_id, rule_id);

-- A policy-only rule has no value graph. Value graphs always carry exactly one output and target.
CREATE TRIGGER mapping_rules_graph_insert BEFORE INSERT ON mapping_rules
WHEN (NEW.output_edge_id IS NOT NULL AND NEW.output_step_id IS NOT NULL)
  OR ((NEW.output_edge_id IS NOT NULL OR NEW.output_step_id IS NOT NULL) <> (NEW.target_ref_json IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'invalid_reference: rule requires exactly one output and a target'); END;
CREATE TRIGGER mapping_rules_graph_update BEFORE UPDATE ON mapping_rules
WHEN (NEW.output_edge_id IS NOT NULL AND NEW.output_step_id IS NOT NULL)
  OR ((NEW.output_edge_id IS NOT NULL OR NEW.output_step_id IS NOT NULL) <> (NEW.target_ref_json IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'invalid_reference: rule requires exactly one output and a target'); END;
