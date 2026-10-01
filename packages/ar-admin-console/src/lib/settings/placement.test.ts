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
