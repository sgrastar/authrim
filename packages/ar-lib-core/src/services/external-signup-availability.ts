/**
 * Whether a tenant lets a new person sign up through an external identity provider (social
 * login): the question `prompt=create` asks before it sends the browser to the sign-up page.
 *
 * It answers "does the sign-up page offer a provider that can create the account", from the same
 * facts the two sides use:
 *
 * - what the sign-up page shows: the bridge's enabled providers (the first
 *   `EXTERNAL_PROVIDER_LIST_LIMIT`, in the bridge's order) that the tenant's
 *   `authentication-methods` settings list and have not turned off for sign-up
 *   (`GET /api/auth/authentication-methods` builds the list from the same rules);
 * - what lets the bridge create the account when the person comes back: the provider's own
 *   `jit_provisioning`, and the tenant's `external_idp.jit_provisioning_enabled` and
 *   `external_idp.jit_allowed_provider_ids`. A provider that can only link an existing account
 *   (JIT off) offers no sign-up, so it does not count.
 *
 * This file only decides, from values already read; the caller reads them (`ar-auth`'s
 * `isSelfRegistrationAvailable`).
 *
 * Not counted: SAML IdPs and providers registered by hand in the settings (neither has a
 * `jit_provisioning` switch to read), and `external_idp.jit_require_verified_email` (it depends on
 * the person's email at sign-in, not on configuration).
 */

import {
  jitSettingValuesWellTyped,
  parseJitAllowedProviderIds,
} from '../types/settings/external-idp';
import {
  externalProviderSignupSwitches,
  externalProviderUsagePolicyFrom,
} from './account-login-methods';

/** The sign-in page and the sign-up page list at most this many external providers. */
export const EXTERNAL_PROVIDER_LIST_LIMIT = 20;

/** An external provider of the bridge (`upstream_providers`) as far as sign-up cares. */
export interface ExternalSignupProviderRow {
  id: string;
  slug: string | null;
  enabled: boolean;
  /** The provider creates accounts for people it does not know yet (`jit_provisioning`). */
  jitProvisioning: boolean;
}

/** The tenant's JIT switches (`external_idp.jit_*`), as the bridge reads them. */
export interface ExternalJitSignupPolicy {
  enabled: boolean;
  /** null: every provider; else only these provider ids. */
  allowedProviderIds: string[] | null;
}

function parseUsageItems(
  settings: Record<string, unknown> | null
): Array<Record<string, unknown>> | null {
  if (!settings) return null;
  const rawUsage = settings['authentication-methods.external_provider_usage'];
  if (rawUsage === undefined) return null;
  if (Array.isArray(rawUsage)) return rawUsage;
  if (typeof rawUsage === 'string') {
    try {
      const parsed = JSON.parse(rawUsage) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return null;
}

function usageSwitchOn(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return true;
}

/**
 * Whether the authentication-methods API lists the bridge's providers at all. A tenant without
 * saved usage settings gets them all; one with saved settings gets them only while a provider
 * other than a SAML IdP still has some use turned on. The API and the sign-up prediction both
 * ask this, so a provider the page does not list cannot be counted.
 */
export function bridgeExternalProvidersListed(settings: Record<string, unknown> | null): boolean {
  const usageItems = parseUsageItems(settings);
  if (usageItems === null) return true;
  return usageItems.some((item) => {
    const id = typeof item.id === 'string' ? item.id : '';
    const providerId = typeof item.providerId === 'string' ? item.providerId : '';
    if (id.startsWith('saml:') || providerId.startsWith('saml:')) return false;
    return (
      usageSwitchOn(item.loginEnabled) ||
      usageSwitchOn(item.signupEnabled) ||
      usageSwitchOn(item.reauthEnabled) ||
      usageSwitchOn(item.accountLinkEnabled)
    );
  });
}

/**
 * The tenant's JIT switches from its resolved `external-idp` settings, the way the bridge reads
 * them before it creates an account: a value of the wrong type switches JIT off rather than on.
 */
export function externalJitSignupPolicy(values: Record<string, unknown>): ExternalJitSignupPolicy {
  // The bridge's own type check: one badly typed JIT value (any of them) switches JIT off.
  if (!jitSettingValuesWellTyped(values)) return { enabled: false, allowedProviderIds: null };
  return {
    enabled: values['external_idp.jit_provisioning_enabled'] === true,
    allowedProviderIds: parseJitAllowedProviderIds(
      values['external_idp.jit_allowed_provider_ids'] as string
    ),
  };
}

/**
 * The ids of the providers through which a new person can sign up, given the tenant's
 * `authentication-methods` document (null: none saved), the bridge's providers in the bridge's
 * order, and the tenant's JIT switches. A provider whose saved entries contradict each other (one on, one off) is not counted. Throws where a saved switch cannot be understood, so
 * the caller can treat that as "no sign-up method".
 */
export function externalSignupProviderIds(input: {
  authenticationMethods: Record<string, unknown> | null;
  providers: readonly ExternalSignupProviderRow[];
  jit: ExternalJitSignupPolicy;
}): string[] {
  const { authenticationMethods, providers, jit } = input;
  if (!jit.enabled) return [];
  if (!bridgeExternalProvidersListed(authenticationMethods)) return [];
  const ids: string[] = [];
  for (const provider of providers
    .filter((p) => p.enabled)
    .slice(0, EXTERNAL_PROVIDER_LIST_LIMIT)) {
    // Only a provider that creates accounts, and that the tenant lets create them.
    if (!provider.jitProvisioning) continue;
    if (jit.allowedProviderIds !== null && !jit.allowedProviderIds.includes(provider.id)) continue;
    // The sign-up switch, found and read as the bridge reads it before it creates the account.
    const key = {
      providerId: provider.id,
      ids: [provider.id, provider.slug ?? ''].filter(Boolean),
    };
    if (authenticationMethods) {
      // The bridge takes the first entry that applies, the page may take another. Entries that
      // disagree leave it unclear whether the page offers the sign-up: this provider is not counted.
      if (new Set(externalProviderSignupSwitches(authenticationMethods, key)).size > 1) continue;
    }
    const usage = authenticationMethods
      ? externalProviderUsagePolicyFrom(authenticationMethods, key)
      : { signupEnabled: true };
    if (usage.signupEnabled) ids.push(provider.id);
  }
  return ids;
}
