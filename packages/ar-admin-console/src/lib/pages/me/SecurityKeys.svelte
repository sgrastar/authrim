<script lang="ts">
	/**
	 * My account → Security keys: the admin's step-up second factors, and their recovery when
	 * every key is lost. Confirmations the Admin API asks for (passkey, a key, a step-up receipt)
	 * are handled inside the client.
	 */
	import { ApiError } from '#lib/api/api-error.js';
	import type {
		SecondFactor,
		SecondFactorRecovery,
		SecondFactorsClient,
		SecondFactorState
	} from '#lib/api/second-factors.js';
	import { i18n, t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import ConfirmDialog from '#lib/ui/patterns/ConfirmDialog.svelte';
	import DetailItem from '#lib/ui/patterns/DetailItem.svelte';
	import DetailList from '#lib/ui/patterns/DetailList.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import FormDialog from '#lib/ui/patterns/FormDialog.svelte';
	import InlineGroup from '#lib/ui/patterns/InlineGroup.svelte';
	import ItemCard from '#lib/ui/patterns/ItemCard.svelte';
	import ItemGrid from '#lib/ui/patterns/ItemGrid.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import IconButton from '#lib/ui/primitives/IconButton.svelte';
	import TextField from '#lib/ui/primitives/TextField.svelte';
	import DateTime from '#lib/ui/time/DateTime.svelte';
	import { formatTime } from '#lib/ui/time/format-time.js';
	import { timePreference } from '#lib/ui/time/time-preference.svelte.js';
	import { toast } from '#lib/ui/toast/toast.svelte.js';

	interface Props {
		client: SecondFactorsClient;
		/** Fixed clock for stories and tests. */
		now?: () => number;
	}

	let { client, now = Date.now }: Props = $props();

	let keyState = $state<SecondFactorState | null>(null);
	let recovery = $state<SecondFactorRecovery | null>(null);
	let loadState = $state<'loading' | 'ready' | 'failed'>('loading');
	let busy = $state(false);

	let adding = $state<'key' | 'recovery' | null>(null);
	let addName = $state('');
	let addError = $state<string>();
	let removing = $state<SecondFactor | null>(null);
	let confirming = $state<'complete' | 'cancel' | null>(null);

	const activeKeys = $derived((keyState?.second_factors ?? []).filter((key) => !key.revoked_at));
	const onlyOne = $derived(activeKeys.length === 1);
	const recoveryReady = $derived(recovery !== null && now() >= recovery.not_before);

	function when(value: number): string {
		const formatted = formatTime(value, { locale: i18n.locale, zone: timePreference.zone });
		return formatted?.text ?? '';
	}

	async function load() {
		loadState = 'loading';
		try {
			[keyState, recovery] = await Promise.all([client.list(), client.getRecovery()]);
			loadState = 'ready';
		} catch {
			loadState = 'failed';
		}
	}

	$effect(() => {
		load();
	});

	function errorText(error: unknown): string {
		if (error instanceof ApiError) {
			const keys: Record<string, MessageKey> = {
				second_factor_not_device_bound: 'sk.error.notDeviceBound',
				credential_in_use: 'sk.error.inUse',
				second_factor_minimum: 'sk.error.minimum',
				recovery_requires_last_resort: 'sk.error.lastResort',
				recovery_notification_unavailable: 'sk.error.noEmail',
				recovery_notification_failed: 'sk.error.noEmail',
				recovery_pending: 'sk.error.pending'
			};
			if (error.code === 'recovery_waiting' && typeof error.body.not_before === 'number') {
				return t('sk.error.waiting', { date: when(error.body.not_before) });
			}
			const key = keys[error.code];
			if (key) return t(key);
		}
		if (error instanceof Error && error.name === 'NotAllowedError') return t('sk.error.cancelled');
		return t('sk.error');
	}

	const nameOf = (key: { label: string | null }) => key.label || t('sk.unnamed');

	function openAdd(kind: 'key' | 'recovery') {
		addName = '';
		addError = undefined;
		adding = kind;
	}

	async function submitAdd() {
		const kind = adding;
		if (!kind) return;
		busy = true;
		addError = undefined;
		try {
			const result = await client.register({
				label: addName.trim() || undefined,
				recovery: kind === 'recovery'
			});
			adding = null;
			toast.success(t('recovery' in result ? 'sk.recoveryFiled' : 'sk.added'));
			await load();
		} catch (error) {
			addError = errorText(error);
		} finally {
			busy = false;
		}
	}

	async function remove() {
		const target = removing;
		if (!target) return;
		busy = true;
		try {
			await client.remove(target.id);
			toast.success(t('sk.removed'));
			await load();
		} catch (error) {
			toast.error(errorText(error));
		} finally {
			busy = false;
			removing = null;
		}
	}

	async function settleRecovery() {
		const action = confirming;
		if (!action) return;
		busy = true;
		try {
			if (action === 'complete') await client.completeRecovery();
			else await client.cancelRecovery();
			toast.success(t(action === 'complete' ? 'sk.recovery.completed' : 'sk.recovery.cancelled'));
			await load();
		} catch (error) {
			toast.error(errorText(error));
		} finally {
			busy = false;
			confirming = null;
		}
	}
</script>

<Card title={t('sk.title')} info={t('sk.info')}>
	{#snippet actions()}
		{#if loadState === 'ready' && keyState?.enrollment.mode !== 'recovery_required' && !recovery}
			<Button icon="plus" size="sm" onclick={() => openAdd('key')}>{t('sk.add')}</Button>
		{/if}
	{/snippet}

	{#if loadState === 'loading'}
		<LoadingState label={t('common.loading')} />
	{:else if loadState === 'failed'}
		<EmptyState icon="warningCircle" title={t('sk.loadFailed')}>
			{#snippet action()}
				<Button size="sm" onclick={load}>{t('common.retry')}</Button>
			{/snippet}
		</EmptyState>
	{:else if keyState}
		<div class="stack">
			{#if recovery}
				<Callout
					tone={recoveryReady ? 'info' : 'warning'}
					title={t(recoveryReady ? 'sk.recovery.ready.title' : 'sk.recovery.waiting.title')}
				>
					<p>
						{recoveryReady
							? t('sk.recovery.ready.body')
							: t('sk.recovery.waiting.body', { date: when(recovery.not_before) })}
					</p>
					<InlineGroup>
						{#if recoveryReady}
							<Button size="sm" variant="primary" onclick={() => (confirming = 'complete')}>
								{t('sk.recovery.complete')}
							</Button>
						{/if}
						<Button size="sm" onclick={() => (confirming = 'cancel')}>
							{t('sk.recovery.cancel')}
						</Button>
					</InlineGroup>
				</Callout>
			{:else if keyState.enrollment.mode === 'first' && keyState.enrollment.first_enrollment_ends_at}
				<Callout
					title={t('sk.first.title', { date: when(keyState.enrollment.first_enrollment_ends_at) })}
				>
					{t('sk.first.body')}
				</Callout>
			{:else if keyState.enrollment.mode === 'recovery_required'}
				<Callout tone="warning" title={t('sk.recoveryNeeded.title')}>
					<p>{t('sk.recoveryNeeded.body')}</p>
					<Button size="sm" onclick={() => openAdd('recovery')}>{t('sk.recover')}</Button>
				</Callout>
			{/if}

			{#if activeKeys.length === 0}
				<EmptyState icon="key" title={t('sk.empty')} />
			{:else}
				<ItemGrid label={t('sk.title')}>
					{#each activeKeys as key (key.id)}
						<ItemCard title={nameOf(key)} icon="key">
							{#snippet meta()}
								{#if onlyOne}<Badge tone="info">{t('sk.only')}</Badge>{/if}
							{/snippet}
							{#snippet actions()}
								<IconButton
									icon="trash"
									label="{t('sk.remove')}: {nameOf(key)}"
									disabled={onlyOne}
									onclick={() => (removing = key)}
								/>
							{/snippet}
							<DetailList size="sm">
								<DetailItem label={t('sk.created')}><DateTime value={key.created_at} /></DetailItem>
								<DetailItem label={t('sk.lastUsed')}>
									{#if key.last_used_at}<DateTime value={key.last_used_at} />{:else}{t(
											'sk.never'
										)}{/if}
								</DetailItem>
							</DetailList>
						</ItemCard>
					{/each}
				</ItemGrid>
			{/if}

			{#if activeKeys.length > 0 && !recovery}
				<div class="recover-link">
					<Button size="sm" variant="ghost" onclick={() => openAdd('recovery')}>
						{t('sk.recover')}
					</Button>
				</div>
			{/if}
		</div>
	{/if}
</Card>

<FormDialog
	open={adding !== null}
	title={t(adding === 'recovery' ? 'sk.recoverTitle' : 'sk.addTitle')}
	description={t(adding === 'recovery' ? 'sk.recoverBody' : 'sk.addBody')}
	submitLabel={t(adding === 'recovery' ? 'sk.recoverSubmit' : 'sk.register')}
	{busy}
	error={addError}
	onsubmit={submitAdd}
	oncancel={() => (adding = null)}
>
	<TextField
		label={t('sk.name')}
		hint={t('sk.nameHint')}
		maxlength={64}
		autocomplete="off"
		bind:value={addName}
	/>
</FormDialog>

<ConfirmDialog
	open={removing !== null}
	title={t('sk.removeTitle', { name: removing ? nameOf(removing) : '' })}
	body={t('sk.removeBody')}
	confirmLabel={t('sk.remove')}
	tone="danger"
	{busy}
	onconfirm={remove}
	oncancel={() => (removing = null)}
/>

<ConfirmDialog
	open={confirming !== null}
	title={t(confirming === 'complete' ? 'sk.recovery.completeTitle' : 'sk.recovery.cancelTitle')}
	body={t(confirming === 'complete' ? 'sk.recovery.ready.body' : 'sk.recovery.cancelBody')}
	confirmLabel={t(confirming === 'complete' ? 'sk.recovery.complete' : 'sk.recovery.cancel')}
	tone={confirming === 'complete' ? 'danger' : 'default'}
	{busy}
	onconfirm={settleRecovery}
	oncancel={() => (confirming = null)}
/>

<style>
	.stack {
		display: flex;
		flex-direction: column;
		gap: var(--space-field);
	}

	.recover-link {
		display: flex;
		justify-content: flex-end;
	}
</style>
