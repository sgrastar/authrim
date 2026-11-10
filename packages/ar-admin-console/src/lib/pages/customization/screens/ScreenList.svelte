<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { DEFAULT_ACCOUNT_SCREEN_KEYS } from '@authrim/ar-lib-core/types/screens';
	import { ApiError } from '#lib/api/api-error.js';
	import {
		SCREEN_KINDS,
		type ScreenKind,
		type ScreenListItem,
		type ScreensClient
	} from '#lib/api/screens.js';
	import { i18n, t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import CellText from '#lib/ui/patterns/CellText.svelte';
	import ConfirmDialog from '#lib/ui/patterns/ConfirmDialog.svelte';
	import DataTable, { type Column, type SortState } from '#lib/ui/patterns/DataTable.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import FilterBar from '#lib/ui/patterns/FilterBar.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import ActionMenu, { type MenuAction } from '#lib/ui/primitives/ActionMenu.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import SearchField from '#lib/ui/primitives/SearchField.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import { sortRows } from '#lib/ui/patterns/table-sort.js';
	import Page from '#lib/ui/templates/Page.svelte';
	import DateTime from '#lib/ui/time/DateTime.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import { screenErrorKey } from './screen-errors';

	/**
	 * Customization → Screens: tenant screens, with account screens in their own table. Built-in
	 * system screens remain available as templates in the creation wizard.
	 */
	interface Props {
		client: ScreensClient;
		canWrite: boolean;
		/** Where a screen's page is (`new` for a new one). */
		hrefOf: (id: string) => string;
		onopen: (id: string) => void;
	}

	let { client, canWrite, hrefOf, onopen }: Props = $props();

	let screens = $state<ScreenListItem[]>([]);
	let usagesComplete = $state(true);
	let phase = $state<'loading' | 'ready' | 'forbidden' | 'failed'>('loading');
	let busy = $state(false);
	let deleting = $state<ScreenListItem | null>(null);
	let query = $state('');
	let kind = $state<ScreenKind | ''>('');
	let screenSort = $state<SortState | null>(null);
	let accountSort = $state<SortState | null>(null);
	const defaultAccountKeys = new Set<string>(DEFAULT_ACCOUNT_SCREEN_KEYS);
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
				!screen.is_system &&
				(!kind || screen.screen_kind === kind) &&
				(!needle ||
					screen.display_name.toLowerCase().includes(needle) ||
					screen.screen_key.toLowerCase().includes(needle))
		);
	});
	const kindLabel = (value: ScreenKind) => t(`sc.kind.${value}` as MessageKey);
	function sortValue(screen: ScreenListItem, key: string): string | number {
		switch (key) {
			case 'name':
				return screen.display_name;
			case 'kind':
				return kindLabel(screen.screen_kind);
			case 'usage':
				return screen.usage.flows + screen.usage.account_pages;
			case 'created':
				return screen.created_at;
			default:
				return screen.updated_at;
		}
	}
	const screenRows = $derived(
		sortRows(
			shown.filter((screen) => screen.screen_kind !== 'account'),
			screenSort,
			sortValue,
			i18n.locale
		)
	);
	const accountRows = $derived(
		sortRows(
			shown.filter((screen) => screen.screen_kind === 'account'),
			accountSort,
			sortValue,
			i18n.locale
		)
	);
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
				: defaultAccountKeys.has(screen.screen_key)
					? t('sc.delete.defaultAccount')
					: inUse(screen)
						? t('sc.delete.inUse')
						: t('sc.action.delete'),
			icon: 'trash',
			danger: true,
			disabled:
				busy || screen.is_system || defaultAccountKeys.has(screen.screen_key) || inUse(screen),
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
		// Keep the table readable on narrow screens.
		{ key: 'name', label: t('sc.list.col.name'), sortable: true },
		{ key: 'kind', label: t('sc.list.col.kind'), width: '18%', sortable: true },
		{ key: 'usage', label: t('sc.list.col.usage'), width: '18%', sortable: true },
		{ key: 'created', label: t('sc.list.col.created'), width: '15%', sortable: true },
		{ key: 'updated', label: t('sc.list.col.updated'), width: '15%', sortable: true },
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

{#snippet screenCell(row: ScreenListItem, column: Column)}
	{#if column.key === 'name'}
		<CellText title={row.display_name} description={row.screen_key}>
			{#if !row.is_active}<Badge tone="warning">{t('sc.status.inactive')}</Badge>{/if}
		</CellText>
	{:else if column.key === 'kind'}
		{kindLabel(row.screen_kind)}
	{:else if column.key === 'usage'}
		{usageText(row)}
	{:else if column.key === 'created'}
		<DateTime value={row.created_at} stacked />
	{:else if column.key === 'updated'}
		<DateTime value={row.updated_at} stacked />
	{:else}
		<ActionMenu
			size="sm"
			label={t('sc.list.actions', { name: row.display_name })}
			actions={actionsOf(row)}
		/>
	{/if}
{/snippet}

<Page>
	<PageHeader title={t('nav.custom.screens')}>
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

		{#if kind !== 'account'}
			<Card title={t('sc.list.title')} flush>
				<DataTable
					caption={t('sc.list.title')}
					{columns}
					rows={screenRows}
					bind:sort={screenSort}
					rowKey={(row) => row.id}
					onrowopen={(row) => onopen(row.id)}
					rowOpenLabel={(row) => t('sc.list.open', { name: row.display_name })}
					dense
				>
					{#snippet cell(row, column)}
						{@render screenCell(row, column)}
					{/snippet}
					{#snippet empty()}
						<EmptyState
							icon="list"
							title={filtered ? t('sc.list.emptyFiltered') : t('sc.list.empty')}
						/>
					{/snippet}
				</DataTable>
			</Card>
		{/if}

		{#if !kind || kind === 'account'}
			<Card title={t('sc.list.accountTable')} flush>
				<DataTable
					caption={t('sc.list.accountTable')}
					{columns}
					rows={accountRows}
					bind:sort={accountSort}
					rowKey={(row) => row.id}
					onrowopen={(row) => onopen(row.id)}
					rowOpenLabel={(row) => t('sc.list.open', { name: row.display_name })}
					dense
				>
					{#snippet cell(row, column)}
						{@render screenCell(row, column)}
					{/snippet}
					{#snippet empty()}
						<EmptyState
							icon="list"
							title={filtered ? t('sc.list.emptyFiltered') : t('sc.list.emptyAccount')}
						/>
					{/snippet}
				</DataTable>
			</Card>
		{/if}
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
