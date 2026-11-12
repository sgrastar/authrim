<script lang="ts">
	import { untrack } from 'svelte';
	import type { TeamAccess } from '#lib/access/access.js';
	import type { AdminTeamClient, TeamInvitation } from '#lib/api/admin-team.js';
	import { ApiError } from '#lib/api/api-error.js';
	import { t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
	import Card from '#lib/ui/patterns/Card.svelte';
	import CellText from '#lib/ui/patterns/CellText.svelte';
	import ConfirmDialog from '#lib/ui/patterns/ConfirmDialog.svelte';
	import DataTable from '#lib/ui/patterns/DataTable.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import ActionMenu, { type MenuAction } from '#lib/ui/primitives/ActionMenu.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import Checkbox from '#lib/ui/primitives/Checkbox.svelte';
	import DateTime from '#lib/ui/time/DateTime.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import { teamErrorKey } from './team-errors';
	import { SUPER_ADMIN_ROLE } from './team-model';

	/**
	 * The invitations sent to new administrators. Those still waiting for their recipient at
	 * first; a switch adds the accepted, revoked and expired ones (the last 100). A waiting or
	 * expired invitation can be sent again (a new code, a new time limit) or revoked.
	 */
	interface Props {
		client: AdminTeamClient;
		access: TeamAccess;
	}

	let { client, access }: Props = $props();

	type Change = 'resend' | 'revoke';

	let invitations = $state<TeamInvitation[]>([]);
	let all = $state(false);
	let phase = $state<'loading' | 'ready' | 'forbidden' | 'failed'>('loading');
	let busy = $state(false);
	let pending = $state<{ change: Change; invitation: TeamInvitation } | null>(null);
	let request = 0;

	async function load() {
		const mine = ++request;
		phase = 'loading';
		try {
			const result = await client.listInvitations(all);
			if (mine !== request) return;
			invitations = result;
			phase = 'ready';
		} catch (error) {
			if (mine !== request) return;
			phase = error instanceof ApiError && error.status === 403 ? 'forbidden' : 'failed';
		}
	}

	$effect(() => {
		void all;
		untrack(() => void load());
	});

	async function confirm() {
		if (!pending) return;
		const { change, invitation } = pending;
		busy = true;
		try {
			if (change === 'resend') {
				const { delivered } = await client.resendInvitation(invitation.id);
				const done = delivered ? 'tm.toast.resent' : 'tm.toast.resentNotDelivered';
				(delivered ? toast.success : toast.warning)(t(done, { email: invitation.email }));
			} else {
				await client.revokeInvitation(invitation.id);
				toast.success(t('tm.toast.revoked', { email: invitation.email }));
			}
			pending = null;
			await load();
		} catch (error) {
			pending = null;
			toast.error(t(teamErrorKey(error)));
		} finally {
			busy = false;
		}
	}

	/**
	 * An invitation for every tenant (a super administrator's always is) is sent again or revoked
	 * only with the authority to give such roles, as creating it took.
	 */
	const canChange = (invitation: TeamInvitation) =>
		access.global ||
		(invitation.scope_type !== 'global' && invitation.role.name !== SUPER_ADMIN_ROLE);

	// A code that was handed over is not e-mailed again: the service that received it re-issues or
	// revokes it through the API.
	const actionsOf = (invitation: TeamInvitation): MenuAction[] => [
		...(invitation.code_delivery === 'response'
			? []
			: [
					{
						label: t('tm.inv.action.resend'),
						icon: 'mail' as const,
						disabled: busy,
						onselect: () => (pending = { change: 'resend', invitation })
					}
				]),
		{
			label: t('tm.inv.action.revoke'),
			icon: 'trash',
			danger: true,
			disabled: busy,
			onselect: () => (pending = { change: 'revoke', invitation })
		}
	];

	const STATUS: Record<
		TeamInvitation['status'],
		{ key: MessageKey; tone: 'info' | 'neutral' | 'success' | 'warning' }
	> = {
		pending: { key: 'tm.inv.status.pending', tone: 'info' },
		expired: { key: 'tm.inv.status.expired', tone: 'warning' },
		accepted: { key: 'tm.inv.status.accepted', tone: 'success' },
		revoked: { key: 'tm.inv.status.revoked', tone: 'neutral' }
	};

	const columns = $derived([
		{ key: 'invitee', label: t('tm.inv.col.invitee') },
		{ key: 'role', label: t('tm.inv.col.role'), width: '24%' },
		{ key: 'status', label: t('tm.inv.col.status'), width: '14%' },
		{ key: 'delivery', label: t('tm.inv.col.delivery'), width: '14%' },
		{ key: 'expires', label: t('tm.inv.col.expires'), width: '20%' },
		...(access.invite
			? [
					{
						key: 'actions',
						label: t('tm.inv.col.actions', { name: '' }),
						width: '56px',
						hideLabel: true
					}
				]
			: [])
	]);

	const confirmTitle = $derived(
		pending
			? t(pending.change === 'resend' ? 'tm.resend.title' : 'tm.revoke.title', {
					email: pending.invitation.email
				})
			: ''
	);
</script>

{#if phase === 'forbidden'}
	<EmptyState icon="lock" title={t('tm.inv.noAccess')} />
{:else}
	<Card title={t('tm.inv.title')} description={all ? t('tm.inv.limitNote') : undefined} flush>
		{#snippet actions()}
			<Checkbox size="sm" bind:checked={all}>{t('tm.inv.showCompleted')}</Checkbox>
		{/snippet}
		{#if phase === 'loading'}
			<LoadingState label={t('common.loading')} />
		{:else if phase === 'failed'}
			<EmptyState icon="warningCircle" title={t('tm.inv.loadFailed')}>
				{#snippet action()}
					<Button size="sm" onclick={load}>{t('common.retry')}</Button>
				{/snippet}
			</EmptyState>
		{:else}
			<DataTable caption={t('tm.inv.title')} {columns} rows={invitations} rowKey={(row) => row.id}>
				{#snippet cell(row, column)}
					{#if column.key === 'invitee'}
						<CellText
							title={row.name ?? row.email}
							description={row.name ? row.email : undefined}
						/>
					{:else if column.key === 'role'}
						<CellText title={row.role.display_name ?? row.role.name} />
						{#if row.scope_type === 'global'}
							<Badge tone="warning">{t('tm.inv.scope.global')}</Badge>
						{/if}
					{:else if column.key === 'status'}
						<Badge tone={STATUS[row.status].tone} dot>{t(STATUS[row.status].key)}</Badge>
					{:else if column.key === 'delivery'}
						{#if row.code_delivery === 'response'}
							{t('tm.inv.delivery.handed')}
						{:else if row.last_delivery_status === 'failed'}
							<Badge tone="danger">{t('tm.inv.delivery.failed')}</Badge>
						{:else if row.last_delivery_status === 'sent'}
							{t('tm.inv.delivery.sent')}
						{:else}
							{t('tm.inv.delivery.pending')}
						{/if}
					{:else if column.key === 'expires'}
						<DateTime value={row.expires_at} stacked />
					{:else if (row.status === 'pending' || row.status === 'expired') && canChange(row)}
						<ActionMenu
							size="sm"
							label={t('tm.inv.col.actions', { name: row.email })}
							actions={actionsOf(row)}
						/>
					{/if}
				{/snippet}
				{#snippet empty()}
					<EmptyState
						icon="mail"
						title={all ? t('tm.inv.emptyAll') : t('tm.inv.empty')}
						description={access.invite ? t('tm.inv.emptyBody') : undefined}
					/>
				{/snippet}
			</DataTable>
		{/if}
	</Card>
{/if}

<ConfirmDialog
	open={pending !== null}
	title={confirmTitle}
	body={t(pending?.change === 'revoke' ? 'tm.revoke.body' : 'tm.resend.body')}
	confirmLabel={t(pending?.change === 'revoke' ? 'tm.inv.action.revoke' : 'tm.inv.action.resend')}
	tone={pending?.change === 'revoke' ? 'danger' : 'default'}
	{busy}
	onconfirm={confirm}
	oncancel={() => (pending = null)}
/>
