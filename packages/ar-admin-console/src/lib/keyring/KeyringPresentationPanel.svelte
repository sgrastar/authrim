<script lang="ts">
	import { onDestroy } from 'svelte';
	import { ApiError } from '#lib/api/api-error.js';
	import { t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import type { KeyringPresentationFlow } from './presentation-flow.svelte.js';

	/**
	 * What the admin sees while presenting their admin credential from Keyring: the QR code to
	 * scan, the two-digit number to type into Keyring, and how long is left. The number is never
	 * in the QR code, so a photo of the screen alone is not enough to approve someone else's
	 * request. The flow is owned by the caller; this panel only shows it.
	 */
	interface Props {
		flow: KeyringPresentationFlow;
		/** Start over after a failure or the end of the time. */
		onretry: () => void;
		/** Leave the browser path for a QR code (offered when the flow went through the browser). */
		onqr?: () => void;
	}

	let { flow, onretry, onqr }: Props = $props();

	let qrDataUrl = $state('');

	// The QR library is only needed while a QR is on screen, so it is loaded on demand.
	$effect(() => {
		const value = flow.qr;
		if (!value) {
			qrDataUrl = '';
			return;
		}
		import('qrcode')
			.then(({ toDataURL }) =>
				toDataURL(value, { margin: 2, width: 220, errorCorrectionLevel: 'M' })
			)
			.then((url) => {
				if (flow.qr === value) qrDataUrl = url;
			})
			.catch(() => {
				if (flow.qr === value) qrDataUrl = '';
			});
	});

	// No status checks while the tab is hidden.
	$effect(() => {
		const sync = () => flow.setVisible(document.visibilityState !== 'hidden');
		sync();
		document.addEventListener('visibilitychange', sync);
		return () => document.removeEventListener('visibilitychange', sync);
	});

	onDestroy(() => flow.destroy());

	const countdown = $derived.by(() => {
		const total = Math.ceil(flow.remainingMs / 1000);
		return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
	});

	const FAILURES: Record<string, MessageKey> = {
		match_code_mismatch: 'kp.failed.matchCode',
		holder_key_not_registered: 'kp.failed.notRegistered',
		holder_key_already_registered: 'kp.failed.alreadyRegistered',
		credential_in_use: 'kp.failed.alreadyRegistered',
		credential_not_active: 'kp.failed.notActive',
		wrong_admin: 'kp.failed.wrongAdmin',
		step_up_expired: 'kp.failed.stale',
		step_up_required: 'kp.failed.stale'
	};

	const failureText = $derived(
		flow.endReason === 'expired'
			? t('kp.expired')
			: t((flow.failure && FAILURES[flow.failure]) || 'kp.failed')
	);

	const START_ERRORS: Record<string, MessageKey> = {
		keyring_not_registered: 'kp.error.notRegistered',
		keyring_not_eligible: 'kp.error.notEligible',
		keyring_unavailable: 'kp.error.unavailable',
		second_factor_recovery_required: 'kp.error.recovery'
	};

	const startErrorText = $derived(
		t(
			(flow.error instanceof ApiError && START_ERRORS[flow.error.code]) ||
				(flow.error instanceof Error && flow.error.name === 'NotAllowedError'
					? 'kp.error.cancelled'
					: 'kp.error')
		)
	);

	/** Spoken when the step changes (never the number itself). */
	const announcement = $derived.by(() => {
		switch (flow.phase) {
			case 'starting':
				return t('kp.starting');
			case 'waiting':
				return flow.checking ? t('kp.checking') : t('kp.scan');
			case 'ready':
				return t('kp.openBrowser');
			case 'browser':
				return t('kp.browser');
			// The verified, failed and refused states show a live callout, which is announced
			// already; saying it here too would read it twice.
			default:
				return '';
		}
	});

	const spaced = (value: string) => value.split('').join(' ');
</script>

<div class="sr-only" role="status" aria-live="polite">{announcement}</div>

{#if flow.phase === 'starting' || flow.phase === 'idle'}
	<LoadingState label={t('kp.starting')} />
{:else if flow.phase === 'waiting'}
	<div class="presentation">
		<ol class="presentation__steps">
			<li>{t('kp.step.scan')}</li>
			<li>{t('kp.step.code')}</li>
			<li>{t('kp.step.confirm')}</li>
		</ol>
		<div class="presentation__body">
			<div class="presentation__qr">
				{#if qrDataUrl}
					<img src={qrDataUrl} width="220" height="220" alt={t('kp.qr.alt')} />
				{:else}
					<LoadingState label={t('kp.starting')} />
				{/if}
			</div>
			<div class="presentation__code">
				<p class="presentation__label" id="kp-code-label">{t('kp.code.label')}</p>
				<p class="presentation__digits" aria-labelledby="kp-code-label">
					<span aria-hidden="true">{flow.matchCode}</span>
					<span class="sr-only">{spaced(flow.matchCode)}</span>
				</p>
				<p class="presentation__note">{t('kp.code.note')}</p>
			</div>
		</div>
		{#if flow.checking}
			<Callout tone="info">{t('kp.checking')}</Callout>
		{/if}
		<p class="presentation__countdown">{t('kp.expiresIn', { time: countdown })}</p>
	</div>
{:else if flow.phase === 'ready'}
	<div class="presentation">
		<p class="presentation__note">{t('kp.browser.note')}</p>
		<div class="presentation__actions">
			<Button size="sm" icon="deviceMobile" onclick={() => void flow.openBrowser()}>
				{t('kp.openBrowser')}
			</Button>
			{#if onqr}
				<Button size="sm" variant="ghost" onclick={onqr}>{t('kp.useQr')}</Button>
			{/if}
		</div>
	</div>
{:else if flow.phase === 'browser'}
	<div class="presentation">
		<LoadingState label={t('kp.browser')} />
		<p class="presentation__note">{t('kp.browser.note')}</p>
	</div>
{:else if flow.phase === 'verified'}
	<Callout tone="info" icon="check" live>{t('kp.verified')}</Callout>
{:else if flow.phase === 'ended'}
	<div class="presentation">
		<Callout tone="warning" live>{failureText}</Callout>
		<div class="presentation__actions">
			<Button size="sm" onclick={onretry}>{t('kp.again')}</Button>
			{#if flow.canUseBrowser && onqr}
				<Button size="sm" variant="ghost" onclick={onqr}>{t('kp.useQr')}</Button>
			{/if}
		</div>
	</div>
{:else}
	<div class="presentation">
		<Callout tone="danger" live>{startErrorText}</Callout>
		<div class="presentation__actions">
			<Button size="sm" onclick={onretry}>{t('kp.again')}</Button>
			{#if flow.canUseBrowser && onqr}
				<Button size="sm" variant="ghost" onclick={onqr}>{t('kp.useQr')}</Button>
			{/if}
		</div>
	</div>
{/if}

<style>
	.presentation {
		display: flex;
		flex-direction: column;
		gap: var(--space-related);
	}

	.presentation__actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-related);
	}

	.presentation__steps {
		margin: 0;
		padding-inline-start: 20px;
		color: var(--text-secondary);
		font-size: var(--fs-body);
		line-height: var(--lh-body);
	}

	.presentation__body {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-columns);
		align-items: center;
	}

	.presentation__qr {
		display: grid;
		place-items: center;
		min-width: 220px;
		min-height: 220px;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
	}

	.presentation__qr img {
		display: block;
		border-radius: var(--radius-md);
	}

	.presentation__code {
		display: flex;
		flex-direction: column;
		gap: var(--space-related);
	}

	.presentation__label,
	.presentation__note,
	.presentation__countdown {
		margin: 0;
		color: var(--text-secondary);
		font-size: var(--fs-body);
	}

	.presentation__countdown,
	.presentation__note {
		color: var(--text-muted);
		font-size: var(--fs-caption);
		font-variant-numeric: tabular-nums;
	}

	.presentation__digits {
		margin: 0;
		color: var(--text-primary);
		font-family: var(--font-mono);
		font-size: var(--fs-page-title);
		font-weight: var(--fw-semibold);
		letter-spacing: 0.12em;
		direction: ltr;
		unicode-bidi: isolate;
	}
</style>
