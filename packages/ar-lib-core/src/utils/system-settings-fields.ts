/**
 * Where each Settings API setting lived in the older `system_settings` document, and how runtime
 * read it there.
 *
 * The older settings endpoints wrote one platform-wide `system_settings` document (and each
 * tenant's certification profile, an overlay of whole sections). This table lets the one-time
 * import read those values as runtime read them, and lets `resolveProtocolSettings` hand the
 * values saved in the Settings API to the protocol code in the document's shape.
 */

import type { CategoryName } from '../types/settings/catalog';
import { DISABLED_MARKER } from './settings-manager';

/**
 * In the values read from the older stores: the setting is left out of a document that decided it
 * (a section a tenant's certification profile replaced), so only env and the default applied. The
 * import writes the value in effect for it instead.
 */
export const LEGACY_UNSET = '__LEGACY_UNSET__';

/** Where each Settings API setting lives in the `system_settings` document. */
export interface SystemSettingsField {
  category: CategoryName;
  key: string;
  path: readonly string[];
  /**
   * Other places runtime read the value from, before `path`: the first that holds a value it
   * would take wins.
   */
  legacyPaths?: readonly (readonly string[])[];
  /** Convert the Settings API value to the document's form. */
  toDocument?: (value: unknown) => unknown;
  /** Convert the document's value to the Settings API form (for showing it as a fallback). */
  fromDocument?: (value: unknown) => unknown;
  /**
   * What runtime uses when the document has the field's section but not the field itself, so
   * the fallback shown matches what applies.
   */
  sectionDefault?: unknown;
  /**
   * What runtime uses when the document's section is null (reading the field from it failed),
   * where that differs from sectionDefault.
   */
  sectionNull?: unknown;
}

const STORED_LEGACY_VALUE = Symbol.for('authrim.storedLegacySettingValue');

/**
 * A value of the older document that no Settings API value carries as runtime read it (a string
 * where runtime computed with a number, a value that spells a Settings API marker, ...). It is
 * never converted: the import reports it as rejected (the import then needs attention) instead
 * of saving something that reads differently. Shown as the stored value.
 */
export class StoredLegacyValue {
  readonly [STORED_LEGACY_VALUE] = true;
  constructor(readonly value: unknown) {}
  toJSON(): unknown {
    return this.value;
  }
}

export function isStoredLegacyValue(value: unknown): value is StoredLegacyValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<symbol, unknown>)[STORED_LEGACY_VALUE] === true
  );
}

function asStored(value: unknown): StoredLegacyValue {
  return new StoredLegacyValue(value);
}

/** A domain entry a request's host (lowercase, never with a comma) can match. */
function isMatchableDomain(entry: unknown): entry is string {
  return (
    typeof entry === 'string' &&
    entry !== '' &&
    entry === entry.trim().toLowerCase() &&
    !entry.includes(',')
  );
}

/**
 * The HTTPS request_uri domains: set as a comma-separated string, matched lowercase against the
 * request's host (or as its parent domain), and only as a list (anything else left env to decide).
 * A stored list keeps only the entries a host can match: the others (such as 'Trusted.example',
 * 'a.example,b.example', or '', which matched every host ending in a dot) are left out, so it
 * allows no more than it did. A list with none left refuses every host: ','.
 */
const domainList = {
  // As authorization splits HTTPS_REQUEST_URI_ALLOWED_DOMAINS: only an empty string is no list,
  // and an empty entry stays (authorization matches no host with it, so ',' refuses every host).
  toDocument: (value: unknown) =>
    typeof value === 'string'
      ? value === ''
        ? []
        : value.split(',').map((entry) => entry.trim().toLowerCase())
      : value,
  fromDocument: (value: unknown) => {
    if (!Array.isArray(value)) return undefined;
    if (value.length === 0) return '';
    const matchable = value.filter(isMatchableDomain);
    return matchable.length > 0 ? matchable.join(',') : ',';
  },
};

/** A list of strings as runtime reads it, shown and set as a comma-separated string. */
const stringList = {
  toDocument: (value: unknown) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean)
      : value,
  fromDocument: (value: unknown) =>
    Array.isArray(value) ? value.filter((entry) => typeof entry === 'string').join(',') : undefined,
};

/**
 * Token Exchange subject token types, as runtime matched each entry of the older list exactly
 * (a short name, or its URN). Entries it never matched (unknown, padded, or several in one) are
 * left out, so they do not become allowed types.
 */
const SUBJECT_TOKEN_TYPES: Record<string, string> = {
  access_token: 'access_token',
  jwt: 'jwt',
  id_token: 'id_token',
  'urn:ietf:params:oauth:token-type:access_token': 'access_token',
  'urn:ietf:params:oauth:token-type:jwt': 'jwt',
  'urn:ietf:params:oauth:token-type:id_token': 'id_token',
};
const subjectTokenTypes = {
  toDocument: stringList.toDocument,
  fromDocument: (value: unknown) =>
    Array.isArray(value)
      ? [
          ...new Set(
            value
              .map((entry) => (typeof entry === 'string' ? SUBJECT_TOKEN_TYPES[entry] : undefined))
              .filter((entry): entry is string => entry !== undefined)
          ),
        ].join(',')
      : undefined,
};

/** A boolean runtime read as `=== true` whenever the field was there. */
const trueOnly = {
  fromDocument: (value: unknown) => value === true,
};

/** A positive number of seconds (else runtime's env or default applies). */
const positiveNumber = {
  fromDocument: (value: unknown) => (typeof value === 'number' && value > 0 ? value : undefined),
};

/**
 * A parameter limit runtime took within 1..100 (else its own default). Runtime compared counts
 * with it (`count > limit`), so a fraction limits as its whole part does.
 */
const paramLimit = {
  fromDocument: (value: unknown) =>
    typeof value === 'number' && value >= 1 && value <= 100 ? Math.floor(value) : undefined,
};

/** A boolean runtime takes only when it is one. */
const booleanOnly = {
  fromDocument: (value: unknown) => (typeof value === 'boolean' ? value : undefined),
};

/** A flag runtime tested for truth whenever the field was there (null included). */
const truthy = {
  fromDocument: (value: unknown) => Boolean(value),
};

/** A flag runtime read as `value ?? env` and then tested for truth: null left it to env. */
const truthyUnlessNull = {
  fromDocument: (value: unknown) => (value === null ? undefined : Boolean(value)),
};

/** Algorithms a request object may be signed with under message signing (never none). */
export const REQUEST_OBJECT_SIGNING_ALGORITHMS: readonly string[] = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
];
/** Algorithms authorization responses can be signed with. */
export const AUTHORIZATION_SIGNING_ALGORITHMS: readonly string[] = ['RS256', 'ES256', 'PS256'];

/**
 * A list of algorithms runtime matched entry by entry (`list.includes(alg)`), shown and set as a
 * comma-separated string of algorithms it can use. Entries it never matched or cannot sign or
 * verify with are left out, so the list allows no more than it did. One with none left refused
 * every algorithm, which no Settings API value does: kept as stored (the import rejects it).
 */
function algorithmList(supported: readonly string[]) {
  return {
    toDocument: stringList.toDocument,
    fromDocument: (value: unknown) => {
      if (value === null) return undefined;
      if (!Array.isArray(value)) return asStored(value);
      const usable = [
        ...new Set(
          value.filter(
            (entry): entry is string => typeof entry === 'string' && supported.includes(entry)
          )
        ),
      ];
      return usable.length > 0 ? usable.join(',') : asStored(value);
    },
  };
}

/**
 * A list runtime used as stored (discovery published it), shown and set as a comma-separated
 * string. Anything that string cannot carry exactly (a list that is empty or has entries such as
 * 'a,b' or ' a ', or a value that is not a list) is kept as stored.
 */
const exactList = {
  toDocument: stringList.toDocument,
  fromDocument: (value: unknown) => {
    if (value === null) return undefined;
    if (
      Array.isArray(value) &&
      value.length > 0 &&
      value.every(
        (entry) =>
          typeof entry === 'string' &&
          entry !== '' &&
          entry === entry.trim() &&
          !entry.includes(',')
      )
    ) {
      return value.join(',');
    }
    return asStored(value);
  },
};

/**
 * A number runtime used as stored (`value ?? default`) in arithmetic and comparisons, which read
 * a numeric string as its number: such a string is that number. Anything else but null is kept
 * as stored, so runtime treats it as before.
 */
const coercedNumber = {
  fromDocument: (value: unknown) => {
    if (value === null) return undefined;
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      return Number(value);
    }
    return asStored(value);
  },
};

/**
 * A request_uri lifetime runtime took whenever it was truthy (`if (value)`), negative or a string
 * included, and then computed with: a falsy value is unset, a numeric string the number it was
 * computed as (but one that reads as 0, which would read as unset), and anything else kept as
 * stored.
 */
function truthyLifetime(value: unknown): unknown {
  if (!value) return undefined;
  const seconds = coercedNumber.fromDocument(value);
  // A string that reads as 0 was still taken (it is truthy): kept as stored, since 0 is unset.
  return seconds === 0 ? asStored(value) : seconds;
}

/**
 * A boolean or number runtime passed on as stored (`value ?? default`). Anything else is kept as
 * stored, not converted: a clock skew string without a unit failed every verification, and JARM
 * took a message signing flag such as "true" for truth while PAR took only true.
 */
const storedValue = {
  fromDocument: (value: unknown) =>
    value === null
      ? undefined
      : typeof value === 'boolean' || typeof value === 'number'
        ? value
        : asStored(value),
};

export const SYSTEM_SETTINGS_FIELDS: readonly SystemSettingsField[] = [
  { category: 'security', key: 'security.fapi_enabled', path: ['fapi', 'enabled'] },
  { category: 'security', key: 'security.fapi_strict_dpop', path: ['fapi', 'strictDPoP'] },
  {
    category: 'security',
    key: 'security.fapi_allow_public_clients',
    path: ['fapi', 'allowPublicClients'],
  },
  {
    category: 'security',
    key: 'security.require_signed_request_object',
    path: ['fapi', 'messageSigning', 'requireSignedRequestObject'],
  },
  {
    // Runtime required DPoP when this was true, never in FAPI mode when it was false, and in FAPI
    // mode otherwise.
    category: 'security',
    key: 'security.dpop_required',
    path: ['fapi', 'requireDpop'],
    toDocument: (value: unknown) =>
      value === 'always' ? true : value === 'never' ? false : undefined,
    fromDocument: (value: unknown) => (value ? 'always' : value === false ? 'never' : undefined),
  },
  {
    // Required unless it was false.
    category: 'security',
    key: 'security.fapi_require_private_key_jwt',
    path: ['fapi', 'requirePrivateKeyJwt'],
    fromDocument: (value: unknown) => value !== false,
  },
  {
    category: 'security',
    key: 'security.fapi_client_assertion_audience',
    path: ['fapi', 'clientAssertionAudience'],
    fromDocument: (value: unknown) => (value === 'issuer' ? 'issuer' : 'endpoint_or_issuer'),
  },
  {
    // Applied in FAPI mode as min(value, 60) whenever it was truthy (Math.min read a numeric
    // string as its number).
    category: 'oauth',
    key: 'oauth.par_fapi_ttl',
    path: ['fapi', 'maxRequestUriExpiry'],
    fromDocument: (value: unknown) => {
      const seconds = truthyLifetime(value);
      return typeof seconds === 'number' ? Math.min(seconds, 60) : seconds;
    },
  },
  {
    category: 'security',
    key: 'security.fapi_message_signing_enabled',
    path: ['fapi', 'messageSigning', 'enabled'],
    // PAR, registration and discovery took it as `=== true`, while JARM responses took it for
    // truth (applying the default algorithm and the allowed list): a value that is not a boolean
    // is passed on as stored, so each keeps doing what it did (the import reports it as rejected).
    ...storedValue,
  },
  {
    category: 'security',
    key: 'security.require_jarm',
    path: ['fapi', 'messageSigning', 'requireJarm'],
    ...truthy,
  },
  {
    category: 'security',
    key: 'security.request_object_signing_algs',
    path: ['fapi', 'messageSigning', 'requestObjectSigningAlgorithms'],
    ...algorithmList(REQUEST_OBJECT_SIGNING_ALGORITHMS),
  },
  {
    category: 'security',
    key: 'security.authorization_signing_algs',
    path: ['fapi', 'messageSigning', 'authorizationSigningAlgorithms'],
    // Empty: no list, so authorization signs with any algorithm the client registered.
    toDocument: (value: unknown) => (value === '' ? undefined : stringList.toDocument(value)),
    fromDocument: algorithmList(AUTHORIZATION_SIGNING_ALGORITHMS).fromDocument,
  },
  {
    // Used whenever it was truthy (with message signing on).
    category: 'security',
    key: 'security.default_authorization_signing_alg',
    path: ['fapi', 'messageSigning', 'defaultAuthorizationSigningAlgorithm'],
    fromDocument: (value: unknown) =>
      !value ? undefined : typeof value === 'string' ? value : asStored(value),
  },
  {
    category: 'security',
    key: 'security.request_object_max_age_seconds',
    path: ['fapi', 'messageSigning', 'maxRequestObjectAgeSeconds'],
    ...coercedNumber,
  },
  {
    category: 'security',
    key: 'security.request_object_max_lifetime_seconds',
    path: ['fapi', 'messageSigning', 'maxRequestObjectLifetimeSeconds'],
    ...coercedNumber,
  },
  {
    category: 'security',
    key: 'security.request_object_clock_skew_seconds',
    path: ['fapi', 'messageSigning', 'clockSkewSeconds'],
    ...storedValue,
  },
  {
    category: 'security',
    key: 'security.par_required',
    path: ['oidc', 'requirePar'],
    ...truthy,
  },
  {
    // Used whenever it was truthy (else 600 seconds).
    category: 'oauth',
    key: 'oauth.par_default_ttl',
    path: ['oidc', 'parExpiry'],
    fromDocument: truthyLifetime,
  },
  {
    category: 'security',
    key: 'security.allow_unsigned_request_object',
    path: ['oidc', 'allowNoneAlgorithm'],
    ...truthy,
  },
  {
    category: 'feature-flags',
    key: 'feature.enable_rar',
    path: ['oidc', 'rar', 'enabled'],
    ...truthyUnlessNull,
  },
  {
    category: 'feature-flags',
    key: 'feature.enable_ai_scopes',
    path: ['oidc', 'aiScopes', 'enabled'],
    ...truthyUnlessNull,
  },
  {
    // Runtime fell back to ENABLE_AI_EPHEMERAL_AUTH whenever this was not true: a saved false
    // never disabled it, so only true is a value.
    category: 'feature-flags',
    key: 'feature.enable_ai_ephemeral_auth',
    path: ['oidc', 'aiEphemeralAuth', 'enabled'],
    fromDocument: (value: unknown) => (value ? true : undefined),
  },
  {
    category: 'oauth',
    key: 'oauth.response_types_supported',
    path: ['oidc', 'responseTypesSupported'],
  },
  {
    category: 'oauth',
    key: 'oauth.token_endpoint_auth_methods_supported',
    path: ['oidc', 'tokenEndpointAuthMethodsSupported'],
  },
  {
    // Empty: discovery's own list.
    category: 'discovery',
    key: 'discovery.claims_supported',
    path: ['oidc', 'claimsSupported'],
    toDocument: (value: unknown) => (value === '' ? undefined : exactList.toDocument(value)),
    fromDocument: exactList.fromDocument,
  },
  {
    category: 'oauth',
    key: 'oauth.https_request_uri_timeout_ms',
    path: ['oidc', 'httpsRequestUri', 'timeoutMs'],
    ...coercedNumber,
  },
  {
    category: 'oauth',
    key: 'oauth.https_request_uri_max_size',
    path: ['oidc', 'httpsRequestUri', 'maxSizeBytes'],
    ...coercedNumber,
  },
  {
    // The token endpoint read it at the top level first, then in the security section.
    category: 'security',
    key: 'security.dpop_nonce_enabled',
    path: ['security', 'dpop_nonce_enabled'],
    legacyPaths: [['security.dpop_nonce_enabled']],
    ...booleanOnly,
  },
  {
    category: 'security',
    key: 'security.dpop_nonce_resource_overrides',
    path: ['security', 'dpop_nonce_resource_overrides'],
    legacyPaths: [['security.dpop_nonce_resource_overrides']],
    // A map of resource to boolean; other entries never applied.
    fromDocument: (value: unknown) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value as Record<string, unknown>).filter(
              ([, entry]) => typeof entry === 'boolean'
            )
          )
        : undefined,
  },
  {
    category: 'oauth',
    key: 'oauth.https_request_uri_enabled',
    path: ['oidc', 'httpsRequestUri', 'enabled'],
  },
  {
    category: 'oauth',
    key: 'oauth.https_request_uri_allowed_domains',
    path: ['oidc', 'httpsRequestUri', 'allowedDomains'],
    ...domainList,
  },
  {
    category: 'tokens',
    key: 'tokens.exchange_enabled',
    path: ['oidc', 'tokenExchange', 'enabled'],
    ...trueOnly,
  },
  {
    category: 'tokens',
    key: 'tokens.exchange_allowed_subject_token_types',
    path: ['oidc', 'tokenExchange', 'allowedSubjectTokenTypes'],
    ...subjectTokenTypes,
  },
  {
    category: 'limits',
    key: 'limits.token_exchange_max_resource_params',
    path: ['oidc', 'tokenExchange', 'maxResourceParams'],
    ...paramLimit,
  },
  {
    category: 'limits',
    key: 'limits.token_exchange_max_audience_params',
    path: ['oidc', 'tokenExchange', 'maxAudienceParams'],
    ...paramLimit,
  },
  {
    // Token Exchange enables ID-JAG when this is true or ENABLE_ID_JAG is 'true': a saved false
    // never disabled it, so only true is a value.
    category: 'feature-flags',
    key: 'feature.enable_id_jag',
    path: ['oidc', 'tokenExchange', 'idJag', 'enabled'],
    fromDocument: (value: unknown) => (value === true ? true : undefined),
  },
  {
    category: 'tokens',
    key: 'tokens.id_jag_allowed_issuers',
    path: ['oidc', 'tokenExchange', 'idJag', 'allowedIssuers'],
    // Kept as a list: an issuer is matched exactly, commas included.
    fromDocument: (value: unknown) =>
      Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : undefined,
  },
  {
    category: 'tokens',
    key: 'tokens.id_jag_max_token_lifetime',
    path: ['oidc', 'tokenExchange', 'idJag', 'maxTokenLifetime'],
    fromDocument: (value: unknown) => (typeof value === 'number' ? value : undefined),
  },
  {
    category: 'tokens',
    key: 'tokens.id_jag_include_tenant_claim',
    path: ['oidc', 'tokenExchange', 'idJag', 'includeTenantClaim'],
    ...booleanOnly,
  },
  {
    category: 'tokens',
    key: 'tokens.id_jag_require_confidential_client',
    path: ['oidc', 'tokenExchange', 'idJag', 'requireConfidentialClient'],
    ...booleanOnly,
  },
  {
    category: 'tokens',
    key: 'tokens.introspection_expected_audience',
    path: ['oidc', 'introspectionValidation', 'expectedAudience'],
    // Unset (null) is the empty string: the issuer applies.
    toDocument: (value: unknown) => (value === '' ? null : value),
    fromDocument: (value: unknown) =>
      typeof value === 'string' ? value : value === null ? '' : undefined,
  },
  {
    category: 'tokens',
    key: 'tokens.introspection_cache_ttl',
    path: ['oidc', 'introspectionCache', 'ttlSeconds'],
    ...positiveNumber,
  },
  {
    category: 'feature-flags',
    key: 'feature.introspection_cache_enabled',
    path: ['oidc', 'introspectionCache', 'enabled'],
    ...trueOnly,
  },
  {
    category: 'tokens',
    key: 'tokens.introspection_strict_validation',
    path: ['oidc', 'introspectionValidation', 'strictValidation'],
    ...trueOnly,
  },
  {
    category: 'feature-flags',
    key: 'feature.enable_client_credentials',
    path: ['oidc', 'clientCredentials', 'enabled'],
  },
  {
    category: 'feature-flags',
    key: 'feature.conformance_enabled',
    path: ['conformance', 'enabled'],
    sectionDefault: false,
    sectionNull: false,
    // As the login code read it: `?? default`, then tested for truth.
    fromDocument: (value: unknown) => (value === null ? false : Boolean(value)),
  },
  {
    category: 'feature-flags',
    key: 'feature.conformance_use_builtin_forms',
    path: ['conformance', 'useBuiltinForms'],
    sectionDefault: true,
    // A null section failed the login code's read, which then turned both off.
    sectionNull: false,
    fromDocument: (value: unknown) => (value === null ? true : Boolean(value)),
  },
];

/** The top-level keys of the document a field is read from. */
export function systemSettingsFieldSections(field: SystemSettingsField): string[] {
  return [field.path[0], ...(field.legacyPaths ?? []).map((path) => path[0])];
}

function readPath(document: Record<string, unknown>, path: readonly string[]) {
  let node: unknown = document;
  let parent: unknown = undefined;
  for (const part of path) {
    parent = node;
    node = node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined;
  }
  return { node, parent };
}

/** The value runtime read for one field of the document, in the Settings API form. */
function fieldValue(field: SystemSettingsField, document: Record<string, unknown>): unknown {
  for (const path of field.legacyPaths ?? []) {
    const { node } = readPath(document, path);
    const value = node !== undefined && field.fromDocument ? field.fromDocument(node) : node;
    if (value !== undefined) return spellsMarker(value) ? asStored(value) : value;
  }
  const read = readPath(document, field.path);
  let node = read.node;
  if (field.sectionDefault !== undefined && node === undefined) {
    // The section is there but holds no such field: an object without it, or a value that is
    // not an object (reading the field from it gave nothing), or null (reading it failed).
    const section = document[field.path[0]];
    if (section === null && field.sectionNull !== undefined) node = field.sectionNull;
    else if (section !== undefined && section !== null) node = field.sectionDefault;
    else if (read.parent && typeof read.parent === 'object') node = field.sectionDefault;
  }
  // A value runtime would not take is no value (its own fallback applies).
  const value = node !== undefined && field.fromDocument ? field.fromDocument(node) : node;
  return spellsMarker(value) ? asStored(value) : value;
}

/** A stored string the Settings API would read as one of its markers, not as the value. */
function spellsMarker(value: unknown): boolean {
  return value === DISABLED_MARKER || value === LEGACY_UNSET;
}

/**
 * The document's own values for the fields of one category, keyed by setting key, in the
 * Settings API form. Used to show them as the platform value the Settings API falls back to.
 */
export function systemSettingsFieldValues(
  document: Record<string, unknown> | null,
  category: string
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  if (!document) return values;
  for (const field of SYSTEM_SETTINGS_FIELDS) {
    if (field.category !== category) continue;
    const value = fieldValue(field, document);
    if (value !== undefined) values[field.key] = value;
  }
  return values;
}

/**
 * Write a Settings API value into a document at the field's path, in the document's form (a
 * value whose form is undefined leaves the field out).
 */
export function writeSystemSettingsField(
  document: Record<string, unknown>,
  field: SystemSettingsField,
  value: unknown
): void {
  const converted = isStoredLegacyValue(value)
    ? value.value
    : field.toDocument
      ? field.toDocument(value)
      : value;
  if (converted === undefined) return;
  let node = document;
  for (const [index, part] of field.path.entries()) {
    if (index === field.path.length - 1) {
      node[part] = converted;
    } else {
      const child = node[part];
      if (!child || typeof child !== 'object' || Array.isArray(child)) node[part] = {};
      node = node[part] as Record<string, unknown>;
    }
  }
}

/**
 * The platform's Settings API documents that hold an older `system_settings` document's values
 * as runtime read them (what the import saves for the platform), keyed by KV key. Values no
 * setting carries as runtime read them are left out.
 */
export function systemSettingsPlatformDocuments(
  document: Record<string, unknown>
): Record<string, Record<string, unknown>> {
  const documents: Record<string, Record<string, unknown>> = {};
  for (const category of new Set(SYSTEM_SETTINGS_FIELDS.map((field) => field.category))) {
    const values = Object.fromEntries(
      Object.entries(systemSettingsFieldValues(document, category)).filter(
        ([, value]) => !isStoredLegacyValue(value)
      )
    );
    if (Object.keys(values).length > 0) documents[`settings:platform:${category}`] = values;
  }
  return documents;
}
