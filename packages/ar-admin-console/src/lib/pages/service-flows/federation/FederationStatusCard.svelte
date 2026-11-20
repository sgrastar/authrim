<script lang="ts">
	import type {
		FederationRefreshHistoryItem,
		FederationSource
	} from '#lib/api/federation-sources.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import DetailItem from '#lib/ui/patterns/DetailItem.svelte';
	import DetailList from '#lib/ui/patterns/DetailList.svelte';
	import DateTime from '#lib/ui/time/DateTime.svelte';
	import { federationStatus } from '../federation-model';
	import { refreshDelta, refreshOutcome, remainingDays } from './federation-page-model';

	/**
	 * Whether the federation is keeping up: when its metadata was last fetched and checked, how
	 * long it stays valid, when the next fetch is, how many entities it holds, and the last few
	 * fetches. A run-out or failing federation says so first. "Update now" fetches at once.
	 */
	interface Props {
		source: FederationSource;
		history: FederationRefreshHistoryItem[];
		canRefresh: boolean;
		refreshing?: boolean;
		/** Why the last "Update now" failed. */
		failure?: string;
		onrefresh: () => void;
		/** The entities of the side the service flow works with (not the whole document), and how many of them are set aside. */
		entityCount?: number | null;
		excludedCount?: number | null;
	}
	let {
		source,
		history,
		canRefresh,
		refreshing = false,
		failure = '',
		onrefresh,
		entityCount,
		excludedCount
	}: Props = $props();

	const shownCount = $derived(
		entityCount !== undefined ? entityCount : (source.status?.entityCount ?? null)
	);
	const shownExcluded = $derived(
		excludedCount !== undefined ? excludedCount : (source.status?.excludedCount ?? 0)
	);

	const status = $derived(source.status);
	const standing = $derived(federationStatus(source));
	const days = $derived(remainingDays(status?.acceptedValidUntil ?? null));
	const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
	const verification = $derived(status?.lastVerification?.status ?? null);
</script>

<Card title={t('sf.fed.statusCard.title')}>
	{#snippet actions()}
		{#if canRefresh}
			<Button variant="secondary" size="sm" loading={refreshing} onclick={onrefresh}
				>{t('sf.fed.statusCard.refresh')}</Button
			>
		{/if}
	{/snippet}
	{#if standing === 'expired'}
		<Callout tone="warning" title={t('sf.fed.statusCard.expiredTitle')}
			>{t('sf.fed.statusCard.expiredBody')}</Callout
		>
	{:else if standing === 'refreshFailed'}
		<Callout tone="warning" title={t('sf.fed.statusCard.failedTitle')}>
			{t('sf.fed.statusCard.failedBody', { count: status?.consecutiveFailures ?? 0 })}
			{#if status?.lastErrorCode}<code>{status.lastErrorCode}</code>{/if}
		</Callout>
	{:else if standing === 'draft'}
		<Callout tone="info">{t('sf.fed.statusCard.draft')}</Callout>
	{/if}
	{#if failure}<Callout tone="danger" live>{failure}</Callout>{/if}
	{#if status}
		<DetailList ruled>
			<DetailItem label={t('sf.fed.statusCard.lastFetched')}>
				{#if iso(status.lastSuccessAt)}<DateTime value={iso(status.lastSuccessAt)!} />{:else}{t(
						'sf.fed.row.notFetched'
					)}{/if}
			</DetailItem>
			<DetailItem label={t('sf.fed.created.signature')}>
				{#if verification}
					<Badge tone={verification === 'verified' ? 'success' : 'warning'} dot
						>{t(`sf.fed.verification.${verification}`)}</Badge
					>
				{:else}—{/if}
			</DetailItem>
			<DetailItem label={t('sf.fed.statusCard.validUntil')}>
				{#if status.acceptedValidUntil}
					<DateTime value={status.acceptedValidUntil} />
					{#if days !== null}
						<Badge tone={days < 0 ? 'danger' : days <= 3 ? 'warning' : 'neutral'}
							>{days < 0
								? t('sf.fed.statusCard.daysAgo', { count: -days })
								: t('sf.fed.statusCard.daysLeft', { count: days })}</Badge
						>
					{/if}
				{:else}—{/if}
			</DetailItem>
			<DetailItem label={t('sf.fed.statusCard.nextRefresh')}>
				{#if iso(status.nextRefreshAt)}<DateTime value={iso(status.nextRefreshAt)!} />{:else}—{/if}
			</DetailItem>
			<DetailItem label={t('sf.fed.created.entities')}>
				{shownCount === null
					? '—'
					: t('sf.fed.statusCard.entityCount', {
							count: shownCount,
							excluded: shownExcluded ?? 0
						})}
			</DetailItem>
		</DetailList>
	{/if}
	{#if history.length > 0}
		<h3 class="history__title">{t('sf.fed.history.title')}</h3>
		<ul class="history" aria-label={t('sf.fed.history.title')}>
			{#each history as item (item.jobId)}
				<li class="history__item">
					<DateTime value={new Date(item.startedAt).toISOString()} />
					<span
						>{t(
							item.trigger === 'manual' ? 'sf.fed.history.manual' : 'sf.fed.history.automatic'
						)}</span
					>
					<Badge tone={item.status === 'failed' ? 'danger' : 'neutral'}
						>{refreshOutcome(item)}</Badge
					>
					{#if item.entityCount !== null}
						<span>{t('sf.fed.row.entities', { count: item.entityCount })} {refreshDelta(item)}</span
						>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</Card>

<style>
	.history__title {
		margin: var(--space-grid) 0 8px;
		font-size: var(--fs-body);
	}

	.history {
		display: grid;
		gap: 6px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.history__item {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-related);
		align-items: center;
		color: var(--text-secondary);
		font-size: var(--fs-small);
	}
</style>
