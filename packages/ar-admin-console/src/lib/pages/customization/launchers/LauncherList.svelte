<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { ApiError, ConflictError } from '#lib/api/api-error.js';
	import type { ConsoleLauncher, LaunchersClient } from '#lib/api/launchers.js';
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
	import IconButton from '#lib/ui/primitives/IconButton.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import DateTime from '#lib/ui/time/DateTime.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import { audienceSummary, opensSummary } from './launcher-copy';
	import { moved } from './launcher-model';
	import LauncherIcon from './LauncherIcon.svelte';

	/**
	 * Customization → Launchers: every launcher of the tenant in the order the account page shows
	 * them, top first. The arrows move one up or down and save the new order at once (the whole
	 * order is sent, so a list changed by someone else meanwhile is reloaded instead). A row opens
	 * the launcher; its menu also deletes it. With no launchers yet the page says so and offers to
	 * create the first.
	 *
	 * A tenant's list holds the platform's launchers shared with it too (marked so; they move like
	 * the others but cannot be deleted). The platform's own list (`client.scope` platform) shows
	 * whom each is shared with in place of who sees it.
	 */
	interface Props {
		client: LaunchersClient;
		canWrite: boolean;
		hrefOf: (id: string) => string;
		onopen: (id: string) => void;
	}

	let { client, canWrite, hrefOf, onopen }: Props = $props();

	const platform = $derived(client.scope === 'platform');
	let launchers = $state<ConsoleLauncher[]>([]);
	let phase = $state<'loading' | 'ready' | 'forbidden' | 'failed'>('loading');
	let moving = $state(false);
	let deleting = $state<ConsoleLauncher | null>(null);
	let busy = $state(false);
	let root = $state<HTMLElement>();

	async function load() {
		phase = 'loading';
		try {
			launchers = await client.list();
			phase = 'ready';
		} catch (error) {
			phase = error instanceof ApiError && error.forbidden ? 'forbidden' : 'failed';
		}
	}
	$effect(() => {
		untrack(() => void load());
	});

	async function move(index: number, by: -1 | 1) {
		if (moving || busy) return;
		const before = launchers;
		const launcher = before[index];
		const next = moved(before, index, by);
		if (next.every((item, i) => item.id === before[i].id)) return;
		launchers = next;
		moving = true;
		try {
			launchers = await client.reorder(next.map((item) => item.id));
			toast.success(t('ln.list.moved'));
		} catch (error) {
			if (error instanceof ConflictError) {
				toast.error(t('ln.list.moveConflict'));
				await load();
			} else {
				launchers = before;
				toast.error(t('ln.list.moveFailed'));
			}
		} finally {
			moving = false;
		}
		// The arrow pressed follows its row; where the row reached an end, the other arrow.
		await tick();
		const at = launchers.findIndex((item) => item.id === launcher.id);
		if (at < 0) return;
		const wanted = by < 0 ? (at > 0 ? 'up' : 'down') : at < launchers.length - 1 ? 'down' : 'up';
		root
			?.querySelector<HTMLButtonElement>(`[data-move="${CSS.escape(launcher.id)}-${wanted}"]`)
			?.focus();
	}

	async function remove() {
		const launcher = deleting;
		if (!launcher) return;
		busy = true;
		try {
			await client.remove(launcher.id, launcher.sharing?.version);
			launchers = launchers.filter((item) => item.id !== launcher.id);
			deleting = null;
			toast.success(t('ln.list.deleted', { name: launcher.name }));
		} catch (error) {
			if (error instanceof ApiError && error.notFound) {
				launchers = launchers.filter((item) => item.id !== launcher.id);
				deleting = null;
				return;
			}
			// The dialog closes first: behind it the toast could not be read.
			deleting = null;
			toast.error(t('ln.list.deleteFailed'));
		} finally {
			busy = false;
		}
	}

	function actionsOf(launcher: ConsoleLauncher): MenuAction[] {
		return [
			{
				label: t('ln.list.open', { name: launcher.name }),
				icon: 'pencil',
				onselect: () => onopen(launcher.id)
			},
			// A launcher the platform shares is hidden in the tenant, not deleted.
			...(launcher.shared
				? []
				: [
						{
							label: t('ln.list.delete'),
							icon: 'trash' as const,
							danger: true,
							disabled: busy || moving,
							onselect: () => (deleting = launcher)
						}
					])
		];
	}

	function sharingSummary(launcher: ConsoleLauncher): string {
		const sharing = launcher.sharing;
		if (!sharing) return '—';
		if (sharing.share_mode === 'selected')
			return t('ln.sharing.count', { n: sharing.tenant_ids.length });
		return t(`ln.sharing.mode.${sharing.share_mode}` as MessageKey);
	}

	const title = $derived(platform ? t('ln.platform.title') : t('ln.list.title'));

	const reorderable = $derived(canWrite && launchers.length > 1);
	const columns = $derived([
		...(reorderable ? [{ key: 'order', label: t('ln.list.order'), width: '92px' }] : []),
		{ key: 'launcher', label: t('ln.list.launcher') },
		{ key: 'opens', label: t('ln.list.opens'), width: '24%' },
		platform
			? { key: 'sharing', label: t('ln.list.sharing'), width: '17%' }
			: { key: 'audience', label: t('ln.list.audience'), width: '17%' },
		{ key: 'status', label: t('ln.list.status'), width: '96px' },
		{ key: 'updated', label: t('ln.list.updated'), width: '13%' },
		...(canWrite
			? [
					{
						key: 'actions',
						label: t('ln.list.actions', { name: '' }),
						width: '56px',
						hideLabel: true
					}
				]
			: [])
	]);
</script>

<Page>
	<PageHeader
		{title}
		description={platform ? t('ln.platform.description') : t('ln.list.description')}
	>
		{#snippet actions()}
			{#if canWrite && phase === 'ready'}
				<Button variant="primary" icon="plus" href={hrefOf('new')}>{t('ln.list.create')}</Button>
			{/if}
		{/snippet}
	</PageHeader>

	<div class="launcher-list" bind:this={root}>
		<Card {title} info={platform ? t('ln.platform.info') : t('ln.list.info')} flush>
			{#if phase === 'loading'}
				<LoadingState label={t('common.loading')} />
			{:else if phase === 'forbidden'}
				<EmptyState icon="lock" title={t('ln.list.noAccess')} />
			{:else if phase === 'failed'}
				<EmptyState icon="warningCircle" title={t('ln.list.loadFailed')}>
					{#snippet action()}<Button size="sm" onclick={load}>{t('common.retry')}</Button>{/snippet}
				</EmptyState>
			{:else}
				<DataTable
					caption={title}
					{columns}
					rows={launchers}
					rowKey={(launcher) => launcher.id}
					onrowopen={(launcher) => onopen(launcher.id)}
					rowOpenLabel={(launcher) => t('ln.list.open', { name: launcher.name })}
				>
					{#snippet cell(launcher, column)}
						{@const index = launchers.indexOf(launcher)}
						{#if column.key === 'order'}
							<span class="launcher-list__order">
								<IconButton
									icon="arrowUp"
									size="sm"
									label={t('ln.list.moveUp', { name: launcher.name })}
									data-move="{launcher.id}-up"
									disabled={moving || busy || index === 0}
									onclick={() => move(index, -1)}
								/>
								<IconButton
									icon="arrowDown"
									size="sm"
									label={t('ln.list.moveDown', { name: launcher.name })}
									data-move="{launcher.id}-down"
									disabled={moving || busy || index === launchers.length - 1}
									onclick={() => move(index, 1)}
								/>
							</span>
						{:else if column.key === 'launcher'}
							<span class="launcher-list__name">
								<LauncherIcon
									iconType={launcher.icon_type}
									value={launcher.icon_value}
									background={launcher.background_color}
									color={launcher.icon_color}
									size="sm"
								/>
								<span class="launcher-list__text">
									<CellText title={launcher.name} description={launcher.category ?? undefined} />
									{#if launcher.shared}
										<span class="launcher-list__badges">
											<Badge tone="info">{t('ln.shared.badge')}</Badge>
											{#if launcher.shared.platform_updated}
												<Badge tone="warning">{t('ln.shared.updatedBadge')}</Badge>
											{/if}
										</span>
									{/if}
								</span>
							</span>
						{:else if column.key === 'opens'}
							{@const opens = opensSummary(launcher)}
							<CellText title={opens.title} description={opens.description} />
						{:else if column.key === 'audience'}
							{audienceSummary(launcher.visibility)}
						{:else if column.key === 'sharing'}
							{sharingSummary(launcher)}
							{#if launcher.sharing && !launcher.sharing.tenant_change_allowed}
								<Badge>{t('ln.sharing.lockedBadge')}</Badge>
							{/if}
						{:else if column.key === 'status'}
							{#if launcher.enabled}
								<Badge tone="success" dot>{t('ln.status.shown')}</Badge>
							{:else}
								<Badge dot>{t('ln.status.hidden')}</Badge>
							{/if}
						{:else if column.key === 'updated'}
							{#if launcher.updated_at}<DateTime value={launcher.updated_at} stacked />{:else}—{/if}
						{:else if column.key === 'actions'}
							<ActionMenu
								size="sm"
								label={t('ln.list.actions', { name: launcher.name })}
								actions={actionsOf(launcher)}
							/>
						{/if}
					{/snippet}
					{#snippet empty()}
						<EmptyState
							icon="squaresFour"
							title={t('ln.list.empty')}
							description={t('ln.list.emptyBody')}
						>
							{#snippet action()}
								{#if canWrite}
									<Button size="sm" icon="plus" href={hrefOf('new')}>{t('ln.list.create')}</Button>
								{/if}
							{/snippet}
						</EmptyState>
					{/snippet}
				</DataTable>
			{/if}
		</Card>
	</div>
</Page>

<ConfirmDialog
	open={deleting !== null}
	title={t('ln.list.deleteTitle', { name: deleting?.name ?? '' })}
	body={t('ln.list.deleteBody')}
	confirmLabel={t('ln.list.delete')}
	tone="danger"
	{busy}
	onconfirm={remove}
	oncancel={() => (deleting = null)}
/>

<style>
	.launcher-list {
		display: contents;
	}

	.launcher-list__order {
		display: inline-flex;
		gap: 4px;
	}

	.launcher-list__name {
		display: flex;
		align-items: center;
		gap: 10px;
		min-inline-size: 0;
	}

	.launcher-list__text {
		display: grid;
		gap: 4px;
		justify-items: start;
		min-inline-size: 0;
	}

	.launcher-list__badges {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}
</style>
