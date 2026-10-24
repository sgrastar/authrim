/**
 * Which Mapping Set an OIDC app is bound to: the app's own choice, else the tenant's default, else
 * the platform's default, else none. Only an unset level falls to the next; a level that is set
 * and cannot be used fails the selection (it never becomes another level's answer).
 *
 * The selection is decided by the app's row and the settings in effect alone. It reads no
 * database, so it gives the same answer in every Worker whether or not DB_ADMIN is bound. Reading
 * the chosen set is `resolveOidcIdentityMappingBinding` (identity-mapping-resolution.ts).
 *
 * The release of claims (ID token, UserInfo, the subject of an authorization request) and the
 * consent screen go through this selection (see `applyOIDCIdentityMapping`), and so does the admin
 * API that shows what applies to an app.
 */
import type { OIDCIdentityMappingFieldMappingSelector } from '../types/oidc';
import {
  IDENTITY_MAPPING_SET_ID_MAX_LENGTH,
  IDENTITY_MAPPING_NONE,
} from '../types/settings/identity-mapping';
import type { SettingSource } from '../utils/settings-manager';
import {
  resolveEffectiveSettingsWithSources,
  resolvePlatformSettingsWithSources,
  type EffectiveSettingsEnv,
} from './effective-settings';
import {
  identityMappingResolutionReasonCode,
  type IdentityMappingTier,
} from './identity-mapping-set-binding';
import { readOidcDefaultSetSelection } from './identity-mapping-set-reference';

const DEFAULT_SET_KEY = 'identity_mapping.oidc_default_set_id';

// ---------------------------------------------------------------------------------------------
// The app's own choice
// ---------------------------------------------------------------------------------------------

/** What an app's `identity_mapping` says. */
export type ClientIdentityMappingChoice =
  /** The app names nothing: the tenant's default (or the platform's) decides. */
  | { kind: 'unset' }
  /** `{ "mode": "none" }`: the app takes no mapping, whatever the defaults say. */
  | { kind: 'none' }
  | {
      kind: 'set';
      setId: string;
      /** The app's selector as stored (the pinned version, namespace and profiles it names). */
      selector: OIDCIdentityMappingFieldMappingSelector;
    }
  /**
   * A value that is neither (a set ID that is not a string or is empty, an unknown mode, both a mode
   * and a set, JSON that does not parse). `legacy_profile_only_selector`: an object that names a
   * Destination Profile (`destinationProfileId`) and no Mapping Set and no opt-out, as older apps
   * were saved. That profile once held the app's claims and its consent screen; it binds nothing
   * now, so the selector fails instead of being read as "unset", which would drop that gate in
   * silence.
   */
  | { kind: 'invalid'; reason?: 'legacy_profile_only_selector' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUsableSetId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value === value.trim() &&
    value.length <= IDENTITY_MAPPING_SET_ID_MAX_LENGTH
  );
}

/**
 * Reads an app's `identity_mapping` (the stored JSON text or the parsed object). `fieldMappingSetId`
 * (or its older spelling `policySetId`, which the admin API folds into it on save and the usage
 * and backup checks still read) names a set; `{ mode: 'none' }` is the explicit opt-out; nothing
 * (null, undefined, empty, an object with neither) is unset.
 *
 * This only reads the value; the admin API checks what is saved.
 */
export function readClientIdentityMappingChoice(raw: unknown): ClientIdentityMappingChoice {
  let value = raw;
  if (typeof value === 'string') {
    if (value.trim() === '') return { kind: 'unset' };
    try {
      value = JSON.parse(value);
    } catch {
      return { kind: 'invalid' };
    }
  }
  if (value === undefined || value === null) return { kind: 'unset' };
  if (!isRecord(value)) return { kind: 'invalid' };

  const named =
    value.fieldMappingSetId !== undefined && value.fieldMappingSetId !== null
      ? value.fieldMappingSetId
      : value.policySetId;
  const hasName = named !== undefined && named !== null;
  const hasMode = value.mode !== undefined && value.mode !== null;

  if (hasMode) {
    // `none` is the only mode, and it is the whole answer: a mode beside a set would be two.
    if (value.mode !== IDENTITY_MAPPING_NONE || hasName) return { kind: 'invalid' };
    return { kind: 'none' };
  }
  if (!hasName) {
    const namesProfile = [value.destinationProfileId, value.destination_profile_id].some(
      (profile) => profile !== undefined && profile !== null
    );
    return namesProfile
      ? { kind: 'invalid', reason: 'legacy_profile_only_selector' }
      : { kind: 'unset' };
  }
  if (!isUsableSetId(named)) return { kind: 'invalid' };

  const selector: OIDCIdentityMappingFieldMappingSelector = { fieldMappingSetId: named };
  for (const key of [
    'fieldMappingVersionId',
    'destinationNamespace',
    'sourceProfileId',
    'destinationProfileId',
  ] as const) {
    const field = value[key];
    if (typeof field === 'string' && field.length > 0) selector[key] = field;
  }
  return { kind: 'set', setId: named, selector };
}

// ---------------------------------------------------------------------------------------------
// The selection
// ---------------------------------------------------------------------------------------------

/**
 * What one level of the order says. `not_consulted`: the selection was decided above it and the
 * caller did not ask to see the rest.
 */
export type IdentityMappingChainState = 'unset' | 'set' | 'none' | 'invalid' | 'not_consulted';

export interface IdentityMappingChainEntry {
  tier: IdentityMappingTier;
  state: IdentityMappingChainState;
  /** The set this level names, when `state` is `set`. */
  setId?: string;
  /**
   * Where the value came from, for the two default levels (`kv`: saved at the tenant itself;
   * `platform`: inherited). Absent for the app, and where nothing is set.
   */
  source?: SettingSource;
}

/** Every level of the order, the app's first, in the state the selection found it. */
export type IdentityMappingChain = [
  IdentityMappingChainEntry,
  IdentityMappingChainEntry,
  IdentityMappingChainEntry,
];

export type IdentityMappingNoneReason = 'client_opt_out' | 'tenant_opt_out' | 'no_default';

export type IdentityMappingSelection =
  | {
      kind: 'bound';
      tier: IdentityMappingTier;
      setId: string;
      /** The app's own selector, for the app level. */
      selector?: OIDCIdentityMappingFieldMappingSelector;
      chain: IdentityMappingChain;
    }
  | { kind: 'none'; reason: IdentityMappingNoneReason; chain: IdentityMappingChain };

export type IdentityMappingSelectionErrorCode =
  /** A default that is set, but is not a usable value (see `readOidcDefaultSetSelection`). */
  | 'default_setting_invalid'
  /** The app's `identity_mapping` is set to something that is not a choice. */
  | 'client_selector_invalid'
  /** The settings could not be read. The levels they decide are not taken to be unset. */
  | 'settings_unreadable';

/**
 * The selection could not be made. The message and fields name the level, never a value, a row or
 * another tenant's ID.
 */
export class IdentityMappingSelectionError extends Error {
  constructor(
    readonly code: IdentityMappingSelectionErrorCode,
    /** The level that failed (none for unreadable settings: they decide two levels). */
    readonly tier: IdentityMappingTier | undefined,
    /** What the levels said when the selection failed (`not_consulted` for those not reached). */
    readonly chain: IdentityMappingChain | undefined,
    /** One of a fixed set of codes for what failed underneath (see identityMappingResolutionReasonCode). */
    readonly reasonCode?: string
  ) {
    super(`Identity mapping selection failed (${code})${tier ? ` at ${tier}` : ''}`);
    this.name = 'IdentityMappingSelectionError';
  }
}

export interface SelectIdentityMappingInput {
  /** What the settings are read through (SETTINGS, and the variables a setting can come from). */
  env: EffectiveSettingsEnv;
  tenantId: string;
  protocol: 'oidc';
  /**
   * The app's `identity_mapping`: the stored JSON text or the parsed object. Undefined and null
   * are unset.
   */
  clientSelector: unknown;
  /**
   * Also read the defaults when the app decides, so the chain shows every level (the admin view).
   * Off at runtime: an app that names its set or opts out needs no settings.
   */
  inspectDefaults?: boolean;
  /** Read the settings documents past the cache, for a view that must show a value just saved. */
  fresh?: boolean;
}

const NOT_CONSULTED = (tier: IdentityMappingTier): IdentityMappingChainEntry => ({
  tier,
  state: 'not_consulted',
});

function clientEntry(choice: ClientIdentityMappingChoice): IdentityMappingChainEntry {
  return choice.kind === 'set'
    ? { tier: 'client', state: 'set', setId: choice.setId }
    : { tier: 'client', state: choice.kind };
}

/** A default level's entry from the value read for it. The platform has no `none` to give. */
function defaultEntry(
  tier: 'tenant_default' | 'platform_default',
  value: unknown,
  source: SettingSource
): IdentityMappingChainEntry {
  const read = readOidcDefaultSetSelection(value);
  if (read.kind === 'unset') return { tier, state: 'unset' };
  if (read.kind === 'set') return { tier, state: 'set', setId: read.setId, source };
  if (read.kind === 'none' && tier === 'tenant_default') return { tier, state: 'none', source };
  return { tier, state: 'invalid', source };
}

/**
 * The platform level of the order, as the selection reads it for a tenant that sets nothing: one
 * read of the platform's settings, for a view of every tenant that shows the platform's default
 * once. Throws when the settings cannot be read.
 */
export async function readPlatformIdentityMappingDefault(
  env: EffectiveSettingsEnv,
  options: { fresh?: boolean } = {}
): Promise<IdentityMappingChainEntry> {
  return readPlatformEntry(env, options.fresh);
}

async function readPlatformEntry(
  env: EffectiveSettingsEnv,
  fresh: boolean | undefined
): Promise<IdentityMappingChainEntry> {
  const { values, sources } = await resolvePlatformSettingsWithSources(env, 'identity-mapping', {
    fresh,
  });
  // Read at the platform's own scope, so a saved value reports `kv`: it is the platform's.
  const source = sources[DEFAULT_SET_KEY];
  return defaultEntry(
    'platform_default',
    values[DEFAULT_SET_KEY],
    source === 'kv' ? 'platform' : source
  );
}

/**
 * Selects the Mapping Set for an OIDC app. Throws `IdentityMappingSelectionError` when a level that
 * is set cannot be used, or when the settings cannot be read.
 */
export async function selectIdentityMapping(
  input: SelectIdentityMappingInput
): Promise<IdentityMappingSelection> {
  const choice = readClientIdentityMappingChoice(input.clientSelector);
  const client = clientEntry(choice);

  if (choice.kind === 'invalid') {
    throw new IdentityMappingSelectionError(
      'client_selector_invalid',
      'client',
      [client, NOT_CONSULTED('tenant_default'), NOT_CONSULTED('platform_default')],
      choice.reason
    );
  }

  const decidedByClient = choice.kind === 'set' || choice.kind === 'none';
  if (decidedByClient && !input.inspectDefaults) {
    const chain: IdentityMappingChain = [
      client,
      NOT_CONSULTED('tenant_default'),
      NOT_CONSULTED('platform_default'),
    ];
    return choice.kind === 'set'
      ? { kind: 'bound', tier: 'client', setId: choice.setId, selector: choice.selector, chain }
      : { kind: 'none', reason: 'client_opt_out', chain };
  }

  // The defaults: the tenant's value, else the platform's (inherited), as the settings show it.
  let tenant: IdentityMappingChainEntry;
  let platform: IdentityMappingChainEntry;
  try {
    const { values, sources } = await resolveEffectiveSettingsWithSources(
      input.env,
      'identity-mapping',
      { tenantId: input.tenantId, fresh: input.fresh }
    );
    const value = values[DEFAULT_SET_KEY];
    const source = sources[DEFAULT_SET_KEY];
    // `kv`: saved at the tenant itself. Anything else is the platform's value (or the code default,
    // which is unset): inherited.
    const savedAtTenant = source === 'kv' || source === 'tenant';
    if (savedAtTenant) {
      tenant = defaultEntry('tenant_default', value, source);
      // A tenant document that holds an unset value does not hide the platform's.
      platform =
        tenant.state === 'unset' || input.inspectDefaults
          ? await readPlatformEntry(input.env, input.fresh)
          : NOT_CONSULTED('platform_default');
    } else {
      tenant = { tier: 'tenant_default', state: 'unset' };
      platform = defaultEntry('platform_default', value, source);
    }
  } catch (error) {
    if (decidedByClient) {
      // Only the display wanted the defaults: the app's own answer stands.
      tenant = NOT_CONSULTED('tenant_default');
      platform = NOT_CONSULTED('platform_default');
    } else {
      throw new IdentityMappingSelectionError(
        'settings_unreadable',
        undefined,
        undefined,
        identityMappingResolutionReasonCode(error)
      );
    }
  }

  const chain: IdentityMappingChain = [client, tenant, platform];
  if (choice.kind === 'set') {
    return { kind: 'bound', tier: 'client', setId: choice.setId, selector: choice.selector, chain };
  }
  if (choice.kind === 'none') return { kind: 'none', reason: 'client_opt_out', chain };

  for (const entry of [tenant, platform]) {
    if (entry.state === 'invalid') {
      throw new IdentityMappingSelectionError('default_setting_invalid', entry.tier, chain);
    }
    if (entry.state === 'none') return { kind: 'none', reason: 'tenant_opt_out', chain };
    if (entry.state === 'set' && entry.setId) {
      return { kind: 'bound', tier: entry.tier, setId: entry.setId, chain };
    }
  }
  return { kind: 'none', reason: 'no_default', chain };
}
