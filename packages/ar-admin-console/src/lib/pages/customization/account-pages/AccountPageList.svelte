<script lang="ts">
	import { untrack } from 'svelte';
	import type {
		AccountPagesClient,
		AccountPagesState,
		PageRecord
	} from '#lib/api/account-pages.js';
	import { ApiError } from '#lib/api/api-error.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Card from '#lib/ui/patterns/Card.svelte';
	import CellText from '#lib/ui/patterns/CellText.svelte';
	import ConfirmDialog from '#lib/ui/patterns/ConfirmDialog.svelte';
	import DataTable from '#lib/ui/patterns/DataTable.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import ActionMenu, { type MenuAction } from '#lib/ui/primitives/ActionMenu.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import DateTime from '#lib/ui/time/DateTime.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import { pagesErrorKey } from './account-page-errors';
	import {
		MAX_PAGES,
		PRESET_PAGE_ID,
		duplicatePage,
		newPage,
		pageState
	} from './account-page-model';

	/**
	 * Customization → Account page: the pages the tenant has for the signed-in user's account
	 * page. Right after setup there is one, made from the preset (it is stored with the first
	 * change). A page is opened to be built; the list creates, duplicates and deletes pages and
	 * chooses the one users see (a published one).
	 */
	interface Props {
		client: AccountPagesClient;
		canWrite: boolean;
		/** Opens a page in the editor. */
		onopen: (id: string) => void;
	}

	let { client, canWrite, onopen }: Props = $props();

	let data = $state<AccountPagesState | null>(null);
	let phase = $state<'loading' | 'ready' | 'forbidden' | 'failed'>('loading');
	let working = $state(false);
	let deleting = $state<PageRecord | null>(null);

	async function load(quiet = false) {
		if (!quiet) phase = 'loading';
		try {
			data = await client.load();
			phase = 'ready';
		} catch (failure) {
			phase = failure instanceof ApiError && failure.status === 403 ? 'forbidden' : 'failed';
		}
	}

	$effect(() => {
		untrack(() => void load());
	});

	const pages = $derived(data?.document.pages ?? []);

	/**
	 * One change to the document at a time, saved over the version it was read at. Answers whether
	 * it was made (a failure is told to the admin here).
	 */
	async function change(
		next: (current: AccountPagesState) => { pages: PageRecord[]; defaultId: string | null },
		done: 'ap.toast.created' | 'ap.toast.duplicated' | 'ap.toast.deleted' | 'ap.toast.default',
		options?: { clearThemeFor?: string }
	): Promise<boolean> {
		if (!data || working) return false;
		working = true;
		try {
			const result = next(data);
			const document = {
				...data.document,
				pages: result.pages,
				default_page_id: result.defaultId
			};
			await client.save(document, data.version, { clearThemeFor: options?.clearThemeFor });
			toast.success(t(done));
			await load(true);
			return true;
		} catch (failure) {
			toast.error(t(pagesErrorKey(failure)));
			if (failure instanceof ApiError && failure.status === 409) await load(true);
			return false;
		} finally {
			working = false;
		}
	}

	async function create() {
		let createdId = '';
		const made = await change((current) => {
			const page = newPage(
				current.document.pages.map((item) => item.id),
				t('ap.newName'),
				Date.now()
			);
			createdId = page.id;
			return {
				pages: [...current.document.pages, page],
				defaultId: current.document.default_page_id
			};
		}, 'ap.toast.created');
		if (made && createdId) onopen(createdId);
	}

	function duplicate(page: PageRecord) {
		void change((current) => {
			const copy = duplicatePage(
				page,
				current.document.pages.map((item) => item.id),
				t('ap.copyName', { name: page.name }),
				Date.now()
			);
			return {
				pages: [...current.document.pages, copy],
				defaultId: current.document.default_page_id
			};
		}, 'ap.toast.duplicated');
	}

	function makeDefault(page: PageRecord) {
		void change(
			(current) => ({ pages: current.document.pages, defaultId: page.id }),
			'ap.toast.default'
		);
	}

	async function remove() {
		const page = deleting;
		deleting = null;
		if (!page) return;
		await change(
			(current) => ({
				pages: current.document.pages.filter((item) => item.id !== page.id),
				defaultId: current.document.default_page_id
			}),
			'ap.toast.deleted',
			{ clearThemeFor: page.id }
		);
	}

	const columns = $derived([
		{ key: 'name', label: t('ap.col.name') },
		{ key: 'state', label: t('ap.col.state'), width: '24%' },
		{ key: 'places', label: t('ap.col.places'), width: '10%' },
		{ key: 'updated', label: t('ap.col.updated'), width: '16%' },
		{
			key: 'actions',
			label: t('ap.col.actions'),
			width: '8%',
			align: 'end' as const,
			hideLabel: true
		}
	]);

	function actionsFor(page: PageRecord): MenuAction[] {
		const inUse = data?.document.default_page_id === page.id;
		const list: MenuAction[] = [
			{
				label: t('ap.action.setDefault'),
				disabled: inUse || !page.published,
				onselect: () => makeDefault(page)
			},
			{
				label: t('ap.action.duplicate'),
				icon: 'copy',
				disabled: pages.length >= MAX_PAGES,
				onselect: () => duplicate(page)
			},
			{
				label: t('ap.action.delete'),
				icon: 'trash',
				danger: true,
				// The page users see, and the last page, are kept.
				disabled: inUse || pages.length <= 1,
				onselect: () => (deleting = page)
			}
		];
		return list;
	}
</script>

<Page>
	<PageHeader title={t('nav.custom.accountPage')} description={t('ap.page.desc')}>
		{#snippet actions()}
			{#if canWrite && phase === 'ready'}
				<Button
					variant="primary"
					icon="plus"
					disabled={working || pages.length >= MAX_PAGES}
					onclick={() => void create()}
				>
					{t('ap.new')}
				</Button>
			{/if}
		{/snippet}
	</PageHeader>

	{#if phase === 'forbidden'}
		<EmptyState icon="lock" title={t('ap.noAccess')} />
	{:else if phase === 'loading'}
		<LoadingState label={t('common.loading')} />
	{:else if phase === 'failed'}
		<EmptyState icon="warningCircle" title={t('ap.loadFailed')}>
			{#snippet action()}
				<Button size="sm" onclick={() => load()}>{t('common.retry')}</Button>
			{/snippet}
		</EmptyState>
	{:else}
		<Card title={t('ap.list.title')} flush>
			<DataTable
				caption={t('ap.list.title')}
				{columns}
				rows={pages}
				rowKey={(row) => row.id}
				onrowopen={(row) => onopen(row.id)}
				rowOpenLabel={(row) => t('ap.list.open', { name: row.name })}
			>
				{#snippet cell(row, column)}
					{#if column.key === 'name'}
						<CellText title={row.name} />
						<span class="marks">
							{#if data?.document.default_page_id === row.id}
								<Badge tone="success" dot size="sm">{t('ap.inUse')}</Badge>
							{/if}
							{#if row.id === PRESET_PAGE_ID}<Badge size="sm">{t('ap.preset')}</Badge>{/if}
						</span>
					{:else if column.key === 'state'}
						{@const status = pageState(row, data?.screens)}
						<Badge
							tone={status === 'published'
								? 'success'
								: status === 'changed'
									? 'warning'
									: 'neutral'}
						>
							{t(`ap.state.${status}`)}
						</Badge>
					{:else if column.key === 'places'}
						{t('ap.places.count', { count: String(row.draft.screens.length) })}
					{:else if column.key === 'updated'}
						{#if data?.stored}<DateTime value={row.updated_at} />{/if}
					{:else if canWrite}
						<ActionMenu
							label={t('ap.col.actionsFor', { name: row.name })}
							actions={actionsFor(row)}
							size="sm"
							disabled={working}
						/>
					{/if}
				{/snippet}
				{#snippet empty()}
					<EmptyState icon="app" title={t('ap.empty')} />
				{/snippet}
			</DataTable>
		</Card>
	{/if}
</Page>

<ConfirmDialog
	open={deleting !== null}
	title={t('ap.delete.title', { name: deleting?.name ?? '' })}
	body={t('ap.delete.body')}
	confirmLabel={t('ap.delete.confirm')}
	tone="danger"
	onconfirm={() => void remove()}
	oncancel={() => (deleting = null)}
/>

<style>
	.marks {
		display: inline-flex;
		flex-wrap: wrap;
		gap: 4px;
		margin-inline-start: 8px;
	}
</style>
