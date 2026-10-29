<script lang="ts">
	import { t, type MessageKey } from '$lib/i18n/i18n.svelte';
	import type { UsageBinding } from '$lib/api/schema-setting';
	import Card from '$lib/ui/patterns/Card.svelte';
	import DataTable from '$lib/ui/patterns/DataTable.svelte';
	import Badge from '$lib/ui/primitives/Badge.svelte';
	import { PROTECTION_KEY } from './labels';

	/**
	 * Where an attribute is relied on. The ones marked "cannot be deleted" keep the attribute from
	 * being deleted until they stop relying on it. Kinds this console does not know are shown by
	 * their own name.
	 */
	interface Props {
		usage: UsageBinding[];
	}

	let { usage }: Props = $props();

	const KNOWN_TYPES = new Set([
		'authentication_method',
		'notification',
		'discovery',
		'consent',
		'policy',
		'protocol_output',
		'display',
		'ui',
		'custom'
	]);
	const KNOWN_SOURCES = new Set(['derived', 'admin', 'system', 'migration']);

	const typeText = (type: string) =>
		KNOWN_TYPES.has(type) ? t(`ss.usage.type.${type}` as MessageKey) : type;
	const sourceText = (source: string) =>
		KNOWN_SOURCES.has(source) ? t(`ss.usage.source.${source}` as MessageKey) : source;

	const columns = $derived([
		{ key: 'type', label: t('ss.usage.col.type'), width: '20%' },
		{ key: 'target', label: t('ss.usage.col.target') },
		{ key: 'protection', label: t('ss.usage.col.protection'), width: '160px' },
		{ key: 'source', label: t('ss.usage.col.source'), width: '22%' }
	]);
</script>

<Card title={t('ss.section.usage')} info={t('ss.usage.lead')} flush={usage.length > 0}>
	{#if usage.length === 0}
		<p class="none">{t('ss.usage.none')}</p>
	{:else}
		<DataTable {columns} rows={usage} rowKey={(row) => row.id} caption={t('ss.section.usage')}>
			{#snippet cell(row, column)}
				{#if column.key === 'type'}
					{typeText(row.bindingType)}
				{:else if column.key === 'target'}
					<span class="target">{row.bindingId}</span>
					{#if row.reason}<span class="reason">{row.reason}</span>{/if}
				{:else if column.key === 'protection'}
					<Badge
						tone={row.protection === 'delete_blocked'
							? 'danger'
							: row.protection === 'warn'
								? 'warning'
								: 'neutral'}>{t(PROTECTION_KEY[row.protection])}</Badge
					>
				{:else}
					{sourceText(row.source)}
				{/if}
			{/snippet}
		</DataTable>
	{/if}
</Card>

<style>
	.none {
		margin: 0;
		color: var(--text-secondary);
	}

	.target {
		overflow-wrap: anywhere;
	}

	.reason {
		display: block;
		color: var(--text-muted);
		font-size: var(--fs-small);
	}
</style>
