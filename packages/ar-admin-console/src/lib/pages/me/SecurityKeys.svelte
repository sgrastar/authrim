<script lang="ts">
	/**
	 * My account → Security keys: the admin's step-up second factors, and their recovery when
	 * every key is lost. Confirmations the Admin API asks for (passkey, a key, a step-up receipt)
	 * are handled inside the client.
	 */
	import { withStepUp } from '#lib/api/admin-step-up.js';
	import { ApiError } from '#lib/api/api-error.js';
	import { httpKeyringFactor, type KeyringFactorClient } from '#lib/api/keyring-factor.js';
	import KeyringPresentationDialog from '#lib/keyring/KeyringPresentationDialog.svelte';
	import {
		browserSupportsDigitalCredentials,
		KeyringPresentationFlow
	} from '#lib/keyring/presentation-flow.svelte.js';
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
		/** Keyring as a second factor (registration). */
		keyring?: KeyringFactorClient;
		/** Fixed clock for stories and tests. */
		now?: () => number;
		/** How often the waiting period is looked at again. */
		tickMs?: number;
	}

	let { client, keyring = httpKeyringFactor, now = Date.now, tickMs = 30_000 }: Props = $props();

	// The clock the waiting period is read against: a request becomes completable, or lapses,
	// while the page stays open.
	let clock = $state(Date.now());
	$effect(() => {
		clock = now();
		const timer = setInterval(() => (clock = now()), tickMs);
		return () => clearInterval(timer);
	});

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
	const recoveryReady = $derived(recovery !== null && clock >= recovery.not_before);
	// A sole administrator is refused a recovery: say so before they prepare a new factor.
	const recoveryBlocked = $derived(keyState?.recovery?.available === false);
	// A lapsed request can no longer be completed: read the state again (it is gone from it).
	// At most once a minute: with this device's clock ahead of the server's, the server may still
	// list it for a while.
	const LAPSE_RECHECK_MS = 60_000;
	let lapseCheckedAt = -Infinity;
	$effect(() => {
		if (!recovery || clock < recovery.expires_at || loadState === 'loading') return;
		if (clock - lapseCheckedAt < LAPSE_RECHECK_MS) return;
		lapseCheckedAt = clock;
		void load();
	});

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
		// The authenticator already holds a credential from excludeCredentials (a sign-in passkey
		// or a key registered here): the browser refuses before the server sees anything.
		if (error instanceof Error && error.name === 'InvalidStateError') return t('sk.error.inUse');
		return t('sk.error');
	}

	const nameOf = (key: { label: string | null }) => key.label || t('sk.unnamed');
	const isKeyring = (key: SecondFactor) => key.kind === 'keyring_holder_key';

	// Registering Keyring: an L2 step-up (or the first-enrollment rule) when the request starts,
	// then the presentation from Keyring; the server registers the key once it is verified.
	// For recovery the same presentation files a recovery request (a fresh passkey, no step-up).
	let enrolling = $state<KeyringPresentationFlow | null>(null);
	let keyringPurpose = $state<'enroll' | 'recovery'>('enroll');

	function openKeyring(purpose: 'enroll' | 'recovery' = 'enroll') {
		enrolling?.destroy();
		keyringPurpose = purpose;
		const recovering = purpose === 'recovery';
		const flow = new KeyringPresentationFlow({
			start: () =>
				withStepUp((receipt) =>
					recovering ? keyring.startRecovery() : keyring.startEnroll(receipt)
				),
			progress: (id) => keyring.enrollProgress(id),
			// Through the browser when the platform allows it and the browser can; the QR code stays.
			...(keyState?.keyring?.dc_api && browserSupportsDigitalCredentials()
				? {
						browser: {
							start: () =>
								withStepUp((receipt) =>
									recovering
										? keyring.startRecoveryInBrowser()
										: keyring.startEnrollInBrowser(receipt)
								),
							submit: (id: string, data: unknown) => keyring.submitEnroll(id, data)
						}
					}
				: {}),
			onverified: () => {
				closeKeyring();
				toast.success(t(recovering ? 'sk.recoveryFiled' : 'kp.enroll.added'));
				void load();
			}
		});
		enrolling = flow;
		void flow.start();
	}

	function closeKeyring() {
		enrolling?.destroy();
		enrolling = null;
	}

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
			// The first-enrollment window closed while the page was open: offer recovery instead.
			if (error instanceof ApiError && error.code === 'second_factor_recovery_required') {
				adding = null;
				toast.error(t('sk.error.windowClosed'));
				await load();
				return;
			}
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
			// The request is gone (lapsed, or cancelled elsewhere): show what is true now.
			if (error instanceof ApiError && error.status === 404) void load();
		} finally {
			busy = false;
			confirming = null;
		}
	}
</script>

<Card title={t('sk.title')} info={t('sk.info')}>
	{#snippet actions()}
		{#if loadState === 'ready' && keyState?.enrollment.mode !== 'recovery_required' && !recovery}
			<InlineGroup>
				<Button icon="plus" size="sm" onclick={() => openKeyring()}>{t('kp.enroll.add')}</Button>
				<Button icon="plus" size="sm" onclick={() => openAdd('key')}>{t('sk.add')}</Button>
			</InlineGroup>
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
					{#if recoveryBlocked}
						<p>{t('sk.recovery.soleAdmin')}</p>
					{:else}
						<p>{t('sk.recoveryNeeded.body')}</p>
						<InlineGroup>
							<Button size="sm" onclick={() => openAdd('recovery')}>{t('sk.recover')}</Button>
							<Button size="sm" onclick={() => openKeyring('recovery')}>
								{t('kp.recover.add')}
							</Button>
						</InlineGroup>
					{/if}
				</Callout>
			{:else if onlyOne}
				<Callout title={t('sk.onlyOne.title')}>{t('sk.onlyOne.body')}</Callout>
			{/if}

			{#if activeKeys.length === 0}
				<EmptyState icon="key" title={t('sk.empty')} />
			{:else}
				<ItemGrid label={t('sk.title')}>
					{#each activeKeys as key (key.id)}
						<ItemCard title={nameOf(key)} icon={isKeyring(key) ? 'deviceMobile' : 'key'}>
							{#snippet meta()}
								<Badge>{t(isKeyring(key) ? 'kp.kind.keyring' : 'kp.kind.securityKey')}</Badge>
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
					{#if recoveryBlocked}
						<p class="recover-link__note">{t('sk.recovery.soleAdmin')}</p>
					{:else}
						<Button size="sm" variant="ghost" onclick={() => openAdd('recovery')}>
							{t('sk.recover')}
						</Button>
						<Button size="sm" variant="ghost" onclick={() => openKeyring('recovery')}>
							{t('kp.recover.add')}
						</Button>
					{/if}
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

<KeyringPresentationDialog
	open={enrolling !== null}
	title={t(keyringPurpose === 'recovery' ? 'kp.recover.title' : 'kp.enroll.title')}
	description={`${t(keyringPurpose === 'recovery' ? 'kp.recover.body' : 'kp.enroll.body')} ${t(
		'kp.enroll.needCredential'
	)}`}
	flow={enrolling}
	onretry={() => void enrolling?.start()}
	onqr={() => void enrolling?.start({ qr: true })}
	oncancel={closeKeyring}
/>

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
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: var(--space-related);
	}

	.recover-link__note {
		margin: 0;
		color: var(--text-muted);
		font-size: var(--fs-caption);
	}
</style>
