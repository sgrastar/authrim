/** The exact persisted graph material shared by compile and the deploy-time 023 migration. */
export function mappingGraphMaterialSql(legacy = false): string {
  const target = legacy
    ? `COALESCE((SELECT t.target_ref_json FROM mapping_transform_steps t WHERE t.tenant_id=r.tenant_id AND t.rule_id=r.id),
       (SELECT e.target_ref_json FROM mapping_rule_edges e WHERE e.tenant_id=r.tenant_id AND e.rule_id=r.id))`
    : 'r.target_ref_json';
  const outputStep = legacy
    ? '(SELECT t.id FROM mapping_transform_steps t WHERE t.tenant_id=r.tenant_id AND t.rule_id=r.id)'
    : 'r.output_step_id';
  const outputEdge = legacy
    ? `CASE WHEN NOT EXISTS (SELECT 1 FROM mapping_transform_steps t WHERE t.tenant_id=r.tenant_id AND t.rule_id=r.id)
       THEN (SELECT e.id FROM mapping_rule_edges e WHERE e.tenant_id=r.tenant_id AND e.rule_id=r.id) END`
    : 'r.output_edge_id';
  const inputs = legacy
    ? `CASE WHEN t.edge_id IS NULL THEN json('[]') ELSE json_array(json_object('position',0,'edge_id',t.edge_id,'input_step_id',NULL,'name',NULL)) END`
    : `(SELECT json_group_array(json_object('position',i.position,'edge_id',i.edge_id,'input_step_id',i.input_step_id,'name',i.name))
        FROM (SELECT * FROM mapping_transform_step_inputs WHERE tenant_id=t.tenant_id AND step_id=t.id ORDER BY position) i)`;
  return `SELECT v.tenant_id, v.id AS version_id,
    (SELECT json_group_array(json_object('id',r.id,'target_ref_json',${target},
      'output_edge_id',${outputEdge},'output_step_id',${outputStep},
      'edges',(SELECT json_group_array(json_object('id',e.id,'source_ref_json',e.source_ref_json,'target_ref_json',e.target_ref_json,'edge_kind',e.edge_kind))
        FROM (SELECT * FROM mapping_rule_edges WHERE tenant_id=r.tenant_id AND rule_id=r.id ORDER BY display_order,id) e),
      'steps',(SELECT json_group_array(json_object('id',t.id,'operation',t.operation,'parameters_json',t.parameters_json,'inputs',json(${inputs})))
        FROM (SELECT * FROM mapping_transform_steps WHERE tenant_id=r.tenant_id AND rule_id=r.id ORDER BY step_order,id) t)))
     FROM (SELECT * FROM mapping_rules WHERE tenant_id=v.tenant_id AND field_mapping_version_id=v.id ORDER BY priority,created_at,rowid) r) AS graph_json
    FROM field_mapping_versions v`;
}

export function canonicalMappingGraphJson(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (typeof item !== 'object' || item === null) return item;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(item).sort()) {
      const entry: unknown = Reflect.get(item, key);
      if (entry !== undefined) result[key] = sort(entry);
    }
    return result;
  };
  return JSON.stringify(sort(value));
}
