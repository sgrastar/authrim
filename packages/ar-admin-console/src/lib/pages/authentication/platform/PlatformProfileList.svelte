<script lang="ts">
	import { untrack } from 'svelte';
	import { ApiError } from '#lib/api/api-error.js';
	import type { PlatformProfile, PlatformProfilesClient } from '#lib/api/platform-profiles.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Card from '#lib/ui/patterns/Card.svelte';
	import CellText from '#lib/ui/patterns/CellText.svelte';
	import ConfirmDialog from '#lib/ui/patterns/ConfirmDialog.svelte';
	import DataTable from '#lib/ui/patterns/DataTable.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import ActionMenu, { type MenuAction } from '#lib/ui/primitives/ActionMenu.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import DateTime from '#lib/ui/time/DateTime.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';

	/**
	 * The platform's own profiles of one kind: what each is called, whether it is locked, how many
	 * tenants keep a copy of it. Locking and deleting are here; editing opens its page.
	 */
	interface Props {
		client: PlatformProfilesClient;
		canWrite: boolean;
		hrefOf: (id: string) => string;
		onopen: (id: string) => void;
	}
	let { client, canWrite, hrefOf, onopen }: Props = $props();
	let profiles = $state<PlatformProfile[]>([]);
	let phase = $state<'loading' | 'ready' | 'forbidden' | 'failed'>('loading');
	let deleting = $state<PlatformProfile | null>(null);
	let busy = $state(false);

	async function load() {
		phase = 'loading';
		try {
			profiles = await client.list();
			phase = 'ready';
		} catch (error) {
			phase = error instanceof ApiError && error.forbidden ? 'forbidden' : 'failed';
		}
	}
	$effect(() => {
		untrack(() => void load());
	});

	const replace = (profile: PlatformProfile) =>
		(profiles = profiles.map((item) => (item.id === profile.id ? profile : item)));

	async function setLocked(profile: PlatformProfile, locked: boolean) {
		busy = true;
		try {
			replace(await client.setLocked(profile.id, profile.version, locked));
			toast.success(t(locked ? 'pp.list.locked' : 'pp.list.unlocked'));
		} catch (error) {
			toast.error(
				error instanceof ApiError && error.status === 409
					? t('pp.page.conflict')
					: t('pp.list.failed')
			);
			void load();
		} finally {
			busy = false;
		}
	}

	async function remove() {
		const profile = deleting;
		if (!profile) return;
		busy = true;
		try {
			await client.remove(profile.id);
			profiles = profiles.filter((item) => item.id !== profile.id);
			deleting = null;
			toast.success(t('pp.list.deleteSuccess'));
		} catch (error) {
			deleting = null;
			const code = error instanceof ApiError ? error.body.error : undefined;
			toast.error(
				code === 'profile_in_use'
					? t('pp.list.inUse')
					: code === 'reference_check_incomplete'
						? t('pp.list.checkIncomplete')
						: t('pp.list.failed')
			);
			void load();
		} finally {
			busy = false;
		}
	}

	function actionsOf(profile: PlatformProfile): MenuAction[] {
		const actions: MenuAction[] = [
			{
				label: t('pp.list.open', { name: profile.name }),
				icon: 'pencil',
				onselect: () => onopen(profile.id)
			}
		];
		if (profile.state !== 'active') return actions;
		actions.push(
			{
				label: t(profile.locked ? 'pp.list.unlock' : 'pp.list.lock'),
				icon: 'lock',
				disabled: busy,
				onselect: () => void setLocked(profile, !profile.locked)
			},
			{
				label: t('pp.list.delete'),
				icon: 'trash',
				danger: true,
				disabled: busy,
				onselect: () => (deleting = profile)
			}
		);
		return actions;
	}

	const columns = $derived([
		{ key: 'name', label: t('pp.list.name') },
		{ key: 'overriding', label: t('pp.list.overriding'), width: '28%' },
		{ key: 'updated', label: t('pp.list.updated'), width: '20%' },
		...(canWrite
			? [
					{
						key: 'actions',
						label: t('pp.list.actions', { name: '' }),
						width: '56px',
						hideLabel: true
					}
				]
			: [])
	]);
</script>

<Card title={t('pp.tab.profiles')} flush>
	{#snippet actions()}
		{#if canWrite}<Button size="sm" icon="plus" href={hrefOf('new')}>{t('pp.list.create')}</Button
			>{/if}
	{/snippet}
	{#if phase === 'loading'}
		<LoadingState label={t('common.loading')} />
	{:else if phase === 'forbidden'}
		<EmptyState icon="lock" title={t('pp.page.noAccess')} />
	{:else if phase === 'failed'}
		<EmptyState icon="warningCircle" title={t('pp.page.loadFailed')}>
			{#snippet action()}<Button size="sm" onclick={load}>{t('common.retry')}</Button>{/snippet}
		</EmptyState>
	{:else}
		<DataTable
			caption={t('pp.tab.profiles')}
			{columns}
			rows={profiles}
			rowKey={(profile) => profile.id}
			onrowopen={(profile) => onopen(profile.id)}
			rowOpenLabel={(profile) => t('pp.list.open', { name: profile.name })}
		>
			{#snippet cell(profile, column)}
				{#if column.key === 'name'}
					<span class="profile-name">
						<CellText title={profile.name} />
						{#if profile.locked || profile.state !== 'active'}
							<span class="profile-name__badges">
								{#if profile.locked}<Badge size="sm">{t('pl.locked')}</Badge>{/if}
								{#if profile.state !== 'active'}<Badge size="sm" tone="warning"
										>{t('pp.list.deleting')}</Badge
									>{/if}
							</span>
						{/if}
					</span>
				{:else if column.key === 'overriding'}
					{profile.overridingTenants === null
						? '—'
						: t('pp.list.overridingCount', { count: profile.overridingTenants })}
				{:else if column.key === 'updated'}
					{#if profile.updated_at}<DateTime value={profile.updated_at} stacked />{:else}—{/if}
				{:else if column.key === 'actions'}
					<ActionMenu
						size="sm"
						label={t('pp.list.actions', { name: profile.name })}
						actions={actionsOf(profile)}
					/>
				{/if}
			{/snippet}
			{#snippet empty()}<EmptyState icon="stack" title={t('pp.list.empty')} />{/snippet}
		</DataTable>
	{/if}
</Card>

<ConfirmDialog
	open={deleting !== null}
	title={t('pp.list.deleteTitle', { name: deleting?.name ?? '' })}
	body={t('pp.list.deleteBody')}
	confirmLabel={t('pp.list.delete')}
	tone="danger"
	{busy}
	onconfirm={remove}
	oncancel={() => (deleting = null)}
/>

<style>
	.profile-name {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 4px;
	}
	.profile-name__badges {
		display: inline-flex;
		gap: 4px;
	}
</style>
