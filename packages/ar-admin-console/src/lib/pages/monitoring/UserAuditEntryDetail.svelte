<script lang="ts">
	import type { UserAuditEntry } from '#lib/api/user-audit.js';
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
		eventLabelKey,
		metadataJson,
		resultOf
	} from './user-audit-labels';

	/**
	 * One end-user event in full: when, what, how it ended, who and which application, session
	 * and request, from where, and the rest of its metadata. A field the event does not have is
	 * left out, not shown empty.
	 */
	interface Props {
		entry: UserAuditEntry;
		onclose: () => void;
	}

	let { entry, onclose }: Props = $props();

	const eventKey = $derived(eventLabelKey(entry.action, hasMessage));
	const result = $derived(resultOf(entry));
	const severity = $derived(entry.severity ? SEVERITY_LABEL[entry.severity] : undefined);
	const metadata = $derived(metadataJson(entry.metadata));

	/** The identifiers an admin copies into a search or a ticket. */
	const ids = $derived(
		[
			{ label: t('uaud.detail.user'), value: entry.userId },
			{ label: t('uaud.detail.client'), value: entry.clientId },
			{ label: t('uaud.detail.session'), value: entry.sessionId },
			{ label: t('uaud.detail.request'), value: entry.requestId }
		].filter((item): item is { label: string; value: string } => !!item.value)
	);
</script>

<Card title={t('uaud.detail.title')}>
	{#snippet actions()}
		<Button size="sm" variant="ghost" icon="close" onclick={onclose}
			>{t('uaud.detail.close')}</Button
		>
	{/snippet}

	<DetailList ruled>
		<DetailItem label={t('uaud.detail.time')}
			><DateTime value={entry.createdAt} seconds /></DetailItem
		>
		<DetailItem label={t('uaud.detail.event')}>
			{#if eventKey}{t(eventKey)}{/if}
			<code>{entry.action}</code>
		</DetailItem>
		{#if result}
			<DetailItem label={t('uaud.detail.result')}>
				<Badge tone={RESULT_TONE[result]}>{t(RESULT_LABEL[result])}</Badge>
			</DetailItem>
		{/if}
		{#if severity}
			<DetailItem label={t('uaud.detail.severity')}>{t(severity)}</DetailItem>
		{/if}
		{#if entry.errorCode || entry.errorMessage}
			<DetailItem label={t('uaud.detail.error')}>
				{#if entry.errorCode}<code>{entry.errorCode}</code>{/if}
				{#if entry.errorMessage}<span class="secondary">{entry.errorMessage}</span>{/if}
			</DetailItem>
		{/if}
		{#each ids as item (item.label)}
			<DetailItem label={item.label}>
				<code>{item.value}</code>
				{#snippet end()}
					<CopyButton
						variant="icon"
						text={item.value}
						label={t('uaud.detail.copy', { label: item.label })}
					/>
				{/snippet}
			</DetailItem>
		{/each}
		{#if entry.ipAddress}
			<DetailItem label={t('uaud.detail.ip')}><code dir="ltr">{entry.ipAddress}</code></DetailItem>
		{/if}
		{#if entry.userAgent}
			<DetailItem label={t('uaud.detail.userAgent')}
				><span class="wrap" dir="ltr">{entry.userAgent}</span></DetailItem
			>
		{/if}
	</DetailList>

	{#if metadata}
		<div class="block">
			<CodeField
				label={t('uaud.detail.metadata')}
				language="json"
				value={metadata}
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

	.wrap {
		overflow-wrap: anywhere;
	}

	.block {
		margin-block-start: var(--space-field);
	}
</style>
