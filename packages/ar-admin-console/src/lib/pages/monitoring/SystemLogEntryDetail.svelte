<script lang="ts">
	import type { SystemLogEntry } from '#lib/api/system-log.js';
	import { hasMessage, t } from '#lib/i18n/i18n.svelte.js';
	import CodeField from '#lib/ui/code/CodeField.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import DetailItem from '#lib/ui/patterns/DetailItem.svelte';
	import DetailList from '#lib/ui/patterns/DetailList.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import CopyButton from '#lib/ui/primitives/CopyButton.svelte';
	import DateTime from '#lib/ui/time/DateTime.svelte';
	import {
		RESULT_LABEL,
		RESULT_TONE,
		SEVERITY_LABEL,
		SEVERITY_TONE,
		detailsJson,
		eventLabelKey,
		resultOf,
		severityOf,
		sourceLabelKey,
		surfaceOf
	} from './system-log-labels';

	/**
	 * One system event in full: when, where it happened, what, how it ended, what it was about,
	 * the request it belongs to, how long it is kept, and its details. A field the event does not
	 * have is left out, not shown empty.
	 */
	interface Props {
		entry: SystemLogEntry;
		onclose: () => void;
	}

	let { entry, onclose }: Props = $props();

	const sourceKey = $derived(sourceLabelKey(entry.source, hasMessage));
	const eventKey = $derived(eventLabelKey(entry.event_type, hasMessage));
	const result = $derived(resultOf(entry));
	const severity = $derived(severityOf(entry));
	const details = $derived(detailsJson(entry.details));
</script>

<Card title={t('slog.detail.title')}>
	{#snippet actions()}
		<Button size="sm" variant="ghost" icon="close" onclick={onclose}
			>{t('slog.detail.close')}</Button
		>
	{/snippet}

	<DetailList ruled>
		<DetailItem label={t('slog.detail.time')}
			><DateTime value={entry.created_at} seconds /></DetailItem
		>
		<DetailItem label={t('slog.detail.source')}>
			{#if sourceKey}{t(sourceKey)}{/if}
			<code>{surfaceOf(entry.source)}</code>
		</DetailItem>
		<DetailItem label={t('slog.detail.event')}>
			{#if eventKey}{t(eventKey)}{/if}
			<code>{entry.event_type}</code>
		</DetailItem>
		{#if result}
			<DetailItem label={t('slog.detail.result')}>
				<Badge tone={RESULT_TONE[result]}>{t(RESULT_LABEL[result])}</Badge>
			</DetailItem>
		{/if}
		{#if severity}
			<DetailItem label={t('slog.detail.severity')}>
				<Badge tone={SEVERITY_TONE[severity]}>{t(SEVERITY_LABEL[severity])}</Badge>
			</DetailItem>
		{/if}
		{#if entry.error_code}
			<DetailItem label={t('slog.detail.error')}><code>{entry.error_code}</code></DetailItem>
		{/if}
		{#if entry.target_id || entry.target_type}
			<DetailItem label={t('slog.detail.target')}>
				<code>{entry.target_id ?? entry.target_type}</code>
				{#if entry.target_id && entry.target_type}
					<span class="secondary"><code>{entry.target_type}</code></span>
				{/if}
				{#snippet end()}
					{#if entry.target_id}
						<CopyButton
							variant="icon"
							text={entry.target_id}
							label={t('slog.detail.copy', { label: t('slog.detail.target') })}
						/>
					{/if}
				{/snippet}
			</DetailItem>
		{/if}
		{#if entry.request_id}
			<DetailItem label={t('slog.detail.request')}>
				<code>{entry.request_id}</code>
				{#snippet end()}
					<CopyButton
						variant="icon"
						text={entry.request_id ?? ''}
						label={t('slog.detail.copy', { label: t('slog.detail.request') })}
					/>
				{/snippet}
			</DetailItem>
		{/if}
		{#if entry.retention_until}
			<DetailItem label={t('slog.detail.retention')}
				><DateTime value={entry.retention_until} /></DetailItem
			>
		{/if}
	</DetailList>

	{#if details}
		<div class="block">
			<CodeField
				label={t('slog.detail.details')}
				language="json"
				value={details}
				readonly
				rows={6}
			/>
		</div>
	{/if}
</Card>

<style>
	.secondary {
		color: var(--text-muted);
		font-size: var(--fs-caption);
		line-height: var(--lh-body);
	}

	.block {
		margin-block-start: var(--space-field);
	}
</style>
