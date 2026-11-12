<script lang="ts">
	import { untrack } from 'svelte';
	import type { AdminUserActivity, AdminUsersClient } from '#lib/api/admin-users.js';
	import { isIncompleteError } from '#lib/api/user-audit.js';
	import { hasMessage, t } from '#lib/i18n/i18n.svelte.js';
	import {
		RESULT_LABEL,
		RESULT_TONE,
		eventLabel,
		eventLabelKey,
		resultOf
	} from '#lib/pages/monitoring/user-audit-labels.js';
	import Card from '#lib/ui/patterns/Card.svelte';
	import DataTable from '#lib/ui/patterns/DataTable.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import DateTime from '#lib/ui/time/DateTime.svelte';

	/**
	 * The user's latest events (sign-ins, sessions, changes). Loads on its own, so a failure here
	 * leaves the rest of the page alone; the full log is one link away.
	 */
	interface Props {
		client: AdminUsersClient;
		userId: string;
		/** Opens the audit log for this user. */
		onopenaudit?: (userId: string) => void;
		/** Changes when the user was changed on this page: read the activity again. */
		refresh?: number;
	}

	let { client, userId, onopenaudit, refresh = 0 }: Props = $props();

	let data = $state<AdminUserActivity | null>(null);
	let phase = $state<'loading' | 'ready' | 'failed' | 'incomplete'>('loading');

	let generation = 0;
	async function load(): Promise<void> {
		const mine = ++generation;
		phase = 'loading';
		try {
			const result = await client.activity(userId);
			if (mine !== generation) return;
			data = result;
			phase = 'ready';
		} catch (error) {
			if (mine !== generation) return;
			// Too many events in the period: asking again cannot help, the audit log can narrow it.
			phase = isIncompleteError(error) ? 'incomplete' : 'failed';
		}
	}

	$effect(() => {
		void [userId, refresh];
		untrack(() => void load());
	});

	const columns = $derived([
		{ key: 'time', label: t('usr.d.col.time'), width: '26%' },
		{ key: 'event', label: t('usr.d.col.event') },
		{ key: 'result', label: t('usr.d.col.result'), width: '18%' }
	]);
</script>

<Card
	title={t('usr.d.activity')}
	description={t('usr.d.activity.period')}
	flush={phase === 'ready' && !!data && data.entries.length > 0}
>
	{#snippet actions()}
		{#if onopenaudit}
			<Button size="sm" onclick={() => onopenaudit(userId)}>{t('usr.d.activity.all')}</Button>
		{/if}
	{/snippet}
	{#if phase === 'loading'}
		<p class="muted" role="status">{t('common.loading')}</p>
	{:else if phase === 'incomplete'}
		<p class="muted">{t('usr.d.activity.tooMany')}</p>
	{:else if phase === 'failed' || !data}
		<div class="failed">
			<p class="muted">{t('usr.d.section.failed')}</p>
			<Button size="sm" onclick={load}>{t('common.retry')}</Button>
		</div>
	{:else if data.entries.length === 0}
		<p class="muted">{t('usr.d.activity.empty')}</p>
	{:else}
		<DataTable caption={t('usr.d.activity')} {columns} rows={data.entries} rowKey={(row) => row.id}>
			{#snippet cell(row, column)}
				{#if column.key === 'time'}
					{#if row.at}<DateTime value={row.at} stacked />{:else}—{/if}
				{:else if column.key === 'event'}
					{#if eventLabelKey(row.action, hasMessage)}
						{eventLabel(row.action, t, hasMessage)}
					{:else}
						<code>{row.action}</code>
					{/if}
				{:else}
					{@const result = resultOf(row)}
					{#if result}
						<Badge tone={RESULT_TONE[result]} dot>{t(RESULT_LABEL[result])}</Badge>
					{/if}
				{/if}
			{/snippet}
		</DataTable>
	{/if}
</Card>

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
</style>
