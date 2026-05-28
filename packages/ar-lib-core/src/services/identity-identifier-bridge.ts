export const IDENTITY_IDENTIFIER_REASON_CODES = {
  subjectIdentifierStrategyMissing: 'identity_mapping.subject_identifier_strategy_missing',
  unsafeSubjectIdentifierStrategy: 'identity_mapping.subject_identifier_strategy_unsafe',
} as const;

export type IdentityBindingSemantic = 'federated_login_subject' | 'external_subject' | string;
export type SubjectIdentifierDestinationProtocol = 'oidc' | 'saml' | 'scim' | string;
export type SubjectIdentifierRequirement = 'required' | 'not_required';

export interface IdentityBindingKeyResult {
  protocol: string;
  sourceId: string;
  providerSubjectKeyHash: string;
  metadata: Record<string, unknown>;
}

export interface SamlIdentityBindingKeyInput {
  issuer: string;
  nameId: string;
  nameIdFormat: string;
  nameQualifier?: string | null;
  spNameQualifier?: string | null;
  destinationScope?: string | null;
  semantic?: IdentityBindingSemantic;
}

export interface OidcIdentityBindingKeyInput {
  issuer: string;
  subject: string;
  clientId?: string | null;
  sectorIdentifier?: string | null;
  semantic?: IdentityBindingSemantic;
}

export interface ScimIdentityBindingKeyInput {
  sourceId: string;
  externalSubject: string;
  schemaUrn?: string | null;
  semantic?: IdentityBindingSemantic;
}

export type SubjectIdentifierStrategyKind =
  | 'opaque_pairwise'
  | 'opaque_public'
  | 'imported_external'
  | 'deterministic_hmac';

export interface SubjectIdentifierStrategy {
  kind: SubjectIdentifierStrategyKind;
  keyRef?: string | null;
  sourceBindingRef?: string | null;
  sourceSystemRef?: string | null;
  lifecyclePolicy?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface SubjectIdentifierStrategyPlanInput {
  destinationProtocol?: SubjectIdentifierDestinationProtocol;
  requirement?: SubjectIdentifierRequirement;
  existingIdentifierValue?: string | null;
  tenantDefaultStrategy?: SubjectIdentifierStrategy | null;
  destinationOverrideStrategy?: SubjectIdentifierStrategy | null;
  clientOverrideStrategy?: SubjectIdentifierStrategy | null;
}

export type SubjectIdentifierStrategyPlan =
  | {
      status: 'not_required';
      identifierValue: null;
      strategy: null;
      inheritedFrom: null;
      reasonCode: null;
    }
  | {
      status: 'use_existing';
      identifierValue: string;
      inheritedFrom: 'existing';
      reasonCode: null;
    }
  | {
      status: 'issue_with_strategy';
      strategy: SubjectIdentifierStrategy;
      inheritedFrom: 'tenant_default' | 'destination_override' | 'client_override';
      reasonCode: null;
    }
  | {
      status: 'fail_closed';
      strategy: null;
      inheritedFrom: null;
      reasonCode: typeof IDENTITY_IDENTIFIER_REASON_CODES.subjectIdentifierStrategyMissing;
    };

interface BindingHashPayload {
  protocol: string;
  sourceId: string;
  semantic: string;
  components: Record<string, unknown>;
}

const RAW_IDENTIFIER_METADATA_KEYS = new Set([
  'email',
  'eppn',
  'employeeNumber',
  'loginUid',
  'nameId',
  'rawIdentifier',
  'scimUserName',
  'subject',
  'sub',
  'uid',
  'userName',
]);

export async function createSamlIdentityBindingKey(
  input: SamlIdentityBindingKeyInput
): Promise<IdentityBindingKeyResult> {
  validateRequired(input.issuer, 'issuer');
  validateRequired(input.nameId, 'nameId');
  validateRequired(input.nameIdFormat, 'nameIdFormat');

  const semantic = input.semantic ?? 'federated_login_subject';
  const payload: BindingHashPayload = {
    protocol: 'saml',
    sourceId: input.issuer,
    semantic,
    components: {
      issuer: input.issuer,
      nameId: input.nameId,
      nameIdFormat: input.nameIdFormat,
      nameQualifier: input.nameQualifier ?? null,
      spNameQualifier: input.spNameQualifier ?? null,
      destinationScope: input.destinationScope ?? null,
    },
  };

  return {
    protocol: 'saml',
    sourceId: input.issuer,
    providerSubjectKeyHash: await hashStableJson(payload),
    metadata: withoutRawIdentifiers({
      bindingSemantic: semantic,
      issuer: input.issuer,
      nameIdFormat: input.nameIdFormat,
      hasNameQualifier: Boolean(input.nameQualifier),
      hasSpNameQualifier: Boolean(input.spNameQualifier),
      destinationScope: input.destinationScope ?? null,
    }),
  };
}

export async function createOidcIdentityBindingKey(
  input: OidcIdentityBindingKeyInput
): Promise<IdentityBindingKeyResult> {
  validateRequired(input.issuer, 'issuer');
  validateRequired(input.subject, 'subject');

  const semantic = input.semantic ?? 'federated_login_subject';
  const payload: BindingHashPayload = {
    protocol: 'oidc',
    sourceId: input.issuer,
    semantic,
    components: {
      issuer: input.issuer,
      subject: input.subject,
      clientId: input.clientId ?? null,
      sectorIdentifier: input.sectorIdentifier ?? null,
    },
  };

  return {
    protocol: 'oidc',
    sourceId: input.issuer,
    providerSubjectKeyHash: await hashStableJson(payload),
    metadata: withoutRawIdentifiers({
      bindingSemantic: semantic,
      issuer: input.issuer,
      hasClientScope: Boolean(input.clientId),
      hasSectorIdentifier: Boolean(input.sectorIdentifier),
    }),
  };
}

export async function createScimIdentityBindingKey(
  input: ScimIdentityBindingKeyInput
): Promise<IdentityBindingKeyResult> {
  validateRequired(input.sourceId, 'sourceId');
  validateRequired(input.externalSubject, 'externalSubject');

  const semantic = input.semantic ?? 'external_subject';
  const payload: BindingHashPayload = {
    protocol: 'scim',
    sourceId: input.sourceId,
    semantic,
    components: {
      sourceId: input.sourceId,
      externalSubject: input.externalSubject,
      schemaUrn: input.schemaUrn ?? null,
    },
  };

  return {
    protocol: 'scim',
    sourceId: input.sourceId,
    providerSubjectKeyHash: await hashStableJson(payload),
    metadata: withoutRawIdentifiers({
      bindingSemantic: semantic,
      sourceId: input.sourceId,
      schemaUrn: input.schemaUrn ?? null,
    }),
  };
}

export function planSubjectIdentifierStrategy(
  input: SubjectIdentifierStrategyPlanInput
): SubjectIdentifierStrategyPlan {
  if (input.requirement === 'not_required') {
    return {
      status: 'not_required',
      identifierValue: null,
      strategy: null,
      inheritedFrom: null,
      reasonCode: null,
    };
  }

  if (input.existingIdentifierValue) {
    return {
      status: 'use_existing',
      identifierValue: input.existingIdentifierValue,
      inheritedFrom: 'existing',
      reasonCode: null,
    };
  }

  if (input.clientOverrideStrategy) {
    validateSubjectIdentifierStrategy(input.clientOverrideStrategy);
    return {
      status: 'issue_with_strategy',
      strategy: input.clientOverrideStrategy,
      inheritedFrom: 'client_override',
      reasonCode: null,
    };
  }

  if (input.destinationOverrideStrategy) {
    validateSubjectIdentifierStrategy(input.destinationOverrideStrategy);
    return {
      status: 'issue_with_strategy',
      strategy: input.destinationOverrideStrategy,
      inheritedFrom: 'destination_override',
      reasonCode: null,
    };
  }

  if (input.tenantDefaultStrategy) {
    validateSubjectIdentifierStrategy(input.tenantDefaultStrategy);
    return {
      status: 'issue_with_strategy',
      strategy: input.tenantDefaultStrategy,
      inheritedFrom: 'tenant_default',
      reasonCode: null,
    };
  }

  return {
    status: 'fail_closed',
    strategy: null,
    inheritedFrom: null,
    reasonCode: IDENTITY_IDENTIFIER_REASON_CODES.subjectIdentifierStrategyMissing,
  };
}

export function planOidcSubjectIdentifierStrategy(
  input: Omit<SubjectIdentifierStrategyPlanInput, 'destinationProtocol' | 'requirement'>
): SubjectIdentifierStrategyPlan {
  return planSubjectIdentifierStrategy({
    ...input,
    destinationProtocol: 'oidc',
    requirement: 'required',
  });
}

export function planSamlSubjectIdentifierStrategy(
  input: Omit<SubjectIdentifierStrategyPlanInput, 'destinationProtocol'>
): SubjectIdentifierStrategyPlan {
  return planSubjectIdentifierStrategy({
    ...input,
    destinationProtocol: 'saml',
  });
}

export function planScimSubjectIdentifierStrategy(
  input: Omit<SubjectIdentifierStrategyPlanInput, 'destinationProtocol'>
): SubjectIdentifierStrategyPlan {
  return planSubjectIdentifierStrategy({
    ...input,
    destinationProtocol: 'scim',
  });
}

export function validateSubjectIdentifierStrategy(strategy: SubjectIdentifierStrategy): void {
  validateRequired(strategy.kind, 'strategy.kind');
  if (strategy.kind === 'opaque_pairwise' || strategy.kind === 'opaque_public') {
    if (strategy.sourceBindingRef || strategy.sourceSystemRef) {
      throw new Error(
        'opaque subject identifier strategies must not depend on raw source identifiers'
      );
    }
  }

  if (strategy.kind === 'deterministic_hmac') {
    validateRequired(strategy.keyRef, 'strategy.keyRef');
    validateRequired(strategy.sourceBindingRef, 'strategy.sourceBindingRef');
  }

  if (strategy.kind === 'imported_external') {
    validateRequired(strategy.sourceSystemRef, 'strategy.sourceSystemRef');
  }

  assertNoRawIdentifierMetadata(strategy.metadata ?? null, 'strategy.metadata');
}

export function withoutRawIdentifiers(metadata: Record<string, unknown>): Record<string, unknown> {
  assertNoRawIdentifierMetadata(metadata, 'metadata');
  return metadata;
}

function assertNoRawIdentifierMetadata(value: unknown, path: string): void {
  if (value === null || value === undefined) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoRawIdentifierMetadata(item, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (RAW_IDENTIFIER_METADATA_KEYS.has(key)) {
      throw new Error(`${path}.${key} must not contain raw subject identifiers`);
    }
    assertNoRawIdentifierMetadata(item, `${path}.${key}`);
  }
}

function validateRequired(value: string | null | undefined, fieldName: string): void {
  if (!value || value.trim().length === 0) {
    throw new Error(`${fieldName} is required`);
  }
}

async function hashStableJson(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableJson(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortForStableJson(value));
}

function sortForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortForStableJson);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.keys(value)
    .sort()
    .reduce<Record<string, unknown>>((sorted, key) => {
      const item = value[key];
      if (item !== undefined) {
        sorted[key] = sortForStableJson(item);
      }
      return sorted;
    }, {});
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
