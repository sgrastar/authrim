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
import type { MessageKey } from '$lib/i18n/i18n.svelte';

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
	const seen: CategoryName[] = [];
	for (const section of page.sections) {
		for (const setting of section.settings) {
			const category = categoryOf(setting.key);
			if (!seen.includes(category)) seen.push(category);
		}
	}
	return seen;
}

// ---------------------------------------------------------------------------------------------
// Pages

/** Authentication → Staying signed in: how long a sign-in lasts, for people and for apps. */
export const STAYING_SIGNED_IN: SettingsPageDef = {
	id: 'staying-signed-in',
	nav: 'authentication/staying-signed-in',
	title: 'set.page.stayingSignedIn',
	description: 'set.page.stayingSignedIn.desc',
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
		},
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

export const SETTINGS_PAGES: readonly SettingsPageDef[] = [STAYING_SIGNED_IN];
