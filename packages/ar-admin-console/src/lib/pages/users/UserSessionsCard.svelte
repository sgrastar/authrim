<script lang="ts">
	import { untrack } from 'svelte';
	import { type AdminUserSessions, type AdminUsersClient } from '#lib/api/admin-users.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Card from '#lib/ui/patterns/Card.svelte';
	import CellText from '#lib/ui/patterns/CellText.svelte';
	import ConfirmDialog from '#lib/ui/patterns/ConfirmDialog.svelte';
	import DataTable from '#lib/ui/patterns/DataTable.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import DateTime from '#lib/ui/time/DateTime.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import { deviceText, signOutErrorKey } from './user-model';

	/**
	 * The user's active sessions, and signing them out everywhere (the Admin API asks for a
	 * step-up first). Loads on its own, so a failure here leaves the rest of the page alone.
	 */
	interface Props {
		client: AdminUsersClient;
		userId: string;
		/** What names the user in the confirmation and the toast. */
		label: string;
		/** May sign the user out (`admin:sessions:revoke`). */
		canRevoke: boolean;
		/** Changes when something outside ended the sessions (suspending): read them again. */
		refresh?: number;
	}

	let { client, userId, label, canRevoke, refresh = 0 }: Props = $props();

	let data = $state<AdminUserSessions | null>(null);
	let phase = $state<'loading' | 'ready' | 'failed'>('loading');
	let asking = $state(false);
	let busy = $state(false);

	let generation = 0;
	async function load(quiet = false): Promise<void> {
		const mine = ++generation;
		if (!quiet) phase = 'loading';
		try {
			const result = await client.sessions(userId);
			if (mine !== generation) return;
			data = result;
			phase = 'ready';
		} catch {
			if (mine !== generation) return;
			phase = 'failed';
		}
	}

	$effect(() => {
		void [userId, refresh];
		untrack(() => void load());
	});

	async function signOut(): Promise<void> {
		busy = true;
		try {
			await client.revokeSessions(userId);
			asking = false;
			toast.success(t('usr.toast.signedOut', { name: label }));
			await load(true);
		} catch (error) {
			asking = false;
			toast.error(t(signOutErrorKey(error)));
		} finally {
			busy = false;
		}
	}

	const columns = $derived([
		{ key: 'active', label: t('usr.d.col.lastActive'), width: '22%' },
		{ key: 'expires', label: t('usr.d.col.expires'), width: '22%' },
		{ key: 'ip', label: t('usr.d.col.ip'), width: '20%' },
		{ key: 'agent', label: t('usr.d.col.agent') }
	]);
</script>

<Card title={t('usr.d.sessions')} flush={phase === 'ready' && !!data && data.sessions.length > 0}>
	{#snippet actions()}
		{#if canRevoke && phase === 'ready' && data && data.sessions.length > 0}
			<Button size="sm" icon="logout" onclick={() => (asking = true)}>{t('usr.d.signOut')}</Button>
		{/if}
	{/snippet}
	{#if phase === 'loading'}
		<p class="muted" role="status">{t('common.loading')}</p>
	{:else if phase === 'failed' || !data}
		<div class="failed">
			<p class="muted">{t('usr.d.section.failed')}</p>
			<Button size="sm" onclick={() => load()}>{t('common.retry')}</Button>
		</div>
	{:else if data.sessions.length === 0}
		<p class="muted">{t('usr.d.sessions.empty')}</p>
	{:else}
		<DataTable
			caption={t('usr.d.sessions')}
			{columns}
			rows={data.sessions}
			rowKey={(row) => row.id}
		>
			{#snippet cell(row, column)}
				{#if column.key === 'active'}
					{#if row.lastActiveAt}<DateTime value={row.lastActiveAt} stacked />{:else}—{/if}
				{:else if column.key === 'expires'}
					{#if row.expiresAt}<DateTime value={row.expiresAt} stacked />{:else}—{/if}
				{:else if column.key === 'ip'}
					{#if row.ipAddress}<code>{row.ipAddress}</code>{:else}—{/if}
				{:else if row.userAgent}
					<CellText title={deviceText(row.userAgent) ?? row.userAgent} />
				{:else}
					—
				{/if}
			{/snippet}
		</DataTable>
		{#if data.total > data.sessions.length}
			<p class="note muted">
				{t('usr.d.sessions.some', { n: data.sessions.length, total: data.total })}
			</p>
		{/if}
	{/if}
</Card>

<ConfirmDialog
	open={asking}
	title={t('usr.d.signOut.title', { name: label })}
	body={t('usr.d.signOut.body')}
	confirmLabel={t('usr.d.signOut')}
	tone="danger"
	{busy}
	onconfirm={signOut}
	oncancel={() => (asking = false)}
/>

<style>
	.muted {
		margin: 0;
		color: var(--text-muted);
	}

	.failed {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-related);
		align-items: center;
	}

	.note {
		padding: var(--box-head-pad-y) var(--box-pad);
		font-size: var(--fs-caption);
	}
</style>
