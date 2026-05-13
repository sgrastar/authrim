import type {
  SAMLAttribute,
  SAMLAttributeValueType,
  SAMLComputedAttribute,
} from '@authrim/ar-lib-core';

export interface SAMLAttributeSubject {
  id: string;
  email?: string;
  name?: string;
  claims?: Record<string, unknown>;
  attributes?: Record<string, unknown>;
  customClaims?: Record<string, unknown>;
  customFields?: Record<string, unknown>;
}

export interface SAMLAttributeReleaseConfig {
  attributeMapping: Record<string, string>;
  attributeReleasePolicy?: {
    attributes: SAMLAttributeReleaseRule[];
  };
}

export interface SAMLAttributeReleaseRule {
  name: string;
  nameFormat?: string;
  friendlyName?: string;
  valueType?: SAMLAttributeValueType;
  source: SAMLAttributeReleaseSource;
  claim?: string;
  value?: string | string[];
  computed?: SAMLComputedAttribute;
  required?: boolean;
}

export interface MissingRequiredSAMLAttribute {
  name: string;
  friendlyName?: string;
  source: SAMLAttributeReleaseSource;
  claim?: string;
}

export class MissingRequiredSAMLAttributeError extends Error {
  readonly missingAttributes: MissingRequiredSAMLAttribute[];

  constructor(missingAttributes: MissingRequiredSAMLAttribute[]) {
    super(
      `Missing required SAML attribute value: ${missingAttributes.map((attr) => attr.name).join(', ')}`
    );
    this.name = 'MissingRequiredSAMLAttributeError';
    this.missingAttributes = missingAttributes;
  }
}

export type SAMLAttributeReleaseSource =
  | 'claim'
  | 'attribute'
  | 'custom_claim'
  | 'custom_field'
  | 'constant'
  | 'computed';

export interface SAMLAttributeReleaseResult {
  attributes: SAMLAttribute[];
  optionalMissingAttributes: MissingRequiredSAMLAttribute[];
}

type AttributeValue = string | number | boolean;

const SOURCE_ALIASES: Record<string, keyof SAMLAttributeSubject> = {
  sub: 'id',
  user_id: 'id',
};

/**
 * Build SAML attributes from the existing claim-to-SAML attribute mapping.
 *
 * This keeps the current SAMLSPConfig.attributeMapping contract intact while
 * centralizing the release logic so a policy-backed resolver can replace the
 * mapping source later.
 */
export function buildSAMLAttributesFromMapping(
  subject: SAMLAttributeSubject,
  attributeMapping: Record<string, string> = {}
): SAMLAttribute[] {
  const attributes: SAMLAttribute[] = [];

  for (const [sourceClaim, samlAttributeName] of Object.entries(attributeMapping)) {
    const values = normalizeAttributeValues(readSubjectValue(subject, sourceClaim));
    if (values.length === 0) {
      continue;
    }

    attributes.push({
      name: samlAttributeName,
      values,
    });
  }

  return attributes;
}

export function buildSAMLAttributesForSP(
  subject: SAMLAttributeSubject,
  spConfig: SAMLAttributeReleaseConfig
): SAMLAttribute[] {
  return buildSAMLAttributesForSPWithDiagnostics(subject, spConfig).attributes;
}

export function buildSAMLAttributesForSPWithDiagnostics(
  subject: SAMLAttributeSubject,
  spConfig: SAMLAttributeReleaseConfig
): SAMLAttributeReleaseResult {
  const rules = spConfig.attributeReleasePolicy?.attributes ?? [];
  if (rules.length === 0) {
    return {
      attributes: buildSAMLAttributesFromMapping(subject, spConfig.attributeMapping),
      optionalMissingAttributes: [],
    };
  }

  const attributes: SAMLAttribute[] = [];
  const missingAttributes: MissingRequiredSAMLAttribute[] = [];
  const optionalMissingAttributes: MissingRequiredSAMLAttribute[] = [];

  for (const rule of rules) {
    const attribute = buildAttributeFromRule(subject, rule);
    if (attribute) {
      attributes.push(attribute);
      continue;
    }

    if (rule.required) {
      missingAttributes.push({
        name: rule.name,
        friendlyName: rule.friendlyName,
        source: rule.source,
        claim: rule.claim,
      });
    } else {
      optionalMissingAttributes.push({
        name: rule.name,
        friendlyName: rule.friendlyName,
        source: rule.source,
        claim: rule.claim,
      });
    }
  }

  if (missingAttributes.length > 0) {
    throw new MissingRequiredSAMLAttributeError(missingAttributes);
  }

  return { attributes, optionalMissingAttributes };
}

function buildAttributeFromRule(
  subject: SAMLAttributeSubject,
  rule: SAMLAttributeReleaseRule
): SAMLAttribute | null {
  const values = normalizeAttributeValues(readRuleValue(subject, rule));
  if (values.length === 0) {
    return null;
  }

  return {
    name: rule.name,
    nameFormat: rule.nameFormat,
    friendlyName: rule.friendlyName,
    valueType: rule.valueType,
    values,
  };
}

function readRuleValue(subject: SAMLAttributeSubject, rule: SAMLAttributeReleaseRule): unknown {
  switch (rule.source) {
    case 'claim':
      return rule.claim ? readSubjectValue(subject, rule.claim) : undefined;
    case 'attribute':
      return rule.claim ? readSubjectValue(subject, `attributes.${rule.claim}`) : undefined;
    case 'custom_claim':
      return rule.claim ? readSubjectValue(subject, `customClaims.${rule.claim}`) : undefined;
    case 'custom_field':
      return rule.claim ? readSubjectValue(subject, `customFields.${rule.claim}`) : undefined;
    case 'constant':
      return rule.value;
    case 'computed':
      return readComputedRuleValue(subject, rule);
  }
}

function readComputedRuleValue(
  subject: SAMLAttributeSubject,
  rule: SAMLAttributeReleaseRule
): unknown {
  switch (rule.computed) {
    case 'eduPersonScopedAffiliation':
      return readEduPersonScopedAffiliation(subject, rule.claim);
    default:
      return undefined;
  }
}

function readEduPersonScopedAffiliation(
  subject: SAMLAttributeSubject,
  directClaim = 'eduPersonScopedAffiliation'
): unknown {
  const directValue =
    readSubjectValue(subject, `customClaims.${directClaim}`) ??
    readSubjectValue(subject, `claims.${directClaim}`) ??
    readSubjectValue(subject, directClaim);
  if (normalizeAttributeValues(directValue).length > 0) {
    return directValue;
  }

  const affiliations = normalizeAttributeValues(
    readSubjectValue(subject, 'customClaims.eduPersonAffiliation') ??
      readSubjectValue(subject, 'customClaims.affiliation') ??
      readSubjectValue(subject, 'claims.eduPersonAffiliation') ??
      readSubjectValue(subject, 'claims.affiliation')
  );
  const scopes = normalizeAttributeValues(
    readSubjectValue(subject, 'customClaims.eduPersonScope') ??
      readSubjectValue(subject, 'customClaims.institutionScope') ??
      readSubjectValue(subject, 'customClaims.scope') ??
      readSubjectValue(subject, 'claims.eduPersonScope') ??
      readSubjectValue(subject, 'claims.institutionScope') ??
      readSubjectValue(subject, 'claims.scope')
  );

  if (affiliations.length === 0 || scopes.length === 0) {
    return undefined;
  }

  return affiliations.flatMap((affiliation) => scopes.map((scope) => `${affiliation}@${scope}`));
}

function readSubjectValue(subject: SAMLAttributeSubject, sourceClaim: string): unknown {
  const aliasedClaim = SOURCE_ALIASES[sourceClaim] ?? sourceClaim;
  const path = aliasedClaim.split('.');

  if (path.length === 1) {
    return subject[path[0] as keyof SAMLAttributeSubject];
  }

  const [root, ...rest] = path;
  const rootValue = readRootValue(subject, root);
  if (!isRecord(rootValue)) {
    return undefined;
  }

  return readNestedValue(rootValue, rest);
}

function readRootValue(subject: SAMLAttributeSubject, root: string): unknown {
  switch (root) {
    case 'claims':
      return subject.claims;
    case 'attributes':
      return subject.attributes;
    case 'customClaims':
    case 'custom_claims':
      return subject.customClaims;
    case 'customFields':
    case 'custom_fields':
      return subject.customFields;
    default:
      return subject[root as keyof SAMLAttributeSubject];
  }
}

function readNestedValue(record: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = record;

  for (const segment of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }

  return current;
}

function normalizeAttributeValues(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => normalizeAttributeValues(item));
  }

  if (isAttributeValue(value)) {
    const stringValue = String(value);
    return stringValue.length > 0 ? [stringValue] : [];
  }

  return [];
}

function isAttributeValue(value: unknown): value is AttributeValue {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
