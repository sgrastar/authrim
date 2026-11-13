<script lang="ts">
	import type { ConsentVersion } from '#lib/api/consent-statements.js';
	import { t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
	import Card from '#lib/ui/patterns/Card.svelte';
	import DataTable, { type Column } from '#lib/ui/patterns/DataTable.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import DateTime from '#lib/ui/time/DateTime.svelte';
	import { draftOf, versionLabel } from './statement-model';

	/**
	 * A statement's versions, newest first, with the current one marked. A new version starts as
	 * a draft; a draft can be edited, published or deleted, and a published one is read-only.
	 */
	interface Props {
		versions: readonly ConsentVersion[];
		canWrite: boolean;
		/** Unsaved changes or a running save: version actions wait for them. */
		blocked: boolean;
		viewId: string;
		onview: (id: string) => void;
		onnew: () => void;
		onpublish: (version: ConsentVersion) => void;
		ondelete: (version: ConsentVersion) => void;
	}

	let { versions, canWrite, blocked, viewId, onview, onnew, onpublish, ondelete }: Props = $props();

	const columns = $derived([
		{ key: 'version', label: t('cs.versions.col.version') },
		{ key: 'status', label: t('cs.versions.col.status'), width: '160px' },
		{ key: 'date', label: t('cs.versions.col.date'), width: '200px' },
		{ key: 'actions', label: t('cs.versions.col.actions'), width: '280px' }
	]);
	const hasDraft = $derived(draftOf(versions) !== null);
</script>

{#snippet cell(row: ConsentVersion, column: Column)}
	{#if column.key === 'version'}
		<strong>{versionLabel(row.version)}</strong>
		{#if row.is_current}<Badge tone="success">{t('cs.versions.current')}</Badge>{/if}
	{:else if column.key === 'status'}
		<Badge tone={row.status === 'draft' ? 'warning' : 'neutral'}>
			{t(`cs.version.status.${row.status}` as MessageKey)}
		</Badge>
	{:else if column.key === 'date'}
		<DateTime value={row.effective_at} style="date" />
	{:else}
		<span class="actions">
			<Button size="sm" variant="ghost" disabled={row.id === viewId} onclick={() => onview(row.id)}>
				{t('cs.versions.view')}
			</Button>
			{#if canWrite && row.status === 'draft'}
				<Button size="sm" disabled={blocked} onclick={() => onpublish(row)}>
					{t('cs.versions.publish')}
				</Button>
				<Button
					size="sm"
					variant="ghost"
					icon="trash"
					disabled={blocked}
					onclick={() => ondelete(row)}
				>
					{t('cs.versions.delete')}
				</Button>
			{/if}
		</span>
	{/if}
{/snippet}

<Card title={t('cs.versions.title')} description={t('cs.versions.intro')} flush>
	{#snippet actions()}
		{#if canWrite}
			<Button
				size="sm"
				icon="plus"
				disabled={blocked || hasDraft}
				title={hasDraft ? t('cs.versions.hasDraft') : undefined}
				onclick={onnew}
			>
				{t('cs.versions.new')}
			</Button>
		{/if}
	{/snippet}
	<DataTable
		caption={t('cs.versions.title')}
		{columns}
		rows={versions}
		rowKey={(row) => row.id}
		dense
		{cell}
	>
		{#snippet empty()}
			<EmptyState icon="list" title={t('cs.versions.empty')} />
		{/snippet}
	</DataTable>
</Card>

<style>
	.actions {
		display: inline-flex;
		flex-wrap: wrap;
		gap: 4px;
	}
</style>
