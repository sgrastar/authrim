<script lang="ts">
	import { t, type MessageKey } from '$lib/i18n/i18n.svelte';
	import type { HistoryDetail, HistoryEntry, SchemaSettingClient } from '$lib/api/schema-setting';
	import Callout from '$lib/ui/patterns/Callout.svelte';
	import Card from '$lib/ui/patterns/Card.svelte';
	import DataTable from '$lib/ui/patterns/DataTable.svelte';
	import LoadingState from '$lib/ui/patterns/LoadingState.svelte';
	import Button from '$lib/ui/primitives/Button.svelte';
	import DateTime from '$lib/ui/time/DateTime.svelte';

	/**
	 * The changes made to an attribute, newest first: which version, what was done, when, by whom.
	 * A version opens to show which items changed, from what to what.
	 */
	interface Props {
		client: SchemaSettingClient;
		tenantId: string;
		schemaId: string;
		/** Changes whenever the attribute was saved, so the list reads again. */
		version: number;
	}

	let { client, tenantId, schemaId, version }: Props = $props();

	const PAGE = 20;
	const KNOWN_OPERATIONS = new Set(['create', 'update', 'rename', 'delete', 'toggle_active']);

	let entries = $state<HistoryEntry[]>([]);
	let total = $state(0);
	let loading = $state(true);
	let failed = $state(false);
	let opened = $state<HistoryDetail | null>(null);
	let openFailed = $state(false);
	let generation = 0;

	async function load(more: boolean) {
		const mine = ++generation;
		loading = true;
		failed = false;
		try {
			const page = await client.history(tenantId, schemaId, {
				limit: PAGE,
				offset: more ? entries.length : 0
			});
			if (mine !== generation) return;
			entries = more ? [...entries, ...page.versions] : page.versions;
			total = page.total;
		} catch {
			if (mine === generation) failed = true;
		} finally {
			if (mine === generation) loading = false;
		}
	}

	// The attribute or its version changed: read the first page again.
	$effect(() => {
		void [tenantId, schemaId, version];
		opened = null;
		openGeneration++;
		void load(false);
	});

	/** Each choice counts up; an answer for an earlier one (or after closing) is dropped. */
	let openGeneration = 0;

	async function show(entry: HistoryEntry) {
		const mine = ++openGeneration;
		openFailed = false;
		if (opened?.version === entry.version) {
			opened = null;
			return;
		}
		try {
			const read = await client.historyVersion(tenantId, schemaId, entry.version);
			if (mine === openGeneration) opened = read;
		} catch {
			if (mine === openGeneration) openFailed = true;
		}
	}

	const operationText = (operation: string) =>
		KNOWN_OPERATIONS.has(operation) ? t(`ss.history.op.${operation}` as MessageKey) : operation;

	/** A value as one line: text as it is, anything else as JSON. */
	function shown(value: unknown): string {
		if (value === null || value === undefined || value === '') return '—';
		return typeof value === 'string' ? value : JSON.stringify(value);
	}

	const columns = $derived([
		{ key: 'version', label: t('ss.history.version'), width: '80px' },
		{ key: 'operation', label: t('ss.history.operation') },
		{ key: 'when', label: t('ss.history.when'), width: '24%' },
		{ key: 'actor', label: t('ss.history.actor'), width: '20%' },
		{ key: 'summary', label: t('ss.history.summary'), width: '120px' },
		{ key: 'show', label: t('ss.history.changes'), width: '170px', hideLabel: true }
	]);
</script>

<Card title={t('ss.section.history')} flush={entries.length > 0}>
	{#if loading && entries.length === 0}
		<LoadingState label={t('ss.section.history')} />
	{:else if failed && entries.length === 0}
		<Callout tone="danger">
			{t('ss.history.loadFailed')}
			<Button size="sm" variant="secondary" onclick={() => load(false)}>{t('common.retry')}</Button>
		</Callout>
	{:else if entries.length === 0}
		<p class="none">{t('ss.history.empty')}</p>
	{:else}
		<DataTable
			{columns}
			rows={entries}
			rowKey={(row) => String(row.version)}
			caption={t('ss.section.history')}
		>
			{#snippet cell(row, column)}
				{#if column.key === 'version'}
					{row.version}
				{:else if column.key === 'operation'}
					{operationText(row.operation)}
				{:else if column.key === 'when'}
					<DateTime value={row.createdAt} stacked />
				{:else if column.key === 'actor'}
					<span class="actor">{row.actorId ?? row.actorType}</span>
				{:else if column.key === 'summary'}
					{t('ss.history.modified', { count: row.summary.modified })}
				{:else}
					<Button size="sm" variant="ghost" onclick={() => show(row)}
						>{t(opened?.version === row.version ? 'ss.history.hide' : 'ss.history.show')}</Button
					>
				{/if}
			{/snippet}
		</DataTable>
		{#if openFailed}
			<div class="below"><Callout tone="danger">{t('ss.history.loadFailed')}</Callout></div>
		{/if}
		{#if opened}
			<div class="below">
				<h3>{t('ss.history.changes')}</h3>
				{#if opened.changes.modified.length === 0}
					<p class="none">{t('ss.history.noChanges')}</p>
				{:else}
					<table class="changes">
						<thead>
							<tr>
								<th scope="col">{t('ss.history.item')}</th>
								<th scope="col">{t('ss.history.old')}</th>
								<th scope="col">{t('ss.history.new')}</th>
							</tr>
						</thead>
						<tbody>
							{#each opened.changes.modified as change (change.key)}
								<tr>
									<th scope="row"><code>{change.key}</code></th>
									<td>{shown(change.oldValue)}</td>
									<td>{shown(change.newValue)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				{/if}
			</div>
		{/if}
		{#if entries.length < total}
			<div class="below">
				<Button variant="secondary" size="sm" onclick={() => load(true)} {loading}
					>{t('ss.history.more')}</Button
				>
			</div>
		{/if}
	{/if}
</Card>

<style>
	code {
		font-family: var(--font-mono);
		font-size: var(--fs-body);
	}

	.none {
		margin: 0;
		color: var(--text-secondary);
	}

	.below {
		padding: 16px;
		border-top: 1px solid var(--border);
	}

	h3 {
		margin: 0 0 8px;
		font-size: var(--fs-label);
		font-weight: var(--fw-semibold);
	}

	.actor {
		overflow-wrap: anywhere;
	}

	.changes {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--fs-small);
	}

	.changes th,
	.changes td {
		padding: 6px 8px;
		border-bottom: 1px solid var(--border);
		text-align: start;
		vertical-align: top;
		overflow-wrap: anywhere;
	}

	.changes thead th {
		color: var(--text-muted);
		font-weight: var(--fw-medium);
	}

	.changes tbody th {
		font-weight: var(--fw-regular);
	}
</style>
