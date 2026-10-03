<script lang="ts">
	import {
		errorCode,
		type ComplianceClient,
		type RetentionCategory,
		type RetentionStatus
	} from '$lib/api/compliance';
	import { ApiError } from '$lib/api/api-error';
	import { i18n, t } from '$lib/i18n/i18n.svelte';
	import { formatNumber } from '$lib/ui/format';
	import Callout from '$lib/ui/patterns/Callout.svelte';
	import Card from '$lib/ui/patterns/Card.svelte';
	import DataTable from '$lib/ui/patterns/DataTable.svelte';
	import FormDialog from '$lib/ui/patterns/FormDialog.svelte';
	import LoadingState from '$lib/ui/patterns/LoadingState.svelte';
	import Button from '$lib/ui/primitives/Button.svelte';
	import Checkbox from '$lib/ui/primitives/Checkbox.svelte';
	import NumberField from '$lib/ui/primitives/NumberField.svelte';
	import { toast } from '$lib/ui/toast/toast.svelte';
	import { deletionText, duration, editText, label, retentionText, timeText } from './labels';

	interface Props {
		client: ComplianceClient;
		tenantId: string;
	}

	let { client, tenantId }: Props = $props();

	let status = $state<RetentionStatus | null>(null);
	let loadError = $state('');

	let editing = $state(false);
	let busy = $state(false);
	let editError = $state('');
	let lookupDays = $state<number | null>(180);
	/** Set once the API asked to confirm a shortening: the retention it read then. */
	let shorteningFrom = $state<number | null>(null);
	/** The value that request was for: another value is confirmed anew. */
	let shorteningTo = $state<number | null>(null);
	const shortening = $derived(shorteningFrom !== null && shorteningTo === lookupDays);
	let confirmShortening = $state(false);

	async function load() {
		loadError = '';
		try {
			status = await client.retention(tenantId);
		} catch {
			loadError = t('cmp.loadFailed');
		}
	}

	$effect(() => {
		void load();
	});

	function lastRun(category: RetentionCategory): string | null {
		const deletion = category.deletion;
		if (deletion.kind !== 'scheduled_task') return null;
		return deletion.tenant_last_run
			? `${t('cmp.ret.lastRun', { outcome: deletion.tenant_last_run.outcome })} · ${timeText(deletion.tenant_last_run.at)}`
			: t('cmp.ret.neverRun');
	}

	function openEdit(category: RetentionCategory) {
		lookupDays = category.retention.value;
		shorteningFrom = null;
		shorteningTo = null;
		confirmShortening = false;
		editError = '';
		editing = true;
	}

	async function save() {
		if (!lookupDays) return;
		busy = true;
		editError = '';
		const requested = lookupDays;
		try {
			await client.setLookupRetention(tenantId, {
				retention_days: lookupDays,
				...(shortening && confirmShortening
					? { confirm_shortening: true, expected_current_retention_days: shorteningFrom! }
					: {})
			});
			editing = false;
			toast.success(t('cmp.ret.lookupSaved'));
			await load();
		} catch (error) {
			const current = error instanceof ApiError ? error.body.current_retention_days : undefined;
			if (
				errorCode(error) === 'retention_shortening_confirmation_required' &&
				typeof current === 'number'
			) {
				// Confirmed against the retention read now: a confirmation given for another one
				// (changed by someone else meanwhile) is asked again.
				shorteningFrom = current;
				// For the value it was asked about; another one now entered is confirmed anew.
				shorteningTo = requested;
				confirmShortening = false;
			} else {
				editError = t('cmp.ret.lookupFailed');
			}
		} finally {
			busy = false;
		}
	}

	const num = (value: number) => formatNumber(value, i18n.locale);
</script>

<p class="lead">{t('cmp.ret.desc')}</p>

{#if loadError}
	<Callout tone="danger" live>
		{loadError}
		<Button variant="secondary" size="sm" onclick={load}>{t('cmp.retry')}</Button>
	</Callout>
{/if}

{#if !status}
	{#if !loadError}<LoadingState label={t('cmp.loading')} />{/if}
{:else}
	{#if status.summary.attention.length > 0}
		<Callout tone="warning" title={t('cmp.ret.attention')}>
			<ul class="attention">
				{#each status.summary.attention as item (`${item.category}:${item.reason}`)}
					<li>
						<strong>{label('cmp.cat.', item.category)}</strong>: {label('cmp.reason.', item.reason)}
					</li>
				{/each}
			</ul>
		</Callout>
	{/if}

	<Card flush>
		<DataTable
			caption={t('cmp.tab.retention')}
			columns={[
				{ key: 'data', label: t('cmp.ret.col.data'), width: '18%' },
				{ key: 'kept', label: t('cmp.ret.col.kept'), width: '22%' },
				{ key: 'deleted', label: t('cmp.ret.col.deletedBy') },
				{ key: 'records', label: t('cmp.ret.col.records'), width: '14%', align: 'end' },
				{ key: 'set', label: t('cmp.ret.col.setIn'), width: '16%' }
			]}
			rows={status.categories}
			rowKey={(category) => category.id}
		>
			{#snippet cell(category, column)}
				{#if column.key === 'data'}
					<strong>{label('cmp.cat.', category.id)}</strong>
				{:else if column.key === 'kept'}
					<div class="stack">
						<span>{retentionText(category)}</span>
						{#if category.cap}
							<span class="muted"
								>{t('cmp.ret.capped', { value: duration(category.cap.seconds) })}</span
							>
						{/if}
						{#if category.varies}
							<span class="muted">{label('cmp.ret.varies.', category.varies)}</span>
						{/if}
						{#if category.extension && category.extension.absolute_limit_seconds === null}
							<span class="muted">{t('cmp.ret.noAbsoluteLimit')}</span>
						{/if}
					</div>
				{:else if column.key === 'deleted'}
					<div class="stack">
						<span>{deletionText(category)}</span>
						{#if lastRun(category)}<span class="muted">{lastRun(category)}</span>{/if}
						{#if category.archive}<span class="muted">{t('cmp.ret.archiveKept')}</span>{/if}
					</div>
				{:else if column.key === 'records'}
					{category.counts
						? t('cmp.ret.records', {
								total: num(category.counts.total),
								expired: num(category.counts.expired)
							})
						: '—'}
				{:else}
					<div class="stack">
						<span>{editText(category)}</span>
						{#if category.edit.kind === 'lookup_directory'}
							<Button variant="secondary" size="sm" onclick={() => openEdit(category)}>
								{t('cmp.ret.change')}
							</Button>
						{/if}
					</div>
				{/if}
			{/snippet}
		</DataTable>
	</Card>
{/if}

<FormDialog
	open={editing}
	title={t('cmp.ret.lookupTitle')}
	submitLabel={t('cmp.save')}
	{busy}
	error={editError}
	onsubmit={save}
	oncancel={() => (editing = false)}
>
	<NumberField
		label={t('cmp.ret.lookupDays')}
		min={30}
		max={3650}
		required
		bind:value={lookupDays}
	/>
	{#if shortening}
		<Callout tone="warning" live>
			{t('cmp.ret.lookupShorten', { from: shorteningFrom ?? 0, to: lookupDays ?? 0 })}
		</Callout>
		<Checkbox
			checked={confirmShortening}
			onchange={(event) => (confirmShortening = event.currentTarget.checked)}
		>
			{t('cmp.ret.lookupShortenConfirm')}
		</Checkbox>
	{/if}
</FormDialog>

<style>
	.lead {
		margin: 0 0 var(--space-related);
		color: var(--text-secondary);
	}

	.attention {
		margin: 0;
		padding-inline-start: 1.25rem;
	}

	.stack {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 4px;
	}

	.muted {
		color: var(--text-secondary);
	}
</style>
