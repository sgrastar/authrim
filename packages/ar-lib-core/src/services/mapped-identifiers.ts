import {
  findSourceValue,
  persistentIdentifierSettingsProblem,
} from '@authrim/ar-lib-field-mapping/runtime';
import type {
  MappingRuleEdge,
  MappingTransformStep,
  SourceValueEnvelope,
} from '@authrim/ar-lib-field-mapping/contract';
import {
  computeIdentifier,
  IDENTIFIER_ALGORITHMS,
  IdentifierComputationError,
  isSubjectIdentifierValue,
  SHIBBOLETH_DIGESTS,
  SHIBBOLETH_ENCODINGS,
  type IdentifierAlgorithm,
  type ShibbolethDigest,
  type ShibbolethEncoding,
} from './identifier-algorithms';

/**
 * Persistent identifiers a mapping releases (`persistent_identifier` steps), made before the
 * mapping runs: hashing and reading the salt are asynchronous, the mapping is not. Each is keyed
 * by its step's id; the step only takes it (`runtimeContext.identifiers`). A step that cannot be
 * made is left out, which fails the mapping: nothing else goes out in its place. The salt never
 * leaves this module.
 */

/** The tenant's own salt for identifiers Authrim makes (created on first use). */
export const DEFAULT_IDENTIFIER_SALT_REF = 'identifier-salt:default';

export type IdentifierRecipient =
  | {
      protocol: 'oidc';
      clientId: string;
      /** The pairwise sector (OIDC Core §8.1), or null when it cannot be told. */
      sector: string | null;
    }
  | { protocol: 'saml'; spEntityId: string; idpEntityId: string };

export interface PrepareMappedIdentifiersInput {
  transforms?: readonly MappingTransformStep[];
  edges: readonly MappingRuleEdge[];
  sourceValues: readonly SourceValueEnvelope[];
  recipient: IdentifierRecipient;
  /** Reads the tenant's default salt; null when it cannot be had. */
  loadDefaultSalt: () => Promise<string | null>;
  /** For a test user or before consent: what every identifier is instead of being made. */
  placeholder?: string | null;
}

export interface PreparedMappedIdentifiers {
  identifiers: Record<string, string>;
  /** Why a step has no identifier (codes only, never values). */
  failures: Record<string, string>;
}

export function usesMappedIdentifiers(transforms?: readonly MappingTransformStep[]): boolean {
  return (transforms ?? []).some((step) => step.operation === 'persistent_identifier');
}

export async function prepareMappedIdentifiers(
  input: PrepareMappedIdentifiersInput
): Promise<PreparedMappedIdentifiers> {
  const identifiers: Record<string, string> = {};
  const failures: Record<string, string> = {};
  const steps = (input.transforms ?? []).filter(
    (step) => step.operation === 'persistent_identifier'
  );
  if (steps.length === 0) return { identifiers, failures };

  let salt: Promise<string | null> | undefined;
  for (const step of steps) {
    try {
      if (input.placeholder) {
        identifiers[step.id] = input.placeholder;
        continue;
      }
      const settings = readSettings(step);
      const value = readInput(step, input.edges, input.sourceValues);
      salt ??= input.loadDefaultSalt();
      const saltText = await salt;
      if (!saltText) throw new IdentifierComputationError('identifier.salt_missing');
      const target = resolveTarget(settings, input.recipient);
      const opaque = await computeIdentifier({
        algorithm: settings.algorithm,
        value,
        audience: target.audience,
        issuer: target.issuer,
        salt: new TextEncoder().encode(saltText),
        digest: settings.digest,
        encoding: settings.encoding,
        scope: settings.scope,
        sourceMetadataSet: settings.sourceMetadataSet,
        destinationMetadataSet: settings.destinationMetadataSet,
      });
      identifiers[step.id] = frame(settings, opaque, input.recipient);
    } catch (error) {
      failures[step.id] =
        error instanceof IdentifierComputationError ? error.code : 'identifier.unavailable';
    }
  }
  return { identifiers, failures };
}

interface IdentifierSettings {
  format: 'plain' | 'saml_targeted_id' | 'saml_pairwise_id' | 'saml_subject_id';
  algorithm: IdentifierAlgorithm;
  digest?: ShibbolethDigest;
  encoding?: ShibbolethEncoding;
  audience: 'auto' | 'sector' | 'sp_entity_id';
  scope?: string;
  sourceMetadataSet?: string;
  destinationMetadataSet?: string;
}

const FORMATS = ['plain', 'saml_targeted_id', 'saml_pairwise_id', 'saml_subject_id'] as const;
const AUDIENCES = ['auto', 'sector', 'sp_entity_id'] as const;

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** The step's settings, refusing combinations that cannot make a valid identifier. */
function readSettings(step: MappingTransformStep): IdentifierSettings {
  const parameters = step.parameters ?? {};
  // The same check the admin API runs before saving.
  const problem = persistentIdentifierSettingsProblem(parameters);
  if (problem === 'salt') throw new IdentifierComputationError('identifier.salt_missing');
  if (problem === 'scope') {
    throw new IdentifierComputationError(
      parameters.scope === undefined ? 'identifier.scope_missing' : 'identifier.invalid_scope'
    );
  }
  const format = oneOf(parameters.format, FORMATS);
  const algorithm = oneOf(parameters.algorithm, IDENTIFIER_ALGORITHMS);
  if (problem || !format || !algorithm) {
    throw new IdentifierComputationError('identifier.invalid_settings');
  }
  return {
    format,
    algorithm,
    audience: oneOf(parameters.audience, AUDIENCES) ?? 'auto',
    digest: oneOf(parameters.digest, SHIBBOLETH_DIGESTS),
    encoding: oneOf(parameters.encoding, SHIBBOLETH_ENCODINGS),
    scope: optionalText(parameters.scope),
    sourceMetadataSet: optionalText(parameters.sourceMetadataSet),
    destinationMetadataSet: optionalText(parameters.destinationMetadataSet),
  };
}

/** The one value the identifier is made from: a single non-empty text, nothing else. */
function readInput(
  step: MappingTransformStep,
  edges: readonly MappingRuleEdge[],
  sourceValues: readonly SourceValueEnvelope[]
): string {
  if (step.inputEdgeIds.length !== 1) {
    throw new IdentifierComputationError('identifier.input_missing');
  }
  const edge = edges.find((candidate) => candidate.id === step.inputEdgeIds[0]);
  const found = edge ? findSourceValue([...sourceValues], edge) : undefined;
  let value = found?.value;
  if (Array.isArray(value)) {
    if (value.length !== 1) throw new IdentifierComputationError('identifier.input_not_single');
    value = value[0];
  }
  if (typeof value === 'number' && Number.isFinite(value)) value = String(value);
  if (typeof value !== 'string' || value.length === 0) {
    throw new IdentifierComputationError('identifier.input_missing');
  }
  return value;
}

/** Who the identifier is for, and who issues it, as the algorithm reads them. */
function resolveTarget(
  settings: IdentifierSettings,
  recipient: IdentifierRecipient
): { audience: string; issuer?: string } {
  if (recipient.protocol === 'oidc') {
    if (
      settings.format !== 'plain' ||
      settings.audience === 'sp_entity_id' ||
      settings.algorithm.startsWith('simplesamlphp_')
    ) {
      throw new IdentifierComputationError('identifier.invalid_settings');
    }
    if (settings.audience === 'sector') {
      // Never the client ID in its place: that would be a different identifier.
      if (!recipient.sector) throw new IdentifierComputationError('identifier.sector_missing');
      return { audience: recipient.sector };
    }
    return { audience: recipient.clientId };
  }
  if (settings.audience === 'sector') {
    throw new IdentifierComputationError('identifier.invalid_settings');
  }
  return { audience: recipient.spEntityId, issuer: recipient.idpEntityId };
}

/** The identifier as its protocol carries it. */
function frame(
  settings: IdentifierSettings,
  opaque: string,
  recipient: IdentifierRecipient
): string {
  switch (settings.format) {
    case 'plain':
      return opaque;
    case 'saml_targeted_id': {
      if (recipient.protocol !== 'saml') {
        throw new IdentifierComputationError('identifier.invalid_settings');
      }
      // Released as a NameID-valued attribute (assertion.ts reads the three parts).
      return `${recipient.idpEntityId}!${recipient.spEntityId}!${opaque}`;
    }
    case 'saml_pairwise_id':
    case 'saml_subject_id': {
      if (recipient.protocol !== 'saml') {
        throw new IdentifierComputationError('identifier.invalid_settings');
      }
      // SimpleSAMLphp's algorithms already end in "@scope"; the others are scoped here.
      const scoped = opaque.includes('@') ? opaque : `${opaque}@${settings.scope ?? failScope()}`;
      if (!isSubjectIdentifierValue(scoped)) {
        throw new IdentifierComputationError('identifier.invalid_subject_identifier');
      }
      return scoped;
    }
  }
}

function failScope(): never {
  throw new IdentifierComputationError('identifier.scope_missing');
}

/**
 * The pairwise sector of an OIDC client (OIDC Core §8.1): the host of its sector_identifier_uri,
 * else the one host all its redirect URIs share. Null when neither tells one host (several hosts,
 * none, an unparsable URI). Host names are lower case and punycoded; a port is not part of it.
 */
export function resolvePairwiseSector(input: {
  sectorIdentifierUri?: string | null;
  redirectUris?: readonly string[] | null;
}): string | null {
  const hostOf = (uri: string): string | null => {
    try {
      const host = new URL(uri).hostname;
      return host.length > 0 ? host : null;
    } catch {
      return null;
    }
  };
  if (input.sectorIdentifierUri) return hostOf(input.sectorIdentifierUri);
  const hosts = new Set<string>();
  for (const uri of input.redirectUris ?? []) {
    const host = hostOf(uri);
    if (!host) return null;
    hosts.add(host);
  }
  return hosts.size === 1 ? [...hosts][0] : null;
}
