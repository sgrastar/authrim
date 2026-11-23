import { describe, expect, it } from 'vitest';
import type { PageRecord } from '#lib/api/account-pages.js';
import type { Screen } from '#lib/api/screens.js';
import {
	addPlacement,
	buildPublication,
	definitionToTranslations,
	movePlacement,
	newPage,
	normalizeDefinition,
	pageState,
	parsePagesDocument,
	placementIdFor,
	placementRows,
	presetDefinition,
	publishedPage,
	snapshotsStale,
	removePlacement,
	translationsToLocalizations,
	translationsTooLong,
	unplaced
} from './account-page-model';

function screen(key: string, overrides: Partial<Screen> = {}): Screen {
	return {
		id: `id-${key}`,
		screen_key: key,
		display_name: key,
		description: null,
		screen_kind: 'account',
		fields: [{ id: 'w', block_type: 'account_profile_widget' } as never],
		localizations: {},
		settings: {},
		is_active: true,
		is_system: false,
		version: 1,
		created_at: 1,
		updated_at: 1,
		...overrides
	};
}

const ALL = presetDefinition().screens.map((placement) => screen(placement.screen_key));

describe('what is stored', () => {
	it('shows the preset as the one page while nothing is stored', () => {
		const { document, stored } = parsePagesDocument(
			{ pages: undefined, legacy: undefined },
			'Standard',
			5
		);
		expect(stored).toBe(false);
		expect(document.pages).toHaveLength(1);
		expect(document.pages[0]).toMatchObject({
			id: 'authrim-default',
			name: 'Standard',
			published_version: 0,
			published_at: ''
		});
		expect(document.pages[0].draft.screens.length).toBeGreaterThan(5);
		expect(document.default_page_id).toBeNull();
	});

	it('carries over the single page an older console kept', () => {
		const legacy = JSON.stringify({
			screens: [{ id: 'a', screen_key: 'account_profile', width: 'half' }]
		});
		const { document } = parsePagesDocument({ pages: '', legacy }, 'Standard', 5);
		expect(document.pages[0].draft.screens).toEqual([
			expect.objectContaining({ id: 'a', screen_key: 'account_profile', width: 'half' })
		]);
	});

	it('reads the stored document and drops a rollback', () => {
		const stored = {
			schema_version: 'authrim.account_pages.v1',
			default_page_id: 'p1',
			pages: [
				{
					id: 'p1',
					name: 'One',
					base_preset_id: 'authrim-default',
					base_preset_version: 3,
					draft: presetDefinition(),
					rollback: { screens: [] },
					published_version: 2,
					published_at: '2026-11-01T00:00:00.000Z',
					created_at: 1,
					updated_at: 2
				}
			]
		};
		const { document, stored: isStored } = parsePagesDocument(
			{ pages: JSON.stringify(stored), legacy: undefined },
			'Standard',
			5
		);
		expect(isStored).toBe(true);
		expect(document.default_page_id).toBe('p1');
		expect('rollback' in document.pages[0]).toBe(false);
	});

	it('keeps to what the API accepts of a page: places dropped, ids made unique', () => {
		const normalized = normalizeDefinition({
			screens: [
				{ id: 'x', screen_key: 'account_a', width: 'half', condition: 'nonsense' },
				{ id: 'x', screen_key: 'account_b' },
				{ id: 'bad id', screen_key: 'account_c' },
				{ screen_key: 'Not Valid' },
				{ id: 'dup', screen_key: 'account_a' },
				'junk'
			]
		});
		expect(normalized.screens.map((p) => [p.id, p.screen_key, p.condition, p.width])).toEqual([
			['x', 'account_a', 'always', 'half'],
			['x-2', 'account_b', 'always', 'full'],
			['account_c-3', 'account_c', 'always', 'full']
		]);
	});
});

describe('places of a page', () => {
	const base = { ...presetDefinition(), screens: [] };

	it('adds a screen once, with an id of its own, and finds what is left', () => {
		const one = addPlacement(base, screen('account_profile'));
		const again = addPlacement(one, screen('account_profile'));
		expect(again.screens).toHaveLength(1);
		expect(one.screens[0]).toMatchObject({
			id: 'profile',
			width: 'full',
			enabled: true,
			condition: 'always'
		});
		expect(unplaced(one, ALL).map((s) => s.screen_key)).not.toContain('account_profile');
		expect(placementIdFor(screen('account_profile'), ['profile'])).toBe('profile-2');
	});

	it('moves a place one step and leaves an end where it is', () => {
		let page = addPlacement(addPlacement(base, screen('account_a')), screen('account_b'));
		page = movePlacement(page, 'b', -1);
		expect(page.screens.map((p) => p.id)).toEqual(['b', 'a']);
		expect(movePlacement(page, 'b', -1)).toBe(page);
		expect(removePlacement(page, 'a').screens.map((p) => p.id)).toEqual(['b']);
	});

	it('lays half places side by side, a lone half in a row of its own', () => {
		const p = (id: string, width: 'full' | 'half') =>
			({
				id,
				screen_key: id,
				width,
				enabled: true,
				condition: 'always',
				show_for_guests: true
			}) as const;
		const rows = placementRows([
			p('a', 'full'),
			p('b', 'half'),
			p('c', 'half'),
			p('d', 'half'),
			p('e', 'full')
		]);
		expect(rows.map((row) => row.map((x) => x.id))).toEqual([['a'], ['b', 'c'], ['d'], ['e']]);
	});
});

describe('publishing', () => {
	const now = '2026-11-23T00:00:00.000Z';

	it('takes a snapshot of every enabled place and leaves a disabled one out', () => {
		const draft = presetDefinition();
		draft.screens[0].enabled = false;
		const built = buildPublication(draft, ALL, now);
		expect(built.ok).toBe(true);
		if (!built.ok) return;
		expect(Object.keys(built.published.screen_snapshots)).not.toContain(
			draft.screens[0].screen_key
		);
		expect(built.published.resolved_at).toBe(now);
	});

	it('refuses a screen that is missing or inactive', () => {
		const draft = presetDefinition();
		const built = buildPublication(draft, ALL.slice(1), now);
		expect(built).toMatchObject({ ok: false, problem: { code: 'screen_missing' } });
		const inactive = ALL.map((s) => (s === ALL[0] ? { ...s, is_active: false } : s));
		expect(buildPublication(draft, inactive, now)).toMatchObject({ ok: false });
	});

	it('refuses a screen with two account widgets', () => {
		const two = ALL.map((s, index) =>
			index === 0
				? {
						...s,
						display_name: 'Two',
						fields: [{ block_type: 'account_a' }, { block_type: 'account_b' }] as never
					}
				: s
		);
		expect(buildPublication(presetDefinition(), two, now)).toMatchObject({
			ok: false,
			problem: { code: 'multiple_widgets', name: 'Two' }
		});
	});

	it('refuses a link to a place that is not always shown', () => {
		const draft = presetDefinition();
		const linked = ALL.map((s, index) =>
			index === 0 ? { ...s, fields: [{ block_type: 'link', href: '#passkeys' }] as never } : s
		);
		const passkeys = draft.screens.find((p) => p.id === 'passkeys');
		expect(passkeys?.condition).not.toBe('always');
		expect(buildPublication(draft, linked, now)).toMatchObject({
			ok: false,
			problem: { code: 'link_target', target: '#passkeys' }
		});
		const toProfile = ALL.map((s, index) =>
			index === 0 ? { ...s, fields: [{ block_type: 'link', href: '#profile' }] as never } : s
		);
		expect(buildPublication(draft, toProfile, now).ok).toBe(true);
	});

	it('tells an unpublished page, a published one and one changed since', () => {
		const page: PageRecord = newPage([], 'A page', 1000);
		expect(pageState(page)).toBe('unpublished');
		const built = buildPublication(page.draft, ALL, now);
		if (!built.ok) throw new Error('built');
		const live = publishedPage(page, page.draft, built.published, 2000);
		expect(live.published_version).toBe(1);
		expect(pageState(live)).toBe('published');
		const changed = { ...live, draft: movePlacement(live.draft, live.draft.screens[0].id, 1) };
		expect(pageState(changed)).toBe('changed');
	});
});

describe('page text in each language', () => {
	it('is held by text id, then language, as the translation table has it, and back', () => {
		const translations = definitionToTranslations({
			...presetDefinition(),
			localizations: { ja: { title: '口座', description: '' }, de: { description: 'Konto' } }
		});
		expect(translations).toEqual({ title: { ja: '口座' }, description: { de: 'Konto' } });
		expect(
			translationsToLocalizations({
				title: { ja: ' 口座 ', en: '' },
				description: { de: 'Konto', ja: '説明' }
			})
		).toEqual({ ja: { title: '口座', description: '説明' }, de: { description: 'Konto' } });
		expect(translationsToLocalizations({})).toBeUndefined();
		// What the table writes is what is read back after a save.
		const typed = { title: { ja: '口座' }, description: { ja: '説明' } };
		const stored = translationsToLocalizations(typed);
		expect(definitionToTranslations({ ...presetDefinition(), localizations: stored })).toEqual(
			typed
		);
	});
});

describe('text longer than the page keeps', () => {
	it('is told apart at the limit, so nothing is cut when it is saved', () => {
		expect(translationsTooLong({ title: { ja: 'あ'.repeat(120) } })).toBe(false);
		expect(translationsTooLong({ title: { ja: 'あ'.repeat(121) } })).toBe(true);
		expect(translationsTooLong({ description: { de: 'a'.repeat(1000) } })).toBe(false);
		expect(translationsTooLong({ description: { de: 'a'.repeat(1001) } })).toBe(true);
		// A long description is fine as a description, too long only as a heading.
		expect(translationsTooLong({ title: { de: 'a'.repeat(500) } })).toBe(true);
		expect(translationsTooLong({})).toBe(false);
	});
});

describe('a screen changed since the page was published', () => {
	it('makes the page changed again, though its places are the same', () => {
		const page: PageRecord = newPage([], 'A page', 1000);
		const built = buildPublication(page.draft, ALL, '2026-11-23T00:00:00.000Z');
		if (!built.ok) throw new Error('built');
		const live = publishedPage(page, page.draft, built.published, 2000);
		expect(pageState(live, ALL)).toBe('published');
		const edited = ALL.map((s, index) => (index === 0 ? { ...s, version: s.version + 1 } : s));
		expect(pageState(live, edited)).toBe('changed');
		expect(snapshotsStale(live, ALL.slice(1))).toBe(true);
		// Without the screens to compare with, only the page itself is judged.
		expect(pageState(live)).toBe('published');
	});
});
