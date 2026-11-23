import { describe, expect, it } from 'vitest';
import type { PageRecord } from '#lib/api/account-pages.js';
import { stepPart } from '#lib/ui/builder/layout-model.js';
import { Draft } from '#lib/ui/save/draft.svelte.js';
import type { Screen } from '#lib/api/screens.js';
import {
	buildPublication,
	canonicalRows,
	hasLauncherSlot,
	launcherIdsOf,
	definitionToTranslations,
	newPage,
	normalizeLayout,
	normalizeDefinition,
	layoutToPlacements,
	placementsToLayout,
	pageState,
	previewBlocks,
	settingsKey,
	parsePagesDocument,
	placementIdFor,
	placementRows,
	presetDefinition,
	publishedPage,
	snapshotsStale,
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

describe('a place id that is also a property of every object', () => {
	const weird = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'];
	const definition = () =>
		normalizeDefinition({
			screens: weird.map((id, at) => ({ id, screen_key: `account_w${at}` }))
		});

	it('is kept as it is, so a link to it still points at it', () => {
		expect(definition().screens.map((p) => p.id)).toEqual(weird);
	});

	it('keeps each place its own settings, whatever its id', () => {
		const placements = definition().screens.map((p, at) => ({ ...p, enabled: at % 2 === 0 }));
		const { rows, settings } = placementsToLayout(placements, []);
		expect(Object.keys(settings)).toEqual(weird.map((id) => settingsKey(id)));
		const back = layoutToPlacements(rows, settings);
		expect(back.map((p) => [p.id, p.enabled])).toEqual(placements.map((p) => [p.id, p.enabled]));
	});

	it('is told changed and put back like any other when its settings change', () => {
		const { settings } = placementsToLayout(definition().screens, []);
		const draft = new Draft({ settings });
		expect(draft.dirty).toBe(false);
		draft.value.settings[settingsKey('__proto__')].enabled = false;
		expect(draft.dirty).toBe(true);
		draft.discard();
		expect(draft.dirty).toBe(false);
		expect(draft.value.settings[settingsKey('__proto__')].enabled).toBe(true);
	});
});

describe('places of a page', () => {
	it('finds the screens that are not yet placed and names a new place after its screen', () => {
		const half = presetDefinition().screens.filter((p) => p.screen_key !== 'account_profile');
		const page = { ...presetDefinition(), screens: half };
		expect(unplaced(page, ALL).map((s) => s.screen_key)).toEqual(['account_profile']);
		expect(placementIdFor(screen('account_profile'), [])).toBe('profile');
		expect(placementIdFor(screen('account_profile'), ['profile'])).toBe('profile-2');
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

describe('the page as rows of columns', () => {
	const ids = (rows: { columns: { id: string }[][] }[]) =>
		rows.map((row) => row.columns.map((column) => column.map((part) => part.id)));

	it('shows a full place as a row of one column and half places side by side as a row of two', () => {
		const preset = presetDefinition();
		const { rows, settings } = placementsToLayout(preset.screens, ALL);
		expect(ids(rows)[0]).toEqual([['overview']]);
		// Profile and devices are half: one row, two columns. Sessions and passkeys likewise.
		expect(ids(rows)[2]).toEqual([['profile'], ['devices']]);
		expect(settings[settingsKey('passkeys')]).toMatchObject({
			condition: 'passkey_enabled',
			enabled: true
		});
	});

	it('gives back the places it was made from', () => {
		const preset = presetDefinition();
		const { rows, settings } = placementsToLayout(preset.screens, ALL);
		expect(layoutToPlacements(rows, settings)).toEqual(preset.screens);
		// A half place alone keeps its width through a row of two columns with one empty.
		const lone = [{ ...preset.screens[2], width: 'half' as const }];
		const made = placementsToLayout(lone, ALL);
		expect(made.rows[0].columns).toHaveLength(2);
		expect(layoutToPlacements(made.rows, made.settings)).toEqual(lone);
	});

	it('is the row that sets the width, so a part moved into a row of two becomes half', () => {
		const { rows, settings } = placementsToLayout(presetDefinition().screens.slice(0, 2), ALL);
		const merged = [{ id: 'r', columns: [rows[0].columns[0], rows[1].columns[0]] }];
		expect(layoutToPlacements(merged, settings).map((p) => p.width)).toEqual(['half', 'half']);
	});

	it('keeps a column to one place and a row to two columns, passing the rest on without loss', () => {
		let n = 0;
		const part = (id: string) => ({ id, kind: id, label: id });
		const rows = normalizeLayout(
			[
				{ id: 'a', columns: [[part('p'), part('q')], [part('r')], [part('s')]] },
				{ id: 'b', columns: [[], []] },
				{ id: 'c', columns: [[part('t')]] }
			],
			() => `new-${++n}`
		);
		expect(ids(rows)).toEqual([[['p'], ['r']], [['q']], [['s']], [['t']]]);
		expect(rows.map((row) => row.columns.length)).toEqual([2, 1, 1, 1]);
	});
});

describe('the layout the page keeps', () => {
	let n = 0;
	const fresh = () => `new-${++n}`;
	const part = (id: string) => ({ id, kind: `account_${id}`, label: id });
	const shape = (rows: { columns: { id: string }[][] }[]) =>
		rows.map((row) => row.columns.map((column) => column.map((p) => p.id)));

	it('moves a part in the second column only to the first, as the stored places say it', () => {
		const rows = canonicalRows([{ id: 'r', columns: [[], [part('a')]] }], fresh);
		expect(shape(rows)).toEqual([[['a'], []]]);
	});

	it('shows a half place followed by a row of two as reloading would: halves pair up in order', () => {
		const rows = canonicalRows(
			[
				{ id: 'r1', columns: [[part('a')], []] },
				{ id: 'r2', columns: [[part('b')], [part('c')]] }
			],
			fresh
		);
		expect(shape(rows)).toEqual([
			[['a'], ['b']],
			[['c'], []]
		]);
		// Row ids stay with the rows they were.
		expect(rows.map((row) => row.id)).toEqual(['r1', 'r2']);
	});

	it('is what is saved and read back: the canvas shows no state the places cannot say', () => {
		const layouts = [
			[{ id: 'a', columns: [[part('x')]] }],
			[
				{ id: 'a', columns: [[part('x')], [part('y')]] },
				{ id: 'b', columns: [[part('z')], []] }
			],
			[
				{ id: 'a', columns: [[part('x')], []] },
				{ id: 'b', columns: [[part('y')], [part('z')]] }
			],
			[
				{ id: 'a', columns: [[], [part('x')]] },
				{ id: 'b', columns: [[part('y')]] }
			]
		];
		for (const layout of layouts) {
			const shown = canonicalRows(layout, fresh);
			const placements = layoutToPlacements(shown, {});
			const back = placementsToLayout(
				placements,
				placements.map((p) => screen(p.screen_key))
			).rows;
			expect(shape(back)).toEqual(shape(shown));
			// Showing it again changes nothing.
			expect(shape(canonicalRows(shown, fresh))).toEqual(shape(shown));
		}
	});

	it('swaps two full-width places by the keyboard: a step past the row, not into its column', () => {
		const rows = [
			{ id: 'r1', columns: [[part('a')]] },
			{ id: 'r2', columns: [[part('b')]] }
		];
		expect(shape(canonicalRows(stepPart(rows, 'b', 'up', fresh, 1), fresh))).toEqual([
			[['b']],
			[['a']]
		]);
		expect(shape(canonicalRows(stepPart(rows, 'a', 'down', fresh, 1), fresh))).toEqual([
			[['b']],
			[['a']]
		]);
	});
});

describe('the keyboard in a row of two', () => {
	let n = 0;
	const fresh = () => `new-${++n}`;
	const part = (id: string) => ({ id, kind: `account_${id}`, label: id });
	const shape = (rows: { columns: { id: string }[][] }[]) =>
		rows.map((row) => row.columns.map((column) => column.map((p) => p.id)));

	it('exchanges two half places side by side, so each keeps its width and the order changes', () => {
		const rows = [{ id: 'r', columns: [[part('a')], [part('b')]] }];
		expect(shape(canonicalRows(stepPart(rows, 'a', 'right', fresh, 1), fresh))).toEqual([
			[['b'], ['a']]
		]);
		expect(shape(canonicalRows(stepPart(rows, 'b', 'left', fresh, 1), fresh))).toEqual([
			[['b'], ['a']]
		]);
		// Into an empty column it simply moves, and an end stays where it is.
		const alone = [{ id: 'r', columns: [[part('a')], []] }];
		expect(shape(stepPart(alone, 'a', 'right', fresh, 1))).toEqual([[[], ['a']]]);
		expect(shape(stepPart(rows, 'a', 'left', fresh, 1))).toEqual([[['a'], ['b']]]);
	});
});

describe('the blocks of a place as the Login UI lays them out', () => {
	const field = (block_type: string, extra: Record<string, unknown> = {}) =>
		({ block_type, label: block_type, ...extra }) as never;
	const withFields = (fields: unknown[]) => screen('account_x', { fields: fields as never });

	it('drops the row markers and keeps the order the blocks ask for', () => {
		const blocks = previewBlocks(
			{ width: 'full' },
			withFields([
				field('text', { order: 2 }),
				field('layout_row', { order: 1 }),
				field('heading', { order: 1 }),
				field('divider')
			])
		);
		expect(blocks.map((b) => b.kind)).toEqual(['divider', 'heading', 'text']);
	});

	it('puts a block in the column it asks for only in a full-width place', () => {
		const fields = [
			field('heading', { layout_column: 1 }),
			field('account_profile_widget', { layout_column: 2 }),
			field('text', { layout_column: 3 }),
			field('divider')
		];
		expect(previewBlocks({ width: 'full' }, withFields(fields)).map((b) => b.column)).toEqual([
			1,
			2,
			null,
			null
		]);
		// A half-width place is one column, whatever the blocks ask for.
		expect(previewBlocks({ width: 'half' }, withFields(fields)).map((b) => b.column)).toEqual([
			null,
			null,
			null,
			null
		]);
	});
});

describe('the launcher slot', () => {
	it('keeps the chosen launchers through the page, the layout and back', () => {
		const definition = normalizeDefinition({
			screens: [
				{ id: 'apps', screen_key: 'account_launchers', launcher_ids: ['a', 'b', 'a', 'bad id'] },
				{ id: 'profile', screen_key: 'account_profile' }
			]
		});
		expect(definition.screens[0].launcher_ids).toEqual(['a', 'b']);
		expect('launcher_ids' in definition.screens[1]).toBe(false);
		const { rows, settings } = placementsToLayout(definition.screens, ALL);
		expect(layoutToPlacements(rows, settings)).toEqual(definition.screens);
		// An empty choice is kept: the slot shows none.
		expect(launcherIdsOf([])).toEqual([]);
		expect(launcherIdsOf('a')).toBeUndefined();
		expect(launcherIdsOf(Array.from({ length: 150 }, (_, i) => `l${i}`))).toHaveLength(100);
	});

	it('is a screen holding the launcher widget; a page can place one', () => {
		const launchers = screen('account_launchers', {
			fields: [{ block_type: 'account_launcher_widget' }] as never
		});
		const second = screen('account_more_apps', {
			fields: [{ block_type: 'account_launcher_widget' }] as never
		});
		expect(hasLauncherSlot(launchers)).toBe(true);
		expect(hasLauncherSlot(screen('account_profile'))).toBe(false);
		expect(hasLauncherSlot(undefined)).toBe(false);
		const place = (id: string, key: string, enabled = true) => ({
			id,
			screen_key: key,
			width: 'full' as const,
			enabled,
			condition: 'always' as const,
			show_for_guests: true
		});
		const draft = {
			...presetDefinition(),
			screens: [place('a', 'account_launchers'), place('b', 'account_more_apps')]
		};
		expect(buildPublication(draft, [launchers, second], '2026-11-23T00:00:00.000Z')).toMatchObject({
			ok: false,
			problem: { code: 'multiple_launcher_slots' }
		});
		// A slot that is switched off is not a second one.
		const off = {
			...presetDefinition(),
			screens: [place('a', 'account_launchers'), place('b', 'account_more_apps', false)]
		};
		expect(buildPublication(off, [launchers, second], '2026-11-23T00:00:00.000Z').ok).toBe(true);
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
		const changed = {
			...live,
			draft: {
				...live.draft,
				screens: live.draft.screens.map((p, i) => (i === 0 ? { ...p, enabled: false } : p))
			}
		};
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
