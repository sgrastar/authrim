<script lang="ts">
	import { untrack } from 'svelte';
	import type { TeamAccess } from '#lib/access/access.js';
	import type { AdminStatus, AdminTeamClient, TeamAdmin } from '#lib/api/admin-team.js';
	import { ApiError } from '#lib/api/api-error.js';
	import { t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
	import Card from '#lib/ui/patterns/Card.svelte';
	import CellText from '#lib/ui/patterns/CellText.svelte';
	import ConfirmDialog from '#lib/ui/patterns/ConfirmDialog.svelte';
	import DataTable from '#lib/ui/patterns/DataTable.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import FilterBar from '#lib/ui/patterns/FilterBar.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import Pagination from '#lib/ui/patterns/Pagination.svelte';
	import ActionMenu, { type MenuAction } from '#lib/ui/primitives/ActionMenu.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import SearchField from '#lib/ui/primitives/SearchField.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import DateTime from '#lib/ui/time/DateTime.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import { adminLabel, isLocked } from './team-model';
	import { teamErrorKey } from './team-errors';

	/**
	 * The tenant's administrators: searched by email, narrowed by state and second factor, a page
	 * at a time (the API pages). With the right to manage admins, a row's menu suspends,
	 * reactivates or unlocks it, after a confirmation.
	 */
	interface Props {
		client: AdminTeamClient;
		access: TeamAccess;
		/** Rows per page at first. */
		pageSize?: number;
	}

	let { client, access, pageSize: initialSize = 20 }: Props = $props();

	type Change = 'suspend' | 'activate' | 'unlock';

	let admins = $state<TeamAdmin[]>([]);
	let total = $state(0);
	let page = $state(1);
	let pageSize = $state(untrack(() => initialSize));
	let email = $state('');
	let status = $state('');
	let mfa = $state('');
	let phase = $state<'loading' | 'ready' | 'forbidden' | 'failed'>('loading');
	let busy = $state(false);
	let pending = $state<{ change: Change; admin: TeamAdmin } | null>(null);
	let request = 0;

	async function load() {
		const mine = ++request;
		phase = 'loading';
		try {
			const result = await client.listAdmins({
				page,
				limit: pageSize,
				email: email || undefined,
				status: (status || undefined) as AdminStatus | undefined,
				mfa: mfa === '' ? undefined : mfa === 'on'
			});
			if (mine !== request) return;
			// A change emptied the last page (the last one there suspended under a filter): go to
			// the page that is now last, which loads again.
			if (result.admins.length === 0 && page > 1 && result.totalPages > 0) {
				page = Math.min(page - 1, result.totalPages);
				return;
			}
			({ admins, total } = result);
			phase = 'ready';
		} catch (error) {
			if (mine !== request) return;
			phase = error instanceof ApiError && error.status === 403 ? 'forbidden' : 'failed';
		}
	}

	$effect(() => {
		// Reload when the query changes; a new filter starts at the first page (below).
		void [page, pageSize, email, status, mfa];
		untrack(() => void load());
	});

	function filter(apply: () => void) {
		apply();
		page = 1;
	}

	const filtered = $derived(!!email || !!status || !!mfa);

	function clear() {
		filter(() => {
			email = '';
			status = '';
			mfa = '';
		});
	}

	const DONE: Record<Change, MessageKey> = {
		suspend: 'tm.toast.suspended',
		activate: 'tm.toast.activated',
		unlock: 'tm.toast.unlocked'
	};

	async function confirm() {
		if (!pending) return;
		const { change, admin } = pending;
		busy = true;
		try {
			await client[change](admin.id);
			pending = null;
			toast.success(t(DONE[change], { name: adminLabel(admin) }));
			await load();
		} catch (error) {
			pending = null;
			toast.error(t(teamErrorKey(error)));
		} finally {
			busy = false;
		}
	}

	const actionsOf = (admin: TeamAdmin): MenuAction[] => {
		const ask = (change: Change) => () => (pending = { change, admin });
		const actions: MenuAction[] = [];
		if (isLocked(admin)) {
			actions.push({ label: t('tm.action.unlock'), icon: 'lock', onselect: ask('unlock') });
		}
		if (admin.status === 'suspended') {
			actions.push({
				label: t('tm.action.activate'),
				icon: 'checkCircle',
				onselect: ask('activate')
			});
		} else {
			actions.push({
				label: t('tm.action.suspend'),
				icon: 'close',
				danger: true,
				onselect: ask('suspend')
			});
		}
		return actions.map((action) => ({ ...action, disabled: busy }));
	};

	const statusOptions = $derived([
		{ value: '', label: `${t('tm.admins.filter.status')}: ${t('tm.admins.filter.all')}` },
		{ value: 'active', label: t('tm.status.active') },
		{ value: 'suspended', label: t('tm.status.suspended') },
		{ value: 'locked', label: t('tm.status.locked') }
	]);
	const mfaOptions = $derived([
		{ value: '', label: `${t('tm.admins.filter.mfa')}: ${t('tm.admins.filter.all')}` },
		{ value: 'on', label: t('tm.admins.filter.mfaOn') },
		{ value: 'off', label: t('tm.admins.filter.mfaOff') }
	]);

	const columns = $derived([
		{ key: 'admin', label: t('tm.admins.col.admin') },
		{ key: 'status', label: t('tm.admins.col.status'), width: '16%' },
		{ key: 'mfa', label: t('tm.admins.col.mfa'), width: '16%' },
		{ key: 'lastLogin', label: t('tm.admins.col.lastLogin'), width: '22%' },
		...(access.manage
			? [
					{
						key: 'actions',
						label: t('tm.admins.col.actions', { name: '' }),
						width: '56px',
						hideLabel: true
					}
				]
			: [])
	]);

	const CONFIRM: Record<Change, { title: MessageKey; body: MessageKey; label: MessageKey }> = {
		suspend: { title: 'tm.suspend.title', body: 'tm.suspend.body', label: 'tm.action.suspend' },
		activate: { title: 'tm.activate.title', body: 'tm.activate.body', label: 'tm.action.activate' },
		unlock: { title: 'tm.unlock.title', body: 'tm.unlock.body', label: 'tm.action.unlock' }
	};
	const shown = $derived(pending ? CONFIRM[pending.change] : CONFIRM.suspend);
</script>

{#if phase === 'forbidden'}
	<EmptyState icon="lock" title={t('tm.admins.noAccess')} />
{:else}
	<FilterBar results={phase === 'ready' ? total : undefined} active={filtered} onclear={clear}>
		{#snippet search()}
			<SearchField
				label={t('tm.admins.search')}
				placeholder={t('tm.admins.search')}
				size="sm"
				delay={300}
				value={email}
				onsearch={(value) => filter(() => (email = value.trim()))}
			/>
		{/snippet}
		<Select
			label={t('tm.admins.filter.status')}
			hideLabel
			size="sm"
			options={statusOptions}
			value={status}
			onchange={(value) => filter(() => (status = value))}
		/>
		<Select
			label={t('tm.admins.filter.mfa')}
			hideLabel
			size="sm"
			options={mfaOptions}
			value={mfa}
			onchange={(value) => filter(() => (mfa = value))}
		/>
	</FilterBar>

	<Card
		title={t('tm.admins.title')}
		description={t('tm.admins.homeNote')}
		flush
		footer={phase === 'ready' && total > pageSize ? pager : undefined}
	>
		{#if phase === 'loading'}
			<LoadingState label={t('common.loading')} />
		{:else if phase === 'failed'}
			<EmptyState icon="warningCircle" title={t('tm.admins.loadFailed')}>
				{#snippet action()}
					<Button size="sm" onclick={load}>{t('common.retry')}</Button>
				{/snippet}
			</EmptyState>
		{:else}
			<DataTable caption={t('tm.admins.title')} {columns} rows={admins} rowKey={(row) => row.id}>
				{#snippet cell(row, column)}
					{#if column.key === 'admin'}
						<CellText
							title={row.name ?? row.email}
							description={row.name ? row.email : undefined}
						/>
					{:else if column.key === 'status'}
						{#if isLocked(row)}
							<Badge tone="danger" dot>{t('tm.status.locked')}</Badge>
						{:else if row.status === 'suspended'}
							<Badge tone="warning" dot>{t('tm.status.suspended')}</Badge>
						{:else}
							<Badge tone="success" dot>{t('tm.status.active')}</Badge>
						{/if}
					{:else if column.key === 'mfa'}
						{row.mfa_enabled ? t('tm.mfa.on') : t('tm.mfa.off')}
					{:else if column.key === 'lastLogin'}
						{#if row.last_login_at}
							<DateTime value={row.last_login_at} stacked />
						{:else}
							{t('tm.admins.never')}
						{/if}
					{:else}
						<ActionMenu
							size="sm"
							label={t('tm.admins.col.actions', { name: adminLabel(row) })}
							actions={actionsOf(row)}
						/>
					{/if}
				{/snippet}
				{#snippet empty()}
					<EmptyState
						icon="users"
						title={t('tm.admins.empty')}
						description={filtered ? t('tm.admins.emptyBody') : undefined}
					/>
				{/snippet}
			</DataTable>
		{/if}
	</Card>
{/if}

{#snippet pager()}
	<Pagination
		{page}
		{pageSize}
		{total}
		pageSizes={[20, 50, 100]}
		onchange={(nextPage, nextSize) => {
			page = nextSize === pageSize ? nextPage : 1;
			pageSize = nextSize;
		}}
	/>
{/snippet}

<ConfirmDialog
	open={pending !== null}
	title={t(shown.title, { name: pending ? adminLabel(pending.admin) : '' })}
	body={t(shown.body)}
	confirmLabel={t(shown.label)}
	tone={pending?.change === 'suspend' ? 'danger' : 'default'}
	{busy}
	onconfirm={confirm}
	oncancel={() => (pending = null)}
/>
