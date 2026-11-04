<script lang="ts">
	import { isConsolePath, type AdminNotice } from '#lib/api/admin-notices.js';
	import type {
		NoticeDelivery,
		NoticeDeliveryClient,
		NoticeDeliveryPage
	} from '#lib/api/notice-delivery.js';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import { t, hasMessage } from '#lib/i18n/i18n.svelte.js';
	import { noticeText } from '#lib/api/admin-notices.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import DataTable from '#lib/ui/patterns/DataTable.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import DetailItem from '#lib/ui/patterns/DetailItem.svelte';
	import DetailList from '#lib/ui/patterns/DetailList.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import Link from '#lib/ui/primitives/Link.svelte';
	import DateTime from '#lib/ui/time/DateTime.svelte';
	import {
		DELIVERY_CHANNEL_LABEL,
		DELIVERY_STATUS_LABEL,
		DELIVERY_STATUS_TONE,
		SEVERITY_LABEL,
		SEVERITY_TONE,
		scopeLabel
	} from './notice-labels';

	/**
	 * One notice in full: what it says, where it comes from, the link to the page that deals with
	 * it, and the one action that closes it (information is cleared from this admin's screen,
	 * the rest is marked as handled for everyone).
	 */
	interface Props {
		notice: AdminNotice;
		canResolve: boolean;
		busy?: boolean;
		error?: string;
		/** Where the notice was emailed and posted (admins who may read settings). */
		delivery?: NoticeDeliveryClient;
		onresolve: () => void;
		ondismiss: () => void;
		onclose: () => void;
	}

	let {
		notice,
		canResolve,
		busy = false,
		error,
		delivery,
		onresolve,
		ondismiss,
		onclose
	}: Props = $props();

	let deliveries = $state<NoticeDelivery[]>([]);
	let summary = $state<NoticeDeliveryPage['summary']>([]);
	let nextCursor = $state<string | null>(null);
	let loadingMore = $state(false);
	let deliveryPhase = $state<'loading' | 'ready' | 'failed'>('loading');

	/** Cancels whatever is being read for the notice shown before. */
	let reading: AbortController | null = null;

	$effect(() => {
		const id = notice.id;
		if (!delivery) return;
		reading?.abort();
		const controller = new AbortController();
		reading = controller;
		loadingMore = false;
		deliveryPhase = 'loading';
		delivery
			.listDeliveries(id, { signal: controller.signal })
			.then((page) => {
				deliveries = page.items;
				summary = page.summary;
				nextCursor = page.next;
				deliveryPhase = 'ready';
			})
			.catch(() => {
				if (!controller.signal.aborted) deliveryPhase = 'failed';
			});
		return () => controller.abort();
	});

	/** The next page of a long list (over 200 admins and channels). */
	async function loadMore() {
		const controller = reading;
		if (!delivery || !nextCursor || !controller) return;
		loadingMore = true;
		try {
			const page = await delivery.listDeliveries(notice.id, {
				after: nextCursor,
				signal: controller.signal
			});
			// Another notice was opened meanwhile: this page is not its.
			if (controller.signal.aborted) return;
			deliveries = [...deliveries, ...page.items];
			nextCursor = page.next;
		} catch {
			if (!controller.signal.aborted) toast.error(t('nt.dlv.loadFailed'));
		} finally {
			if (!controller.signal.aborted) loadingMore = false;
		}
	}

	const message = $derived(noticeText(notice, { t, hasMessage }));
	const tenantParam = $derived(notice.params.tenant_id);
	const who = $derived(
		notice.resolved_by === 'system' ? t('nt.detail.resolvedBySystem') : (notice.resolved_by ?? '—')
	);
</script>

<Card title={t('nt.detail.title')}>
	{#snippet actions()}
		<Button size="sm" variant="ghost" onclick={onclose}>{t('nt.detail.close')}</Button>
	{/snippet}
	<DetailList>
		<DetailItem label={t('nt.detail.message')}>
			<Badge tone={SEVERITY_TONE[notice.severity]}>{t(SEVERITY_LABEL[notice.severity])}</Badge>
			{message}
		</DetailItem>
		{#if notice.body}
			<DetailItem label={t('nt.detail.body')}><span class="body">{notice.body}</span></DetailItem>
		{/if}
		<DetailItem label={t('nt.col.scope')}>{scopeLabel(notice, t)}</DetailItem>
		{#if tenantParam !== undefined}
			<DetailItem label={t('nt.detail.tenant')}><code>{tenantParam}</code></DetailItem>
		{/if}
		<DetailItem label={t('nt.detail.source')}>
			{notice.source === 'system'
				? t('nt.detail.source.system')
				: t('nt.detail.source.announcement')}
		</DetailItem>
		{#if notice.created_by}
			<DetailItem label={t('nt.detail.createdBy')}><code>{notice.created_by}</code></DetailItem>
		{/if}
		<DetailItem label={t('nt.detail.created')}><DateTime value={notice.created_at} /></DetailItem>
		{#if notice.expires_at}
			<DetailItem label={t('nt.detail.expires')}><DateTime value={notice.expires_at} /></DetailItem>
		{/if}
		{#if notice.resolved_at}
			<DetailItem label={t('nt.detail.resolved')}>
				<DateTime value={notice.resolved_at} />
			</DetailItem>
			<DetailItem label={t('nt.detail.resolvedBy')}>{who}</DetailItem>
		{/if}
		{#if isConsolePath(notice.link)}
			<DetailItem label={t('nt.detail.link')}>
				<Link href={notice.link}>{notice.link}</Link>
			</DetailItem>
		{/if}
	</DetailList>

	{#if error}
		<div class="actions-note"><Callout tone="danger" live>{error}</Callout></div>
	{/if}

	{#if !notice.resolved_at}
		{#if notice.dismissible}
			<div class="actions">
				<Button disabled={busy} onclick={ondismiss}>{t('nt.dismiss')}</Button>
				<p class="hint">{t('nt.dismiss.hint')}</p>
			</div>
		{:else if canResolve}
			<div class="actions">
				<Button variant="primary" disabled={busy} onclick={onresolve}>{t('nt.resolve')}</Button>
				<p class="hint">{t('nt.resolve.hint')}</p>
			</div>
		{/if}
	{/if}
</Card>

{#if delivery}
	<Card title={t('nt.dlv.title')} flush>
		{#if deliveryPhase === 'loading'}
			<LoadingState label={t('common.loading')} />
		{:else if deliveryPhase === 'failed'}
			<EmptyState icon="warningCircle" title={t('nt.dlv.loadFailed')} />
		{:else}
			{#if summary.length > 0}
				<p class="summary">
					{#each summary as entry (`${entry.channel}:${entry.status}`)}
						<Badge tone={DELIVERY_STATUS_TONE[entry.status]}
							>{t(DELIVERY_CHANNEL_LABEL[entry.channel])}・{t(DELIVERY_STATUS_LABEL[entry.status])}
							{entry.count}</Badge
						>
					{/each}
				</p>
			{/if}
			<DataTable
				caption={t('nt.dlv.title')}
				columns={[
					{ key: 'channel', label: t('nt.dlv.col.channel'), width: '14%' },
					{ key: 'target', label: t('nt.dlv.col.target') },
					{ key: 'status', label: t('nt.dlv.col.status'), width: '26%' },
					{ key: 'attempts', label: t('nt.dlv.col.attempts'), width: '12%' },
					{ key: 'error', label: t('nt.dlv.col.error'), width: '20%' }
				]}
				rows={deliveries}
				rowKey={(row) => row.id}
			>
				{#snippet cell(row, column)}
					{#if column.key === 'channel'}
						{t(DELIVERY_CHANNEL_LABEL[row.channel])}
					{:else if column.key === 'target'}
						<code>{row.target_id}</code>
					{:else if column.key === 'status'}
						<Badge tone={DELIVERY_STATUS_TONE[row.status]}
							>{t(DELIVERY_STATUS_LABEL[row.status])}</Badge
						>
					{:else if column.key === 'attempts'}
						{row.attempts}
					{:else if row.last_error}
						<code>{row.last_error}</code>
					{:else}
						—
					{/if}
				{/snippet}
				{#snippet empty()}
					<EmptyState icon="bell" title={t('nt.dlv.empty')} />
				{/snippet}
			</DataTable>
			{#if nextCursor}
				<div class="more">
					<Button size="sm" loading={loadingMore} onclick={loadMore}>{t('nt.dlv.more')}</Button>
				</div>
			{/if}
		{/if}
	</Card>
{/if}

<style>
	.summary {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-related);
		padding: var(--box-pad);
		margin: 0;
	}

	.more {
		display: flex;
		justify-content: center;
		padding: var(--box-pad);
	}

	.body {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.actions-note,
	.actions {
		margin-block-start: var(--space-field);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-related);
	}

	.hint {
		margin: 0;
		color: var(--text-muted);
		font-size: var(--fs-caption);
		line-height: var(--lh-body);
	}
</style>
