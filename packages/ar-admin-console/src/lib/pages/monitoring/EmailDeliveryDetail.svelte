<script lang="ts">
	import type { EmailDelivery } from '#lib/api/email-deliveries.js';
	import { hasMessage, t } from '#lib/i18n/i18n.svelte.js';
	import Card from '#lib/ui/patterns/Card.svelte';
	import DetailItem from '#lib/ui/patterns/DetailItem.svelte';
	import DetailList from '#lib/ui/patterns/DetailList.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import CopyButton from '#lib/ui/primitives/CopyButton.svelte';
	import Link from '#lib/ui/primitives/Link.svelte';
	import DateTime from '#lib/ui/time/DateTime.svelte';
	import { STATUS_LABEL, STATUS_TONE, kindLabelKey, statusOf } from './email-deliveries-labels';

	/**
	 * One send record in full: what was sent to whom, where it stands with the provider, the
	 * attempts and the last error, when it was requested, accepted and last updated, and the
	 * provider's own IDs. A field the record does not have is left out, not shown empty.
	 */
	interface Props {
		item: EmailDelivery;
		/** Whether the user behind it can be opened (the caller may read users). */
		userHref?: (accountId: string) => string | null;
		onclose: () => void;
	}

	let { item, userHref = () => null, onclose }: Props = $props();

	const kindKey = $derived(kindLabelKey(item.notification_kind, hasMessage));
	const status = $derived(statusOf(item));
	const href = $derived(item.account_id ? userHref(item.account_id) : null);
</script>

<Card title={t('edel.detail.title')}>
	{#snippet actions()}
		<Button size="sm" variant="ghost" icon="close" onclick={onclose}
			>{t('edel.detail.close')}</Button
		>
	{/snippet}

	<DetailList ruled>
		<DetailItem label={t('edel.detail.kind')}>
			{#if kindKey}{t(kindKey)}{/if}
			<code>{item.notification_kind}</code>
		</DetailItem>
		<DetailItem label={t('edel.detail.recipient')}>
			{#if item.recipient}
				<code>{item.recipient}</code>
			{:else}
				<span class="muted">{t('edel.recipient.hidden')}</span>
			{/if}
			{#snippet end()}
				{#if item.recipient}
					<CopyButton
						variant="icon"
						text={item.recipient}
						label={t('edel.detail.copy', { label: t('edel.detail.recipient') })}
					/>
				{/if}
			{/snippet}
		</DetailItem>
		{#if item.account_id}
			<DetailItem label={t('edel.detail.account')}>
				{#if href}
					<Link {href}><code>{item.account_id}</code></Link>
				{:else}
					<code>{item.account_id}</code>
				{/if}
			</DetailItem>
		{/if}
		<DetailItem label={t('edel.detail.status')}>
			{#if status}
				<Badge tone={STATUS_TONE[status]}>{t(STATUS_LABEL[status])}</Badge>
			{:else}
				<code>{item.status}</code>
			{/if}
			<span class="secondary"
				>{item.final_delivery_tracked
					? t('edel.detail.final.yes')
					: t('edel.detail.final.no')}</span
			>
		</DetailItem>
		<DetailItem label={t('edel.detail.attempts')}>{item.attempts}</DetailItem>
		{#if item.last_error_code}
			<DetailItem label={t('edel.detail.error')}><code>{item.last_error_code}</code></DetailItem>
		{/if}
		{#if item.requested_at}
			<DetailItem label={t('edel.detail.requested')}
				><DateTime value={item.requested_at} seconds showSecondary stacked /></DetailItem
			>
		{/if}
		{#if item.provider_accepted_at}
			<DetailItem label={t('edel.detail.accepted')}
				><DateTime value={item.provider_accepted_at} seconds showSecondary stacked /></DetailItem
			>
		{/if}
		{#if item.status_updated_at}
			<DetailItem label={t('edel.detail.updated')}
				><DateTime value={item.status_updated_at} seconds showSecondary stacked /></DetailItem
			>
		{/if}
		<DetailItem label={t('edel.detail.provider')}
			><code>{item.provider_installation_id}</code></DetailItem
		>
		{#if item.provider_message_id}
			<DetailItem label={t('edel.detail.messageId')}>
				<code>{item.provider_message_id}</code>
				{#snippet end()}
					<CopyButton
						variant="icon"
						text={item.provider_message_id ?? ''}
						label={t('edel.detail.copy', { label: t('edel.detail.messageId') })}
					/>
				{/snippet}
			</DetailItem>
		{/if}
		<DetailItem label={t('edel.detail.intent')}>
			<code>{item.intent_id}</code>
			{#snippet end()}
				<CopyButton
					variant="icon"
					text={item.intent_id}
					label={t('edel.detail.copy', { label: t('edel.detail.intent') })}
				/>
			{/snippet}
		</DetailItem>
	</DetailList>
</Card>

<style>
	.secondary {
		display: block;
		color: var(--text-muted);
		font-size: var(--fs-caption);
	}

	.muted {
		color: var(--text-muted);
	}
</style>
