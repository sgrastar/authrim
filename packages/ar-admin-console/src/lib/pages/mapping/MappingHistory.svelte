<script lang="ts">
	import { ApiError } from '$lib/api/api-error';
	import type {
		HistoryEntry,
		IdentityMappingClient,
		RestorePreview
	} from '$lib/api/identity-mapping';
	import { t } from '$lib/i18n/i18n.svelte';
	import Callout from '$lib/ui/patterns/Callout.svelte';
	import Card from '$lib/ui/patterns/Card.svelte';
	import DataTable from '$lib/ui/patterns/DataTable.svelte';
	import EmptyState from '$lib/ui/patterns/EmptyState.svelte';
	import FormDialog from '$lib/ui/patterns/FormDialog.svelte';
	import LoadingState from '$lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '$lib/ui/patterns/PageHeader.svelte';
	import Button from '$lib/ui/primitives/Button.svelte';
	import DateTime from '$lib/ui/time/DateTime.svelte';
	import Page from '$lib/ui/templates/Page.svelte';
	import { toast } from '$lib/ui/toast/toast.svelte';
	import { changeText, label, levelValueText } from './labels';

	/**
	 * MAP-08: the changes to the tenant default and to apps' choices, newest first, each with the
	 * value before and after. Restoring one writes back the value before it, for that level only;
	 * the API's preview says what apps would see and which later changes to the same level it
	 * also undoes, and the restore is refused if the level changed since. A change whose earlier
	 * set is gone or switched off cannot be restored, and says why.
	 */
	interface Props {
		client: IdentityMappingClient;
		tenantId: string;
	}

	let { client, tenantId }: Props = $props();

	let entries = $state<HistoryEntry[] | null>(null);
	let loadError = $state(false);
	let opening = $state('');
	let plan = $state<RestorePreview | null>(null);
	let restoring = $state(false);
	let dialogError = $state('');

	/** Each load counts up; an answer for an older tenant is dropped. */
	let generation = 0;

	async function load() {
		const mine = ++generation;
		loadError = false;
		entries = null;
		plan = null;
		opening = '';
		dialogError = '';
		try {
			const answer = await client.history(tenantId);
			if (mine === generation) entries = answer;
		} catch {
			if (mine === generation) loadError = true;
		}
	}

	$effect(() => {
		void load();
	});

	const levelText = (entry: HistoryEntry) =>
		entry.tier === 'client'
			? t('mc.hist.level.client', { app: entry.client_name ?? entry.client_id ?? '' })
			: t('mc.hist.level.tenant_default');

	async function open(entry: HistoryEntry) {
		const mine = ++generation;
		opening = entry.id;
		dialogError = '';
		try {
			const answer = await client.previewRestore(tenantId, entry.id);
			// Only the last one asked for is confirmed; an older answer never replaces it.
			if (mine === generation) plan = answer;
		} catch (error) {
			if (mine !== generation) return;
			// Restorability is checked again now: the set may have gone since the list was read.
			const reason = error instanceof ApiError ? error.body.reason : undefined;
			if (typeof reason === 'string') {
				toast.error(label('mc.hist.notRestorable.', reason));
				await load();
			} else {
				toast.error(t('mc.actionFailed'));
			}
		} finally {
			if (mine === generation) opening = '';
		}
	}

	async function restore() {
		if (!plan) return;
		// What was confirmed: this tenant and this preview, whatever happens on the page meanwhile.
		const confirmed = { tenantId, entryId: plan.entry.id, version: plan.expected_version };
		restoring = true;
		try {
			await client.restore(confirmed.tenantId, confirmed.entryId, confirmed.version);
			plan = null;
			toast.success(t('mc.hist.restored'));
			await load();
		} catch (error) {
			dialogError =
				error instanceof ApiError && error.status === 409
					? t('mc.hist.conflict')
					: t('mc.actionFailed');
		} finally {
			restoring = false;
		}
	}

	const affected = $derived(plan?.apps.filter((app) => app.changes.length > 0) ?? []);
</script>

<Page width="wide">
	<PageHeader title={t('mc.hist.title')} description={t('mc.hist.desc')} />

	{#if loadError}
		<Callout tone="warning" live>
			{t('mc.loadFailed')}
			<Button variant="secondary" size="sm" onclick={load}>{t('mc.retry')}</Button>
		</Callout>
	{:else if !entries}
		<LoadingState label={t('mc.loading')} />
	{:else}
		<Card title={t('mc.hist.title')} flush>
			<DataTable
				caption={t('mc.hist.title')}
				columns={[
					{ key: 'when', label: t('mc.hist.col.when'), width: '15%' },
					{ key: 'who', label: t('mc.hist.col.who'), width: '13%' },
					{ key: 'level', label: t('mc.hist.col.level'), width: '17%' },
					{ key: 'change', label: t('mc.hist.col.change') },
					{ key: 'via', label: t('mc.hist.col.via'), width: '11%' },
					{ key: 'actions', label: t('mc.hist.col.actions'), width: '20%', hideLabel: true }
				]}
				rows={entries}
				rowKey={(entry) => entry.id}
			>
				{#snippet empty()}
					<EmptyState icon="history" title={t('mc.hist.empty')} />
				{/snippet}
				{#snippet cell(entry, column)}
					{#if column.key === 'when'}
						<DateTime value={entry.at} stacked />
					{:else if column.key === 'who'}
						{entry.actor.label}
					{:else if column.key === 'level'}
						{levelText(entry)}
					{:else if column.key === 'change'}
						{t('mc.hist.change', {
							before: levelValueText(entry.before),
							after: levelValueText(entry.after)
						})}
					{:else if column.key === 'via'}
						<span class="muted">{label('mc.hist.via.', entry.via)}</span>
					{:else if entry.restorable}
						<Button
							size="sm"
							variant="secondary"
							loading={opening === entry.id}
							onclick={() => open(entry)}
						>
							{t('mc.hist.restore')}
						</Button>
					{:else}
						<span class="muted">
							{label('mc.hist.notRestorable.', entry.not_restorable_reason ?? '')}
						</span>
					{/if}
				{/snippet}
			</DataTable>
		</Card>
	{/if}
</Page>

<FormDialog
	open={plan !== null}
	title={t('mc.hist.dialog.title')}
	submitLabel={t('mc.hist.dialog.submit')}
	busy={restoring}
	error={dialogError}
	onsubmit={restore}
	oncancel={() => (plan = null)}
>
	{#if plan}
		<div class="dialog">
			<p>
				{t('mc.hist.dialog.body', {
					level: levelText(plan.entry),
					to: levelValueText(plan.restores),
					from: levelValueText(plan.current)
				})}
			</p>
			{#if plan.later_changes.length > 0}
				<Callout tone="warning">
					{t('mc.hist.dialog.later', { count: plan.later_changes.length })}
				</Callout>
			{/if}
			<div>
				<p class="label">{t('mc.hist.dialog.apps')}</p>
				{#if affected.length === 0}
					<p class="muted">{t('mc.hist.dialog.noApps')}</p>
				{:else}
					<ul class="apps">
						{#each affected as app (app.client_id)}
							<li>
								<strong>{app.name}</strong>
								<span>{app.changes.map(changeText).join(' · ')}</span>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		</div>
	{/if}
</FormDialog>

<style>
	.dialog {
		display: flex;
		flex-direction: column;
		gap: var(--space-field);
	}

	.dialog p {
		margin: 0;
	}

	.label {
		font-size: var(--fs-label);
		font-weight: var(--fw-semibold);
		margin-block-end: var(--space-related);
	}

	.apps {
		margin: var(--space-related) 0 0;
		padding-inline-start: 1.2em;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.apps li {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-related);
	}

	.muted {
		color: var(--text-secondary);
	}
</style>
