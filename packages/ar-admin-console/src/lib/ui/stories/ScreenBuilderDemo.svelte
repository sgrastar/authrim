<script lang="ts">
	import { i18n, t } from '$lib/i18n/i18n.svelte';
	import {
		findPart,
		insertPart,
		setColumns,
		type LayoutPart,
		type LayoutRow
	} from '../builder/layout-model';
	import LayoutCanvas from '../builder/LayoutCanvas.svelte';
	import PartPalette, { type PaletteEntry } from '../builder/PartPalette.svelte';
	import PreviewFrame from '../builder/PreviewFrame.svelte';
	import TranslationTable, {
		type TranslationRow,
		type Translations
	} from '../builder/TranslationTable.svelte';
	import Card from '../patterns/Card.svelte';
	import Tabs from '../patterns/Tabs.svelte';
	import { Draft, sameValue } from '../save/draft.svelte';
	import SaveScope from '../save/SaveScope.svelte';
	import PartSettingsPanel from './PartSettingsPanel.svelte';
	import { localized, sample } from './sample';
	import ScreenPreview from './ScreenPreview.svelte';
	import {
		PART_DEFS,
		PART_GROUPS,
		defaultSettings,
		kindDefaults,
		METHODS,
		partName,
		setting,
		type DisplayCondition,
		type PartGroup,
		type PartSettings
	} from './screen-parts';

	/**
	 * Storybook demo after the legacy screen editor (/admin/screens): parts on the left, the
	 * page in rows and columns in the middle, the selected part's (or row's) settings on the
	 * right; a preview; and every text side by side per language. Saved with a SaveScope.
	 */
	interface Screen {
		rows: LayoutRow[];
		settings: Record<string, PartSettings>;
		rowSettings: Record<string, DisplayCondition>;
		translations: Translations;
	}

	let counter = 0;
	const newId = (kind: string) => `${kind.replace(/_widget$/, '')}-${++counter}`;
	const newRowId = () => `row-${++counter}`;
	const part = (kind: string, label: string): LayoutPart => ({ id: newId(kind), kind, label });
	const alwaysShown = (): DisplayCondition => ({ mode: 'always', feature: 'passkey' });

	function seed(): Screen {
		const heading = part('heading', sample('tCreateAccount'));
		const given = part('identity_field', sample('fieldGiven'));
		const family = part('identity_field', sample('fieldFamily'));
		const passkey = part('auth_widget', sample('tWithPasskey'));
		const divider = part('divider', sample('tOr'));
		const mail = part('auth_widget', sample('tEmailCode'));
		const app = part('auth_widget', sample('tWithApp'));
		const other = part('link', sample('tOtherAccount'));
		const rows: LayoutRow[] = [
			[[heading]],
			[[given], [family]],
			[[passkey]],
			[[divider]],
			[[mail], [app]],
			[[other]]
		].map((columns) => ({ id: newRowId(), columns }));
		return {
			rows,
			settings: {
				[heading.id]: defaultSettings(),
				[given.id]: defaultSettings({ field: 'given_name' }),
				[family.id]: defaultSettings({ field: 'family_name' }),
				[passkey.id]: defaultSettings({ method: 'passkey' }),
				[divider.id]: defaultSettings(),
				[mail.id]: defaultSettings({ method: 'mail_otp' }),
				[app.id]: defaultSettings({ method: 'totp' }),
				[other.id]: defaultSettings({ href: '/login' })
			},
			rowSettings: Object.fromEntries(rows.map((row) => [row.id, alwaysShown()])),
			translations: {}
		};
	}

	const screen = new Draft<Screen>(seed());

	let tab = $state('items');
	let selected = $state<string | null>(null);
	let selectedRow = $state<string | null>(null);
	let previewWidth = $state<'mobile' | 'desktop'>('mobile');

	const groups = $derived(
		(Object.keys(PART_GROUPS) as PartGroup[]).map((id) => ({
			id,
			label: localized(PART_GROUPS[id])
		}))
	);
	const entries = $derived<PaletteEntry[]>(
		PART_DEFS.map((def) => ({
			kind: def.kind,
			label: localized(def.name),
			description: localized(def.description),
			icon: def.icon,
			group: def.group
		}))
	);

	const place = $derived(selected ? findPart(screen.value.rows, selected) : null);
	const rowIndex = $derived(
		selectedRow ? screen.value.rows.findIndex((row) => row.id === selectedRow) : -1
	);

	/** A part as saved, found by id (a moved part keeps its identity). */
	const savedPart = (id: string) =>
		screen.saved.rows.flatMap((row) => row.columns.flat()).find((p) => p.id === id);

	/** What a part is: an auth widget by its method ("Passkey"), others by their type. */
	const roleOf = (p: LayoutPart) => {
		const method = screen.value.settings[p.id]?.method;
		const known = p.kind === 'auth_widget' && METHODS.find(([value]) => value === method);
		return known ? setting(known[1]) : partName(p.kind);
	};

	/** New since saving, or its label or settings changed. */
	const partChanged = (p: LayoutPart) => {
		const saved = savedPart(p.id);
		return (
			!saved ||
			saved.label !== p.label ||
			!sameValue(screen.saved.settings[p.id], screen.value.settings[p.id])
		);
	};

	function create(kind: string): LayoutPart {
		const created = part(kind, partName(kind));
		screen.value.settings = {
			...screen.value.settings,
			[created.id]: defaultSettings(kindDefaults(kind))
		};
		return created;
	}

	/** Rows made by a drop get their own settings too. */
	$effect(() => {
		const missing = screen.value.rows.filter((row) => !screen.value.rowSettings[row.id]);
		if (missing.length === 0) return;
		screen.value.rowSettings = {
			...screen.value.rowSettings,
			...Object.fromEntries(missing.map((row) => [row.id, alwaysShown()]))
		};
	});

	/** Clicking a palette entry adds the part after the selected one, or at the end. */
	function add(kind: string) {
		const created = create(kind);
		const target = place
			? {
					kind: 'column' as const,
					rowId: screen.value.rows[place.row].id,
					column: place.column,
					index: place.index + 1
				}
			: { kind: 'row' as const, index: screen.value.rows.length };
		screen.value.rows = insertPart(screen.value.rows, created, target, newRowId);
		selected = created.id;
		selectedRow = null;
	}

	/** Every text of the page: labels, and the other texts a part has. */
	const texts = $derived<TranslationRow[]>(
		screen.value.rows.flatMap((row) =>
			row.columns.flat().flatMap((p) => {
				const extra = screen.value.settings[p.id];
				const name = roleOf(p);
				/** "Input field · Placeholder": which text of the part this is. */
				const of = (what: string) => `${name} · ${what}`;
				const rowsOf: TranslationRow[] = [];
				if (p.label) rowsOf.push({ id: p.id, label: name, source: p.label });
				if (extra?.text) {
					rowsOf.push({ id: `${p.id}.text`, label: of(setting('body')), source: extra.text });
				}
				if (extra?.placeholder) {
					rowsOf.push({
						id: `${p.id}.placeholder`,
						label: of(setting('placeholder')),
						source: extra.placeholder
					});
				}
				if (extra?.helpText) {
					rowsOf.push({
						id: `${p.id}.helpText`,
						label: of(setting('helpText')),
						source: extra.helpText
					});
				}
				// Linked choices are translated on the schema, with the values they label.
				// TODO(api): screen-local option labels go to
				// ScreenLocalization.fields[block_id].options[value]; the other rows here map to
				// fields[block_id].label / text / placeholder / help_text as today.
				for (const option of extra && !extra.linked ? extra.options : []) {
					if (!option.label) continue;
					rowsOf.push({
						id: `${p.id}.option.${option.value}`,
						label: of(t('options.legend')),
						source: option.label
					});
				}
				return rowsOf;
			})
		)
	);

	const languageName = (code: string) =>
		new Intl.DisplayNames([code], { type: 'language' }).of(code) ?? code;
	const targetCodes = $derived(
		['en', 'de', 'fr', 'es', 'ko', 'ar', 'ja'].filter((code) => code !== i18n.locale)
	);

	// TODO(api): saving writes fields_json (parts in row order, with each row's columns and
	// display condition, see screen-parts.ts) and localizations_json in one request, and the
	// Admin API validates bindings (SCHEMA_TYPES_FOR) and option values before storing.
	const save = () => new Promise((resolve) => setTimeout(resolve, 900)).then(() => {});
</script>

<SaveScope draft={screen} onsave={save}>
	<Tabs
		label={sample('screenName')}
		bind:value={tab}
		items={[
			{ id: 'items', label: sample('tabItems'), icon: 'list' },
			{ id: 'preview', label: sample('tabPreview'), icon: 'app' },
			{ id: 'localize', label: sample('tabLocalize'), icon: 'translate' }
		]}
	>
		{#snippet panel(current)}
			{#if current === 'items'}
				<p class="hint">{sample('builderHint')}</p>
				<div class="builder">
					<Card title={localized(['部品', 'Parts', 'Bausteine', 'الأجزاء'])}>
						<PartPalette {entries} {groups} onadd={add} />
					</Card>
					<LayoutCanvas
						label={sample('screenName')}
						bind:rows={screen.value.rows}
						bind:selected
						bind:selectedRow
						{create}
						changed={partChanged}
						role={roleOf}
					/>
					{#if place}
						{@const chosen = screen.value.rows[place.row].columns[place.column][place.index]}
						<PartSettingsPanel
							bind:part={screen.value.rows[place.row].columns[place.column][place.index]}
							bind:settings={screen.value.settings[chosen.id]}
							isNew={!savedPart(chosen.id)}
							labelChanged={!!savedPart(chosen.id) && savedPart(chosen.id)?.label !== chosen.label}
						/>
					{:else if rowIndex >= 0}
						{@const row = screen.value.rows[rowIndex]}
						<PartSettingsPanel
							{row}
							rowNumber={rowIndex + 1}
							isNew={!screen.saved.rowSettings[row.id]}
							bind:rowCondition={screen.value.rowSettings[row.id]}
							oncolumns={(count) =>
								(screen.value.rows = setColumns(screen.value.rows, row.id, count))}
						/>
					{:else}
						<PartSettingsPanel />
					{/if}
				</div>
			{:else if current === 'preview'}
				<PreviewFrame label={sample('screenName')} bind:width={previewWidth}>
					<ScreenPreview
						rows={screen.value.rows}
						settings={screen.value.settings}
						rowSettings={screen.value.rowSettings}
					/>
				</PreviewFrame>
			{:else}
				<TranslationTable
					label={sample('tabLocalize')}
					field="translations"
					source={{ code: i18n.locale, name: languageName(i18n.locale) }}
					locales={targetCodes.map((code) => ({ code, name: languageName(code) }))}
					rows={texts}
					bind:values={screen.value.translations}
				/>
			{/if}
		{/snippet}
	</Tabs>
</SaveScope>

<style>
	.hint {
		margin: 0 0 14px;
		color: var(--text-secondary);
		font-size: var(--fs-body);
	}

	.builder {
		display: grid;
		grid-template-columns: minmax(250px, 290px) minmax(0, 1fr) minmax(260px, 320px);
		gap: var(--space-section);
		align-items: start;
	}

	@media (max-width: 1080px) {
		.builder {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
