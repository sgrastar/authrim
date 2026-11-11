<script lang="ts">
	import { untrack } from 'svelte';
	import { ApiError } from '#lib/api/api-error.js';
	import type { SessionProfile, SessionProfilesClient } from '#lib/api/session-profiles.js';
	import { keepsCopy } from '#lib/api/profile-layer.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Card from '#lib/ui/patterns/Card.svelte';
	import CellText from '#lib/ui/patterns/CellText.svelte';
	import ConfirmDialog from '#lib/ui/patterns/ConfirmDialog.svelte';
	import DataTable from '#lib/ui/patterns/DataTable.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import ActionMenu, { type MenuAction } from '#lib/ui/primitives/ActionMenu.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import ProfileLayerBadges from './ProfileLayerBadges.svelte';
	import DateTime from '#lib/ui/time/DateTime.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import { formatSetting } from '#lib/settings/setting-format.js';
	import { sessionSettingMeta } from './session-profile-fields';

	interface Props {
		client: SessionProfilesClient;
		canWrite: boolean;
		hrefOf: (id: string) => string;
		onopen: (id: string) => void;
	}
	let { client, canWrite, hrefOf, onopen }: Props = $props();
	let profiles = $state<SessionProfile[]>([]);
	let phase = $state<'loading' | 'ready' | 'forbidden' | 'failed'>('loading');
	let deleting = $state<SessionProfile | null>(null);
	/** A platform profile whose copy the admin is about to remove. */
	let reverting = $state<SessionProfile | null>(null);
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

	async function remove() {
		const profile = deleting;
		if (!profile || profile.is_system) return;
		busy = true;
		try {
			await client.remove(profile.id);
			profiles = profiles.filter((item) => item.id !== profile.id);
			deleting = null;
			toast.success(t('sp.list.deleteSuccess'));
		} catch {
			toast.error(t('sp.page.saveFailed'));
		} finally {
			busy = false;
		}
	}

	async function revert() {
		const profile = reverting;
		if (!profile) return;
		busy = true;
		try {
			const updated = await client.revert(profile.id);
			profiles = profiles.map((item) => (item.id === updated.id ? updated : item));
			reverting = null;
			toast.success(t('pl.revertSuccess'));
		} catch {
			toast.error(t('pl.revertFailed'));
		} finally {
			busy = false;
		}
	}

	function actionsOf(profile: SessionProfile): MenuAction[] {
		const open: MenuAction = {
			label: t('sp.list.open', { name: profile.name }),
			icon: 'pencil',
			onselect: () => onopen(profile.id)
		};
		// A platform profile is not the tenant's to delete: only its copy can go.
		if (profile.layer?.scope === 'platform') {
			return keepsCopy(profile.layer)
				? [
						open,
						{
							label: t('pl.revert'),
							icon: 'reset',
							disabled: busy,
							onselect: () => (reverting = profile)
						}
					]
				: [open];
		}
		return [
			{
				label: t('sp.list.open', { name: profile.name }),
				icon: 'pencil',
				onselect: () => onopen(profile.id)
			},
			{
				label: t('sp.list.delete'),
				icon: 'trash',
				danger: true,
				disabled: busy,
				onselect: () => (deleting = profile)
			}
		];
	}

	/** How long a session lasts, and whether single sign-on is on. */
	function summary(profile: SessionProfile): string {
		const length = profile.values['session.default_ttl'];
		const parts = [
			length === undefined
				? t('sp.list.asDefault')
				: formatSetting('session.default_ttl', sessionSettingMeta('session.default_ttl'), length),
			profile.values['oauth.sso_enabled'] === undefined
				? t('sp.list.ssoAsDefault')
				: profile.values['oauth.sso_enabled'] === true
					? t('sp.list.ssoOn')
					: t('sp.list.ssoOff')
		];
		return parts.join(' · ');
	}

	const columns = $derived([
		{ key: 'name', label: t('sp.list.name') },
		{ key: 'summary', label: t('sp.list.summary'), width: '34%' },
		{ key: 'created', label: t('sp.list.created'), width: '15%' },
		{ key: 'updated', label: t('sp.list.updated'), width: '15%' },
		...(canWrite
			? [
					{
						key: 'actions',
						label: t('sp.list.actions', { name: '' }),
						width: '56px',
						hideLabel: true
					}
				]
			: [])
	]);
</script>

<Page>
	<PageHeader title={t('sp.list.title')} description={t('sp.list.description')}>
		{#snippet actions()}
			{#if canWrite}<Button variant="primary" icon="plus" href={hrefOf('new')}
					>{t('sp.list.create')}</Button
				>{/if}
		{/snippet}
	</PageHeader>
	<Card title={t('sp.list.title')} flush>
		{#if phase === 'loading'}
			<LoadingState label={t('common.loading')} />
		{:else if phase === 'forbidden'}
			<EmptyState icon="lock" title={t('sp.page.noAccess')} />
		{:else if phase === 'failed'}
			<EmptyState icon="warningCircle" title={t('sp.page.loadFailed')}>
				{#snippet action()}<Button size="sm" onclick={load}>{t('common.retry')}</Button>{/snippet}
			</EmptyState>
		{:else}
			<DataTable
				caption={t('sp.list.title')}
				{columns}
				rows={profiles}
				rowKey={(profile) => profile.id}
				onrowopen={(profile) => onopen(profile.id)}
				rowOpenLabel={(profile) => t('sp.list.open', { name: profile.name })}
			>
				{#snippet cell(profile, column)}
					{#if column.key === 'name'}
						<span class="profile-name">
							<CellText title={profile.name} />
							<ProfileLayerBadges layer={profile.layer} />
						</span>
					{:else if column.key === 'summary'}{summary(profile)}
					{:else if column.key === 'created'}
						{#if profile.created_at}<DateTime value={profile.created_at} stacked />{:else}—{/if}
					{:else if column.key === 'updated'}
						{#if profile.updated_at}<DateTime value={profile.updated_at} stacked />{:else}—{/if}
					{:else if column.key === 'actions' && !profile.is_system}
						<ActionMenu
							size="sm"
							label={t('sp.list.actions', { name: profile.name })}
							actions={actionsOf(profile)}
						/>
					{/if}
				{/snippet}
				{#snippet empty()}<EmptyState icon="clock" title={t('sp.list.empty')} />{/snippet}
			</DataTable>
		{/if}
	</Card>
</Page>

<ConfirmDialog
	open={deleting !== null}
	title={t('sp.list.deleteTitle', { name: deleting?.name ?? '' })}
	body={t('sp.list.deleteBody')}
	confirmLabel={t('sp.list.delete')}
	tone="danger"
	{busy}
	onconfirm={remove}
	oncancel={() => (deleting = null)}
/>

<ConfirmDialog
	open={reverting !== null}
	title={t('pl.revertTitle', { name: reverting?.name ?? '' })}
	body={t('pl.revertBody')}
	confirmLabel={t('pl.revert')}
	{busy}
	onconfirm={revert}
	oncancel={() => (reverting = null)}
/>

<style>
	.profile-name {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 4px;
	}
</style>
