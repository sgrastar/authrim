<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { ApiError } from '#lib/api/api-error.js';
	import {
		SCREEN_KINDS,
		type ScreenKind,
		type ScreenListItem,
		type ScreensClient
	} from '#lib/api/screens.js';
	import { t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import CellText from '#lib/ui/patterns/CellText.svelte';
	import ConfirmDialog from '#lib/ui/patterns/ConfirmDialog.svelte';
	import DataTable from '#lib/ui/patterns/DataTable.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import FilterBar from '#lib/ui/patterns/FilterBar.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import ActionMenu, { type MenuAction } from '#lib/ui/primitives/ActionMenu.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import SearchField from '#lib/ui/primitives/SearchField.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import DateTime from '#lib/ui/time/DateTime.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import { screenErrorKey } from './screen-errors';
	import { fieldsToBuilder } from './screen-layout';
	import type { ChoiceSource } from './screen-model';
	import ScreenPreview from './ScreenPreview.svelte';

	/**
	 * Customization → Screens: every screen of the tenant (the built-in ones first), with a preview
	 * on the right (below the table on a narrow window) of the row under the pointer or holding
	 * the focus. A row opens its screen. The row's menu opens, duplicates or deletes it: a built-in
	 * screen and one a flow or an account page uses are not deleted.
	 */
	interface Props {
		client: ScreensClient;
		canWrite: boolean;
		/** Where a screen's page is (`new` for a new one). */
		hrefOf: (id: string) => string;
		onopen: (id: string) => void;
		/** The choices of the Identity Schema's attributes, for choice parts in the preview. */
		choices?: ChoiceSource;
	}

	let { client, canWrite, hrefOf, onopen, choices }: Props = $props();

	let screens = $state<ScreenListItem[]>([]);
	let usagesComplete = $state(true);
	let phase = $state<'loading' | 'ready' | 'forbidden' | 'failed'>('loading');
	let busy = $state(false);
	let deleting = $state<ScreenListItem | null>(null);
	let query = $state('');
	let kind = $state<ScreenKind | ''>('');
	let picked = $state<string | null>(null);
	// The page is gone: a duplicate finishing late does not take the admin anywhere.
	let gone = false;
	onDestroy(() => (gone = true));

	async function load() {
		phase = 'loading';
		try {
			({ screens, usagesComplete } = await client.list());
			phase = 'ready';
		} catch (error) {
			phase = error instanceof ApiError && error.status === 403 ? 'forbidden' : 'failed';
		}
	}

	$effect(() => {
		untrack(() => void load());
	});

	const shown = $derived.by(() => {
		const needle = query.trim().toLowerCase();
		return screens.filter(
			(screen) =>
				(!kind || screen.screen_kind === kind) &&
				(!needle ||
					screen.display_name.toLowerCase().includes(needle) ||
					screen.screen_key.toLowerCase().includes(needle))
		);
	});
	/** The screen in the preview: the one picked while it is listed, else the first one listed. */
	const previewed = $derived(shown.find((screen) => screen.id === picked) ?? shown[0] ?? null);
	/** Parts saved without an id get one of their own, unique within the preview. */
	const preview = $derived.by(() => {
		if (!previewed) return null;
		let next = 0;
		return fieldsToBuilder(previewed.fields, (prefix) => `${prefix}-preview-${++next}`);
	});

	/** The row under the pointer or holding the focus is the one previewed. */
	function pick(event: Event) {
		const row = event.target instanceof Element ? event.target.closest('tbody tr') : null;
		if (!row?.parentElement) return;
		const screen = shown[[...row.parentElement.children].indexOf(row)];
		if (screen) picked = screen.id;
	}

	const kindLabel = (value: ScreenKind) => t(`sc.kind.${value}` as MessageKey);
	const inUse = (screen: ScreenListItem) =>
		screen.usage.flows + screen.usage.account_pages > 0 || !usagesComplete;

	async function run(change: () => Promise<void>, fallback: MessageKey) {
		busy = true;
		try {
			await change();
		} catch (error) {
			toast.error(t(screenErrorKey(error, fallback)));
		} finally {
			busy = false;
		}
	}

	/** A copy's key: the screen's own, marked as a copy, unique enough not to be taken. */
	const copyKey = (key: string) =>
		`${key.slice(0, 80)}_copy_${Date.now().toString(36)}`.replace(/[^a-z0-9_-]/gu, '_');

	const duplicate = (screen: ScreenListItem) =>
		run(async () => {
			const created = await client.create({
				display_name: t('sc.copy.name', { name: screen.display_name }).slice(0, 200),
				description: screen.description,
				screen_key: copyKey(screen.screen_key),
				screen_kind: screen.screen_kind,
				fields: structuredClone($state.snapshot(screen.fields)),
				localizations: structuredClone($state.snapshot(screen.localizations)),
				// A copy of a built-in screen remembers it, so it can be reset to it later.
				settings: screen.is_system
					? {
							...$state.snapshot(screen.settings),
							base_preset_key: screen.screen_key,
							base_preset_version: 1
						}
					: structuredClone($state.snapshot(screen.settings)),
				is_active: screen.is_active
			});
			if (gone) return;
			toast.success(t('sc.toast.copied'));
			onopen(created.id);
		}, 'sc.error.copy');

	const remove = (screen: ScreenListItem) =>
		run(async () => {
			await client.remove(screen.id, screen.version);
			screens = screens.filter((item) => item.id !== screen.id);
			deleting = null;
			toast.success(t('sc.toast.deleted'));
		}, 'sc.error.delete');

	const actionsOf = (screen: ScreenListItem): MenuAction[] => [
		{ label: t('sc.action.open'), icon: 'pencil', onselect: () => onopen(screen.id) },
		{
			label: t('sc.action.copy'),
			icon: 'copy',
			disabled: busy,
			onselect: () => void duplicate(screen)
		},
		{
			// Why it cannot be deleted, in place of the action, when it cannot.
			label: screen.is_system
				? t('sc.delete.system')
				: inUse(screen)
					? t('sc.delete.inUse')
					: t('sc.action.delete'),
			icon: 'trash',
			danger: true,
			disabled: busy || screen.is_system || inUse(screen),
			onselect: () => (deleting = screen)
		}
	];

	const usageText = (screen: ScreenListItem) => {
		const parts = [
			screen.usage.flows > 0 ? t('sc.usage.flows', { n: screen.usage.flows }) : null,
			screen.usage.account_pages > 0 ? t('sc.usage.pages', { n: screen.usage.account_pages }) : null
		].filter(Boolean);
		return parts.length > 0 ? parts.join(' · ') : t('sc.usage.none');
	};

	const filtered = $derived(query.trim() !== '' || kind !== '');
	const clear = () => {
		query = '';
		kind = '';
	};

	const columns = $derived([
		// Five columns at most: the table sits beside the preview and must fit without scrolling
		// sideways (a table of six or more keeps a wide minimum).
		{ key: 'name', label: t('sc.list.col.name') },
		{ key: 'kind', label: t('sc.list.col.kind'), width: '20%' },
		{ key: 'usage', label: t('sc.list.col.usage'), width: '20%' },
		{ key: 'updated', label: t('sc.list.col.updated'), width: '19%' },
		...(canWrite
			? [
					{
						key: 'actions',
						label: t('sc.list.actions', { name: '' }),
						width: '56px',
						hideLabel: true
					}
				]
			: [])
	]);
</script>

<Page>
	<PageHeader title={t('nav.custom.screens')} description={t('sc.list.desc')}>
		{#snippet actions()}
			{#if canWrite}
				<Button variant="primary" icon="plus" href={hrefOf('new')}>{t('sc.list.create')}</Button>
			{/if}
		{/snippet}
	</PageHeader>

	{#if phase === 'loading'}
		<LoadingState label={t('common.loading')} />
	{:else if phase === 'forbidden'}
		<EmptyState icon="lock" title={t('sc.list.noAccess')} />
	{:else if phase === 'failed'}
		<EmptyState icon="warningCircle" title={t('sc.list.loadFailed')}>
			{#snippet action()}
				<Button size="sm" onclick={load}>{t('common.retry')}</Button>
			{/snippet}
		</EmptyState>
	{:else}
		{#if !usagesComplete}
			<Callout tone="warning">{t('sc.usage.incomplete')}</Callout>
		{/if}
		<FilterBar label={t('sc.list.title')} results={shown.length} active={filtered} onclear={clear}>
			{#snippet search()}
				<SearchField
					label={t('sc.list.search')}
					placeholder={t('sc.list.search')}
					bind:value={query}
				/>
			{/snippet}
			<Select
				label={t('sc.list.kindFilter')}
				size="sm"
				options={[
					{ value: '', label: t('sc.list.allKinds') },
					...SCREEN_KINDS.map((value) => ({ value, label: kindLabel(value) }))
				]}
				bind:value={kind}
			/>
		</FilterBar>

		<div class="screens">
			<Card title={t('sc.list.title')} flush>
				<!-- Hovering or focusing a row only changes what the preview shows. -->
				<div class="screens__table" role="presentation" onpointerover={pick} onfocusin={pick}>
					<DataTable
						caption={t('sc.list.title')}
						{columns}
						rows={shown}
						rowKey={(row) => row.id}
						onrowopen={(row) => onopen(row.id)}
						rowOpenLabel={(row) => t('sc.list.open', { name: row.display_name })}
						dense
					>
						{#snippet cell(row, column)}
							{#if column.key === 'name'}
								<CellText title={row.display_name} description={row.screen_key}>
									<!-- Only what needs noticing: a screen that is off. -->
									{#if !row.is_active}<Badge tone="warning">{t('sc.status.inactive')}</Badge>{/if}
								</CellText>
							{:else if column.key === 'kind'}
								{kindLabel(row.screen_kind)}
							{:else if column.key === 'usage'}
								{usageText(row)}
							{:else if column.key === 'updated'}
								<!-- The date: it fits the column; the time is in its title. -->
								<DateTime value={row.updated_at} style="date" stacked />
							{:else}
								<ActionMenu
									size="sm"
									label={t('sc.list.actions', { name: row.display_name })}
									actions={actionsOf(row)}
								/>
							{/if}
						{/snippet}
						{#snippet empty()}
							<EmptyState
								icon="list"
								title={filtered ? t('sc.list.emptyFiltered') : t('sc.list.empty')}
							/>
						{/snippet}
					</DataTable>
				</div>
			</Card>

			<aside class="screens__preview" aria-label={t('sc.preview.title')}>
				<Card
					title={previewed ? previewed.display_name : t('sc.preview.title')}
					info={t('sc.preview.note')}
				>
					{#if !previewed || !preview}
						<p class="screens__hint">{t('sc.preview.pick')}</p>
					{:else if preview.rows.length === 0}
						<p class="screens__hint">{t('sc.preview.empty')}</p>
					{:else}
						<ScreenPreview
							rows={preview.rows}
							settings={preview.settings}
							rowSettings={preview.rowSettings}
							{choices}
						/>
					{/if}
				</Card>
			</aside>
		</div>
	{/if}
</Page>

<ConfirmDialog
	open={deleting !== null}
	title={t('sc.delete.title', { name: deleting?.display_name ?? '' })}
	body={t('sc.delete.body')}
	confirmLabel={t('sc.action.delete')}
	tone="danger"
	{busy}
	onconfirm={() => deleting && remove(deleting)}
	oncancel={() => (deleting = null)}
/>

<style>
	/* The table and the preview side by side; the preview under the table on a narrow window. */
	.screens {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(300px, 380px);
		gap: var(--space-section);
		align-items: start;
	}

	.screens__preview {
		position: sticky;
		top: var(--space-section);
	}

	.screens__hint {
		margin: 0;
		color: var(--text-secondary);
	}

	/* Below this the table beside the preview would be too narrow to read. */
	@media (max-width: 1200px) {
		.screens {
			grid-template-columns: minmax(0, 1fr);
		}

		.screens__preview {
			position: static;
		}
	}
</style>
