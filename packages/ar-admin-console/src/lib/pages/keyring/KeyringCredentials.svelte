<script lang="ts">
	import { goto } from '$app/navigation';
	import {
		FRESH_AUTH_REQUIRED,
		WalletCredentialError,
		revokeErrorKey,
		type WalletCredential,
		type WalletCredentialManager
	} from '#lib/api/wallet-credentials.js';
	import { keyConfirmationCode } from '#lib/keyring/confirmation-code.js';
	import { t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import ConfirmDialog from '#lib/ui/patterns/ConfirmDialog.svelte';
	import DetailItem from '#lib/ui/patterns/DetailItem.svelte';
	import DetailList from '#lib/ui/patterns/DetailList.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import ItemCard from '#lib/ui/patterns/ItemCard.svelte';
	import ItemGrid from '#lib/ui/patterns/ItemGrid.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import DateTime from '#lib/ui/time/DateTime.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';

	/**
	 * The signed-in administrator's own credentials, each with its key confirmation code, status
	 * and dates, and a Revoke action (permanent, behind a danger confirmation). Revoking needs a
	 * recent sign-in; when the server asks for one, the admin is sent to sign in again.
	 */
	interface Props {
		client: WalletCredentialManager;
		/** Where the sign-in page returns to (the Keyring page). */
		returnPath: string;
		/** Changes whenever the list should be read again (a credential was just issued). */
		refreshKey?: number;
	}

	let { client, returnPath, refreshKey = 0 }: Props = $props();

	let credentials = $state<WalletCredential[]>([]);
	let loadState = $state<'loading' | 'ready' | 'failed'>('loading');
	let revoking = $state<WalletCredential | null>(null);
	let busy = $state(false);
	let revokeError = $state<MessageKey | null>(null);
	let needsFreshAuth = $state(false);
	let generation = 0;

	async function load(background = false) {
		const mine = ++generation;
		if (!background) loadState = 'loading';
		try {
			const list = await client.listCredentials();
			if (mine !== generation) return;
			credentials = list;
			loadState = 'ready';
		} catch {
			if (mine !== generation) return;
			// A failed refresh keeps the list that is on screen.
			if (!background || loadState !== 'ready') loadState = 'failed';
		}
	}

	let seenRefresh = -1;
	$effect(() => {
		const key = refreshKey;
		if (key === seenRefresh) return;
		const first = seenRefresh === -1;
		seenRefresh = key;
		void load(!first);
	});

	const codeOf = (credential: WalletCredential) =>
		(credential.holderKeyThumbprint && keyConfirmationCode(credential.holderKeyThumbprint)) ||
		t('keyring.credentials.noCode');

	const statusLabel = (status: WalletCredential['status']) =>
		t(`keyring.credentials.status.${status}` as MessageKey);
	const statusTone = (status: WalletCredential['status']) =>
		status === 'active' ? 'success' : status === 'suspended' ? 'warning' : 'neutral';

	function openRevoke(credential: WalletCredential) {
		revokeError = null;
		needsFreshAuth = false;
		revoking = credential;
	}

	async function revoke() {
		const target = revoking;
		if (!target) return;
		busy = true;
		try {
			await client.revokeCredential(target.id);
			revoking = null;
			toast.success(t('keyring.credentials.revoked'));
			await load(true);
		} catch (error) {
			revoking = null;
			revokeError = revokeErrorKey(error);
			needsFreshAuth = error instanceof WalletCredentialError && error.code === FRESH_AUTH_REQUIRED;
		} finally {
			busy = false;
		}
	}

	function signInAgain() {
		void goto(`/admin/login?return_to=${encodeURIComponent(returnPath)}`);
	}
</script>

<Card title={t('keyring.credentials.title')} description={t('keyring.credentials.desc')}>
	{#if revokeError}
		<div class="credentials__error">
			<Callout tone="danger" live>{t(revokeError)}</Callout>
			{#if needsFreshAuth}
				<Button size="sm" variant="primary" onclick={signInAgain}
					>{t('keyring.reauth.button')}</Button
				>
			{/if}
		</div>
	{/if}
	{#if loadState === 'loading'}
		<LoadingState label={t('common.loading')} />
	{:else if loadState === 'failed'}
		<EmptyState icon="warningCircle" title={t('keyring.credentials.loadFailed')}>
			{#snippet action()}
				<Button size="sm" onclick={() => load()}>{t('common.retry')}</Button>
			{/snippet}
		</EmptyState>
	{:else if credentials.length === 0}
		<EmptyState icon="key" title={t('keyring.credentials.empty')} />
	{:else}
		<ItemGrid label={t('keyring.credentials.title')}>
			{#each credentials as credential (credential.id)}
				<ItemCard title={codeOf(credential)} icon="key">
					{#snippet meta()}
						<Badge tone={statusTone(credential.status)}>{statusLabel(credential.status)}</Badge>
					{/snippet}
					<DetailList size="sm">
						<DetailItem label={t('keyring.credentials.issued')}>
							<DateTime value={credential.issuedAt} />
						</DetailItem>
						<DetailItem label={t('keyring.credentials.expires')}>
							{#if credential.expiresAt !== null}
								<DateTime value={credential.expiresAt} />
							{:else}
								{t('keyring.credentials.noExpiry')}
							{/if}
						</DetailItem>
					</DetailList>
					{#snippet footer()}
						{#if credential.status !== 'revoked'}
							<Button size="sm" icon="trash" onclick={() => openRevoke(credential)}>
								{t('keyring.credentials.revoke')}
								<span class="sr-only">: {codeOf(credential)}</span>
							</Button>
						{/if}
					{/snippet}
				</ItemCard>
			{/each}
		</ItemGrid>
	{/if}
</Card>

<ConfirmDialog
	open={revoking !== null}
	title={t('keyring.credentials.revokeTitle', { code: revoking ? codeOf(revoking) : '' })}
	body={t('keyring.credentials.revokeBody')}
	confirmLabel={t('keyring.credentials.revoke')}
	tone="danger"
	{busy}
	onconfirm={revoke}
	oncancel={() => (revoking = null)}
/>

<style>
	.credentials__error {
		display: flex;
		flex-direction: column;
		gap: var(--space-related);
		align-items: flex-start;
		margin-block-end: var(--space-related);
	}
</style>
