<script lang="ts">
	import { tick } from 'svelte';
	import { ALL_CATEGORY_META } from '@authrim/ar-lib-core/types/settings/catalog';
	import type { SettingMeta } from '@authrim/ar-lib-core/utils/settings-manager';
	import { hasMessage, t } from '$lib/i18n/i18n.svelte';
	import { PLATFORM_AREAS, TENANT_AREAS } from '$lib/shell/nav-data';
	import Card from '$lib/ui/patterns/Card.svelte';
	import Badge from '$lib/ui/primitives/Badge.svelte';
	import Checkbox from '$lib/ui/primitives/Checkbox.svelte';
	import SearchField from '$lib/ui/primitives/SearchField.svelte';
	import Select from '$lib/ui/primitives/Select.svelte';
	import { API_GROUPS, API_PAGES, OPERATIONS_OF, type ApiRow } from './api-inventory';
	import { API_OPERATIONS } from './api-operations';
	import { NOT_APPLIED, type NotApplied } from './effect';
	import SettingsMapApis from './SettingsMapApis.svelte';
	import { DRAFT, DRAFT_PAGES, type DraftPage } from './inventory';
	import { categoryOf, SETTINGS_PAGES, type Depth } from './placement';
	import { settingText } from './setting-text';

	/**
	 * Every Settings API setting and where it lives — built pages and the draft together —
	 * for reviewing the inventory (Storybook: Pages › Settings map). Grouped by page, then
	 * section; a setting with no place would show at the top in red (the placement test fails
	 * first). Each page also lists the other Admin APIs it uses (api-inventory.ts).
	 *
	 * One header category shows at a time (all of them at once is slow to draw); a search looks
	 * through every category.
	 */
	interface Row {
		/** Number across the whole map (#1…), for pointing at a setting in a review. */
		no: number;
		key: string;
		category: string;
		label: string;
		apiLabel: string;
		section: string;
		depth: Depth;
		duplicateOf?: string;
		note?: string;
		/** Why a saved value does not change anything yet (`effect.ts`); absent: applied. */
		notApplied?: NotApplied;
	}

	interface Group {
		/** Page number (P1…). */
		no: number;
		id: string;
		/** The header category the page is under ('other': pages outside the navigation). */
		area: string;
		title: string;
		status: 'built' | 'draft' | 'proposed' | 'hidden';
		scope: DraftPage['scope'];
		note?: string;
		rows: Row[];
		/** The other Admin APIs the page uses. */
		apis: ApiRow[];
	}

	const DEPTHS: readonly Depth[] = ['primary', 'advanced', 'search', 'hidden'];

	function metaOf(key: string): SettingMeta {
		return ALL_CATEGORY_META[categoryOf(key)].settings[key] as SettingMeta;
	}

	/** "Authentication › Protection" for a navigation item, else the draft's working name. */
	function pageTitle(id: string, fallback?: string): string {
		const [areaId, itemId] = id.split('/');
		const area = [...TENANT_AREAS, ...PLATFORM_AREAS].find((a) => a.id === areaId);
		const item = area?.children.find((c) => c.id === itemId);
		return area && item ? `${t(area.label)} › ${t(item.label)}` : (fallback ?? id);
	}

	function row(
		key: string,
		section: string,
		depth: Depth,
		extra: Partial<Row> = {}
	): Omit<Row, 'no'> {
		const meta = metaOf(key);
		const text = settingText(key);
		return {
			key,
			category: categoryOf(key),
			label: hasMessage(text.label) ? t(text.label) : meta.label,
			apiLabel: meta.label,
			section,
			depth,
			notApplied: NOT_APPLIED.get(key),
			...extra
		};
	}

	type Unnumbered = Omit<Group, 'no' | 'area' | 'rows' | 'apis'> & { rows: Omit<Row, 'no'>[] };

	const AREAS = [...TENANT_AREAS, ...PLATFORM_AREAS];

	/** The header category of a page: the first part of its id, else 'other'. */
	function areaOf(id: string): string {
		const head = id.split('/')[0];
		return AREAS.some((area) => area.id === head) ? head : 'other';
	}

	/** Navigation items in navigation order, for pages that only have APIs. */
	const NAV_ORDER = [...TENANT_AREAS, ...PLATFORM_AREAS].flatMap((area) =>
		area.children.map((item) => `${area.id}/${item.id}`)
	);

	/** Rows in the order they show: section by section, as first met. */
	function bySection<R extends { section: string }>(rows: R[]): R[] {
		const order: string[] = [];
		for (const r of rows) if (!order.includes(r.section)) order.push(r.section);
		return order.flatMap((section) => rows.filter((r) => r.section === section));
	}

	const groups = $derived.by((): Group[] => {
		const built: Unnumbered[] = SETTINGS_PAGES.map((page) => ({
			id: page.nav,
			title: pageTitle(page.nav),
			status: 'built',
			scope: 'tenant',
			rows: page.sections.flatMap((section) =>
				section.settings.map((s) => row(s.key, t(section.title), s.depth))
			)
		}));
		const drafted: Unnumbered[] = DRAFT_PAGES.map((page) => ({
			id: page.id,
			title: pageTitle(page.id, page.title),
			status: page.id === 'hidden' ? 'hidden' : page.proposed ? 'proposed' : 'draft',
			scope: page.scope,
			note: page.note,
			rows: DRAFT.filter((e) => e.page === page.id).map((e) =>
				row(e.key, e.section, e.depth, { duplicateOf: e.duplicateOf, note: e.note })
			)
		}));
		// Pages with APIs but no settings come after, in navigation order, then the API-only ones.
		const withSettings = new Set([...built, ...drafted].map((group) => group.id));
		const apiPages = [...new Set(API_GROUPS.map((group) => group.page))].filter(
			(id) => !withSettings.has(id)
		);
		const rank = (id: string) => {
			const i = NAV_ORDER.indexOf(id);
			return i === -1 ? NAV_ORDER.length + API_PAGES.findIndex((p) => p.id === id) : i;
		};
		const apiOnly: Unnumbered[] = apiPages
			.sort((a, b) => rank(a) - rank(b))
			.map((id) => {
				const page = API_PAGES.find((p) => p.id === id);
				return {
					id,
					title: pageTitle(id, page?.title),
					status: id === 'outside' ? 'hidden' : page?.proposed ? 'proposed' : 'draft',
					scope: page?.scope ?? (id.startsWith('plat-') ? 'platform' : 'tenant'),
					note: page?.note,
					rows: []
				};
			});
		// Numbered once over everything, before any filter: a number stays with its setting.
		let n = 0;
		let a = 0;
		return [...built, ...drafted, ...apiOnly].map((group, i) => ({
			...group,
			no: i + 1,
			area: areaOf(group.id),
			rows: bySection(group.rows).map((r) => ({ ...r, no: ++n })),
			apis: API_GROUPS.filter((api) => api.page === group.id).map((api) => ({
				no: ++a,
				group: api,
				operations: OPERATIONS_OF.get(api.id) ?? []
			}))
		}));
	});

	const everyKey = Object.values(ALL_CATEGORY_META).flatMap((meta) => Object.keys(meta.settings));
	const placedKeys = $derived(new Set(groups.flatMap((g) => g.rows.map((r) => r.key))));
	const unplaced = $derived(everyKey.filter((key) => !placedKeys.has(key)));

	let query = $state('');
	let depth = $state<'all' | Depth>('all');
	let flaggedOnly = $state(false);
	let effect = $state<'all' | 'applied' | 'not-applied'>('all');
	let show = $state<'both' | 'settings' | 'apis'>('both');
	/** The header category shown ('' until chosen: the first one; 'all': every one). */
	let area = $state('');

	/** Header categories with pages, in navigation order, then the pages outside it. */
	const areaOptions = $derived.by(() => {
		const present = new Set(groups.map((g) => g.area));
		const options = AREAS.filter((a) => present.has(a.id)).map((a) => ({
			value: a.id,
			label: PLATFORM_AREAS.includes(a) ? `${t(a.label)} (platform)` : t(a.label)
		}));
		if (present.has('other')) options.push({ value: 'other', label: 'Outside the navigation' });
		return options;
	});
	const activeArea = $derived(area || areaOptions[0]?.value || 'all');
	const searching = $derived(query.trim() !== '');

	/** Show a page: its category first (links cannot jump inside Storybook's frame). */
	async function goTo(id: string) {
		if (!searching) area = areaOf(id);
		await tick();
		document.getElementById(anchor(id))?.scrollIntoView({ block: 'start' });
	}

	function matches(r: Row): boolean {
		if (depth !== 'all' && r.depth !== depth) return false;
		if (flaggedOnly && !r.duplicateOf && !r.note) return false;
		if (effect !== 'all' && (effect === 'not-applied') !== Boolean(r.notApplied)) return false;
		const q = query.trim().toLowerCase().replace(/^#/, '');
		return (
			!q ||
			String(r.no) === q ||
			[r.key, r.label, r.apiLabel, r.section].some((text) => text.toLowerCase().includes(q))
		);
	}

	/** An API group matches the search only (the other filters are about settings). */
	function matchesApi(api: ApiRow): boolean {
		const q = query.trim().toLowerCase().replace(/^a/, '');
		const text = query.trim().toLowerCase();
		return (
			!text ||
			String(api.no) === q ||
			[api.group.id, api.group.name, api.group.overlaps ?? '', ...api.group.paths].some((t) =>
				t.toLowerCase().includes(text)
			)
		);
	}

	const settingsFiltered = $derived(depth !== 'all' || effect !== 'all' || flaggedOnly);

	const shown = $derived(
		groups
			.filter((g) => searching || activeArea === 'all' || g.area === activeArea)
			.map((g) => ({
				...g,
				rows: show === 'apis' ? [] : g.rows.filter(matches),
				apis: show === 'settings' || settingsFiltered ? [] : g.apis.filter(matchesApi)
			}))
			.filter((g) => g.rows.length > 0 || g.apis.length > 0)
	);

	const allApis = $derived(groups.flatMap((g) => g.apis));

	const all = $derived(groups.flatMap((g) => g.rows));
	const count = (d: Depth) => all.filter((r) => r.depth === d).length;

	function sections(rows: Row[]): [string, Row[]][] {
		const bySection: Record<string, Row[]> = {};
		for (const r of rows) (bySection[r.section] ??= []).push(r);
		return Object.entries(bySection);
	}

	/**
	 * The navigation as it will look: every header category, its left-nav items in order, and
	 * how many settings each page gets. Items the draft proposes join their category.
	 */
	interface NavEntry {
		/** Page number (P1…), when the page has settings. */
		no?: number;
		id: string;
		label: string;
		proposed: boolean;
		counts: Partial<Record<Depth, number>>;
		total: number;
		/** API groups the page uses. */
		apis: number;
	}

	const navMap = $derived.by(() => {
		const byId = new Map(groups.map((g) => [g.id, g]));
		const tally = (id: string) => {
			const group = byId.get(id);
			const rows = group?.rows ?? [];
			const counts: Partial<Record<Depth, number>> = {};
			for (const r of rows) counts[r.depth] = (counts[r.depth] ?? 0) + 1;
			return { no: group?.no, counts, total: rows.length, apis: group?.apis.length ?? 0 };
		};
		return [...TENANT_AREAS, ...PLATFORM_AREAS]
			.filter((area) => area.children.length > 0)
			.map((area) => {
				const items: NavEntry[] = area.children.map((item) => ({
					id: `${area.id}/${item.id}`,
					label: t(item.label),
					proposed: false,
					...tally(`${area.id}/${item.id}`)
				}));
				for (const page of DRAFT_PAGES.filter(
					(p) => p.proposed && p.id.startsWith(`${area.id}/`)
				)) {
					items.push({
						id: page.id,
						label: page.title ?? page.id,
						proposed: true,
						...tally(page.id)
					});
				}
				return {
					id: area.id,
					label: t(area.label),
					platform: PLATFORM_AREAS.includes(area),
					items
				};
			});
	});

	const anchor = (id: string) => `map-${id.replace('/', '-')}`;

	const STATUS_TONE = {
		built: 'success',
		draft: 'neutral',
		proposed: 'info',
		hidden: 'neutral'
	} as const;
</script>

<div class="map">
	<Card
		title="Settings map"
		description="Where every Settings API setting lives, built pages and the draft, and which other Admin APIs (dedicated settings, records, actions, logs) each page uses."
	>
		<dl class="map__totals">
			<div>
				<dt>Settings</dt>
				<dd>{all.length} / {everyKey.length}</dd>
			</div>
			{#each DEPTHS as d (d)}
				<div>
					<dt>{d}</dt>
					<dd>{count(d)}</dd>
				</div>
			{/each}
			<div>
				<dt>not applied</dt>
				<dd>{all.filter((r) => r.notApplied).length}</dd>
			</div>
			<div>
				<dt>duplicates</dt>
				<dd>{all.filter((r) => r.duplicateOf).length}</dd>
			</div>
			<div>
				<dt>pages</dt>
				<dd>{groups.filter((g) => g.status !== 'hidden').length}</dd>
			</div>
			<div>
				<dt>API groups</dt>
				<dd>{allApis.length}</dd>
			</div>
			<div>
				<dt>API operations</dt>
				<dd>
					{allApis.reduce((n, api) => n + api.operations.length, 0)} / {API_OPERATIONS.length}
				</dd>
			</div>
		</dl>
		<div class="map__filters">
			<Select
				label="Category"
				size="sm"
				inline
				value={activeArea}
				onchange={(value: string) => (area = value)}
				options={[...areaOptions, { value: 'all', label: 'All categories (slow)' }]}
			/>
			<SearchField label="Search all categories" size="sm" bind:value={query} />
			<Select
				label="Show"
				size="sm"
				inline
				bind:value={show}
				options={[
					{ value: 'both', label: 'Settings and APIs' },
					{ value: 'settings', label: 'Settings only' },
					{ value: 'apis', label: 'APIs only' }
				]}
			/>
			<Select
				label="Depth"
				size="sm"
				inline
				bind:value={depth}
				options={[
					{ value: 'all', label: 'All depths' },
					...DEPTHS.map((d) => ({ value: d, label: d }))
				]}
			/>
			<Select
				label="Effect"
				size="sm"
				inline
				bind:value={effect}
				options={[
					{ value: 'all', label: 'Applied or not' },
					{ value: 'applied', label: 'Applied' },
					{ value: 'not-applied', label: 'Not applied yet' }
				]}
			/>
			<Checkbox size="sm" bind:checked={flaggedOnly}>Notes and duplicates only</Checkbox>
		</div>
	</Card>

	{#if unplaced.length > 0}
		<Card title="Not placed" tone="warning">
			<ul class="map__unplaced">
				{#each unplaced as key (key)}<li><code>{key}</code></li>{/each}
			</ul>
		</Card>
	{/if}

	<Card
		title="By navigation item"
		description="Each item is a page in the left navigation, grouped by header category. The numbers are the settings on the page (primary / advanced / search) and the other API groups it uses."
	>
		<div class="nav-map">
			{#each navMap as area (area.id)}
				<section class="nav-map__area">
					<h3 class="nav-map__title">
						{area.label}{#if area.platform}<Badge>platform</Badge>{/if}
					</h3>
					<ul class="nav-map__items">
						{#each area.items as item (item.id)}
							<li class="nav-map__item" class:is-empty={item.total === 0 && item.apis === 0}>
								{#if item.total > 0 || item.apis > 0}
									<span class="map__no">P{item.no}</span>
									<a
										href="#{anchor(item.id)}"
										onclick={(event) => {
											event.preventDefault();
											void goTo(item.id);
										}}>{item.label}</a
									>
								{:else}
									<span>{item.label}</span>
								{/if}
								{#if item.proposed}<Badge tone="info">proposed</Badge>{/if}
								<span class="nav-map__counts">
									{#if item.total > 0}
										{item.counts.primary ?? 0} / {item.counts.advanced ?? 0} / {item.counts
											.search ?? 0}
									{:else}—{/if}
									{#if item.apis > 0}· {item.apis} API{/if}
								</span>
							</li>
						{/each}
					</ul>
				</section>
			{/each}
		</div>
	</Card>

	{#each shown as group (group.id)}
		<div class="map__group" id={anchor(group.id)}>
			<Card title="P{group.no}  {group.title}" description={group.note} flush>
				{#snippet actions()}
					<span class="map__marks">
						<Badge tone={STATUS_TONE[group.status]}>{group.status}</Badge>
						<Badge>{group.scope === 'client' ? 'app' : group.scope}</Badge>
						{#if group.rows.length > 0}<Badge>{group.rows.length}</Badge>{/if}
						{#if group.apis.length > 0}<Badge>{group.apis.length} API</Badge>{/if}
					</span>
				{/snippet}
				{#if group.rows.length > 0}
					<table class="map__table">
						<colgroup>
							<col class="map__col-no" />
							<col class="map__col-setting" />
							<col class="map__col-depth" />
							<col />
						</colgroup>
						<thead>
							<tr>
								<th scope="col">#</th>
								<th scope="col">Setting</th>
								<th scope="col">Depth</th>
								<th scope="col">Note</th>
							</tr>
						</thead>
						{#each sections(group.rows) as [section, rows] (section)}
							<tbody>
								<tr class="map__section"><th colspan="4" scope="rowgroup">{section}</th></tr>
								{#each rows as r (r.key)}
									<tr>
										<td class="map__no">#{r.no}</td>
										<td>
											<span class="map__label">{r.label}</span>
											<code class="map__key" dir="ltr">{r.key}</code>
											{#if r.notApplied}
												<span class="map__effect">not applied · {r.notApplied}</span>
											{/if}
										</td>
										<td><span class="map__depth map__depth--{r.depth}">{r.depth}</span></td>
										<td class="map__note">
											{#if r.duplicateOf}
												<span>Same as <code dir="ltr">{r.duplicateOf}</code>.</span>
											{/if}
											{#if r.note}<span>{r.note}</span>{/if}
										</td>
									</tr>
								{/each}
							</tbody>
						{/each}
					</table>
				{/if}
				{#if group.apis.length > 0}<SettingsMapApis apis={group.apis} />{/if}
			</Card>
		</div>
	{/each}
</div>

<style>
	.map {
		display: grid;
		gap: var(--space-section);
	}

	.map__totals {
		display: flex;
		flex-wrap: wrap;
		gap: 8px 24px;
		margin: 0 0 16px;
	}

	.map__totals div {
		display: grid;
		gap: 2px;
	}

	.map__totals dt {
		color: var(--text-muted);
		font-size: var(--fs-caption);
	}

	.map__totals dd {
		margin: 0;
		font-size: var(--fs-heading);
		font-weight: var(--fw-semibold);
		font-variant-numeric: tabular-nums;
	}

	.map__filters {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 12px 20px;
	}

	/* The navigation, one block per header category, several side by side. */
	.nav-map {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr));
		gap: 20px 32px;
	}

	.nav-map__title {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 0 0 6px;
		font-size: var(--fs-body);
		font-weight: var(--fw-semibold);
	}

	.nav-map__items {
		display: grid;
		gap: 2px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.nav-map__item {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 3px 0;
		border-top: 1px solid var(--border-subtle);
		font-size: var(--fs-body);
	}

	.nav-map__item a {
		color: var(--info);
	}

	.nav-map__item.is-empty {
		color: var(--text-muted);
	}

	.nav-map__counts {
		margin-inline-start: auto;
		color: var(--text-secondary);
		font-size: var(--fs-caption);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.map__group {
		scroll-margin-top: 16px;
	}

	.map__marks {
		display: inline-flex;
		gap: 6px;
	}

	.map__unplaced {
		margin: 0;
		padding-inline-start: 1.25em;
	}

	.map__table {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--fs-body);
	}

	.map__table th,
	.map__table td {
		padding: 8px var(--box-pad);
		border-top: 1px solid var(--border-subtle);
		text-align: start;
		vertical-align: top;
	}

	.map__table thead th {
		border-top: 0;
		color: var(--text-muted);
		font-size: var(--fs-small);
		font-weight: var(--fw-semibold);
	}

	.map__col-setting {
		width: 45%;
	}

	.map__col-no {
		width: 4rem;
	}

	/* Numbers to point at in a review ("P9 #123"). */
	.map__no {
		color: var(--text-muted);
		font-size: var(--fs-caption);
		font-variant-numeric: tabular-nums;
	}

	.map__col-depth {
		width: 8rem;
	}

	.map__section th {
		background: var(--bg-subtle);
		color: var(--text-secondary);
		font-size: var(--fs-label);
		font-weight: var(--fw-semibold);
	}

	.map__label {
		display: block;
		color: var(--text-primary);
	}

	.map__key {
		color: var(--text-muted);
		font-size: var(--fs-small);
	}

	.map__effect {
		display: block;
		margin-top: 2px;
		color: var(--warning-text);
		font-size: var(--fs-small);
	}

	.map__depth {
		font-size: var(--fs-caption);
		font-weight: var(--fw-semibold);
	}

	.map__depth--primary {
		color: var(--info);
	}

	.map__depth--advanced {
		color: var(--text-primary);
	}

	.map__depth--search,
	.map__depth--hidden {
		color: var(--text-muted);
	}

	.map__note {
		display: grid;
		gap: 2px;
		color: var(--text-secondary);
		font-size: var(--fs-caption);
	}
</style>
