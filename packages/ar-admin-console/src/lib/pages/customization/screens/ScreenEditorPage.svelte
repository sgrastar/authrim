<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import {
		LOGIN_UI_LOCALES,
		getLoginUILanguageDisplayName
	} from '@authrim/ar-lib-core/types/login-ui-languages';
	import { ApiError } from '#lib/api/api-error.js';
	import {
		SCREEN_KINDS,
		type Screen,
		type ScreenField,
		type ScreensClient,
		type ScreenUsage
	} from '#lib/api/screens.js';
	import { t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
	import {
		findPart,
		insertPart,
		setColumns,
		type LayoutPart
	} from '#lib/ui/builder/layout-model.js';
	import LayoutCanvas from '#lib/ui/builder/LayoutCanvas.svelte';
	import PartPalette from '#lib/ui/builder/PartPalette.svelte';
	import PreviewFrame from '#lib/ui/builder/PreviewFrame.svelte';
	import TranslationTable, { type TranslationRow } from '#lib/ui/builder/TranslationTable.svelte';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import ConfirmDialog from '#lib/ui/patterns/ConfirmDialog.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import Tabs from '#lib/ui/patterns/Tabs.svelte';
	import BackLink from '#lib/ui/primitives/BackLink.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import Checkbox from '#lib/ui/primitives/Checkbox.svelte';
	import SegmentedControl from '#lib/ui/primitives/SegmentedControl.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import TextArea from '#lib/ui/primitives/TextArea.svelte';
	import TextField from '#lib/ui/primitives/TextField.svelte';
	import { Draft, sameValue } from '#lib/ui/save/draft.svelte.js';
	import { SaveStopped } from '#lib/ui/save/save-scope.js';
	import SaveScope from '#lib/ui/save/SaveScope.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import PartSettingsPanel from './PartSettingsPanel.svelte';
	import {
		kindsFor,
		newPartSettings,
		paletteEntries,
		paletteGroups,
		roleOf,
		translationRows
	} from './screen-builder';
	import { newPartLabel, partName } from './screen-copy';
	import { screenErrorKey } from './screen-errors';
	import {
		builderToFields,
		fieldsToBuilder,
		isLegacyYesNo,
		legacyYesNoIds,
		type BuilderScreen
	} from './screen-layout';
	import {
		ACCOUNT_KINDS,
		INPUT_KINDS,
		defaultCondition,
		fieldFits,
		type ChoiceSource,
		type SchemaField
	} from './screen-model';
	import {
		SCREEN_TEXT,
		localizationsToTranslations,
		translationsToLocalizations
	} from './screen-texts';
	import ScreenPreview from './ScreenPreview.svelte';
	import ScreenResponses from './ScreenResponses.svelte';
	import ScreenUsages from './ScreenUsages.svelte';
	import { editorValue, newScreenValue, type EditorValue } from './screen-editor';

	/**
	 * A screen's page: a new one (`id` "new") or a saved one. Its basics, then tabs: the builder
	 * (parts on the left, the page in rows in the middle, the selected part's settings on the
	 * right), a preview, the translations, where it is used and, for a screen that keeps response
	 * records, what people answered. A built-in screen is shown, not edited: it is duplicated to be
	 * changed. A save names the version it was made from, so another admin's save is not lost.
	 */
	interface Props {
		client: ScreensClient;
		/** The screen, or "new". */
		id: string;
		canWrite: boolean;
		/** May read the response records (they are personal data). */
		canReadResponses: boolean;
		/** The tenant's attributes, and an enum attribute's choices. */
		schemaFields: readonly SchemaField[];
		choices: ChoiceSource;
		/** The attributes the Identity Schema requires at sign-up. */
		requiredAtSignUp?: readonly string[];
		/** Where the Identity Schema is edited. */
		schemaHref?: string;
		/** The list's address (the way back). */
		listHref: string;
		/** A new screen was saved: it has an id now (the page's address follows). */
		oncreated: (id: string) => void;
		/** A copy was made to edit: open it. */
		onopen: (id: string) => void;
	}

	let {
		client,
		id,
		canWrite,
		canReadResponses,
		schemaFields,
		choices,
		requiredAtSignUp = [],
		schemaHref,
		listHref,
		oncreated,
		onopen
	}: Props = $props();

	const isNew = $derived(id === 'new');

	let phase = $state<'loading' | 'ready' | 'missing' | 'failed'>('loading');
	let draft = $state(new Draft<EditorValue>(newScreenValue()));
	/** The screen as loaded (none for a new one), and the field each part was read from. */
	let loaded = $state<Screen | null>(null);
	// Plain objects (raw state): what a part was read from goes back to the API as it was.
	let origins = $state.raw<BuilderScreen['origins']>({});
	let version = 0;
	let usages = $state<ScreenUsage[]>([]);
	let usagesComplete = $state(true);
	let tab = $state('items');
	let selected = $state<string | null>(null);
	let selectedRow = $state<string | null>(null);
	let previewWidth = $state<'mobile' | 'desktop'>('mobile');
	let resetting = $state(false);
	let copying = $state(false);

	const isSystem = $derived(loaded?.is_system === true);
	const readonly = $derived(isSystem || !canWrite);
	const value = $derived(draft.value);

	let counter = 0;
	const newId = (prefix: string) =>
		`${prefix.replace(/_widget$/u, '')}-${Date.now().toString(36)}-${++counter}`;

	// The page is gone or moved on (another screen, another tenant): a save under way stops.
	let gone = false;
	onDestroy(() => (gone = true));
	/** The latest load: an earlier one answering late (the page moved on) is not taken. */
	let loads = 0;

	function take(screen: Screen, found: { usages: ScreenUsage[]; complete: boolean }) {
		const read = fieldsToBuilder(screen.fields, newId);
		origins = read.origins;
		loaded = screen;
		version = screen.version;
		usages = found.usages;
		usagesComplete = found.complete;
		draft = new Draft(
			editorValue(
				screen,
				read,
				localizationsToTranslations(screen.localizations, screen.fields, read)
			)
		);
		tab = screen.is_system || !canWrite ? 'preview' : 'items';
	}

	async function load() {
		const turn = ++loads;
		const target = id;
		const current = () => !gone && turn === loads && id === target;
		phase = 'loading';
		selected = null;
		selectedRow = null;
		if (isNew) {
			loaded = null;
			origins = {};
			version = 0;
			usages = [];
			draft = new Draft(newScreenValue());
			tab = 'items';
			phase = 'ready';
			return;
		}
		try {
			const detail = await client.get(target);
			if (!current()) return;
			take(detail.screen, { usages: detail.usages, complete: detail.usagesComplete });
			phase = 'ready';
		} catch (error) {
			if (!current()) return;
			phase = error instanceof ApiError && error.status === 404 ? 'missing' : 'failed';
		}
	}

	/** The screen this page has just created: its address follows, and nothing is to load. */
	let created: string | null = null;
	$effect(() => {
		const current = id;
		untrack(() => {
			const justCreated = current === created;
			created = null;
			if (!justCreated) void load();
		});
	});

	const builder = (from: EditorValue): BuilderScreen => ({
		rows: from.rows,
		settings: from.settings,
		rowSettings: from.rowSettings,
		origins
	});

	/** What keeps a save from going: the first problem found, in the admin's words. */
	function problemOf(from: EditorValue): string | null {
		if (!from.name.trim()) return t('sc.editor.nameRequired');
		if (isNew && !/^[a-z0-9_-]{1,96}$/u.test(from.key.trim())) return t('sc.editor.keyInvalid');
		const parts = from.rows.flatMap((row) => row.columns.flat());
		if (parts.length === 0) return t('sc.editor.partsRequired');
		// What the API refuses for the screen's kind: a part it cannot hold, a second account widget.
		const allowed = new Set(kindsFor(from.kind));
		const misplaced = parts.find((part) => !allowed.has(part.kind));
		if (misplaced) return t('sc.editor.partNotForKind', { name: partName(misplaced.kind) });
		if (
			from.kind === 'account' &&
			parts.filter((part) => ACCOUNT_KINDS.has(part.kind)).length > 1
		) {
			return t('sc.editor.oneAccountWidget');
		}
		for (const part of parts) {
			if (part.kind !== 'divider' && !part.label.trim()) {
				return t('sc.editor.labelRequired', { name: partName(part.kind) });
			}
			const settings = from.settings[part.id];
			if (INPUT_KINDS.has(part.kind) && settings && !settings.linked) {
				if (!settings.field.trim()) {
					return t('sc.editor.answerKeyRequired', { name: part.label || partName(part.kind) });
				}
				if (settings.answerTargets.length === 0) {
					return t('sc.editor.targetsRequired', { name: part.label || partName(part.kind) });
				}
			}
		}
		return null;
	}

	async function save(from: EditorValue) {
		const problem = problemOf(from);
		if (problem) {
			toast.error(problem);
			throw new SaveStopped();
		}
		const visit = loads;
		const target = id;
		const fields: ScreenField[] = builderToFields(builder(from));
		const input = {
			display_name: from.name.trim(),
			description: from.description.trim() || null,
			screen_key: from.key.trim(),
			screen_kind: from.kind,
			fields,
			localizations: translationsToLocalizations(from.translations, from),
			settings: { ...(loaded?.settings ?? {}), canvas_layout: from.canvas },
			is_active: from.active
		};
		try {
			const saved = isNew
				? await client.create(input)
				: await client.update(target, version, input);
			if (gone || visit !== loads) throw new SaveStopped();
			// What was saved is what the parts are now read from.
			origins = fieldsToBuilder(saved.fields, newId).origins;
			loaded = saved;
			version = saved.version;
			if (isNew) {
				created = saved.id;
				toast.success(t('sc.editor.created'));
				oncreated(saved.id);
			} else {
				toast.success(t('sc.editor.saved'));
			}
		} catch (error) {
			if (error instanceof SaveStopped) throw error;
			const key = screenErrorKey(error, 'sc.editor.saveFailed');
			// A refused part is named by the API (which part, and why).
			toast.error(
				key === 'sc.editor.saveFailed' && error instanceof ApiError && error.status === 400
					? `${t(key)}: ${error.message}`
					: t(key)
			);
			throw new SaveStopped();
		}
	}

	async function copyToEdit() {
		if (!loaded) return;
		copying = true;
		// The screen as plain data (what the page holds is reactive state).
		const source = $state.snapshot(loaded) as Screen;
		// The visit the copy is for: the page moved on (or is gone), and the copy opens nothing.
		const visit = loads;
		const target = id;
		try {
			const copy = await client.create({
				display_name: t('sc.copy.name', { name: source.display_name }).slice(0, 200),
				description: source.description,
				screen_key: `${source.screen_key.slice(0, 80)}_copy_${Date.now().toString(36)}`,
				screen_kind: source.screen_kind,
				fields: source.fields,
				localizations: source.localizations,
				settings: {
					...source.settings,
					base_preset_key: source.screen_key,
					base_preset_version: 1
				},
				is_active: source.is_active
			});
			if (gone || visit !== loads || target !== id) return;
			toast.success(t('sc.toast.copied'));
			onopen(copy.id);
		} catch (error) {
			toast.error(t(screenErrorKey(error, 'sc.error.copy')));
		} finally {
			copying = false;
		}
	}

	/** Puts the built-in screen this one was copied from in place of its parts (not saved yet). */
	async function resetToPreset() {
		const baseKey = loaded?.settings.base_preset_key;
		if (!baseKey) return;
		// The visit the reset is for: an answer after the page moved on changes nothing.
		const visit = loads;
		const target = id;
		try {
			const { screens } = await client.list();
			if (gone || visit !== loads || target !== id) return;
			const preset = screens.find((screen) => screen.is_system && screen.screen_key === baseKey);
			if (!preset) throw new ApiError(404, 'not_found', 'Preset not found');
			const read = fieldsToBuilder(preset.fields, newId);
			origins = { ...origins, ...read.origins };
			draft.value.rows = read.rows;
			draft.value.settings = read.settings;
			draft.value.rowSettings = read.rowSettings;
			draft.value.translations = {
				...pickScreenTexts(draft.value.translations),
				...localizationsToTranslations(preset.localizations, preset.fields, read)
			};
			selected = null;
			selectedRow = null;
		} catch (error) {
			toast.error(t(screenErrorKey(error, 'sc.editor.loadFailed')));
		} finally {
			resetting = false;
		}
	}

	/** The translations of the screen's own name and description (kept on a reset). */
	const pickScreenTexts = (from: EditorValue['translations']) =>
		Object.fromEntries(
			[SCREEN_TEXT.name, SCREEN_TEXT.description]
				.filter((key) => from[key])
				.map((key) => [key, from[key]])
		);

	// Builder
	/** The account page's one widget, once placed, is not offered again. */
	const placedParts = $derived(value.rows.flatMap((row) => row.columns.flat()));
	const kinds = $derived(
		value.kind === 'account' && placedParts.some((part) => ACCOUNT_KINDS.has(part.kind))
			? kindsFor(value.kind).filter((kind) => !ACCOUNT_KINDS.has(kind))
			: kindsFor(value.kind)
	);
	const groups = $derived(paletteGroups(kinds));
	const entries = $derived(paletteEntries(kinds));
	const place = $derived(selected ? findPart(value.rows, selected) : null);
	const rowIndex = $derived(
		selectedRow ? value.rows.findIndex((row) => row.id === selectedRow) : -1
	);
	const savedPart = (partId: string) =>
		draft.saved.rows.flatMap((row) => row.columns.flat()).find((p) => p.id === partId);
	const partChanged = (part: LayoutPart) => {
		const saved = savedPart(part.id);
		return (
			!saved ||
			saved.label !== part.label ||
			!sameValue(draft.saved.settings[part.id], value.settings[part.id])
		);
	};
	const role = (part: LayoutPart) => roleOf(part, value.settings[part.id]);

	function create(kind: string): LayoutPart {
		const part = { id: newId(kind), kind, label: newPartLabel(kind, value.kind) };
		draft.value.settings = {
			...draft.value.settings,
			[part.id]: newPartSettings(kind, schemaFields, () => `${kind}_${counter + 1}`)
		};
		return part;
	}

	/** Rows made by a drop get their own settings too. */
	$effect(() => {
		const missing = value.rows.filter((row) => !value.rowSettings[row.id]);
		if (missing.length === 0) return;
		draft.value.rowSettings = {
			...draft.value.rowSettings,
			...Object.fromEntries(missing.map((row) => [row.id, defaultCondition()]))
		};
	});

	/** Clicking a palette entry adds the part after the selected one, or at the end. */
	function add(kind: string, field?: string) {
		const part = create(kind);
		if (field) {
			draft.value.settings[part.id].field = field;
			part.label = field;
		}
		const target = place
			? {
					kind: 'column' as const,
					rowId: value.rows[place.row].id,
					column: place.column,
					index: place.index + 1
				}
			: { kind: 'row' as const, index: value.rows.length };
		draft.value.rows = insertPart(value.rows, part, target, () => newId('row'));
		selected = part.id;
		selectedRow = null;
	}

	/** The attributes the schema requires at sign-up that this sign-up screen does not ask. */
	const missing = $derived.by(() => {
		if (value.kind !== 'registration') return [];
		const asked = new Set(
			value.rows
				.flatMap((row) => row.columns.flat())
				.filter((part) => INPUT_KINDS.has(part.kind) && value.settings[part.id]?.linked)
				.map((part) => value.settings[part.id]?.field)
		);
		return requiredAtSignUp.filter((key) => !asked.has(key));
	});
	/** The part that asks for an attribute: a checkbox a yes/no, a choice an enum, a field the rest. */
	function kindFor(key: string): string {
		const field = schemaFields.find((item) => item.key === key);
		return (
			['identity_field', 'select', 'checkbox'].find((kind) => field && fieldFits(kind, field)) ??
			'identity_field'
		);
	}

	const keepsRecords = (from: EditorValue) =>
		Object.values(from.settings).some(
			(settings) => !settings.linked && settings.answerTargets.includes('record')
		);

	// Translations
	const texts = $derived<TranslationRow[]>([
		{ id: SCREEN_TEXT.name, label: t('sc.editor.name'), source: value.name },
		...(value.description
			? [
					{
						id: SCREEN_TEXT.description,
						label: t('sc.editor.description'),
						source: value.description
					}
				]
			: []),
		...translationRows(value.rows, value.settings)
	]);
	const languages = LOGIN_UI_LOCALES.map((code) => ({
		code,
		name: getLoginUILanguageDisplayName(code, false)
	}));

	const answerLabel = (key: string) => {
		const entry = Object.entries(value.settings).find(
			([, settings]) => !settings.linked && settings.field === key
		);
		const part =
			entry && value.rows.flatMap((row) => row.columns.flat()).find((p) => p.id === entry[0]);
		return part?.label || undefined;
	};
	const answerChoice = (key: string, choice: string) =>
		Object.values(value.settings)
			.find((settings) => !settings.linked && settings.field === key)
			?.options.find((option) => option.value === choice)?.label || undefined;

	const tabs = $derived([
		...(readonly ? [] : [{ id: 'items', label: t('sc.editor.tab.items'), icon: 'list' as const }]),
		{ id: 'preview', label: t('sc.editor.tab.preview'), icon: 'app' as const },
		{ id: 'localize', label: t('sc.editor.tab.localize'), icon: 'translate' as const },
		...(isNew ? [] : [{ id: 'usage', label: t('sc.editor.tab.usage'), icon: 'link' as const }]),
		// Every saved custom screen: records kept before a part stopped keeping them stay readable.
		...(!isNew && canReadResponses && loaded && !loaded.is_system
			? [{ id: 'responses', label: t('sc.editor.tab.responses'), icon: 'clipboardText' as const }]
			: [])
	]);
	const kindOptions = $derived(
		SCREEN_KINDS.map((kind) => ({ value: kind, label: t(`sc.kind.${kind}` as MessageKey) }))
	);
	const title = $derived(value.name.trim() || t('sc.editor.new'));
	const loadMessage: Record<'missing' | 'failed', MessageKey> = {
		missing: 'sc.editor.notFound',
		failed: 'sc.editor.loadFailed'
	};
</script>

<SaveScope {draft} onsave={save} bar={false}>
	{#snippet children(controls)}
		<Page>
			<PageHeader {title}>
				{#snippet back()}
					<BackLink href={listHref}>{t('sc.editor.back')}</BackLink>
				{/snippet}
				{#snippet badges()}
					{#if loaded}
						<Badge tone={loaded.is_system ? 'info' : 'neutral'}>
							{loaded.is_system ? t('sc.source.system') : t('sc.source.custom')}
						</Badge>
						{#if !loaded.is_active}<Badge tone="warning">{t('sc.status.inactive')}</Badge>{/if}
					{/if}
				{/snippet}
				{#snippet actions()}
					{#if phase === 'ready' && isSystem && canWrite}
						<Button variant="primary" icon="copy" loading={copying} onclick={copyToEdit}>
							{t('sc.editor.copyToEdit')}
						</Button>
					{:else if phase === 'ready' && !readonly}
						{#if loaded?.settings.base_preset_key}
							<Button variant="secondary" onclick={() => (resetting = true)}>
								{t('sc.editor.resetPreset')}
							</Button>
						{/if}
						<Button
							variant="primary"
							loading={controls.saving}
							disabled={!controls.dirty && !isNew}
							attention={controls.dirty}
							onclick={controls.save}
						>
							{t('sc.editor.save')}
						</Button>
					{/if}
				{/snippet}
			</PageHeader>

			{#if phase === 'loading'}
				<LoadingState label={t('common.loading')} />
			{:else if phase === 'missing' || phase === 'failed'}
				<EmptyState icon="warningCircle" title={t(loadMessage[phase])}>
					{#snippet action()}
						{#if phase === 'failed'}
							<Button size="sm" onclick={load}>{t('common.retry')}</Button>
						{:else}
							<Button size="sm" href={listHref}>{t('sc.editor.back')}</Button>
						{/if}
					{/snippet}
				</EmptyState>
			{:else}
				{#if isSystem}
					<Callout>{t('sc.editor.systemNote')}</Callout>
				{:else if !canWrite}
					<Callout>{t('sc.editor.readOnly')}</Callout>
				{/if}

				<Card title={t('sc.editor.basics')}>
					<fieldset class="basics" disabled={readonly}>
						<TextField
							field="name"
							label={t('sc.editor.name')}
							maxlength={200}
							required
							bind:value={draft.value.name}
						/>
						<TextField
							field="key"
							label={t('sc.editor.key')}
							hint={t('sc.editor.keyHint')}
							maxlength={96}
							readonly={!isNew}
							required
							bind:value={draft.value.key}
						/>
						<Select
							field="kind"
							label={t('sc.editor.kind')}
							options={kindOptions}
							bind:value={draft.value.kind}
						/>
						<SegmentedControl
							label={t('sc.editor.canvas')}
							hideLabel={false}
							size="sm"
							value={value.canvas}
							options={[
								{ value: 'narrow', label: t('sc.editor.canvasNarrow') },
								{ value: 'wide', label: t('sc.editor.canvasWide') }
							]}
							onchange={(next) => (draft.value.canvas = next === 'wide' ? 'wide' : 'narrow')}
						/>
						<div class="basics__wide">
							<TextArea
								field="description"
								label={t('sc.editor.description')}
								rows={2}
								bind:value={draft.value.description}
							/>
						</div>
						<Checkbox field="active" bind:checked={draft.value.active}
							>{t('sc.editor.active')}</Checkbox
						>
					</fieldset>
				</Card>

				{#if !readonly && missing.length > 0}
					<Callout tone="warning" title={t('sc.editor.missingTitle')}>
						<span class="missing">
							{#each missing as key (key)}
								<Button size="sm" icon="plus" onclick={() => add(kindFor(key), key)}>
									{t('sc.editor.missingAdd', { key })}
								</Button>
							{/each}
						</span>
					</Callout>
				{/if}
				{#if keepsRecords(value)}
					<Callout>{t('sc.editor.recordNote')}</Callout>
				{/if}

				<Tabs label={title} items={tabs} bind:value={tab}>
					{#snippet panel(current)}
						{#if current === 'items'}
							<p class="hint">{t('sc.editor.builderHint')}</p>
							<div class="builder">
								<Card title={t('sc.editor.parts')}>
									<PartPalette {entries} {groups} onadd={(kind) => add(kind)} />
								</Card>
								<LayoutCanvas
									label={title}
									bind:rows={draft.value.rows}
									bind:selected
									bind:selectedRow
									{create}
									changed={partChanged}
									{role}
								/>
								{#if place}
									{@const chosen = value.rows[place.row].columns[place.column][place.index]}
									<PartSettingsPanel
										bind:part={draft.value.rows[place.row].columns[place.column][place.index]}
										bind:settings={draft.value.settings[chosen.id]}
										isNew={!savedPart(chosen.id)}
										labelChanged={!!savedPart(chosen.id) &&
											savedPart(chosen.id)?.label !== chosen.label}
										{schemaFields}
										{choices}
										{schemaHref}
										legacyYesNo={isLegacyYesNo(origins[chosen.id])}
									/>
								{:else if rowIndex >= 0}
									{@const row = value.rows[rowIndex]}
									<PartSettingsPanel
										{row}
										rowNumber={rowIndex + 1}
										isNew={!draft.saved.rowSettings[row.id]}
										bind:rowCondition={draft.value.rowSettings[row.id]}
										oncolumns={(count) =>
											(draft.value.rows = setColumns(value.rows, row.id, count))}
									/>
								{:else}
									<PartSettingsPanel />
								{/if}
							</div>
						{:else if current === 'preview'}
							<PreviewFrame label={title} bind:width={previewWidth}>
								<ScreenPreview
									legacyYesNo={legacyYesNoIds(origins)}
									rows={value.rows}
									settings={value.settings}
									rowSettings={value.rowSettings}
									{choices}
								/>
							</PreviewFrame>
						{:else if current === 'localize'}
							<TranslationTable
								label={t('sc.editor.tab.localize')}
								field="translations"
								source={{ code: '', name: t('sc.editor.sourceText') }}
								locales={languages}
								rows={texts}
								disabled={readonly}
								bind:values={draft.value.translations}
							/>
						{:else if current === 'usage'}
							<ScreenUsages {usages} complete={usagesComplete} />
						{:else if current === 'responses' && loaded}
							<ScreenResponses
								{client}
								screenId={loaded.id}
								labelOf={answerLabel}
								choiceOf={answerChoice}
							/>
						{/if}
					{/snippet}
				</Tabs>
			{/if}
		</Page>
	{/snippet}
</SaveScope>

<ConfirmDialog
	open={resetting}
	title={t('sc.editor.resetTitle')}
	body={t('sc.editor.resetBody')}
	confirmLabel={t('sc.editor.resetPreset')}
	onconfirm={resetToPreset}
	oncancel={() => (resetting = false)}
/>

<style>
	.basics {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--space-field) var(--space-section);
		min-inline-size: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}

	.basics__wide {
		grid-column: 1 / -1;
	}

	.missing {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 8px;
	}

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

	@media (max-width: 720px) {
		.basics {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
