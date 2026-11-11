/**
 * Where each setting of the Settings API lives in the console, and how deep.
 *
 * The API groups settings by how they are built (`session`, `oauth`, `tokens`…). Admins look
 * for them by what they want to do ("how long do people stay signed in"). A settings page
 * takes settings from any categories and places each one at one of four depths:
 *
 *   primary  — on the page, always: what most tenants look at
 *   advanced — inside the section's "Advanced" part, closed until opened
 *   search   — not on the page unless set here; found by search and the all-settings list
 *   hidden   — never shown (set when deploying, or not in use yet)
 *
 * Whatever its depth, a value set at this scope is never out of sight: the section's
 * Advanced part counts it on its closed heading, and a `search` setting set here is listed
 * there too.
 *
 * Settings whose page is not built yet have a draft place in `inventory.ts`.
 * `placement.test.ts` checks that every setting has exactly one place, here or there, so a
 * setting the API adds cannot silently go missing from the console.
 */
import { ALL_CATEGORY_META, type CategoryName } from '@authrim/ar-lib-core/types/settings/catalog';
import type { MessageKey } from '#lib/i18n/i18n.svelte.js';

export type Depth = 'primary' | 'advanced' | 'search' | 'hidden';

export interface PlacedSetting {
	/** The API key, `category.name`. */
	key: string;
	depth: Depth;
	/** Shown only while another setting on the page has this value (on the screen, unsaved). */
	when?: { key: string; is: unknown };
	/** A number that may have decimals (a factor); counts and times are whole. */
	decimal?: boolean;
}

export interface SettingsSection {
	id: string;
	title: MessageKey;
	description?: MessageKey;
	/** One line under the closed Advanced heading: what is inside. */
	advanced?: MessageKey;
	/**
	 * Set for the whole deployment, whichever tenant is open: read and saved at the platform
	 * scope, and shown only to admins who may see platform settings. For settings the API lets
	 * only the platform set (`scopes: ['platform']`) that belong with a tenant page's own.
	 */
	level?: 'platform';
	settings: readonly PlacedSetting[];
}

export interface SettingsPageDef {
	id: string;
	/** `<area>/<item>` of the page in the navigation. */
	nav: string;
	title: MessageKey;
	description: MessageKey;
	sections: readonly SettingsSection[];
}

/**
 * The category a setting belongs to. Looked up, not read from the key: several categories
 * name their keys differently (`rate-limit` → `rate_limit.strict`, `feature-flags` →
 * `feature.enable_abac`, `infrastructure` → `infra.…`).
 */
const CATEGORY_OF_KEY: ReadonlyMap<string, CategoryName> = new Map(
	(
		Object.entries(ALL_CATEGORY_META) as [CategoryName, { settings: Record<string, unknown> }][]
	).flatMap(([category, meta]) => Object.keys(meta.settings).map((key) => [key, category] as const))
);

export function categoryOf(key: string): CategoryName {
	const category = CATEGORY_OF_KEY.get(key);
	if (!category) throw new Error(`Unknown setting: ${key}`);
	return category;
}

/** Every category a page reads, in the order first used. */
export function categoriesOf(page: SettingsPageDef): CategoryName[] {
	return [...new Set(partsOf(page).map((part) => part.category))];
}

/**
 * One read and one save of a page: a category at the page's scope, or at the platform for a
 * `level: 'platform'` section. A page that shows a category at both scopes has two parts of it,
 * each with its own version.
 */
export interface SettingsPart {
	/** The category's name at the page's scope; `platform/<category>` at the platform. */
	id: string;
	category: CategoryName;
	platform: boolean;
}

/** The part a setting of a section is read from and saved to. */
export function partIdOf(section: Pick<SettingsSection, 'level'>, key: string): string {
	const category = categoryOf(key);
	return section.level === 'platform' ? `platform/${category}` : category;
}

/** The part of a setting placed on a page (each setting has one place on a page). */
export function partOfKey(page: SettingsPageDef, key: string): string {
	const section = page.sections.find((candidate) =>
		candidate.settings.some((setting) => setting.key === key)
	);
	if (!section) throw new Error(`Not on ${page.id}: ${key}`);
	return partIdOf(section, key);
}

/** Every part a page reads, in the order first used. */
export function partsOf(page: SettingsPageDef): SettingsPart[] {
	const parts: SettingsPart[] = [];
	for (const section of page.sections) {
		for (const setting of section.settings) {
			const id = partIdOf(section, setting.key);
			if (parts.some((part) => part.id === id)) continue;
			parts.push({
				id,
				category: categoryOf(setting.key),
				platform: section.level === 'platform'
			});
		}
	}
	return parts;
}

// ---------------------------------------------------------------------------------------------
// Pages

/**
 * Authentication → Session profiles: how long a person's sign-in lasts, and single sign-on. (The
 * tokens apps get are on Tokens and protocols; the logout notices on Logout.)
 */
export const SESSION_PROFILES: SettingsPageDef = {
	id: 'session-profiles',
	nav: 'authentication/session-profiles',
	title: 'set.page.sessionProfiles',
	description: 'set.page.sessionProfiles.desc',
	sections: [
		{
			id: 'sign-in',
			title: 'set.section.signIn',
			description: 'set.section.signIn.desc',
			advanced: 'set.section.signIn.advanced',
			settings: [
				{ key: 'session.default_ttl', depth: 'primary' },
				{ key: 'session.refresh_default', depth: 'primary' },
				{ key: 'oauth.sso_enabled', depth: 'primary' },
				{ key: 'session.ttl.passkey', depth: 'advanced' },
				{ key: 'session.ttl.email_code', depth: 'advanced' },
				{ key: 'session.ttl.directory_password', depth: 'advanced' },
				{ key: 'session.ttl.direct_auth', depth: 'advanced' },
				{ key: 'session.ttl.did', depth: 'advanced' },
				{ key: 'session.ttl.guest', depth: 'advanced' },
				{ key: 'session.ttl.passkey_registration', depth: 'advanced' },
				{ key: 'session.max_ttl', depth: 'advanced' }
			]
		}
	]
};

/**
 * Authentication → Logout: how the tenant tells apps a person signed out (back-channel logout
 * delivery). Each app's own logout addresses are the app's.
 */
export const LOGOUT: SettingsPageDef = {
	id: 'logout',
	nav: 'authentication/logout',
	title: 'set.page.logout',
	description: 'set.page.logout.desc',
	sections: [
		{
			id: 'logout',
			title: 'set.section.logout',
			description: 'set.section.logout.desc',
			advanced: 'set.section.logout.advanced',
			settings: [
				{ key: 'session.backchannel_on_failure', depth: 'advanced' },
				{ key: 'session.backchannel_retry_max_attempts', depth: 'advanced' },
				{ key: 'session.backchannel_logout_token_exp', depth: 'search' },
				{ key: 'session.backchannel_request_timeout_ms', depth: 'search' },
				{ key: 'session.backchannel_retry_initial_delay_ms', depth: 'search' },
				{ key: 'session.backchannel_retry_max_delay_ms', depth: 'search' },
				{ key: 'session.backchannel_retry_backoff_multiplier', depth: 'search', decimal: true }
			]
		}
	]
};

/** Settings → Signing keys: how the tenant signs ID tokens, and whether apps may choose. */
export const SIGNING_KEYS: SettingsPageDef = {
	id: 'signing-keys',
	nav: 'settings/signing-keys',
	title: 'set.page.signingKeys',
	description: 'set.page.signingKeys.desc',
	sections: [
		{
			id: 'id-token-signing',
			title: 'set.section.idTokenSigning',
			description: 'set.section.idTokenSigning.desc',
			settings: [
				{ key: 'oauth.id_token_signing_alg', depth: 'primary' },
				{ key: 'oauth.id_token_signing_alg_client_override', depth: 'primary' }
			]
		}
	]
};

/**
 * Authentication → Tokens and protocols: the tokens apps get (their lifetimes), what every app
 * of the tenant must meet (the tenant's security
 * floor: an app's own settings can add a requirement but not waive one) and the tenant-wide
 * protocol rules. More of the draft in `inventory.ts` moves here as it is built.
 */
export const TOKENS: SettingsPageDef = {
	id: 'tokens',
	nav: 'authentication/tokens',
	title: 'set.page.tokens',
	description: 'set.page.tokens.desc',
	sections: [
		{
			id: 'app-tokens',
			title: 'set.section.appTokens',
			description: 'set.section.appTokens.desc',
			advanced: 'set.section.appTokens.advanced',
			settings: [
				{ key: 'oauth.access_token_expiry', depth: 'primary' },
				{ key: 'oauth.refresh_token_expiry', depth: 'primary' },
				{ key: 'oauth.id_token_expiry', depth: 'advanced' },
				{ key: 'oauth.refresh_token_rotation', depth: 'advanced' },
				{ key: 'oauth.refresh_token_sliding_window_enabled', depth: 'advanced' },
				{ key: 'oauth.refresh_token_absolute_expiry_enabled', depth: 'advanced' },
				{
					key: 'oauth.refresh_token_absolute_expiry',
					depth: 'advanced',
					when: { key: 'oauth.refresh_token_absolute_expiry_enabled', is: true }
				},
				{ key: 'oauth.offline_access_required', depth: 'advanced' },
				{ key: 'oauth.refresh_id_token_reissue', depth: 'advanced' }
			]
		},
		{
			id: 'authorization-requests',
			title: 'set.section.authRequests',
			description: 'set.section.authRequests.desc',
			advanced: 'set.section.authRequests.advanced',
			settings: [
				{ key: 'security.pkce_required', depth: 'primary' },
				{ key: 'security.par_required', depth: 'primary' },
				{ key: 'oauth.state_required', depth: 'primary' },
				{ key: 'security.require_signed_request_object', depth: 'advanced' },
				{ key: 'security.require_encrypted_request_object', depth: 'advanced' },
				{ key: 'security.allow_unsigned_request_object', depth: 'advanced' },
				{ key: 'oauth.prompt_create_enabled', depth: 'advanced' }
			]
		},
		{
			id: 'redirect-uris',
			title: 'set.section.redirectUris',
			description: 'set.section.redirectUris.desc',
			settings: [{ key: 'security.https_redirect_only', depth: 'primary' }]
		},
		{
			id: 'sender-constrained-tokens',
			title: 'set.section.senderConstrained',
			description: 'set.section.senderConstrained.desc',
			advanced: 'set.section.senderConstrained.advanced',
			settings: [
				{ key: 'security.dpop_bound_access_tokens', depth: 'primary' },
				{ key: 'security.dpop_required', depth: 'advanced' },
				{ key: 'security.dpop_nonce_enabled', depth: 'advanced' }
			]
		},
		{
			id: 'fapi',
			title: 'set.section.fapi',
			description: 'set.section.fapi.desc',
			advanced: 'set.section.fapi.advanced',
			settings: [
				{ key: 'security.fapi_enabled', depth: 'primary' },
				{ key: 'security.fapi_strict_dpop', depth: 'advanced' },
				{ key: 'security.fapi_allow_public_clients', depth: 'advanced' },
				{ key: 'security.fapi_require_private_key_jwt', depth: 'advanced' },
				{ key: 'security.require_jarm', depth: 'advanced' }
			]
		},
		{
			id: 'token-exchange',
			title: 'set.section.tokenExchange',
			description: 'set.section.tokenExchange.desc',
			advanced: 'set.section.tokenExchange.advanced',
			settings: [
				{ key: 'tokens.exchange_enabled', depth: 'primary' },
				{ key: 'tokens.exchange_delegation_enabled', depth: 'advanced' },
				{ key: 'tokens.exchange_impersonation_enabled', depth: 'advanced' }
			]
		},
		{
			id: 'introspection',
			title: 'set.section.introspection',
			description: 'set.section.introspection.desc',
			settings: [{ key: 'tokens.introspection_extended_claims', depth: 'primary' }]
		},
		{
			id: 'scim',
			title: 'set.section.scim',
			description: 'set.section.scim.desc',
			advanced: 'set.section.scim.advanced',
			settings: [
				{ key: 'federation.scim_token_default_expiry', depth: 'primary' },
				{ key: 'assurance.scim_max_ial', depth: 'primary' },
				{ key: 'federation.scim_token_max_expiry', depth: 'advanced' }
			]
		}
	]
};

/**
 * Authentication → Attack protection: what keeps sign-in and sign-up from being abused. More of
 * the draft in `inventory.ts` (failed sign-ins, bot protection, API rate limits) moves here as it
 * is built.
 */
export const PROTECTION: SettingsPageDef = {
	id: 'protection',
	nav: 'authentication/protection',
	title: 'set.page.protection',
	description: 'set.page.protection.desc',
	sections: [
		{
			id: 'email-sending',
			title: 'set.section.emailSending',
			description: 'set.section.emailSending.desc',
			settings: [
				{ key: 'rate_limit.email_max_requests', depth: 'primary' },
				{ key: 'rate_limit.email_window', depth: 'primary' }
			]
		},
		{
			id: 'authenticator-app-attempts',
			title: 'set.section.totpAttempts',
			description: 'set.section.totpAttempts.desc',
			settings: [
				{ key: 'rate_limit.totp_max_requests', depth: 'primary' },
				{ key: 'rate_limit.totp_window', depth: 'primary' }
			]
		}
	]
};

/**
 * Authentication → SAML: the institution the tenant stands for (its scopes and
 * names, which only the platform can change), whether the tenant answers SAML at all, how long what
 * it issues and accepts stays valid, and the defaults a new SAML provider starts from. The
 * Artifact binding settings (`federation.saml_artifact_*`) stay in the draft until that binding
 * exists. Registering providers is still done in the previous Admin UI.
 */
export const ENTERPRISE_SAML: SettingsPageDef = {
	id: 'enterprise',
	nav: 'authentication/enterprise',
	title: 'set.page.enterprise',
	description: 'set.page.enterprise.desc',
	sections: [
		{
			id: 'saml-service',
			title: 'set.section.samlService',
			description: 'set.section.samlService.desc',
			settings: [{ key: 'federation.saml_enabled', depth: 'primary' }]
		},
		{
			id: 'saml-lifetimes',
			title: 'set.section.samlLifetimes',
			description: 'set.section.samlLifetimes.desc',
			advanced: 'set.section.samlLifetimes.advanced',
			settings: [
				{ key: 'federation.saml_assertion_ttl', depth: 'primary' },
				{ key: 'federation.saml_request_ttl', depth: 'advanced' }
			]
		},
		{
			id: 'saml-provider-defaults',
			title: 'set.section.samlProviderDefaults',
			description: 'set.section.samlProviderDefaults.desc',
			advanced: 'set.section.samlProviderDefaults.advanced',
			settings: [
				{ key: 'federation.saml_nameid_format', depth: 'primary' },
				{ key: 'federation.saml_sso_binding', depth: 'advanced' },
				{ key: 'federation.saml_slo_binding', depth: 'advanced' }
			]
		},
		{
			id: 'saml-institution',
			title: 'set.section.samlInstitution',
			description: 'set.section.samlInstitution.desc',
			settings: [
				{ key: 'institution.scopes', depth: 'primary' },
				{ key: 'institution.display_names', depth: 'primary' }
			]
		}
	]
};

/**
 * Settings → Administrators: how admins sign in to this console. The tenant's own part (how long
 * an admin stays signed in, which operations ask for more), and for platform admins the switches
 * that hold for every tenant. The list of administrators is still in the previous Admin UI.
 */
export const TEAM: SettingsPageDef = {
	id: 'team',
	nav: 'settings/team',
	title: 'set.page.team',
	description: 'set.page.team.desc',
	sections: [
		{
			id: 'admin-sign-in',
			title: 'set.section.adminSignIn',
			description: 'set.section.adminSignIn.desc',
			settings: [
				{ key: 'session.ttl.admin_passkey', depth: 'primary' },
				{ key: 'security.admin_step_up_overrides', depth: 'primary' }
			]
		},
		{
			id: 'admin-sign-in-platform',
			title: 'set.section.adminSignInPlatform',
			description: 'set.section.adminSignInPlatform.desc',
			level: 'platform',
			settings: [
				{ key: 'security.admin_step_up_enforced', depth: 'primary' },
				{ key: 'security.admin_keyring_dc_api', depth: 'primary' },
				{ key: 'security.admin_last_resort_reenroll_window_seconds', depth: 'advanced' }
			]
		}
	]
};

export const SETTINGS_PAGES: readonly SettingsPageDef[] = [
	SESSION_PROFILES,
	LOGOUT,
	PROTECTION,
	ENTERPRISE_SAML,
	SIGNING_KEYS,
	TOKENS,
	TEAM
];
