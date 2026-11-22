<script lang="ts">
	import type { FederationRequestedAttributes } from '#lib/api/federation-sources.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import DataTable, { type Column } from '#lib/ui/patterns/DataTable.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';

	/**
	 * What the federation's service providers ask for in their metadata (RequestedAttribute), as a
	 * table: each attribute with how many service providers require it and how many only ask. It
	 * sits with the output source, so the attributes some services cannot do without are looked
	 * for while the source is chosen or made. Given the attribute names of the source in use (or
	 * of the one being made, as they are typed), each row also says whether the source has it.
	 */
	interface Props {
		phase: 'loading' | 'ready' | 'failed';
		data: FederationRequestedAttributes | null;
		/** The SAML attribute names the output source can send; null while none is chosen. */
		sendable?: ReadonlySet<string> | null;
		onretry: () => void;
	}

	let { phase, data, sendable = null, onretry }: Props = $props();

	interface Row {
		name: string;
		friendlyName: string | null;
		required: number;
		optional: number;
	}
	const rows = $derived<Row[]>(
		(data?.attributes ?? []).map((attribute) => ({
			name: attribute.name,
			friendlyName: attribute.friendlyName,
			required: attribute.requiredBy,
			optional: Math.max(attribute.requestedBy - attribute.requiredBy, 0)
		}))
	);
	const columns = $derived<Column[]>([
		{ key: 'attribute', label: t('sf.fed.req.col.attribute'), width: '46%' },
		{ key: 'required', label: t('sf.fed.req.col.required'), align: 'end' },
		{ key: 'optional', label: t('sf.fed.req.col.optional'), align: 'end' },
		...(sendable ? [{ key: 'source', label: t('sf.fed.req.col.source') }] : [])
	]);
	const partial = $derived(data !== null && data.spRead < data.spTotal);
</script>

<Card title={t('sf.fed.req.title')} description={t('sf.fed.req.desc')}>
	{#if phase === 'loading'}
		<LoadingState label={t('common.loading')} />
	{:else if phase === 'failed'}
		<EmptyState icon="warningCircle" title={t('sf.fed.req.loadFailed')}>
			{#snippet action()}
				<Button size="sm" onclick={onretry}>{t('common.retry')}</Button>
			{/snippet}
		</EmptyState>
	{:else if data}
		<div class="req">
			{#if partial}
				<Callout tone="info">
					{t('sf.fed.req.partial', { read: data.spRead, total: data.spTotal })}
				</Callout>
			{/if}
			{#if rows.length === 0}
				{#if !partial}<p class="req__none">{t('sf.fed.req.none')}</p>{/if}
			{:else}
				<DataTable
					{columns}
					{rows}
					rowKey={(row) => row.name}
					caption={t('sf.fed.req.title')}
					dense
					scrollFocusable
					minWidth="0"
				>
					{#snippet cell(row, column)}
						{#if column.key === 'attribute'}
							<div class="req__name">
								<span class="req__label">{row.friendlyName ?? row.name}</span>
								{#if row.friendlyName}<code class="req__id" dir="ltr">{row.name}</code>{/if}
							</div>
						{:else if column.key === 'required'}
							{#if row.required > 0}
								<Badge tone="warning">{row.required}</Badge>
							{:else}
								<span class="req__zero">{row.required}</span>
							{/if}
						{:else if column.key === 'optional'}
							<span class:req__zero={row.optional === 0}>{row.optional}</span>
						{:else if sendable?.has(row.name)}
							<Badge tone="success">{t('sf.fed.req.sendable')}</Badge>
						{:else}
							<Badge tone={row.required > 0 ? 'danger' : 'neutral'}>
								{t('sf.fed.req.notSendable')}
							</Badge>
						{/if}
					{/snippet}
				</DataTable>
			{/if}
		</div>
	{/if}
</Card>

<style>
	.req {
		display: grid;
		gap: var(--space-related);
	}

	.req__none {
		margin: 0;
		color: var(--text-muted);
		font-size: var(--fs-body);
	}

	.req__name {
		display: grid;
		gap: 2px;
		min-width: 0;
	}

	.req__label {
		color: var(--text-primary);
		font-weight: var(--fw-semibold);
	}

	.req__id {
		overflow-wrap: anywhere;
		color: var(--text-muted);
		font-family: var(--font-mono);
		font-size: var(--fs-caption);
	}

	.req__zero {
		color: var(--text-muted);
	}
</style>
