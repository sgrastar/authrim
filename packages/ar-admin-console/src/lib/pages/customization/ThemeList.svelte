<script lang="ts">
	import { untrack } from 'svelte';
	import { ApiError } from '#lib/api/api-error.js';
	import type { ActiveTheme, LoginUiThemesClient, ThemeSummary } from '#lib/api/login-ui-themes.js';
	import { t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
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
	import { themeErrorKey } from './theme-errors';

	/**
	 * Customization → Themes: the tenant's saved themes. None at first; "Create theme" (top end)
	 * opens a new one. A row opens its theme; its menu edits, applies (makes it the one the sign-in
	 * screens show) or deletes it. The applied theme is marked, and so is one saved again since.
	 */
	interface Props {
		client: LoginUiThemesClient;
		canWrite: boolean;
		/** Where a theme's page is (`new` for a new one). */
		hrefOf: (id: string) => string;
		onopen: (id: string) => void;
	}

	let { client, canWrite, hrefOf, onopen }: Props = $props();

	let themes = $state<ThemeSummary[]>([]);
	let active = $state<ActiveTheme | null>(null);
	let phase = $state<'loading' | 'ready' | 'forbidden' | 'failed'>('loading');
	let busy = $state(false);
	let applying = $state<ThemeSummary | null>(null);
	let deleting = $state<ThemeSummary | null>(null);

	async function load() {
		phase = 'loading';
		try {
			({ themes, active } = await client.list());
			phase = 'ready';
		} catch (error) {
			phase = error instanceof ApiError && error.status === 403 ? 'forbidden' : 'failed';
		}
	}

	$effect(() => {
		untrack(() => void load());
	});

	async function run(change: () => Promise<void>, fallback: MessageKey) {
		busy = true;
		try {
			await change();
		} catch (error) {
			toast.error(t(themeErrorKey(error, fallback)));
		} finally {
			busy = false;
		}
	}

	const apply = (theme: ThemeSummary) =>
		run(async () => {
			active = await client.apply(theme.id);
			applying = null;
			toast.success(t('th.toast.applied', { name: theme.name }));
		}, 'th.error.apply');

	const remove = (theme: ThemeSummary) =>
		run(async () => {
			await client.remove(theme.id);
			themes = themes.filter((item) => item.id !== theme.id);
			deleting = null;
			toast.success(t('th.toast.deleted'));
		}, 'th.error.save');

	const isActive = (theme: ThemeSummary) => active?.theme_id === theme.id;
	/** Applied, and saved again since (the screens still show the version applied). */
	const isPending = (theme: ThemeSummary) => isActive(theme) && active!.version < theme.version;

	const actionsOf = (theme: ThemeSummary): MenuAction[] => [
		{ label: t('th.action.edit'), icon: 'pencil', onselect: () => onopen(theme.id) },
		{
			label: t('th.action.apply'),
			icon: 'check',
			disabled: busy,
			onselect: () => (applying = theme)
		},
		{
			label: t('th.action.delete'),
			icon: 'trash',
			danger: true,
			disabled: busy || isActive(theme),
			onselect: () => (deleting = theme)
		}
	];

	const lookOf = (theme: ThemeSummary) =>
		[
			theme.template ? t(`th.tpl.${theme.template}` as MessageKey) : null,
			theme.palette ? t(`th.palette.${theme.palette}` as MessageKey) : null
		]
			.filter(Boolean)
			.join(' · ');

	const columns = $derived([
		{ key: 'name', label: t('th.list.col.name') },
		{ key: 'look', label: t('th.list.col.look'), width: '26%' },
		{ key: 'updated', label: t('th.list.col.updated'), width: '20%' },
		{ key: 'status', label: t('th.list.col.status'), width: '18%' },
		...(canWrite
			? [
					{
						key: 'actions',
						label: t('th.list.actions', { name: '' }),
						width: '56px',
						hideLabel: true
					}
				]
			: [])
	]);
</script>

<Page>
	<PageHeader title={t('nav.custom.branding')} description={t('th.list.desc')}>
		{#snippet actions()}
			{#if canWrite}
				<Button variant="primary" icon="plus" href={hrefOf('new')}>{t('th.list.create')}</Button>
			{/if}
		{/snippet}
	</PageHeader>

	<Card title={t('th.list.title')} flush>
		{#if phase === 'loading'}
			<LoadingState label={t('common.loading')} />
		{:else if phase === 'forbidden'}
			<EmptyState icon="lock" title={t('th.list.noAccess')} />
		{:else if phase === 'failed'}
			<EmptyState icon="warningCircle" title={t('th.list.loadFailed')}>
				{#snippet action()}
					<Button size="sm" onclick={load}>{t('common.retry')}</Button>
				{/snippet}
			</EmptyState>
		{:else}
			<DataTable
				caption={t('th.list.title')}
				{columns}
				rows={themes}
				rowKey={(row) => row.id}
				onrowopen={(row) => onopen(row.id)}
				rowOpenLabel={(row) => t('th.list.open', { name: row.name })}
			>
				{#snippet cell(row, column)}
					{#if column.key === 'name'}
						<CellText title={row.name} />
					{:else if column.key === 'look'}
						{lookOf(row)}
					{:else if column.key === 'updated'}
						<DateTime value={row.updated_at} stacked />
					{:else if column.key === 'status'}
						{#if isActive(row)}
							<Badge tone="success" dot>{t('th.list.active')}</Badge>
							{#if isPending(row)}
								<Badge tone="warning">{t('th.list.pending')}</Badge>
							{/if}
						{/if}
					{:else}
						<ActionMenu
							size="sm"
							label={t('th.list.actions', { name: row.name })}
							actions={actionsOf(row)}
						/>
					{/if}
				{/snippet}
				{#snippet empty()}
					<EmptyState
						icon="brush"
						title={t('th.list.empty')}
						description={t('th.list.emptyBody')}
					/>
				{/snippet}
			</DataTable>
		{/if}
	</Card>
</Page>

<ConfirmDialog
	open={applying !== null}
	title={t('th.apply.title', { name: applying?.name ?? '' })}
	body={t('th.apply.body')}
	confirmLabel={t('th.apply.confirm')}
	{busy}
	onconfirm={() => applying && apply(applying)}
	oncancel={() => (applying = null)}
/>

<ConfirmDialog
	open={deleting !== null}
	title={t('th.delete.title', { name: deleting?.name ?? '' })}
	body={t('th.delete.body')}
	confirmLabel={t('th.action.delete')}
	tone="danger"
	{busy}
	onconfirm={() => deleting && remove(deleting)}
	oncancel={() => (deleting = null)}
/>
