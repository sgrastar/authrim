<script lang="ts">
	import { tick, untrack } from 'svelte';
	import {
		LOGIN_UI_LOCALES,
		getLoginUILanguageDisplayName
	} from '@authrim/ar-lib-core/types/login-ui-languages';
	import type {
		AccountPagesClient,
		AccountPagesState,
		PageDefinition,
		PageRecord,
		Placement
	} from '#lib/api/account-pages.js';
	import { ApiError } from '#lib/api/api-error.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import PartPalette from '#lib/ui/builder/PartPalette.svelte';
	import TranslationTable, { type Translations } from '#lib/ui/builder/TranslationTable.svelte';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import Tabs from '#lib/ui/patterns/Tabs.svelte';
	import TitleEditor from '#lib/ui/patterns/TitleEditor.svelte';
	import BackLink from '#lib/ui/primitives/BackLink.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import IconButton from '#lib/ui/primitives/IconButton.svelte';
	import TextArea from '#lib/ui/primitives/TextArea.svelte';
	import TextField from '#lib/ui/primitives/TextField.svelte';
	import { Draft } from '#lib/ui/save/draft.svelte.js';
	import { SaveStopped } from '#lib/ui/save/save-scope.js';
	import SaveScope from '#lib/ui/save/SaveScope.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import AccountPageCanvas from './AccountPageCanvas.svelte';
	import AccountPageInspector from './AccountPageInspector.svelte';
	import AccountPagePreview from './AccountPagePreview.svelte';
	import { pagesErrorKey, publishProblemMessage } from './account-page-errors';
	import {
		MAX_PLACEMENTS,
		addPlacement,
		buildPublication,
		definitionToTranslations,
		movePlacement,
		pageState,
		publishedPage,
		removePlacement,
		screenOf,
		translationsTooLong,
		translationsToLocalizations,
		unplaced
	} from './account-page-model';

	/**
	 * One account page: its layout (the screens to place on the left, the page in the middle, the
	 * selected place's settings on the right), a preview, and the page's text in each language.
	 * Save keeps the draft; Publish saves what is on screen and makes it the live page (a snapshot
	 * of every screen it places). There is no rollback: a published page is changed by changing the
	 * draft and publishing again.
	 */
	interface Props {
		client: AccountPagesClient;
		id: string;
		canWrite: boolean;
		listHref: string;
		/** Where a screen is edited, from the screen's id. */
		screenHref?: (screenId: string) => string;
	}

	let { client, id, canWrite, listHref, screenHref }: Props = $props();

	interface EditorValue {
		name: string;
		title: string;
		description: string;
		screens: Placement[];
		translations: Translations;
	}

	const blank = (): EditorValue => ({
		name: '',
		title: '',
		description: '',
		screens: [],
		translations: {}
	});

	let phase = $state<'loading' | 'ready' | 'missing' | 'failed'>('loading');
	let loaded = $state<AccountPagesState | null>(null);
	let draft = $state(new Draft<EditorValue>(blank()));
	let tab = $state('builder');
	let selected = $state<string | null>(null);
	let publishing = $state(false);
	let editingName = $state(false);
	let nameError = $state('');

	const page = $derived(loaded?.document.pages.find((item) => item.id === id));
	const value = $derived(draft.value);
	const readonly = $derived(!canWrite);
	const stateOfPage = $derived(page ? pageState(page, loaded?.screens) : 'unpublished');

	function valueOf(record: PageRecord): EditorValue {
		return {
			name: record.name,
			title: record.draft.title ?? '',
			description: record.draft.description ?? '',
			screens: record.draft.screens.map((item) => ({ ...item })),
			translations: definitionToTranslations(record.draft)
		};
	}

	function definitionOf(from: EditorValue, record: PageRecord): PageDefinition {
		const localizations = translationsToLocalizations(from.translations);
		const title = from.title.trim();
		const description = from.description.trim();
		return {
			schema_version: 'authrim.account_page.v1',
			base_preset_id: 'authrim-default',
			base_preset_version: record.draft.base_preset_version ?? record.base_preset_version,
			...(title ? { title } : {}),
			...(description ? { description } : {}),
			...(localizations ? { localizations } : {}),
			screens: from.screens.map((item) => ({ ...item }))
		};
	}

	async function load() {
		phase = 'loading';
		try {
			loaded = await client.load();
			const record = loaded.document.pages.find((item) => item.id === id);
			if (!record) {
				phase = 'missing';
				return;
			}
			draft.reset(valueOf(record));
			selected = null;
			phase = 'ready';
		} catch {
			phase = 'failed';
		}
	}

	$effect(() => {
		void id;
		untrack(() => void load());
	});

	/** Stores the page as the document now holds it (over the version it was read at). */
	async function store(next: PageRecord, makeDefault = false) {
		if (!loaded) throw new Error('not loaded');
		const document = {
			...loaded.document,
			default_page_id: loaded.document.default_page_id ?? (makeDefault ? next.id : null),
			pages: loaded.document.pages.map((item) => (item.id === next.id ? next : item))
		};
		const version = await client.save(document, loaded.version);
		loaded = { ...loaded, document, version, stored: true };
	}

	async function save(from: EditorValue) {
		if (!page) throw new SaveStopped();
		if (!from.name.trim()) {
			nameError = t('ap.editor.nameRequired');
			editingName = true;
			toast.error(t('ap.editor.nameRequired'));
			throw new SaveStopped();
		}
		if (translationsTooLong(from.translations)) {
			// Refused, not cut: what is on screen is what would be saved.
			tab = 'localize';
			toast.error(t('ap.err.textTooLong'));
			throw new SaveStopped();
		}
		try {
			await store({
				...page,
				name: from.name.trim().slice(0, 80),
				draft: definitionOf(from, page),
				updated_at: Date.now()
			});
			toast.success(t('ap.toast.saved'));
		} catch (failure) {
			toast.error(t(pagesErrorKey(failure)));
			throw new SaveStopped();
		}
	}

	/** Saves what is on screen, then makes it the live page. */
	async function publish(controls: { dirty: boolean; save: () => Promise<void> }) {
		if (!page || !loaded || publishing) return;
		publishing = true;
		try {
			if (controls.dirty) {
				await controls.save();
				if (controls.dirty) return;
			}
			const current = loaded.document.pages.find((item) => item.id === id);
			if (!current) return;
			const built = buildPublication(current.draft, loaded.screens, new Date().toISOString());
			if (!built.ok) {
				const message = publishProblemMessage(built.problem);
				toast.error(t(message.key, message.values));
				return;
			}
			await store(publishedPage(current, current.draft, built.published, Date.now()), true);
			toast.success(t('ap.toast.published'));
		} catch (failure) {
			if (failure instanceof ApiError || failure instanceof Error) {
				toast.error(t(pagesErrorKey(failure)));
			}
		} finally {
			publishing = false;
		}
	}

	// ---- Layout ----
	const screens = $derived(loaded?.screens ?? []);
	const free = $derived(unplaced({ ...definitionStub(), screens: value.screens }, screens));
	const full = $derived(value.screens.length >= MAX_PLACEMENTS);
	const place = $derived(value.screens.findIndex((item) => item.id === selected));

	function definitionStub(): PageDefinition {
		return { schema_version: 'authrim.account_page.v1', screens: [] };
	}

	function add(screenKey: string) {
		const screen = screens.find((item) => item.screen_key === screenKey);
		if (!screen || readonly) return;
		const next = addPlacement({ ...definitionStub(), screens: value.screens }, screen);
		draft.value.screens = next.screens;
		selected = next.screens[next.screens.length - 1]?.id ?? null;
	}

	function move(placementId: string, step: -1 | 1) {
		draft.value.screens = movePlacement(
			{ ...definitionStub(), screens: value.screens },
			placementId,
			step
		).screens;
	}

	function remove() {
		if (selected === null) return;
		draft.value.screens = removePlacement(
			{ ...definitionStub(), screens: value.screens },
			selected
		).screens;
		selected = null;
	}

	const changedPlace = (placement: Placement) => {
		const saved = draft.saved.screens.find((item) => item.id === placement.id);
		return !saved || JSON.stringify(saved) !== JSON.stringify(placement);
	};

	// ---- Text in each language ----
	const languages = LOGIN_UI_LOCALES.map((code) => ({
		code,
		name: getLoginUILanguageDisplayName(code, false)
	}));
	const textRows = $derived([
		{ id: 'title', label: t('ap.text.rowTitle'), source: value.title },
		{ id: 'description', label: t('ap.text.rowDescription'), source: value.description }
	]);

	const tabs = $derived([
		{ id: 'builder', label: t('ap.tab.builder'), icon: 'list' as const },
		{ id: 'preview', label: t('ap.tab.preview'), icon: 'app' as const },
		{ id: 'localize', label: t('ap.tab.localize'), icon: 'translate' as const }
	]);

	// ---- The page's name, edited in its title ----
	let nameBefore = '';
	let editButton = $state<HTMLButtonElement | undefined>();

	function beginName() {
		nameBefore = value.name;
		nameError = '';
		editingName = true;
	}

	function endName() {
		editingName = false;
		void tick().then(() => editButton?.focus());
	}
</script>

{#snippet editNameAction()}
	<IconButton
		icon="pencil"
		size="sm"
		label={t('ap.editor.editName')}
		bind:element={editButton}
		onclick={beginName}
	/>
{/snippet}
{#snippet editNameForm()}
	<TitleEditor
		value={value.name}
		label={t('ap.editor.name')}
		hint={t('ap.editor.nameHint')}
		requiredMessage={t('ap.editor.nameRequired')}
		error={nameError}
		doneLabel={t('ap.editor.nameDone')}
		oninput={(typed) => {
			draft.value.name = typed;
			nameError = '';
		}}
		ondone={(name) => {
			draft.value.name = name;
			endName();
		}}
		oncancel={() => {
			draft.value.name = nameBefore;
			endName();
		}}
	/>
{/snippet}

<SaveScope {draft} onsave={save}>
	{#snippet children(controls)}
		<Page>
			<PageHeader
				title={value.name || t('nav.custom.accountPage')}
				titleAction={canWrite && phase === 'ready' && !editingName ? editNameAction : undefined}
				titleEditor={canWrite && phase === 'ready' && editingName ? editNameForm : undefined}
			>
				{#snippet back()}
					<BackLink href={listHref}>{t('ap.editor.back')}</BackLink>
				{/snippet}
				{#snippet badges()}
					{#if phase === 'ready'}
						<Badge
							tone={stateOfPage === 'published'
								? 'success'
								: stateOfPage === 'changed'
									? 'warning'
									: 'neutral'}
						>
							{t(`ap.state.${stateOfPage}`)}
						</Badge>
						{#if loaded?.document.default_page_id === id}
							<Badge tone="success" dot>{t('ap.inUse')}</Badge>
						{/if}
					{/if}
				{/snippet}
				{#snippet actions()}
					{#if phase === 'ready' && canWrite}
						<Button
							variant="primary"
							loading={publishing}
							disabled={controls.saving || (stateOfPage === 'published' && !controls.dirty)}
							title={stateOfPage === 'published' && !controls.dirty
								? t('ap.publish.nothing')
								: undefined}
							onclick={() => void publish(controls)}
						>
							{t('ap.publish')}
						</Button>
					{/if}
				{/snippet}
			</PageHeader>

			{#if phase === 'loading'}
				<LoadingState label={t('common.loading')} />
			{:else if phase === 'missing' || phase === 'failed'}
				<EmptyState
					icon="warningCircle"
					title={phase === 'missing' ? t('ap.editor.missing') : t('ap.loadFailed')}
				>
					{#snippet action()}
						{#if phase === 'failed'}
							<Button size="sm" onclick={load}>{t('common.retry')}</Button>
						{:else}
							<Button size="sm" href={listHref}>{t('ap.editor.back')}</Button>
						{/if}
					{/snippet}
				</EmptyState>
			{:else}
				{#if readonly}
					<Callout>{t('ap.editor.readOnly')}</Callout>
				{:else if !loaded?.stored}
					<Callout>{t('ap.editor.unstored')}</Callout>
				{/if}
				<Tabs label={value.name} items={tabs} bind:value={tab}>
					{#snippet panel(current)}
						{#if current === 'builder'}
							<p class="hint">{t('ap.builder.hint')}</p>
							<div class="builder">
								<Card title={t('ap.screens.title')}>
									{#if full}
										<p class="none">{t('ap.page.limit', { max: String(MAX_PLACEMENTS) })}</p>
									{:else if free.length === 0}
										<p class="none">
											{screens.length === 0 ? t('ap.screens.none') : t('ap.screens.all')}
										</p>
									{:else}
										<PartPalette
											entries={readonly
												? []
												: free.map((screen) => ({
														kind: screen.screen_key,
														label: screen.display_name,
														description: screen.description ?? undefined
													}))}
											showIcons={false}
											onadd={add}
										/>
									{/if}
								</Card>
								<AccountPageCanvas
									placements={value.screens}
									{screens}
									{selected}
									disabled={readonly}
									changed={changedPlace}
									onselect={(placementId) => (selected = placementId)}
									onmove={move}
								/>
								{#if place >= 0}
									<AccountPageInspector
										bind:placement={draft.value.screens[place]}
										screen={screenOf(value.screens[place], screens)}
										screenHref={screenHref && screenOf(value.screens[place], screens)
											? screenHref(screenOf(value.screens[place], screens)!.id)
											: undefined}
										disabled={readonly}
										onremove={remove}
									/>
								{:else}
									<AccountPageInspector placement={null} onremove={remove} />
								{/if}
							</div>
						{:else if current === 'preview'}
							<AccountPagePreview
								placements={value.screens}
								{screens}
								title={value.title}
								description={value.description}
							/>
						{:else}
							<Card title={t('ap.text.title')} description={t('ap.text.desc')}>
								<div class="text">
									<TextField
										label={t('ap.text.titleField')}
										bind:value={draft.value.title}
										maxlength={120}
										disabled={readonly}
										field="title"
									/>
									<TextArea
										label={t('ap.text.descField')}
										bind:value={draft.value.description}
										maxlength={1000}
										rows={3}
										disabled={readonly}
										field="description"
									/>
								</div>
							</Card>
							<TranslationTable
								label={t('ap.tab.localize')}
								field="translations"
								source={{ code: '', name: t('ap.text.source') }}
								locales={languages}
								rows={textRows}
								disabled={readonly}
								bind:values={draft.value.translations}
							/>
						{/if}
					{/snippet}
				</Tabs>
			{/if}
		</Page>
	{/snippet}
</SaveScope>

<style>
	.hint {
		margin: 0 0 14px;
		color: var(--text-secondary);
		font-size: var(--fs-body);
	}

	.none {
		margin: 0;
		color: var(--text-secondary);
		font-size: var(--fs-body);
	}

	.builder {
		display: grid;
		grid-template-columns: minmax(200px, 232px) minmax(0, 1fr) minmax(260px, 300px);
		gap: var(--space-section);
		align-items: start;
	}

	.text {
		display: grid;
		gap: 12px;
		max-inline-size: 640px;
	}

	@media (max-width: 1080px) {
		.builder {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
