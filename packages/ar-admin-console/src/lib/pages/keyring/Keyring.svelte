<script lang="ts">
	import { goto } from '$app/navigation';
	import { onDestroy, untrack } from 'svelte';
	import {
		walletCredentialErrorKey,
		type WalletCredentialManager,
		type WalletCredentialsClient
	} from '#lib/api/wallet-credentials.js';
	import { groupTransactionCode } from '#lib/keyring/confirmation-code.js';
	import { KeyringFlow } from '#lib/keyring/keyring-flow.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import BackLink from '#lib/ui/primitives/BackLink.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import KeyringCredentials from './KeyringCredentials.svelte';

	/**
	 * Account → Authrim Keyring: issue the signed-in administrator's credential to the Keyring
	 * app. Step 1 shows only the QR code; the transaction code appears once the app has fetched
	 * the offer (so one photo of the screen is not enough); after issuance the admin compares a
	 * key confirmation code with the one Keyring shows. Below, the admin's credentials are listed
	 * and can be revoked.
	 */
	interface Props {
		client: WalletCredentialsClient & WalletCredentialManager;
		/** Where the sign-in page returns to (this page). */
		returnPath?: string;
		/** Clock for the countdown (tests, Storybook). */
		now?: () => number;
	}

	let { client, returnPath = '/admin/me/keyring', now }: Props = $props();

	// Props are read once: the flow is built for one client and one clock.
	// svelte-ignore state_referenced_locally
	const flow = new KeyringFlow({ client, now });

	let qrDataUrl = $state('');
	// Bumped when a credential has just been issued, so the list below is read again.
	let credentialsRefresh = $state(0);
	$effect(() => {
		if (flow.phase === 'issued') untrack(() => (credentialsRefresh += 1));
	});

	// The QR library is only needed while a QR is on screen, so it is loaded on demand.
	$effect(() => {
		const offer = flow.credentialOffer;
		if (!offer) {
			qrDataUrl = '';
			return;
		}
		import('qrcode')
			.then(({ toDataURL }) =>
				toDataURL(offer, { margin: 2, width: 240, errorCorrectionLevel: 'M' })
			)
			.then((value) => {
				if (flow.credentialOffer === offer) qrDataUrl = value;
			})
			.catch(() => {
				if (flow.credentialOffer === offer) qrDataUrl = '';
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
		const minutes = Math.floor(total / 60);
		const seconds = total % 60;
		return `${minutes}:${String(seconds).padStart(2, '0')}`;
	});

	const spaced = (value: string) =>
		value
			.replace(/[^A-Za-z0-9]/g, '')
			.split('')
			.join(' ');

	const endTitle = $derived(
		flow.endReason === 'locked'
			? t('keyring.ended.locked')
			: flow.endReason === 'expired'
				? t('keyring.ended.expired')
				: t('keyring.ended.failed')
	);
	const endBody = $derived(
		flow.endReason === 'locked'
			? t('keyring.ended.lockedBody')
			: flow.endReason === 'expired'
				? t('keyring.ended.expiredBody')
				: t('keyring.ended.failedBody')
	);

	/** Spoken when the step changes (never the codes themselves). */
	const announcement = $derived.by(() => {
		switch (flow.phase) {
			case 'creating':
				return t('keyring.creating');
			case 'qr':
				return t('keyring.step1.title');
			case 'code':
				return t('keyring.step2.title');
			case 'issued':
				return t('keyring.issued.title');
			case 'ended':
				return endTitle;
			case 'error':
				return t(walletCredentialErrorKey(flow.error));
			default:
				return '';
		}
	});

	function signInAgain() {
		void goto(`/admin/login?return_to=${encodeURIComponent(returnPath)}`);
	}
</script>

<svelte:head>
	<title>{t('keyring.page.title')} — {t('app.brand')}</title>
</svelte:head>

<Page>
	<PageHeader title={t('keyring.page.title')} description={t('keyring.page.desc')}>
		{#snippet back()}
			<BackLink href="/admin/me">{t('keyring.back')}</BackLink>
		{/snippet}
	</PageHeader>

	<div class="sr-only" role="status" aria-live="polite">{announcement}</div>

	{#if flow.phase === 'idle'}
		<Card title={t('keyring.start.title')} description={t('keyring.start.body')}>
			<Button variant="primary" icon="plus" onclick={() => flow.start()}>
				{t('keyring.start.button')}
			</Button>
		</Card>
	{:else if flow.phase === 'creating'}
		<Card title={t('keyring.start.title')}>
			<LoadingState label={t('keyring.creating')} />
		</Card>
	{:else if flow.phase === 'error'}
		<Card title={t('keyring.start.title')}>
			<Callout tone="danger" live>{t(walletCredentialErrorKey(flow.error))}</Callout>
			{#snippet footer()}
				{#if flow.needsFreshAuth}
					<Button variant="primary" onclick={signInAgain}>{t('keyring.reauth.button')}</Button>
				{:else}
					<Button onclick={() => flow.start()}>{t('keyring.again')}</Button>
				{/if}
			{/snippet}
		</Card>
	{:else if flow.phase === 'qr'}
		<Card title={t('keyring.step1.title')} description={t('keyring.step1.body')}>
			<div class="keyring">
				<div class="keyring__qr">
					{#if qrDataUrl}
						<img src={qrDataUrl} width="240" height="240" alt={t('keyring.qr.alt')} />
					{:else}
						<LoadingState label={t('keyring.creating')} />
					{/if}
				</div>
				<p class="keyring__countdown">{t('keyring.expiresIn', { time: countdown })}</p>
			</div>
			{#snippet footer()}
				<Button size="sm" onclick={() => flow.start()}>{t('keyring.again')}</Button>
			{/snippet}
		</Card>
	{:else if flow.phase === 'code'}
		<Card title={t('keyring.step2.title')} description={t('keyring.step2.body')}>
			<div class="keyring">
				<p class="keyring__label" id="keyring-code-label">{t('keyring.code.label')}</p>
				<p class="keyring__code" aria-labelledby="keyring-code-label">
					<span aria-hidden="true">{groupTransactionCode(flow.transactionCode)}</span>
					<span class="sr-only">{spaced(flow.transactionCode)}</span>
				</p>
				<p class="keyring__countdown">{t('keyring.expiresIn', { time: countdown })}</p>
			</div>
			{#snippet footer()}
				<Button size="sm" onclick={() => flow.start()}>{t('keyring.again')}</Button>
			{/snippet}
		</Card>
	{:else if flow.phase === 'issued'}
		<Card title={t('keyring.issued.title')} description={t('keyring.issued.body')}>
			<div class="keyring">
				{#if flow.confirmationCode}
					<p class="keyring__label" id="keyring-confirm-label">{t('keyring.confirm.label')}</p>
					<p class="keyring__code" aria-labelledby="keyring-confirm-label">
						<span aria-hidden="true">{flow.confirmationCode}</span>
						<span class="sr-only">{spaced(flow.confirmationCode)}</span>
					</p>
					<p class="keyring__note">{t('keyring.confirm.check')}</p>
					<Callout tone="warning">{t('keyring.confirm.mismatch')}</Callout>
				{:else}
					<Callout tone="warning">{t('keyring.confirm.mismatch')}</Callout>
				{/if}
			</div>
		</Card>
	{:else}
		<Card title={endTitle}>
			<Callout tone="warning" live>{endBody}</Callout>
			{#snippet footer()}
				<Button variant="primary" onclick={() => flow.start()}>{t('keyring.again')}</Button>
			{/snippet}
		</Card>
	{/if}

	<KeyringCredentials {client} {returnPath} refreshKey={credentialsRefresh} />
</Page>

<style>
	.keyring {
		display: flex;
		flex-direction: column;
		gap: var(--space-related);
		align-items: flex-start;
	}

	.keyring__qr {
		display: grid;
		place-items: center;
		min-width: 240px;
		min-height: 240px;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
	}

	.keyring__qr img {
		display: block;
		border-radius: var(--radius-md);
	}

	.keyring__label,
	.keyring__note,
	.keyring__countdown {
		margin: 0;
		color: var(--text-secondary);
		font-size: var(--fs-body);
	}

	.keyring__countdown {
		color: var(--text-muted);
		font-size: var(--fs-caption);
		font-variant-numeric: tabular-nums;
	}

	.keyring__code {
		margin: 0;
		color: var(--text-primary);
		font-family: var(--font-mono);
		font-size: var(--fs-page-title);
		font-weight: var(--fw-semibold);
		letter-spacing: 0.12em;
		direction: ltr;
	}
</style>
