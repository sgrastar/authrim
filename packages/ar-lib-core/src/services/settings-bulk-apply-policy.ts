/**
 * Which settings the bulk apply (the same change to several tenants at once) may give to a tenant.
 *
 * A setting that means the same thing in every tenant (a lifetime, a switch, a bound) can be given
 * to many. One that names something of the tenant (its URLs, domains, identifiers, brand text, the
 * references to its own records), or that holds a secret, key or structured document, cannot: the
 * same value would be wrong, or would reach a place it must not. The refusal is decided here, in
 * one place, from the reviewed handling of each setting (the tenant backup inventory in
 * `settings-field-registry.ts`) plus the explicit lists below, and it fails closed: a setting that
 * has not been reviewed is refused.
 */
import {
  ALL_CATEGORY_META,
  CATEGORY_SCOPE_CONFIG,
  getScopedCategoryMeta,
  type CategoryName,
} from '../types/settings/catalog';
import {
  TENANT_SETTING_FIELD_POLICIES,
  type TenantSettingHandling,
} from './tenant-portability/settings-field-registry';

export type BulkApplyRefusalReason =
  | 'unknown_category'
  | 'category_not_at_tenant_scope'
  | 'category_read_only_at_tenant_scope'
  | 'unknown_setting'
  | 'setting_not_at_tenant_scope'
  | 'setting_setup_time_only'
  | 'setting_not_reviewed'
  | 'tenant_specific_reference'
  | 'tenant_specific_url'
  | 'environment_mapping'
  | 'structured_value'
  | 'key_reference'
  | 'tenant_ui_routing'
  | 'tenant_identifier'
  | 'tenant_brand_text';

export type BulkApplyVerdict =
  | { ok: true }
  | { ok: false; reason: BulkApplyRefusalReason; explanation: string };

/**
 * Settings whose reviewed handling is a plain value but whose meaning is the tenant's own. Each
 * one has the reason it cannot be the same everywhere.
 */
export const BULK_APPLY_EXCLUDED_KEYS: Readonly<
  Record<string, { reason: BulkApplyRefusalReason; explanation: string }>
> = Object.fromEntries([
  ...[
    'tenant.ui_login_path',
    'tenant.ui_consent_path',
    'tenant.ui_reauth_path',
    'tenant.ui_error_path',
    'tenant.ui_device_path',
    'tenant.ui_device_authorize_path',
    'tenant.ui_logout_complete_path',
    'tenant.ui_logged_out_path',
    'tenant.ui_register_path',
    'self-service.account_page_path',
  ].map((key) => [
    key,
    {
      reason: 'tenant_ui_routing',
      explanation:
        "A path on the tenant's own UI host: it is only right together with that tenant's UI base URL.",
    },
  ]),
  ...['dcr.default_audience', 'dcr.default_resource'].map((key) => [
    key,
    {
      reason: 'tenant_identifier',
      explanation:
        "The default access token target of new apps: checked against the tenant's own issuer URLs, so it cannot be one value for many tenants.",
    },
  ]),
  ...[
    'login-ui.brand_name',
    'login-ui.brand_panel_title',
    'login-ui.brand_panel_text',
    'login-ui.header_text',
    'tenant-discovery-ui.brand_name',
    'tenant-discovery-ui.page_title',
    'tenant-discovery-ui.kicker_text',
    'tenant-discovery-ui.title_text',
    'tenant-discovery-ui.subtitle_text',
  ].map((key) => [
    key,
    {
      reason: 'tenant_brand_text',
      explanation: "Text that names the tenant to its users: each tenant's own.",
    },
  ]),
]) as Record<string, { reason: BulkApplyRefusalReason; explanation: string }>;

/**
 * Settings that are references to a record by ID, and may be given to many tenants because the
 * record is not one tenant's: the check on save lets a tenant name only its own or the platform's,
 * so a tenant that cannot use the value refuses it by itself.
 */
export const BULK_APPLY_SHARED_REFERENCE_KEYS: ReadonlySet<string> = new Set([
  // The default Mapping Set: the platform's sets are shared by every tenant.
  'identity_mapping.oidc_default_set_id',
]);

const HANDLING_REFUSALS: Readonly<
  Record<Exclude<TenantSettingHandling, 'value'>, { reason: BulkApplyRefusalReason; text: string }>
> = {
  logical_reference: {
    reason: 'tenant_specific_reference',
    text: "Names a record of the tenant (a provider, role, app or profile ID): another tenant's record is not the same one.",
  },
  url_or_asset: {
    reason: 'tenant_specific_url',
    text: "A URL, domain, origin or asset of the tenant: it points at the tenant's own place.",
  },
  environment_mapping: {
    reason: 'environment_mapping',
    text: 'Maps to a binding or destination of the deployment, which differs per tenant and environment.',
  },
  structured: {
    reason: 'structured_value',
    text: 'A structured document (JSON, CSS, HTML or a list of rules) whose nested references need their own validation.',
  },
  key_reference: {
    reason: 'key_reference',
    text: 'Refers to a key or secret.',
  },
};

const handlingByKey = new Map(
  TENANT_SETTING_FIELD_POLICIES.map((policy) => [policy.key, policy.handling])
);

/** Whether a category may be given to a tenant at all (before any key is looked at). */
export function bulkApplyCategoryVerdict(category: string): BulkApplyVerdict {
  if (!Object.hasOwn(ALL_CATEGORY_META, category)) {
    return {
      ok: false,
      reason: 'unknown_category',
      explanation: 'There is no such settings category.',
    };
  }
  const name = category as CategoryName;
  if (!CATEGORY_SCOPE_CONFIG[name]?.allowedScopes.includes('tenant')) {
    return {
      ok: false,
      reason: 'category_not_at_tenant_scope',
      explanation: 'The category cannot be set for a tenant (it is the platform’s or an app’s).',
    };
  }
  if (getScopedCategoryMeta(name).scopePermissions.tenant.editRoles.length === 0) {
    return {
      ok: false,
      reason: 'category_read_only_at_tenant_scope',
      explanation: 'The category is read-only for a tenant.',
    };
  }
  return { ok: true };
}

/** Whether one setting may be given to a tenant by the bulk apply. */
export function bulkApplyKeyVerdict(category: string, key: string): BulkApplyVerdict {
  const categoryVerdict = bulkApplyCategoryVerdict(category);
  if (!categoryVerdict.ok) return categoryVerdict;

  const settings = ALL_CATEGORY_META[category as CategoryName].settings as Record<
    string,
    { scopes?: string[]; visibility?: string }
  >;
  if (!Object.hasOwn(settings, key)) {
    return {
      ok: false,
      reason: 'unknown_setting',
      explanation: 'The category has no such setting.',
    };
  }
  const meta = settings[key];
  if (meta.scopes && !meta.scopes.includes('tenant')) {
    return {
      ok: false,
      reason: 'setting_not_at_tenant_scope',
      explanation: 'The setting cannot be set for a tenant.',
    };
  }
  if (meta.visibility === 'internal') {
    return {
      ok: false,
      reason: 'setting_setup_time_only',
      explanation: 'A setup-time setting, locked once the tenant exists.',
    };
  }
  const excluded = Object.hasOwn(BULK_APPLY_EXCLUDED_KEYS, key)
    ? BULK_APPLY_EXCLUDED_KEYS[key]
    : undefined;
  if (excluded) return { ok: false, reason: excluded.reason, explanation: excluded.explanation };

  const handling = handlingByKey.get(key);
  if (handling === undefined) {
    return {
      ok: false,
      reason: 'setting_not_reviewed',
      explanation: 'The setting has not been reviewed for handling yet.',
    };
  }
  if (handling === 'value') return { ok: true };
  if (handling === 'logical_reference' && BULK_APPLY_SHARED_REFERENCE_KEYS.has(key)) {
    return { ok: true };
  }
  const refusal = HANDLING_REFUSALS[handling];
  return { ok: false, reason: refusal.reason, explanation: refusal.text };
}
