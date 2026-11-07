<script lang="ts">
	import type { AdminAuditClient, AdminAuditEntry } from '#lib/api/admin-audit.js';
	import { hasMessage, t } from '#lib/i18n/i18n.svelte.js';
	import CodeField from '#lib/ui/code/CodeField.svelte';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import DetailItem from '#lib/ui/patterns/DetailItem.svelte';
	import DetailList from '#lib/ui/patterns/DetailList.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import DateTime from '#lib/ui/time/DateTime.svelte';
	import {
		RESULT_LABEL,
		RESULT_TONE,
		SEVERITY_LABEL,
		STEP_UP_KEYS,
		actionLabelKey,
		actorKindKey,
		actorName,
		stepUpFacts
	} from './audit-labels';

	/**
	 * One admin audit entry in full: when, who (and from where), what on which target, how it
	 * ended, a step-up's operation and level in words, and the rest of its metadata. What changed
	 * (before / after) is loaded only when asked for, by an admin who may read it: the read is
	 * itself recorded.
	 */
	interface Props {
		entry: AdminAuditEntry;
		client: AdminAuditClient;
		/** The admin may read what changed (`admin:admin_audit:detail:read`). */
		canReadChanges: boolean;
		onclose: () => void;
	}

	let { entry, client, canReadChanges, onclose }: Props = $props();

	const actionKey = $derived(actionLabelKey(entry.action, hasMessage));
	const kind = $derived(actorKindKey(entry));
	const stepUp = $derived(stepUpFacts(entry));
	const extra = $derived.by(() => {
		const metadata = { ...(entry.metadata ?? {}) };
		if (stepUp) for (const key of STEP_UP_KEYS) delete metadata[key];
		return Object.keys(metadata).length > 0 ? JSON.stringify(metadata, null, 2) : null;
	});

	type Changes =
		| { state: 'idle' }
		| { state: 'loading' }
		| { state: 'failed' }
		| { state: 'ready'; before: string | null; after: string | null };
	let changes = $state<Changes>({ state: 'idle' });

	const pretty = (value: Record<string, unknown> | null | undefined) =>
		value && Object.keys(value).length > 0 ? JSON.stringify(value, null, 2) : null;

	async function loadChanges(): Promise<void> {
		changes = { state: 'loading' };
		try {
			const full = await client.get(entry.id, entry.created_at);
			changes = { state: 'ready', before: pretty(full.before), after: pretty(full.after) };
		} catch {
			changes = { state: 'failed' };
		}
	}
</script>

<Card title={t('aud.detail.title')}>
	{#snippet actions()}
		<Button size="sm" variant="ghost" icon="close" onclick={onclose}>{t('aud.detail.close')}</Button
		>
	{/snippet}

	<DetailList ruled>
		<DetailItem label={t('aud.detail.time')}
			><DateTime value={entry.created_at} seconds /></DetailItem
		>
		<DetailItem label={t('aud.detail.actor')}>
			{actorName(entry, t)}
			{#if kind}<Badge>{t(kind)}</Badge>{/if}
			{#if entry.admin_email && entry.admin_email !== actorName(entry, t)}
				<span class="secondary">{entry.admin_email}</span>
			{/if}
		</DetailItem>
		{#if entry.actor_id || entry.admin_user_id}
			<DetailItem label={t('aud.detail.actorId')}
				><code>{entry.actor_id || entry.admin_user_id}</code></DetailItem
			>
		{/if}
		<DetailItem label={t('aud.detail.action')}>
			{#if actionKey}{t(actionKey)}{/if}
			<code>{entry.action}</code>
		</DetailItem>
		{#if stepUp}
			<DetailItem label={t('aud.detail.stepUpOperation')}
				><code>{stepUp.operation}</code></DetailItem
			>
			<DetailItem label={t('aud.detail.stepUpLevel')}>{t(`aud.level.${stepUp.level}`)}</DetailItem>
		{/if}
		{#if entry.resource_type || entry.resource_id}
			<DetailItem label={t('aud.detail.target')}>
				{#if entry.resource_type}<code>{entry.resource_type}</code>{/if}
				{#if entry.resource_id}<code>{entry.resource_id}</code>{/if}
			</DetailItem>
		{/if}
		<DetailItem label={t('aud.detail.result')}>
			<Badge tone={RESULT_TONE[entry.result]}>{t(RESULT_LABEL[entry.result])}</Badge>
		</DetailItem>
		{#if entry.severity}
			<DetailItem label={t('aud.detail.severity')}>{t(SEVERITY_LABEL[entry.severity])}</DetailItem>
		{/if}
		{#if entry.error_code || entry.error_message}
			<DetailItem label={t('aud.detail.error')}>
				{#if entry.error_code}<code>{entry.error_code}</code>{/if}
				{#if entry.error_message}<span class="secondary">{entry.error_message}</span>{/if}
			</DetailItem>
		{/if}
		{#if entry.ip_address}
			<DetailItem label={t('aud.detail.ip')}><code>{entry.ip_address}</code></DetailItem>
		{/if}
		{#if entry.user_agent}
			<DetailItem label={t('aud.detail.userAgent')}
				><span class="wrap">{entry.user_agent}</span></DetailItem
			>
		{/if}
		{#if entry.request_id}
			<DetailItem label={t('aud.detail.request')}><code>{entry.request_id}</code></DetailItem>
		{/if}
		{#if entry.session_id}
			<DetailItem label={t('aud.detail.session')}><code>{entry.session_id}</code></DetailItem>
		{/if}
	</DetailList>

	{#if extra}
		<div class="block">
			<CodeField label={t('aud.detail.metadata')} language="json" value={extra} readonly rows={6} />
		</div>
	{/if}

	{#if canReadChanges}
		<div class="block">
			{#if changes.state === 'ready'}
				{#if changes.before || changes.after}
					<div class="changes">
						{#if changes.before}
							<CodeField
								label={t('aud.detail.before')}
								language="json"
								value={changes.before}
								readonly
								rows={8}
							/>
						{/if}
						{#if changes.after}
							<CodeField
								label={t('aud.detail.after')}
								language="json"
								value={changes.after}
								readonly
								rows={8}
							/>
						{/if}
					</div>
				{:else}
					<p class="secondary">{t('aud.detail.changesNone')}</p>
				{/if}
			{:else}
				<div class="ask">
					<Button size="sm" loading={changes.state === 'loading'} onclick={loadChanges}
						>{t('aud.detail.loadChanges')}</Button
					>
					<p class="secondary">{t('aud.detail.loadChanges.hint')}</p>
				</div>
				{#if changes.state === 'failed'}
					<Callout tone="danger" live>{t('aud.detail.changesFailed')}</Callout>
				{/if}
			{/if}
		</div>
	{/if}
</Card>

<style>
	.secondary {
		margin: 0;
		color: var(--text-muted);
		font-size: var(--fs-caption);
		line-height: var(--lh-body);
	}

	.wrap {
		overflow-wrap: anywhere;
	}

	.block {
		display: grid;
		gap: var(--space-related);
		margin-block-start: var(--space-field);
	}

	.changes {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
		gap: var(--space-columns);
	}

	.ask {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-related);
	}
</style>
