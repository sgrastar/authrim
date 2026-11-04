<script lang="ts">
	import { isConsolePath, type AdminNotice } from '#lib/api/admin-notices.js';
	import { t, hasMessage } from '#lib/i18n/i18n.svelte.js';
	import { noticeText } from '#lib/api/admin-notices.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import DetailItem from '#lib/ui/patterns/DetailItem.svelte';
	import DetailList from '#lib/ui/patterns/DetailList.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import Link from '#lib/ui/primitives/Link.svelte';
	import DateTime from '#lib/ui/time/DateTime.svelte';
	import { SEVERITY_LABEL, SEVERITY_TONE, scopeLabel } from './notice-labels';

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
		onresolve: () => void;
		ondismiss: () => void;
		onclose: () => void;
	}

	let { notice, canResolve, busy = false, error, onresolve, ondismiss, onclose }: Props = $props();

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

<style>
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
