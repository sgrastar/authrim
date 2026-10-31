/**
 * The SAML settings the runtime reads, per tenant (the `federation` category):
 *
 * - `federation.saml_enabled`: whether the tenant answers SAML requests at all. Read strictly:
 *   when the settings cannot be read this throws, so the caller refuses (a switch that an outage
 *   turned back on would let a tenant that turned SAML off be reached).
 * - `federation.saml_request_ttl`: how long a SAML request stays valid.
 * - `federation.saml_assertion_ttl`: how long an issued assertion is valid. A provider's own
 *   value comes first, then the tenant's.
 * - `federation.saml_sso_binding`, `saml_slo_binding` and `saml_nameid_format`: what a provider
 *   gets when it is added or its metadata is imported and the metadata, the request and the
 *   provider's profile do not say.
 *
 * A lifetime or choice outside what the setting allows is not used: that one value falls back to
 * its default (the value these paths always used), so a lifetime can never become unbounded.
 * When the settings cannot be read, the lifetimes and defaults keep those values too.
 */

import { NameIDFormats, type NameIDFormat } from '../types/saml';
import { FEDERATION_DEFAULTS, FEDERATION_SETTINGS_META } from '../types/settings/federation';
import { isWithinSettingRange } from './setting-range';
import { resolveEffectiveSettings, type EffectiveSettingsEnv } from './effective-settings';

/** Whether the tenant answers SAML requests. Throws when the tenant's settings cannot be read. */
export async function resolveSamlEnabled(
  env: EffectiveSettingsEnv,
  tenantId: string,
  options: { fresh?: boolean } = {}
): Promise<boolean> {
  const values = await resolveEffectiveSettings(env, 'federation', {
    tenantId,
    ...(options.fresh ? { fresh: true } : {}),
  });
  // Only an explicit false turns SAML off.
  return values['federation.saml_enabled'] !== false;
}

async function resolveTtl(
  env: EffectiveSettingsEnv,
  tenantId: string,
  key: 'federation.saml_request_ttl' | 'federation.saml_assertion_ttl'
): Promise<number> {
  const fallback = FEDERATION_DEFAULTS[key];
  try {
    const values = await resolveEffectiveSettings(env, 'federation', { tenantId });
    const value = values[key];
    return isWithinSettingRange(value, FEDERATION_SETTINGS_META[key]) ? value : fallback;
  } catch {
    return fallback;
  }
}

/** How long a SAML request (sign-in or logout) stays valid, in seconds. */
export function resolveSamlRequestTtlSeconds(
  env: EffectiveSettingsEnv,
  tenantId: string
): Promise<number> {
  return resolveTtl(env, tenantId, 'federation.saml_request_ttl');
}

/**
 * How long an assertion issued to a service provider is valid, in seconds: the provider's own
 * lifetime when it has one (a positive number), else the tenant's.
 */
export async function resolveSamlAssertionTtlSeconds(
  env: EffectiveSettingsEnv,
  tenantId: string,
  providerSeconds?: unknown
): Promise<number> {
  if (
    typeof providerSeconds === 'number' &&
    Number.isFinite(providerSeconds) &&
    providerSeconds > 0
  ) {
    return providerSeconds;
  }
  return resolveTtl(env, tenantId, 'federation.saml_assertion_ttl');
}

export interface SamlProvisioningDefaults {
  /** The binding a new identity provider is signed in through. */
  ssoBinding: 'post' | 'redirect';
  /** The binding a new provider is sent logout requests through. */
  sloBinding: 'post' | 'redirect';
  /** The NameID format a new provider gets. */
  nameIdFormat: NameIDFormat;
}

const NAMEID_FORMAT_URIS: Record<string, NameIDFormat> = {
  emailAddress: NameIDFormats.EMAIL,
  persistent: NameIDFormats.PERSISTENT,
  transient: NameIDFormats.TRANSIENT,
  unspecified: NameIDFormats.UNSPECIFIED,
};

function toBinding(value: unknown, fallback: 'HTTP-POST' | 'HTTP-Redirect'): 'post' | 'redirect' {
  const choice = value === 'HTTP-POST' || value === 'HTTP-Redirect' ? value : fallback;
  return choice === 'HTTP-POST' ? 'post' : 'redirect';
}

function toNameIdFormat(value: unknown, fallback: string): NameIDFormat {
  return (
    (typeof value === 'string' && Object.hasOwn(NAMEID_FORMAT_URIS, value)
      ? NAMEID_FORMAT_URIS[value]
      : undefined) ?? NAMEID_FORMAT_URIS[fallback]
  );
}

/** The tenant's defaults for a provider that is added or whose metadata is imported. */
export async function resolveSamlProvisioningDefaults(
  env: EffectiveSettingsEnv,
  tenantId: string
): Promise<SamlProvisioningDefaults> {
  let values: Record<string, unknown> = {};
  try {
    values = await resolveEffectiveSettings(env, 'federation', { tenantId });
  } catch {
    // The defaults are the behaviour providers always had.
  }
  return {
    ssoBinding: toBinding(
      values['federation.saml_sso_binding'],
      FEDERATION_DEFAULTS['federation.saml_sso_binding']
    ),
    sloBinding: toBinding(
      values['federation.saml_slo_binding'],
      FEDERATION_DEFAULTS['federation.saml_slo_binding']
    ),
    nameIdFormat: toNameIdFormat(
      values['federation.saml_nameid_format'],
      FEDERATION_DEFAULTS['federation.saml_nameid_format']
    ),
  };
}
