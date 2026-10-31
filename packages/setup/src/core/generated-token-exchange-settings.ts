import {
  addFail,
  addPass,
  addWarn,
  finalizeCheck,
  makeSmokeCheck,
  type SmokeCheck,
} from './generated-smoke-common.js';
import {
  patchTenantSettings,
  readTenantSettings,
  restoreTenantSettings,
  tenantSettingsPath,
  type TemporarySettingsChange,
  type TenantSettingsSnapshot,
} from './generated-settings-v2.js';

const ENABLED_KEY = 'tokens.exchange_enabled';
/**
 * The tenant's ceiling on delegation. The generated checks use a delegating service client
 * (delegation_mode delegation), which the tenant's Token Exchange refuses while this is off.
 */
const DELEGATION_KEY = 'tokens.exchange_delegation_enabled';
const SUBJECT_TYPES_KEY = 'tokens.exchange_allowed_subject_token_types';

export interface GeneratedTokenExchangeEnableResult {
  check: SmokeCheck;
  restore: () => Promise<SmokeCheck | null>;
  /**
   * Whether this changed the settings: runtime may then refuse Token Exchange for up to
   * SETTINGS_APPLY_TIMEOUT_MS, so the caller retries the exchange until it is accepted.
   */
  changed: boolean;
}

const TOKEN_TYPE_URN_PREFIX = 'urn:ietf:params:oauth:token-type:';
/** The subject token types a tenant setting can hold. */
const STORABLE_TYPES = new Set(['access_token', 'jwt', 'id_token']);
/**
 * Types that make no difference to the list: runtime always accepts the elevation grant and
 * always refuses refresh tokens.
 */
const IMPLIED_TYPES = new Set([
  'elevation_grant',
  'urn:authrim:token-type:elevation-grant',
  'refresh_token',
  `${TOKEN_TYPE_URN_PREFIX}refresh_token`,
]);

/**
 * The subject token types in effect, as the tenant setting stores them (runtime also takes the
 * URNs, e.g. from the environment). `unstorable` lists the entries runtime accepts that a tenant
 * setting cannot hold.
 */
function subjectTokenTypes(snapshot: TenantSettingsSnapshot): {
  types: string[];
  unstorable: string[];
} {
  const value = snapshot.values[SUBJECT_TYPES_KEY];
  const entries =
    typeof value === 'string'
      ? value
          .split(',')
          .map((type) => type.trim())
          .filter(Boolean)
      : [];
  const types: string[] = [];
  const unstorable: string[] = [];
  for (const entry of entries) {
    if (IMPLIED_TYPES.has(entry)) continue;
    const type = entry.startsWith(TOKEN_TYPE_URN_PREFIX)
      ? entry.slice(TOKEN_TYPE_URN_PREFIX.length)
      : entry;
    if (!STORABLE_TYPES.has(type)) unstorable.push(entry);
    else if (!types.includes(type)) types.push(type);
  }
  return { types, unstorable };
}

/** Whether the settings API would take the stored list as it is (names only, see STORABLE_TYPES). */
function isStorableList(snapshot: TenantSettingsSnapshot): boolean {
  const value = snapshot.values[SUBJECT_TYPES_KEY];
  return (
    typeof value === 'string' &&
    value
      .split(',')
      .map((type) => type.trim())
      .filter(Boolean)
      .every((type) => STORABLE_TYPES.has(type))
  );
}

/**
 * Make sure the tenant accepts access-token Token Exchange for a generated check
 * (`tokens.exchange_enabled`, `tokens.exchange_delegation_enabled`, and `access_token` among the
 * subject token types), and give the
 * way to put the tenant's settings back afterwards.
 */
export async function ensureGeneratedTokenExchangeEnabled(input: {
  baseUrl: string;
  timeoutMs: number;
  adminSecret: string;
  tenantId: string;
  checkId: string;
  title: string;
}): Promise<GeneratedTokenExchangeEnableResult> {
  const target = {
    baseUrl: input.baseUrl,
    adminSecret: input.adminSecret,
    tenantId: input.tenantId,
    category: 'tokens',
    timeoutMs: input.timeoutMs,
  };
  const url = `${input.baseUrl}${tenantSettingsPath(input.tenantId, 'tokens')}`;
  const check = makeSmokeCheck(input.checkId, input.title, url);

  let snapshot: TenantSettingsSnapshot;
  try {
    snapshot = await readTenantSettings(target);
  } catch (error) {
    addFail(check, `GET token settings failed: ${String(error)}`);
    return {
      check: finalizeCheck(check, 'Token Exchange settings read failed'),
      restore: async () => null,
      changed: false,
    };
  }

  const leaveUnchanged = (problem: string): GeneratedTokenExchangeEnableResult => {
    addFail(
      check,
      `${problem}; set ${SUBJECT_TYPES_KEY} for the tenant with access_token, jwt or id_token first`
    );
    return {
      check: finalizeCheck(check, 'Token Exchange settings left unchanged'),
      restore: async () => null,
      changed: false,
    };
  };

  const { types, unstorable } = subjectTokenTypes(snapshot);
  if (
    snapshot.values[ENABLED_KEY] === true &&
    snapshot.values[DELEGATION_KEY] === true &&
    types.includes('access_token')
  ) {
    addPass(check, 'Token Exchange is already enabled for access_token');
    return {
      check: finalizeCheck(check, 'Token Exchange already enabled'),
      restore: async () => null,
      changed: false,
    };
  }

  const set: Record<string, unknown> = {};
  if (snapshot.values[ENABLED_KEY] !== true) set[ENABLED_KEY] = true;
  if (snapshot.values[DELEGATION_KEY] !== true) set[DELEGATION_KEY] = true;
  if (!types.includes('access_token')) {
    // Saving the list without them would stop runtime accepting them while the check runs.
    if (unstorable.length > 0) {
      return leaveUnchanged(
        `${SUBJECT_TYPES_KEY} holds types a tenant setting cannot hold (${unstorable.join(', ')})`
      );
    }
    // The tenant's own list is saved again on restore: it must be one the settings API takes.
    if (snapshot.sources[SUBJECT_TYPES_KEY] === 'kv' && !isStorableList(snapshot)) {
      return leaveUnchanged(
        `the tenant's own ${SUBJECT_TYPES_KEY} could not be put back as it is ` +
          `(${String(snapshot.values[SUBJECT_TYPES_KEY])})`
      );
    }
    set[SUBJECT_TYPES_KEY] = [...types, 'access_token'].join(',');
  }
  const change: TemporarySettingsChange = { before: snapshot, set };
  // Put back whatever of the change was saved: also when the save failed or its answer was lost.
  const restore = async () => {
    const restoreCheck = makeSmokeCheck(`${input.checkId}-restore`, `${input.title} restore`, url);
    try {
      const { restored, left } = await restoreTenantSettings(target, change);
      if (restored.length > 0) addPass(restoreCheck, 'Token Exchange settings restored');
      if (left.length > 0) {
        addWarn(
          restoreCheck,
          `left as they are (changed meanwhile, or never changed): ${left.join(', ')}`
        );
      }
    } catch (error) {
      addWarn(restoreCheck, `Token Exchange settings restore failed: ${String(error)}`);
    }
    return finalizeCheck(restoreCheck, 'Token Exchange settings restore completed');
  };

  try {
    await patchTenantSettings(target, { ifMatch: snapshot.version, set: change.set });
  } catch (error) {
    addFail(check, `PATCH token settings failed: ${String(error)}`);
    return { check: finalizeCheck(check, 'Token Exchange enable failed'), restore, changed: true };
  }

  addPass(check, 'Token Exchange enabled for generated approval test');
  addWarn(
    check,
    'runtime applies the change within about a minute; the exchange is retried until then'
  );

  return { check: finalizeCheck(check, 'Token Exchange enabled'), restore, changed: true };
}
