import { validateMappingRuleGraph } from '@authrim/ar-lib-field-mapping/authoring';
import { persistentIdentifierSettingsProblem } from '@authrim/ar-lib-field-mapping/runtime';
import type {
  MappingTransformStep,
  MappingRuleGraph,
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
 *
 * A step takes no input edge. It is made from the authenticated account's ID (the runtime's own
 * account ID: the runtime user ID the Admin API shows as `id`, the same for OIDC and SAML, never
 * read from claims or attributes), or from the value an administrator imported for that account
 * into a dedicated identifier source. The identifiers kept from another IdP are bound to the
 * account too, so one person's identifier is never released for another.
 */

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
  /**
   * The authenticated account's ID, supplied by the runtime. Null: none is known, so no
   * identifier is made (the step fails).
   */
  accountId: string | null;
  recipient: IdentifierRecipient;
  /** Reads the tenant's default salt; null when it cannot be had. */
  loadDefaultSalt: () => Promise<string | null>;
  /**
   * Reads a salt imported from another identity provider, base64 of its bytes; null when there
   * is none by that name (it is never made up).
   */
  loadImportedSalt?: (name: string) => Promise<string | null>;
  /**
   * Looks up an identifier kept from another IdP, by store, audience and the account it was
   * imported for; null when there is none. A failed lookup throws: nothing is made instead.
   */
  lookupStoredIdentifier?: (
    store: string,
    audience: string,
    accountId: string
  ) => Promise<string | null>;
  /**
   * Reads the value an administrator imported for the account into an identifier source; null
   * when there is none. A failed read throws: nothing is made instead.
   */
  lookupSourceValue?: (source: string, accountId: string) => Promise<string | null>;
  /**
   * Reads the exceptions that apply to an account and recipient (a step's `exceptions` list): the
   * salt to use instead, no identifier at all, or nothing (the default). A failed read throws:
   * that is a failure, never a suppression.
   */
  lookupException?: (
    list: string,
    accountId: string,
    audience: string
  ) => Promise<IdentifierException>;
  /** For a test user or before consent: what every identifier is instead of being made. */
  placeholder?: string | null;
}

/** What a list of exceptions says for an account and a recipient. */
export type IdentifierException =
  | { action: 'default' }
  | { action: 'salt'; saltName: string }
  | { action: 'block' };

/** A row of a list of exceptions (mapped_identifier_exceptions). */
export interface IdentifierExceptionRow {
  account_id: string;
  audience: string;
  action: string;
  salt_name: string | null;
}

export const EXCEPTION_ANY = '*';

/**
 * What the rows say for an account and a recipient, as Shibboleth's ComputedPairwiseIdStore
 * reads its exception map: the principal's own entry, else the `*` entry of principals (never
 * both); inside the one chosen, the recipient's own entry, else the `*` entry of recipients; none
 * of the two means the default: the `*` principal's entries are then NOT consulted.
 */
export function resolveIdentifierException(
  rows: readonly IdentifierExceptionRow[],
  accountId: string,
  audience: string
): IdentifierException {
  const own = rows.filter((row) => row.account_id === accountId);
  const chosen = own.length > 0 ? own : rows.filter((row) => row.account_id === EXCEPTION_ANY);
  const entry =
    chosen.find((row) => row.audience === audience) ??
    chosen.find((row) => row.audience === EXCEPTION_ANY);
  if (!entry) return { action: 'default' };
  if (entry.action === 'block') return { action: 'block' };
  if (entry.action === 'salt' && entry.salt_name) {
    return { action: 'salt', saltName: entry.salt_name };
  }
  // A row that says neither is not read as "use the default": the step fails.
  throw new IdentifierComputationError('identifier.exception_invalid');
}

interface ExceptionRowReader {
  query<T>(sql: string, params: unknown[]): Promise<T[]>;
}

/**
 * Reads the rows of a list that can apply: every row of the account and of `*`, whatever the
 * recipient. The account's entries decide whether it has an entry of its own (an entry for another
 * recipient only still makes it the account's: the `*` account is then not consulted), so they are
 * not filtered by recipient.
 */
export function createIdentifierExceptionReader(
  adapter: ExceptionRowReader,
  tenantId: string
): (list: string, accountId: string, audience: string) => Promise<IdentifierException> {
  return async (list, accountId, audience) => {
    const rows = await adapter.query<IdentifierExceptionRow>(
      `SELECT account_id, audience, action, salt_name FROM mapped_identifier_exceptions
        WHERE tenant_id = ? AND list_name = ? AND account_id IN (?, ?)`,
      [tenantId, list, accountId, EXCEPTION_ANY]
    );
    return resolveIdentifierException(rows, accountId, audience);
  };
}

export interface PreparedMappedIdentifiers {
  /** The identifiers made, by step ID. */
  identifiers: Record<string, string>;
  /**
   * The steps an exception suppressed (no identifier is made for this account and recipient),
   * which is neither made nor failed: the target gets no value.
   */
  suppressed: Record<string, true>;
  /** Why a step has no identifier (codes only, never values). */
  failures: Record<string, string>;
  /** The steps whose identifier is one the person already had (from the store). */
  kept: Record<string, true>;
}

/**
 * Whether an identifier failure code is one of the infrastructure (the salt or key could not be
 * read, or the store, source or exception lookup failed) rather than of the configuration or the
 * data: the first may pass on a retry and is never the user's to fix.
 */
export function isInfrastructureIdentifierFailure(code: string): boolean {
  return (
    code === 'identifier.unavailable' ||
    code === 'identifier.salt_missing' ||
    code === 'identifier.stored_unavailable' ||
    code === 'identifier.exceptions_unavailable' ||
    code === 'identifier.source_unavailable'
  );
}

export function usesMappedIdentifiers(transforms?: readonly MappingTransformStep[]): boolean {
  return (transforms ?? []).some((step) => step.operation === 'persistent_identifier');
}

export async function prepareMappedIdentifiers(
  input: PrepareMappedIdentifiersInput
): Promise<PreparedMappedIdentifiers> {
  const identifiers: Record<string, string> = {};
  const suppressed: Record<string, true> = {};
  const failures: Record<string, string> = {};
  const kept: Record<string, true> = {};
  const steps = (input.transforms ?? []).filter(
    (step) => step.operation === 'persistent_identifier'
  );
  if (steps.length === 0) return { identifiers, suppressed, failures, kept };

  let salt: Promise<string | null> | undefined;
  for (const step of steps) {
    try {
      if (input.placeholder) {
        identifiers[step.id] = input.placeholder;
        continue;
      }
      const settings = readSettings(step);
      // No input edge: what the identifier is made from is never read off the mapping's sources.
      if (step.inputEdgeIds.length > 0) {
        throw new IdentifierComputationError('identifier.input_edge_not_allowed');
      }
      const accountId = input.accountId;
      if (!accountId) throw new IdentifierComputationError('identifier.account_missing');
      const target = resolveTarget(settings, input.recipient);
      if (settings.stored !== 'off' && settings.store) {
        let found: string | null;
        try {
          // By the account the identifier was imported for: a failed lookup (or one the store
          // cannot answer) never falls back to making one.
          found = input.lookupStoredIdentifier
            ? await input.lookupStoredIdentifier(settings.store, target.audience, accountId)
            : null;
        } catch {
          throw new IdentifierComputationError('identifier.stored_unavailable');
        }
        if (found) {
          identifiers[step.id] = frame(settings, found, input.recipient);
          kept[step.id] = true;
          continue;
        }
        if (settings.stored === 'require') {
          throw new IdentifierComputationError('identifier.stored_missing');
        }
      }
      // After a kept value (which wins; a block only stops one being made): the exceptions.
      let saltName = settings.salt;
      if (settings.exceptions) {
        if (!input.lookupException) {
          throw new IdentifierComputationError('identifier.exceptions_unavailable');
        }
        let exception: IdentifierException;
        try {
          exception = await input.lookupException(settings.exceptions, accountId, target.audience);
        } catch (error) {
          // A failed read is a failure, never a suppression.
          throw error instanceof IdentifierComputationError
            ? error
            : new IdentifierComputationError('identifier.exceptions_unavailable');
        }
        if (exception.action === 'block') {
          suppressed[step.id] = true;
          continue;
        }
        if (exception.action === 'salt') saltName = exception.saltName;
      }
      const saltBytes = saltName
        ? decodeImportedSalt(await (input.loadImportedSalt?.(saltName) ?? null))
        : await (async () => {
            salt ??= input.loadDefaultSalt();
            const text = await salt;
            return text ? new TextEncoder().encode(text) : null;
          })();
      if (!saltBytes) throw new IdentifierComputationError('identifier.salt_missing');
      const value = await readInput(settings, accountId, input.lookupSourceValue);
      const opaque = await computeIdentifier({
        algorithm: settings.algorithm,
        value,
        audience: target.audience,
        issuer: target.issuer,
        salt: saltBytes,
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
  return { identifiers, suppressed, failures, kept };
}

interface IdentifierSettings {
  format: 'plain' | 'saml_targeted_id' | 'saml_pairwise_id' | 'saml_subject_id';
  algorithm: IdentifierAlgorithm;
  digest?: ShibbolethDigest;
  encoding?: ShibbolethEncoding;
  input: 'account' | 'source';
  /** The identifier source's name, when `input` is `source`. */
  source?: string;
  audience: 'auto' | 'sector' | 'sp_entity_id';
  scope?: string;
  /** An imported salt's name; the tenant's own salt when absent. */
  salt?: string;
  /** The list of exceptions (per account and recipient) the step reads, if any. */
  exceptions?: string;
  stored: 'off' | 'prefer' | 'require';
  store?: string;
  sourceMetadataSet?: string;
  destinationMetadataSet?: string;
}

const FORMATS = ['plain', 'saml_targeted_id', 'saml_pairwise_id', 'saml_subject_id'] as const;
const AUDIENCES = ['auto', 'sector', 'sp_entity_id'] as const;
const STORED = ['off', 'prefer', 'require'] as const;
const INPUTS = ['account', 'source'] as const;

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
  if (
    problem === 'salt' ||
    problem === 'store' ||
    problem === 'input' ||
    problem === 'source' ||
    problem === 'exceptions'
  ) {
    throw new IdentifierComputationError('identifier.invalid_settings');
  }
  if (problem === 'scope') {
    throw new IdentifierComputationError(
      parameters.scope === undefined ? 'identifier.scope_missing' : 'identifier.invalid_scope'
    );
  }
  const format = oneOf(parameters.format, FORMATS);
  const algorithm = oneOf(parameters.algorithm, IDENTIFIER_ALGORITHMS);
  const inputKind = oneOf(parameters.input, INPUTS);
  if (problem || !format || !algorithm || !inputKind) {
    throw new IdentifierComputationError('identifier.invalid_settings');
  }
  return {
    format,
    algorithm,
    input: inputKind,
    source: optionalText(parameters.source),
    audience: oneOf(parameters.audience, AUDIENCES) ?? 'auto',
    digest: oneOf(parameters.digest, SHIBBOLETH_DIGESTS),
    encoding: oneOf(parameters.encoding, SHIBBOLETH_ENCODINGS),
    scope: optionalText(parameters.scope),
    salt: optionalText(parameters.salt),
    exceptions: optionalText(parameters.exceptions),
    stored: oneOf(parameters.stored, STORED) ?? 'off',
    store: optionalText(parameters.store),
    sourceMetadataSet: optionalText(parameters.sourceMetadataSet),
    destinationMetadataSet: optionalText(parameters.destinationMetadataSet),
  };
}

/**
 * The one value the identifier is made from: the account's ID, or the value imported for the
 * account into the step's identifier source. A source with no value for the account fails the
 * step (the account ID is not made to stand in for it).
 */
async function readInput(
  settings: IdentifierSettings,
  accountId: string,
  lookupSourceValue: PrepareMappedIdentifiersInput['lookupSourceValue']
): Promise<string> {
  if (settings.input === 'account') return accountId;
  if (!settings.source || !lookupSourceValue) {
    throw new IdentifierComputationError('identifier.source_unavailable');
  }
  let value: string | null;
  try {
    value = await lookupSourceValue(settings.source, accountId);
  } catch {
    throw new IdentifierComputationError('identifier.source_unavailable');
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new IdentifierComputationError('identifier.source_missing');
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

interface IdentifierRowReader {
  queryOne<T>(sql: string, params: unknown[]): Promise<T | null>;
}

/**
 * Looks identifiers up in the tenant's admin database (mapped_identifier_values), by the account
 * they were imported for.
 */
export function createStoredIdentifierLookup(
  adapter: IdentifierRowReader,
  tenantId: string
): (store: string, audience: string, accountId: string) => Promise<string | null> {
  return async (store, audience, accountId) => {
    const row = await adapter.queryOne<{ identifier: string }>(
      `SELECT identifier FROM mapped_identifier_values
        WHERE tenant_id = ? AND store_name = ? AND audience = ? AND account_id = ?`,
      [tenantId, store, audience, accountId]
    );
    return row?.identifier ?? null;
  };
}

/**
 * Reads the value an administrator imported for an account into an identifier source
 * (identifier_source_values): the one reader the runtime uses, by tenant, source and account.
 */
export function createIdentifierSourceReader(
  adapter: IdentifierRowReader,
  tenantId: string
): (source: string, accountId: string) => Promise<string | null> {
  return async (source, accountId) => {
    const row = await adapter.queryOne<{ value: string }>(
      `SELECT value FROM identifier_source_values
        WHERE tenant_id = ? AND source_name = ? AND account_id = ?`,
      [tenantId, source, accountId]
    );
    return row?.value ?? null;
  };
}

/** An imported salt's bytes (it is kept base64-encoded); null when missing or not base64. */
function decodeImportedSalt(value: string | null): Uint8Array | null {
  if (!value) return null;
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.length > 0 ? bytes : null;
  } catch {
    return null;
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

/**
 * Why a pairwise client's built-in subject could not be made (no account, no sector, no salt).
 * Never an OIDC mapping error: the request fails as a server error, and the user's own ID is
 * never released in its place.
 */
export class PairwiseSubjectUnavailableError extends Error {
  constructor(public readonly code: string) {
    super(`pairwise_subject_unavailable:${code}`);
    this.name = 'PairwiseSubjectUnavailableError';
  }
}

/**
 * The step a `persistent_identifier` of the built-in pairwise subject is made with: the same
 * `authrim_sha256` over the sector and the account's ID with the tenant's default salt that a
 * step with these settings makes, so the two values are one.
 */
const BUILT_IN_PAIRWISE_STEP: MappingTransformStep = {
  id: 'builtin-pairwise-sub',
  inputEdgeIds: [],
  operation: 'persistent_identifier',
  parameters: {
    format: 'plain',
    algorithm: 'authrim_sha256',
    input: 'account',
    audience: 'sector',
  },
  outputTargetRef: { side: 'destination', namespace: 'oidc.claim', path: 'sub' },
};

/**
 * The subject of a `subject_type=pairwise` client (OIDC Core §8.1) when no mapping step issues
 * one: made by the persistent identifier implementation (`authrim_sha256`, audience the sector,
 * account input, the tenant's default salt). Throws PairwiseSubjectUnavailableError when it cannot
 * be made.
 */
export async function computeBuiltInPairwiseSubject(input: {
  accountId: string | null;
  clientId: string;
  sector: string | null;
  loadDefaultSalt: () => Promise<string | null>;
}): Promise<string> {
  const made = await prepareMappedIdentifiers({
    transforms: [BUILT_IN_PAIRWISE_STEP],
    accountId: input.accountId,
    recipient: { protocol: 'oidc', clientId: input.clientId, sector: input.sector },
    loadDefaultSalt: input.loadDefaultSalt,
  });
  const value = made.identifiers[BUILT_IN_PAIRWISE_STEP.id];
  if (!value) {
    throw new PairwiseSubjectUnavailableError(
      made.failures[BUILT_IN_PAIRWISE_STEP.id] ?? 'identifier.unavailable'
    );
  }
  return value;
}

/**
 * Whether the mapping's own value of `sub` stands for a pairwise client: exactly one
 * `persistent_identifier` step writes `sub`, its audience is the sector, and its value is the
 * final value of `sub` after the whole mapping. Anything else is replaced by the built-in value.
 */
export function mappedPairwiseSubject(input: {
  graphRules?: readonly MappingRuleGraph[];
  transforms?: readonly MappingTransformStep[];
  identifiers: Record<string, string>;
  destinationNamespace: string;
  finalSubject: unknown;
}): string | null {
  const rules = input.graphRules?.filter(
    (rule) =>
      rule.targetRef.side === 'destination' &&
      rule.targetRef.namespace === input.destinationNamespace &&
      rule.targetRef.path === 'sub'
  );
  if (rules?.length) {
    if (rules.length !== 1) return null;
    const [rule] = rules;
    if (validateMappingRuleGraph({ ...rule, pairwiseSubject: true }).length) return null;
    if (!('stepIndex' in rule.output)) return null;
    const step = rule.transforms[rule.output.stepIndex];
    if (
      !step ||
      step.operation !== 'persistent_identifier' ||
      step.parameters?.audience !== 'sector'
    )
      return null;
    const made = input.identifiers[step.id];
    return made && input.finalSubject === made ? made : null;
  }
  const writers = (input.transforms ?? []).filter(
    (step) =>
      step.outputTargetRef.side === 'destination' &&
      step.outputTargetRef.namespace === input.destinationNamespace &&
      step.outputTargetRef.path === 'sub'
  );
  if (writers.length !== 1) return null;
  const [step] = writers;
  if (step.operation !== 'persistent_identifier') return null;
  if (step.parameters?.audience !== 'sector') return null;
  const made = input.identifiers[step.id];
  return made && input.finalSubject === made ? made : null;
}
