import { ALL_CATEGORY_META } from '@authrim/ar-lib-core/types/settings/catalog';
import { describe, expect, it } from 'vitest';
import { hasMessage } from '$lib/i18n/i18n.svelte';
import { PLATFORM_AREAS, TENANT_AREAS } from '$lib/shell/nav-data';
import { API_GROUPS, API_PAGES, groupOf } from './api-inventory';
import { API_OPERATIONS } from './api-operations';
import { NOT_APPLIED } from './effect';
import { DRAFT, DRAFT_PAGES } from './inventory';
import { categoryOf, SETTINGS_PAGES } from './placement';
import { settingText } from './setting-text';

const placed = SETTINGS_PAGES.flatMap((page) =>
	page.sections.flatMap((section) => section.settings.map((setting) => setting.key))
);
const drafted = DRAFT.map((entry) => entry.key);
const everyKey = Object.values(ALL_CATEGORY_META).flatMap((meta) => Object.keys(meta.settings));
const navItems = new Set(
	[...TENANT_AREAS, ...PLATFORM_AREAS].flatMap((area) =>
		area.children.map((item) => `${area.id}/${item.id}`)
	)
);

/** The limits of the Mapping Set usage search: platform settings of the identity-mapping category. */
const MAPPING_SCAN_KEYS = [
	'identity_mapping.reference_scan_tenant_limit',
	'identity_mapping.reference_scan_row_limit',
	'identity_mapping.reference_scan_concurrency',
	'identity_mapping.reference_display_limit'
] as const;

describe('where settings live', () => {
	it('places only settings the API has', () => {
		for (const key of [...placed, ...drafted]) {
			const category = ALL_CATEGORY_META[categoryOf(key)];
			expect(category?.settings, key).toHaveProperty([key]);
		}
	});

	it('places each setting once', () => {
		const all = [...placed, ...drafted];
		expect(all.filter((key, i) => all.indexOf(key) !== i)).toEqual([]);
	});

	it('gives every setting of every category a place, on a built page or in the draft', () => {
		const missing = everyKey.filter((key) => !placed.includes(key) && !drafted.includes(key));
		expect(missing).toEqual([]);
	});

	it('drafts only onto known pages: navigation items, or ones the draft proposes', () => {
		const pages = new Map(DRAFT_PAGES.map((page) => [page.id, page]));
		for (const entry of DRAFT) {
			const page = pages.get(entry.page);
			expect(page, `${entry.key} → ${entry.page}`).toBeDefined();
			if (page && !page.proposed && page.id !== 'hidden') {
				expect(navItems.has(page.id), page.id).toBe(true);
			}
		}
		for (const page of SETTINGS_PAGES) expect(navItems.has(page.nav), page.nav).toBe(true);
	});

	it('marks only settings the API has as not applied', () => {
		for (const key of NOT_APPLIED.keys()) expect(everyKey, key).toContain(key);
	});

	it('marks every setting still in development as not applied', () => {
		for (const key of everyKey) {
			const meta = ALL_CATEGORY_META[categoryOf(key)].settings[key];
			if (meta.status !== 'in_development' || meta.visibility === 'internal') continue;
			expect(NOT_APPLIED.has(key), key).toBe(true);
		}
	});

	it('does not mark the CIBA settings the runtime reads', () => {
		const applied = [
			'ciba.expires_in',
			'ciba.min_expires_in',
			'ciba.max_expires_in',
			'ciba.poll_interval',
			'ciba.min_interval',
			'ciba.max_interval',
			'ciba.max_binding_message_length',
			'ciba.binding_message_required',
			'ciba.slow_down_increment',
			'ciba.max_poll_count',
			'ciba.user_code_enabled',
			'ciba.ping_notification_timeout_ms'
		];
		for (const key of applied) {
			expect(NOT_APPLIED.has(key), key).toBe(false);
			expect(ALL_CATEGORY_META.ciba.settings[key].status, key).toBeUndefined();
		}
	});

	it('keeps the CIBA push timeout as to-build: tokens are never pushed', () => {
		expect(NOT_APPLIED.get('ciba.push_notification_timeout_ms')).toBe('to-build');
		expect(ALL_CATEGORY_META.ciba.settings['ciba.push_notification_timeout_ms'].status).toBe(
			'in_development'
		);
	});

	it('applies the sign-up page path and the prompt=create switch that opens it', () => {
		// prompt=create sends the browser to tenant.ui_register_path while the switch is on.
		for (const key of ['tenant.ui_register_path', 'oauth.prompt_create_enabled']) {
			expect(NOT_APPLIED.has(key), key).toBe(false);
		}
		expect(ALL_CATEGORY_META.tenant.settings['tenant.ui_register_path'].status).toBeUndefined();
		expect(ALL_CATEGORY_META.oauth.settings['oauth.prompt_create_enabled'].status).toBeUndefined();
	});

	it('puts the prompt=create switch on the app defaults page', () => {
		const page = SETTINGS_PAGES.find((candidate) => candidate.id === 'app-defaults');
		const setting = page?.sections
			.flatMap((section) => section.settings)
			.find((candidate) => candidate.key === 'oauth.prompt_create_enabled');
		expect(setting?.depth).toBe('advanced');
		expect(drafted).not.toContain('oauth.prompt_create_enabled');
	});

	it('does not mark the device flow settings the runtime reads', () => {
		const applied = [
			'device_flow.expires_in',
			'device_flow.min_expires_in',
			'device_flow.max_expires_in',
			'device_flow.poll_interval',
			'device_flow.min_interval',
			'device_flow.max_interval',
			'device_flow.slow_down_increment',
			'device_flow.max_poll_count',
			'device_flow.user_code_charset',
			'device_flow.user_code_length'
		];
		for (const key of applied) {
			expect(NOT_APPLIED.has(key), key).toBe(false);
			expect(ALL_CATEGORY_META['device-flow'].settings[key].status, key).toBeUndefined();
		}
	});

	it('leaves no device flow setting unapplied, and sets the user code format per tenant only', () => {
		for (const key of Object.keys(ALL_CATEGORY_META['device-flow'].settings)) {
			expect(NOT_APPLIED.has(key), key).toBe(false);
		}
		for (const key of ['device_flow.user_code_charset', 'device_flow.user_code_length']) {
			expect(ALL_CATEGORY_META['device-flow'].settings[key].scopes, key).toEqual(['tenant']);
		}
	});

	it('no longer has the CIBA settings that no CIBA behaviour is behind', () => {
		for (const key of [
			'ciba.auth_request_ttl',
			'ciba.notifier_default_timeout_ms',
			'ciba.notifier_max_timeout_ms',
			'ciba.notifier_retry_delay_base_ms'
		]) {
			expect(everyKey, key).not.toContain(key);
			expect([...placed, ...drafted], key).not.toContain(key);
			expect(NOT_APPLIED.has(key), key).toBe(false);
		}
	});

	it('no longer has the tenant name or the app default audience and resource as settings', () => {
		// The tenant record holds the name; the app registration holds the default target.
		for (const key of ['tenant.name', 'client.default_audience', 'client.default_resource']) {
			expect(everyKey, key).not.toContain(key);
			expect([...placed, ...drafted], key).not.toContain(key);
			expect(NOT_APPLIED.has(key), key).toBe(false);
		}
		// The rest of the Tenant section stays: the logo, with the other branding settings
		expect(drafted).toContain('tenant.logo_uri');
		expect(Object.keys(ALL_CATEGORY_META.client.settings).sort()).toEqual([
			'client.app_login_enabled',
			'client.sso_enabled'
		]);
	});

	it('places the default target of new apps next to the other DCR settings, as applied', () => {
		const dcr = ALL_CATEGORY_META.dcr.settings;
		for (const key of ['dcr.default_audience', 'dcr.default_resource']) {
			expect(everyKey, key).toContain(key);
			expect(NOT_APPLIED.has(key), key).toBe(false);
			expect(dcr[key].status, key).toBeUndefined();
			expect(ALL_CATEGORY_META.dcr.settings[key].scopes ?? ['tenant'], key).toEqual(['tenant']);
			const entry = DRAFT.find((candidate) => candidate.key === key);
			const sibling = DRAFT.find((candidate) => candidate.key === 'dcr.enabled');
			expect(entry?.page, key).toBe(sibling?.page);
			expect(entry?.section, key).toBe(sibling?.section);
		}
	});

	it('no longer has the settings that must not be a tenant switch or that the platform fixes', () => {
		for (const key of [
			'diagnostic-logging.filter_tokens',
			'plugin.memory_limit_mb',
			'plugin.notifier_console_enabled',
			'plugin.execution_timeout_ms',
			'plugin.auto_update_check',
			'plugin.notifier_resend_enabled'
		]) {
			expect(everyKey, key).not.toContain(key);
			expect([...placed, ...drafted], key).not.toContain(key);
			expect(NOT_APPLIED.has(key), key).toBe(false);
		}
	});

	it('places the switch for external plugin code as the only plugin setting, as applied', () => {
		// plugin.enabled gates the code of external (dynamic worker) plugins; the built-in email
		// and CAPTCHA providers are not behind it.
		const plugin = ALL_CATEGORY_META.plugin.settings;
		expect(Object.keys(plugin)).toEqual(['plugin.enabled']);
		expect(plugin['plugin.enabled'].status).toBeUndefined();
		expect(NOT_APPLIED.has('plugin.enabled')).toBe(false);
		expect(DRAFT.find((entry) => entry.key === 'plugin.enabled')).toMatchObject({
			page: 'integrations/plugins',
			depth: 'primary'
		});
	});

	it('places the diagnostic logging PII filter and merged output as applied', () => {
		for (const key of [
			'diagnostic-logging.filter_pii',
			'diagnostic-logging.merged_output_enabled'
		]) {
			expect(everyKey, key).toContain(key);
			expect([...placed, ...drafted], key).toContain(key);
			expect(NOT_APPLIED.has(key), key).toBe(false);
			expect(ALL_CATEGORY_META['diagnostic-logging'].settings[key].status, key).toBeUndefined();
		}
	});

	it('places the default Mapping Set once, on the Mapping Sets page, as applied', () => {
		const key = 'identity_mapping.oidc_default_set_id';
		const meta = ALL_CATEGORY_META['identity-mapping'].settings[key];
		expect(categoryOf(key)).toBe('identity-mapping');
		// The release of claims reads it (ID token, UserInfo and the consent screen).
		expect(meta.status).toBeUndefined();
		expect(NOT_APPLIED.has(key)).toBe(false);
		expect(placed).not.toContain(key);
		expect(DRAFT.filter((entry) => entry.key === key)).toMatchObject([
			{ page: 'access/mapping-sets', depth: 'primary' }
		]);
		expect(DRAFT_PAGES.find((page) => page.id === 'access/mapping-sets')).toBeDefined();
		// Named in every language the console has.
		expect(hasMessage(settingText(key).label)).toBe(true);
		expect(settingText(key).description).toBeDefined();
	});

	it('lets only the platform and a tenant set the default Mapping Set, never an app', () => {
		const category = 'identity-mapping';
		expect(Object.keys(ALL_CATEGORY_META[category].settings)).toEqual([
			'identity_mapping.oidc_default_set_id',
			...MAPPING_SCAN_KEYS
		]);
		expect(
			ALL_CATEGORY_META[category].settings['identity_mapping.oidc_default_set_id'].envKey
		).toBe(undefined);
	});

	it('no longer has the shadow comparison switch: the resolution it compared is gone', () => {
		const key = 'identity_mapping.shadow_compare_enabled';
		expect(everyKey, key).not.toContain(key);
		expect([...placed, ...drafted], key).not.toContain(key);
		expect(NOT_APPLIED.has(key), key).toBe(false);
		expect(hasMessage(settingText(key).label)).toBe(false);
	});

	it('places the limits of the Mapping Set usage search once, as applied platform-only settings', () => {
		for (const key of MAPPING_SCAN_KEYS) {
			const meta = ALL_CATEGORY_META['identity-mapping'].settings[key];
			expect(categoryOf(key)).toBe('identity-mapping');
			// The search of the usage API and of the refusals reads them.
			expect(meta.status).toBeUndefined();
			expect(NOT_APPLIED.has(key)).toBe(false);
			expect(meta.scopes).toEqual(['platform']);
			expect(meta.envKey).toMatch(/^IDENTITY_MAPPING_REFERENCE_/);
			expect(placed).not.toContain(key);
			expect(DRAFT.filter((entry) => entry.key === key)).toMatchObject([
				{ page: 'plat-infra/scale', depth: 'search' }
			]);
			// Named in every language the console has.
			expect(hasMessage(settingText(key).label)).toBe(true);
			expect(settingText(key).description).toBeDefined();
		}
		expect(DRAFT_PAGES.find((page) => page.id === 'plat-infra/scale')).toMatchObject({
			scope: 'platform'
		});
	});

	it('places the bulk apply limits once, as applied platform-only settings', () => {
		for (const [key, envKey] of [
			['bulk_apply.max_tenants_per_request', 'BULK_APPLY_MAX_TENANTS_PER_REQUEST'],
			['bulk_apply.max_keys_per_request', 'BULK_APPLY_MAX_KEYS_PER_REQUEST']
		] as const) {
			const meta = ALL_CATEGORY_META['bulk-apply'].settings[key];
			expect(categoryOf(key)).toBe('bulk-apply');
			// The limits are read by the bulk apply route, so they are not "in development".
			expect(meta.status).toBeUndefined();
			expect(NOT_APPLIED.has(key)).toBe(false);
			expect(meta.scopes).toEqual(['platform']);
			expect(meta.envKey).toBe(envKey);
			expect(placed).not.toContain(key);
			expect(DRAFT.filter((entry) => entry.key === key)).toMatchObject([
				{ page: 'plat-tenants/bulk-apply', depth: 'advanced' }
			]);
			// Named in every language the console has.
			expect(hasMessage(settingText(key).label)).toBe(true);
			expect(settingText(key).description).toBeDefined();
		}
		expect(DRAFT_PAGES.find((page) => page.id === 'plat-tenants/bulk-apply')).toMatchObject({
			scope: 'platform',
			proposed: true
		});
	});

	it('places the institution scopes and names once, on the SAML page, as applied tenant-only settings', () => {
		const page = SETTINGS_PAGES.find((candidate) => candidate.id === 'enterprise');
		for (const key of ['institution.scopes', 'institution.display_names']) {
			const meta = ALL_CATEGORY_META.institution.settings[key];
			expect(categoryOf(key)).toBe('institution');
			// The SAML IdP reads them, so they are not "in development".
			expect(meta.status).toBeUndefined();
			expect(NOT_APPLIED.has(key)).toBe(false);
			expect(meta.scopes).toEqual(['tenant']);
			// Not from the environment: they are the institution’s own.
			expect(meta.envKey).toBeUndefined();
			expect(drafted).not.toContain(key);
			expect(
				page?.sections.flatMap((section) => section.settings).filter((s) => s.key === key)
			).toEqual([{ key, depth: 'primary' }]);
			// Named in every language the console has.
			expect(hasMessage(settingText(key).label)).toBe(true);
			expect(settingText(key).description).toBeDefined();
		}
	});

	it('points every duplicate at a setting that exists', () => {
		for (const entry of DRAFT.filter((e) => e.duplicateOf)) {
			expect(everyKey, entry.key).toContain(entry.duplicateOf);
		}
	});

	it('names every placed setting, section and page in the console’s own words', () => {
		for (const key of placed) {
			expect(hasMessage(settingText(key).label), key).toBe(true);
		}
		for (const page of SETTINGS_PAGES) {
			expect(hasMessage(page.title)).toBe(true);
			for (const section of page.sections) expect(hasMessage(section.title)).toBe(true);
		}
	});

	it('names every choice of a placed setting with choices', () => {
		for (const key of placed) {
			const meta = ALL_CATEGORY_META[categoryOf(key)].settings[key];
			for (const choice of meta.enum ?? []) {
				expect(hasMessage(settingText(key).choice(choice)), `${key}: ${choice}`).toBe(true);
			}
		}
	});

	it('shows a setting only after the one it depends on', () => {
		for (const page of SETTINGS_PAGES) {
			for (const section of page.sections) {
				for (const setting of section.settings) {
					if (!setting.when) continue;
					expect(placed, setting.key).toContain(setting.when.key);
				}
			}
		}
	});
});

describe('where the other Admin APIs are used', () => {
	it('puts every operation in a group', () => {
		const missing = API_OPERATIONS.filter((op) => !groupOf(op.path)).map(
			(op) => `${op.method} ${op.path}`
		);
		expect(missing).toEqual([]);
	});

	it('gives every group operations, and every prefix at least one', () => {
		const groupedOperations = API_OPERATIONS.map((op) => ({ op, group: groupOf(op.path) }));
		for (const group of API_GROUPS) {
			for (const prefix of group.paths) {
				expect(
					groupedOperations.some(
						({ op, group: owner }) => owner === group && op.path.startsWith(prefix)
					),
					`${group.id}: ${prefix}`
				).toBe(true);
			}
		}
		const ids = API_GROUPS.map((group) => group.id);
		expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
	});

	it('places groups only on known pages', () => {
		const pages = new Set([
			...navItems,
			...DRAFT_PAGES.map((page) => page.id),
			...API_PAGES.map((page) => page.id)
		]);
		for (const group of API_GROUPS) expect(pages.has(group.page), group.id).toBe(true);
	});
});
