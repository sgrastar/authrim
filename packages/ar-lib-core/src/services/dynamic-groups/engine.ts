import {
  GROUP_LIMITS,
  type Field,
  type Expression,
  type Evaluation,
  type EvaluationInput,
  type GroupPlan,
  type ServiceGroup,
  type Truth,
} from './model';

const own = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
export function normalizeGroupValue(value: unknown, field: Field): unknown {
  if (field.type.endsWith('[]')) {
    if (!Array.isArray(value) || value.length > 256) return undefined;
    const scalar = { ...field, type: field.type.slice(0, -2) as Field['type'] };
    const result = value.map((item) => normalizeGroupValue(item, scalar));
    return result.some((item) => item === undefined) ? undefined : result;
  }
  if (typeof value !== field.type || (typeof value === 'number' && !Number.isFinite(value)))
    return undefined;
  if (typeof value !== 'string') return value;
  if (value.length > 4096) return undefined;
  const normalized = value.normalize('NFC');
  if (field.normalize === 'domain')
    return /^[a-z0-9.-]+$/i.test(normalized) ? normalized.toLowerCase() : undefined;
  if (field.normalize === 'country')
    return /^[a-z]{2}$/i.test(normalized) ? normalized.toUpperCase() : undefined;
  if (field.normalize === 'email') {
    const at = normalized.lastIndexOf('@');
    return at > 0 && at < normalized.length - 1
      ? normalized.slice(0, at) + normalized.slice(at).toLowerCase()
      : undefined;
  }
  return normalized;
}
export function groupLogic(op: 'all' | 'any' | 'not', values: Truth[]): Truth {
  if (op === 'not') return values[0] === 'unknown' ? 'unknown' : !values[0];
  if (op === 'all')
    return values.includes(false) ? false : values.includes('unknown') ? 'unknown' : true;
  return values.includes(true) ? true : values.includes('unknown') ? 'unknown' : false;
}
export function compareGroupAttribute(
  expression: Extract<Expression, { op: 'attribute' }>,
  field: Field,
  attributes: Record<string, unknown>
): Truth {
  if (!own(attributes, expression.field)) return 'unknown';
  const actual = normalizeGroupValue(attributes[expression.field], field);
  if (actual === undefined || actual === null) return 'unknown';
  const scalarField = { ...field, type: field.type.replace('[]', '') as Field['type'] };
  const expected = normalizeGroupValue(
    expression.value,
    expression.compare === 'in'
      ? { ...field, type: `${field.type}[]` as Field['type'] }
      : expression.compare === 'contains'
        ? scalarField
        : field
  );
  if (expected === undefined) return 'unknown';
  switch (expression.compare) {
    case 'eq':
      return actual === expected;
    case 'in':
      return Array.isArray(expected) && expected.includes(actual);
    case 'contains':
      return Array.isArray(actual) && actual.includes(expected);
    case 'lt':
      return typeof actual === 'number' && typeof expected === 'number' && actual < expected;
    case 'lte':
      return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;
    case 'gt':
      return typeof actual === 'number' && typeof expected === 'number' && actual > expected;
    case 'gte':
      return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
  }
}

/** Validate untrusted JSON before traversing it; never execute expressions supplied as code. */
export function compileGroups(
  tenantId: string,
  groups: ServiceGroup[],
  fields: Record<string, Field>
): GroupPlan {
  if (!tenantId || !Array.isArray(groups) || groups.length > GROUP_LIMITS.groups)
    throw new Error('groups_limit');
  const plan: GroupPlan = {
    tenantId,
    groups,
    fields,
    nodes: {},
    order: [],
    roots: {},
    attributes: {},
    dependents: {},
    dependencies: {},
  };
  const ids = new Map<string, ServiceGroup>();
  const keys = new Set<string>();
  for (const group of groups) {
    if (
      !record(group) ||
      group.tenantId !== tenantId ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(group.id) ||
      ['__proto__', 'constructor', 'prototype'].includes(group.id) ||
      ids.has(group.id)
    )
      throw new Error('group_identity_invalid');
    if (
      !/^[a-z][a-z0-9_-]{0,63}$/.test(group.key) ||
      keys.has(group.key) ||
      typeof group.enabled !== 'boolean' ||
      typeof group.displayName !== 'string' ||
      !group.displayName.trim() ||
      group.displayName.length > 200 ||
      typeof group.description !== 'string' ||
      group.description.length > 2000
    )
      throw new Error('group_metadata_invalid');
    if (
      group.scimRoleId !== undefined &&
      (typeof group.scimRoleId !== 'string' || !/^[a-zA-Z0-9_:-]{1,128}$/.test(group.scimRoleId))
    )
      throw new Error('group_scim_link_invalid');
    ids.set(group.id, group);
    keys.add(group.key);
    plan.dependencies[group.id] = [];
    plan.dependents[group.id] = [];
  }
  const intern = new Map<string, string>();
  for (const group of groups) {
    let count = 0;
    const refs = new Set<string>();
    const attrs = new Set<string>();
    const visit = (raw: unknown, depth: number): string => {
      if (++count > GROUP_LIMITS.nodes || depth > GROUP_LIMITS.depth || !record(raw))
        throw new Error('condition_limit_or_invalid');
      let expression: Expression;
      let children: string[] = [];
      if (raw.op === 'all' || raw.op === 'any') {
        if (!Array.isArray(raw.args) || !raw.args.length || raw.args.length > GROUP_LIMITS.nodes)
          throw new Error('condition_operands_invalid');
        children = raw.args.map((child) => visit(child, depth + 1));
        expression = { op: raw.op, args: raw.args as Expression[] };
      } else if (raw.op === 'not') {
        children = [visit(raw.arg, depth + 1)];
        expression = { op: 'not', arg: raw.arg as Expression };
      } else if (raw.op === 'member') {
        if (
          typeof raw.groupId !== 'string' ||
          raw.groupId === group.id ||
          !ids.get(raw.groupId)?.enabled
        )
          throw new Error('group_reference_invalid');
        refs.add(raw.groupId);
        expression = { op: 'member', groupId: raw.groupId };
      } else if (raw.op === 'attribute') {
        if (typeof raw.field !== 'string' || !own(fields, raw.field))
          throw new Error('attribute_unknown');
        const field = fields[raw.field];
        const op = raw.compare;
        const array = field.type.endsWith('[]');
        if (
          array
            ? op !== 'contains'
            : ![
                'eq',
                'in',
                ...(field.type === 'number' ? ['lt', 'lte', 'gt', 'gte'] : []),
              ].includes(String(op))
        )
          throw new Error('comparison_type_invalid');
        const expectedField =
          op === 'contains'
            ? { ...field, type: field.type.replace('[]', '') as Field['type'] }
            : op === 'in'
              ? { ...field, type: `${field.type}[]` as Field['type'] }
              : field;
        if (
          normalizeGroupValue(raw.value, expectedField) === undefined ||
          (op === 'in' && (!Array.isArray(raw.value) || !raw.value.length))
        )
          throw new Error('comparison_value_invalid');
        expression = {
          op: 'attribute',
          field: raw.field,
          compare: op as Extract<Expression, { op: 'attribute' }>['compare'],
          value: raw.value as Extract<Expression, { op: 'attribute' }>['value'],
        };
        attrs.add(raw.field);
      } else throw new Error('condition_operator_invalid');
      // Keys use child IDs, not expanded dependent group expressions.
      const key = children.length
        ? JSON.stringify([expression.op, children])
        : JSON.stringify(expression);
      const existing = intern.get(key);
      if (existing) return existing;
      const id = `n${intern.size}`;
      intern.set(key, id);
      plan.nodes[id] = {
        expression: children.length
          ? { op: expression.op as 'all' | 'any' | 'not' }
          : (expression as Exclude<Expression, { op: 'all' | 'any' } | { op: 'not' }>),
        children,
      };
      return id;
    };
    plan.roots[group.id] = group.condition === null ? null : visit(group.condition, 0);
    if (
      group.condition !== null &&
      new TextEncoder().encode(JSON.stringify(group.condition)).length > GROUP_LIMITS.bytes
    )
      throw new Error('condition_size_limit');
    if (refs.size > GROUP_LIMITS.references) throw new Error('group_reference_limit');
    plan.dependencies[group.id] = [...refs];
    for (const ref of refs) plan.dependents[ref].push(group.id);
    for (const attr of attrs) (plan.attributes[attr] ??= []).push(group.id);
  }
  if (Object.keys(plan.attributes).length > GROUP_LIMITS.fields)
    throw new Error('group_attribute_limit');
  const visiting = new Set<string>();
  const depths = new Map<string, number>();
  const sort = (id: string): number => {
    if (visiting.has(id)) throw new Error('group_dependency_cycle');
    if (depths.has(id)) return depths.get(id)!;
    visiting.add(id);
    const depth = 1 + Math.max(0, ...plan.dependencies[id].map(sort));
    if (depth > GROUP_LIMITS.chain) throw new Error('group_dependency_depth');
    visiting.delete(id);
    depths.set(id, depth);
    plan.order.push(id);
    return depth;
  };
  groups.forEach((group) => sort(group.id));
  plan.fields = Object.fromEntries(Object.keys(plan.attributes).map((key) => [key, fields[key]]));
  return plan;
}

function membership(
  group: ServiceGroup,
  dynamic: Truth,
  input: EvaluationInput
): Evaluation['groups'][string] {
  if (!group.enabled) return { member: false, dynamic: false, sources: [] };
  const external = input.sources[group.id] ?? {
    manual: false,
    scim: group.scimRoleId ? 'unknown' : false,
  };
  const sources = [
    ...(external.manual ? ['manual'] : []),
    ...(external.scim === true ? ['scim'] : []),
    ...(dynamic === true ? ['dynamic'] : []),
  ];
  return { member: groupLogic('any', [external.manual, external.scim, dynamic]), dynamic, sources };
}
/** Cache is valid only for the same compiled plan. Seeds are unioned before topological traversal. */
export function evaluateGroups(
  plan: GroupPlan,
  input: EvaluationInput,
  previous?: Evaluation,
  changedFields: string[] = Object.keys(plan.attributes),
  changedSources: string[] = plan.order
): Evaluation {
  const result: Evaluation = {
    nodes: { ...previous?.nodes },
    groups: { ...previous?.groups },
    evaluatedNodes: 0,
  };
  const dirty = new Set(
    previous
      ? [...changedFields.flatMap((field) => plan.attributes[field] ?? []), ...changedSources]
      : plan.order
  );
  const evaluated = new Set<string>();
  const visit = (id: string): Truth => {
    if (evaluated.has(id)) return result.nodes[id];
    const node = plan.nodes[id];
    const e = node.expression;
    let value: Truth;
    if (e.op === 'attribute')
      value = compareGroupAttribute(e, plan.fields[e.field], input.attributes);
    else if (e.op === 'member') value = result.groups[e.groupId]?.member ?? 'unknown';
    else value = groupLogic(e.op, node.children.map(visit));
    result.nodes[id] = value;
    evaluated.add(id);
    result.evaluatedNodes++;
    return value;
  };
  for (const id of plan.order) {
    if (!dirty.has(id)) continue;
    const group = plan.groups.find((item) => item.id === id)!;
    const root = plan.roots[id];
    const next = membership(group, root === null ? false : visit(root), input);
    const old = result.groups[id];
    result.groups[id] = next;
    if (!old || old.member !== next.member)
      plan.dependents[id].forEach((dependent) => dirty.add(dependent));
  }
  return result;
}

/** Deliberately simple full recursion, independent of indexes, node interning and incremental traversal. */
export function recomputeGroups(plan: GroupPlan, input: EvaluationInput): Evaluation['groups'] {
  const groups: Evaluation['groups'] = {};
  const expr = (e: Expression): Truth => {
    if (e.op === 'attribute')
      return compareGroupAttribute(e, plan.fields[e.field], input.attributes);
    if (e.op === 'member') return group(e.groupId).member;
    if (e.op === 'not') {
      const v = expr(e.arg);
      return v === 'unknown' ? v : !v;
    }
    const values = e.args.map(expr);
    if (e.op === 'all')
      return values.some((v) => v === false)
        ? false
        : values.some((v) => v === 'unknown')
          ? 'unknown'
          : true;
    return values.some((v) => v === true)
      ? true
      : values.some((v) => v === 'unknown')
        ? 'unknown'
        : false;
  };
  const group = (id: string): Evaluation['groups'][string] => {
    if (own(groups, id)) return groups[id];
    const definition = plan.groups.find((item) => item.id === id)!;
    return (groups[id] = membership(
      definition,
      definition.condition ? expr(definition.condition) : false,
      input
    ));
  };
  plan.groups.forEach((item) => group(item.id));
  return groups;
}

/** Persist only truth results: no plaintext or dictionary-attackable hashes of private attributes. */
export function evaluateGroupInputDelta(
  plan: GroupPlan,
  input: EvaluationInput,
  previous?: Evaluation
): Evaluation {
  if (!previous) return evaluateGroups(plan, input);
  const changed = new Set<string>();
  for (const [id, node] of Object.entries(plan.nodes)) {
    if (
      node.expression.op === 'attribute' &&
      compareGroupAttribute(
        node.expression,
        plan.fields[node.expression.field],
        input.attributes
      ) !== previous.nodes[id]
    )
      changed.add(node.expression.field);
  }
  const sources = plan.groups
    .filter((group) => {
      const old = previous.groups[group.id];
      if (!old) return true;
      const next = membership(group, old.dynamic, input);
      return JSON.stringify(next) !== JSON.stringify(old);
    })
    .map((group) => group.id);
  return evaluateGroups(plan, input, previous, [...changed], sources);
}
