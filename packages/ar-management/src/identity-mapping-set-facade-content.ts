/**
 * What the Mapping Set facade (`identity-mapping-set-facade.ts`) reads and writes: the shape of
 * its request, the content of a set as the version create takes it, and the content read back from
 * the rows in that same shape (so that what a GET returns can be sent to a PUT unchanged).
 *
 * Nothing here validates what a mapping means. That is the control plane's own checks, which the
 * facade calls; this only reads the request and keeps it to its shape.
 */
import { mappingReferencePath } from '@authrim/ar-lib-core';
import {
  badRequest,
  isRecord,
  POLICY_RULE_MAX_CONFLICT_RULES,
  POLICY_RULE_MAX_RELEASE_RULES,
  type CreateFieldMappingVersionRequest,
  type FieldMappingVersionRuleInput,
} from './identity-mapping-control-plane';

/** The most characters of a name, a description or a key. */
const NAME_MAX_CHARS = 200;
const DESCRIPTION_MAX_CHARS = 2000;

const REQUEST_FIELDS = new Set([
  'display_name',
  'description',
  'field_mapping_key',
  'owner_scope_type',
  'enabled',
  'confirm_impact',
  'content',
]);
const CONTENT_FIELDS = new Set([
  'catalogVersionId',
  'compatibilityRange',
  'sourceProfileIds',
  'rules',
]);

/** What the content of a set holds: what the version create takes, and the catalog to compile against. */
export interface MappingSetContent {
  catalogVersionId: string;
  compatibilityRange?: string;
  sourceProfileIds?: string[];
  rules: FieldMappingVersionRuleInput[];
}

export interface MappingSetSaveRequest {
  displayName: string;
  description: string | null;
  fieldMappingKey: string | null;
  ownerScopeType: 'tenant' | 'platform' | null;
  enabled: boolean;
  confirmImpact: number | null;
  content: MappingSetContent;
}

function requireString(value: unknown, field: string, maxChars: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw badRequest(`${field} is required`);
  }
  if (value.length > maxChars) {
    throw badRequest(`${field} must be at most ${maxChars} characters`);
  }
  return value;
}

function requireRecordArray(
  value: unknown,
  path: string,
  required: boolean
): Record<string, unknown>[] {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value)) throw badRequest(`${path} must be an array`);
  value.forEach((item, index) => {
    if (!isRecord(item)) throw badRequest(`${path}[${index}] must be an object`);
  });
  return value as Record<string, unknown>[];
}

/**
 * The shape the version create reads without failing on it: every list is a list of objects. The
 * meaning of what is in them is judged by the control plane's checks.
 */
function assertRulesShape(rules: unknown): FieldMappingVersionRuleInput[] {
  const list = requireRecordArray(rules, 'content.rules', true);
  list.forEach((rule, index) => {
    const path = `content.rules[${index}]`;
    for (const name of [
      'edges',
      'transforms',
      'validationRules',
      'releaseRules',
      'conflictRules',
    ]) {
      requireRecordArray(rule[name], `${path}.${name}`, false);
    }
    for (const [index2, edge] of (
      (rule.edges as Record<string, unknown>[] | undefined) ?? []
    ).entries()) {
      if (!isRecord(edge.sourceRef) || !isRecord(edge.targetRef)) {
        throw badRequest(`${path}.edges[${index2}] needs a sourceRef and a targetRef object`);
      }
    }
    for (const name of ['validationRules', 'conflictRules']) {
      for (const [index2, item] of (
        (rule[name] as Record<string, unknown>[] | undefined) ?? []
      ).entries()) {
        if (!isRecord(item.targetRef)) {
          throw badRequest(`${path}.${name}[${index2}].targetRef must be an object`);
        }
      }
    }
    for (const [index2, item] of (
      (rule.releaseRules as Record<string, unknown>[] | undefined) ?? []
    ).entries()) {
      if (!isRecord(item.sourceRef)) {
        throw badRequest(`${path}.releaseRules[${index2}].sourceRef must be an object`);
      }
    }
    if (rule.priority !== undefined && !Number.isInteger(rule.priority)) {
      throw badRequest(`${path}.priority must be an integer`);
    }
    for (const name of ['scope', 'condition', 'metadata']) {
      if (rule[name] !== undefined && !isRecord(rule[name])) {
        throw badRequest(`${path}.${name} must be an object`);
      }
    }
  });
  return list as unknown as FieldMappingVersionRuleInput[];
}

/** The content of a request; anything it does not know is refused, never ignored. */
export function parseMappingSetContent(value: unknown): MappingSetContent {
  if (!isRecord(value)) throw badRequest('content is required and must be an object');
  for (const name of Object.keys(value)) {
    if (!CONTENT_FIELDS.has(name)) throw badRequest(`content.${name} is not a known field`);
  }
  const catalogVersionId = requireString(value.catalogVersionId, 'content.catalogVersionId', 256);
  if (value.compatibilityRange !== undefined && typeof value.compatibilityRange !== 'string') {
    throw badRequest('content.compatibilityRange must be a string');
  }
  if (
    value.sourceProfileIds !== undefined &&
    (!Array.isArray(value.sourceProfileIds) ||
      value.sourceProfileIds.some((id) => typeof id !== 'string' || !id.trim()))
  ) {
    throw badRequest('content.sourceProfileIds must be an array of non-empty strings');
  }
  return {
    catalogVersionId,
    ...(value.compatibilityRange !== undefined
      ? { compatibilityRange: value.compatibilityRange }
      : {}),
    ...(value.sourceProfileIds !== undefined
      ? { sourceProfileIds: value.sourceProfileIds as string[] }
      : {}),
    rules: assertRulesShape(value.rules),
  };
}

/** The request of a PUT or POST, in the form the facade works with. */
export function parseMappingSetSaveRequest(body: unknown): MappingSetSaveRequest {
  if (!isRecord(body)) throw badRequest('Request body must be an object');
  for (const name of Object.keys(body)) {
    if (!REQUEST_FIELDS.has(name)) throw badRequest(`${name} is not a known field`);
  }
  const displayName = requireString(body.display_name, 'display_name', NAME_MAX_CHARS);
  if (
    body.description !== undefined &&
    body.description !== null &&
    (typeof body.description !== 'string' || body.description.length > DESCRIPTION_MAX_CHARS)
  ) {
    throw badRequest(`description must be a string of at most ${DESCRIPTION_MAX_CHARS} characters`);
  }
  if (body.field_mapping_key !== undefined) {
    requireString(body.field_mapping_key, 'field_mapping_key', NAME_MAX_CHARS);
  }
  if (
    body.owner_scope_type !== undefined &&
    body.owner_scope_type !== 'tenant' &&
    body.owner_scope_type !== 'platform'
  ) {
    throw badRequest('owner_scope_type must be tenant or platform');
  }
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
    throw badRequest('enabled must be a boolean');
  }
  if (
    body.confirm_impact !== undefined &&
    (typeof body.confirm_impact !== 'number' ||
      !Number.isInteger(body.confirm_impact) ||
      body.confirm_impact < 0)
  ) {
    throw badRequest('confirm_impact must be a non-negative integer');
  }
  return {
    displayName,
    description: body.description ?? null,
    fieldMappingKey: (body.field_mapping_key as string | undefined) ?? null,
    ownerScopeType: body.owner_scope_type ?? null,
    enabled: body.enabled ?? true,
    confirmImpact: body.confirm_impact ?? null,
    content: parseMappingSetContent(body.content),
  };
}

/** The input of the version create for this content. */
export function toVersionInput(
  content: MappingSetContent,
  versionLabel: string,
  authorId?: string
): CreateFieldMappingVersionRequest {
  return {
    versionLabel,
    ...(content.compatibilityRange !== undefined
      ? { compatibilityRange: content.compatibilityRange }
      : {}),
    ...(content.sourceProfileIds !== undefined
      ? { sourceProfileIds: content.sourceProfileIds }
      : {}),
    ...(authorId ? { authorId } : {}),
    rules: content.rules,
  };
}

/** What `listFieldMappingVersions` returns of one version, as far as the content is read from it. */
export interface StoredVersionForContent {
  compatibilityRange: string | null;
  latestSnapshot: { catalogVersionId: string | null } | null;
  rules: Array<{
    ruleKey: string;
    ruleKind: string;
    action: string;
    priority: number;
    scope: Record<string, unknown>;
    condition: Record<string, unknown>;
    metadata: Record<string, unknown>;
    edges: Array<{
      id: string;
      sourceRef: Record<string, unknown>;
      targetRef: Record<string, unknown>;
      edgeKind: string;
    }>;
    transforms: Array<{
      edgeId: string | null;
      operation: string;
      parameters: Record<string, unknown>;
    }>;
    validationRules: Array<{
      targetRef: Record<string, unknown>;
      validationKind: string;
      severity: string;
      parameters: Record<string, unknown>;
    }>;
  }>;
  releaseRules: Array<{
    destinationType: string;
    destinationId: string | null;
    sourceRef: Record<string, unknown>;
    releaseAction: string;
    legalBasis: string | null;
    purpose: string | null;
    condition: Record<string, unknown>;
    priority: number;
  }>;
  conflictRules: Array<{
    targetRef: Record<string, unknown>;
    conflictStrategy: string;
    sourcePriority: unknown[];
    condition: Record<string, unknown>;
  }>;
}

/**
 * The content of a stored version, in the form the PUT takes. The release and conflict rules are
 * stored on the version, not on a rule, so they are spread over the rules within the limits of a
 * rule (the version they make is the same wherever they are written).
 */
export function contentFromStoredVersion(version: StoredVersionForContent): MappingSetContent {
  // What is stored cannot tell a value that was left out from one that was given as the default,
  // so the default and the empty are left out here: the content read is never larger than the
  // content that was saved (the checks hold a content to a number of JSON nodes, and defaults
  // written out would count), and it means the same.
  const nonEmpty = (value: Record<string, unknown>) =>
    Object.keys(value).length > 0 ? value : undefined;
  const rules: FieldMappingVersionRuleInput[] = version.rules.map((rule) => ({
    ruleKey: rule.ruleKey,
    ruleKind: rule.ruleKind,
    action: rule.action,
    ...(rule.priority !== 0 ? { priority: rule.priority } : {}),
    ...(nonEmpty(rule.scope) ? { scope: rule.scope } : {}),
    ...(nonEmpty(rule.condition) ? { condition: rule.condition } : {}),
    ...(nonEmpty(rule.metadata) ? { metadata: rule.metadata } : {}),
    ...(rule.edges.length > 0
      ? {
          edges: rule.edges.map((edge) => ({
            sourceRef: edge.sourceRef,
            targetRef: edge.targetRef,
            ...(edge.edgeKind !== 'direct' ? { edgeKind: edge.edgeKind } : {}),
          })),
        }
      : {}),
    ...(rule.transforms.length > 0
      ? {
          transforms: rule.transforms.map((transform) => {
            const edgeIndex = transform.edgeId
              ? rule.edges.findIndex((edge) => edge.id === transform.edgeId)
              : -1;
            return {
              ...(edgeIndex >= 0 ? { edgeIndex } : {}),
              operation: transform.operation,
              ...(nonEmpty(transform.parameters) ? { parameters: transform.parameters } : {}),
            };
          }),
        }
      : {}),
    ...(rule.validationRules.length > 0
      ? {
          validationRules: rule.validationRules.map((item) => ({
            targetRef: item.targetRef,
            validationKind: item.validationKind,
            ...(item.severity !== 'error' ? { severity: item.severity } : {}),
            ...(nonEmpty(item.parameters) ? { parameters: item.parameters } : {}),
          })),
        }
      : {}),
  }));
  // Release and conflict rules belong to the version, not to a rule, but the version create takes
  // them on the rules and holds each rule to a limit. They are given back spread over the rules in
  // order, each filled to its limit before the next, so that what is read is accepted as written.
  // (The version came from rules that each held no more than the limit, so there are enough.)
  const releaseRules = version.releaseRules.map((item) => ({
    destinationType: item.destinationType,
    ...(item.destinationId ? { destinationId: item.destinationId } : {}),
    sourceRef: item.sourceRef,
    releaseAction: item.releaseAction,
    ...(item.legalBasis ? { legalBasis: item.legalBasis } : {}),
    ...(item.purpose ? { purpose: item.purpose } : {}),
    ...(nonEmpty(item.condition) ? { condition: item.condition } : {}),
    ...(item.priority !== 0 ? { priority: item.priority } : {}),
  }));
  const conflictRules = version.conflictRules.map((item) => ({
    targetRef: item.targetRef,
    conflictStrategy: item.conflictStrategy,
    ...(item.sourcePriority.length > 0 ? { sourcePriority: item.sourcePriority } : {}),
    ...(nonEmpty(item.condition) ? { condition: item.condition } : {}),
  }));
  rules.forEach((rule, index) => {
    const release = releaseRules.slice(
      index * POLICY_RULE_MAX_RELEASE_RULES,
      (index + 1) * POLICY_RULE_MAX_RELEASE_RULES
    );
    const conflicts = conflictRules.slice(
      index * POLICY_RULE_MAX_CONFLICT_RULES,
      (index + 1) * POLICY_RULE_MAX_CONFLICT_RULES
    );
    if (release.length > 0) rule.releaseRules = release;
    if (conflicts.length > 0) rule.conflictRules = conflicts;
  });
  return {
    catalogVersionId: version.latestSnapshot?.catalogVersionId ?? '',
    ...(version.compatibilityRange ? { compatibilityRange: version.compatibilityRange } : {}),
    rules,
  };
}

export interface MappingSetContentSummary {
  rules: number;
  edges: number;
  transforms: number;
  validation_rules: number;
  release_rules: number;
  conflict_rules: number;
  /** The names of the claims the content releases (the names only, never a value). */
  released_claims: string[];
}

/** How big a content is, and which claims it releases. */
export function summarizeMappingSetContent(
  content: Pick<MappingSetContent, 'rules'>
): MappingSetContentSummary {
  const count = (pick: (rule: FieldMappingVersionRuleInput) => unknown[] | undefined) =>
    content.rules.reduce((total, rule) => total + (pick(rule)?.length ?? 0), 0);
  const claims = new Set<string>();
  for (const rule of content.rules) {
    for (const edge of rule.edges ?? []) {
      const name = mappingReferencePath(edge.targetRef);
      if (name) claims.add(name);
    }
  }
  return {
    rules: content.rules.length,
    edges: count((rule) => rule.edges),
    transforms: count((rule) => rule.transforms),
    validation_rules: count((rule) => rule.validationRules),
    release_rules: count((rule) => rule.releaseRules),
    conflict_rules: count((rule) => rule.conflictRules),
    released_claims: [...claims].sort(),
  };
}

/** What a save changes: the sizes before and after, and the claims it adds and removes. */
export function diffMappingSetContent(
  before: Pick<MappingSetContent, 'rules'> | null,
  after: Pick<MappingSetContent, 'rules'>
) {
  const afterSummary = summarizeMappingSetContent(after);
  const beforeSummary = before ? summarizeMappingSetContent(before) : null;
  const beforeClaims = new Set(beforeSummary?.released_claims ?? []);
  const afterClaims = new Set(afterSummary.released_claims);
  return {
    before: beforeSummary,
    after: afterSummary,
    claims_added: [...afterClaims].filter((name) => !beforeClaims.has(name)),
    claims_removed: [...beforeClaims].filter((name) => !afterClaims.has(name)),
  };
}
