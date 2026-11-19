<script lang="ts">
	import { Alert, Button, Card } from '#lib/components/index.js';
	import type { ChosenPasskeyRemoval } from '#lib/webauthn/deleted-tenant.js';
	import { LL } from '$i18n/i18n-svelte';

	interface Props {
		/** Whether this browser can tell its passkey provider to drop a passkey. */
		canRemove: boolean;
		/** Whether passkeys remembered in this browser were already reported, without asking. */
		removedAutomatically?: boolean;
		/** Let the person pick a passkey of this host and report it. */
		onRemoveChosen: () => Promise<ChosenPasskeyRemoval>;
	}

	let { canRemove, removedAutomatically = false, onRemoveChosen }: Props = $props();

	let removing = $state(false);
	let removedChosen = $state(false);

	async function removeChosen() {
		if (removing) return;
		removing = true;
		try {
			removedChosen = (await onRemoveChosen()) === 'signalled';
		} finally {
			removing = false;
		}
	}
</script>

<Card class="text-center">
	<h2 class="auth-section-title text-center">{$LL.tenantDeleted_title()}</h2>
	<p class="auth-section-subtitle text-center mb-6">{$LL.tenantDeleted_description()}</p>

	<div class="tenant-deleted__passkeys" aria-live="polite">
		{#if removedAutomatically}
			<Alert variant="success">{$LL.tenantDeleted_autoRemoved()}</Alert>
		{/if}
		{#if removedChosen}
			<Alert variant="success">{$LL.tenantDeleted_chosenRemoved()}</Alert>
		{/if}
	</div>

	{#if canRemove}
		<p class="tenant-deleted__hint">{$LL.tenantDeleted_chooseHint()}</p>
		<Button variant="secondary" class="w-full" loading={removing} onclick={removeChosen}>
			{$LL.tenantDeleted_chooseButton()}
		</Button>
	{/if}

	<p class="tenant-deleted__hint tenant-deleted__hint--manual">
		{$LL.tenantDeleted_manualHint()}
	</p>
</Card>

<style>
	.tenant-deleted__passkeys {
		display: grid;
		gap: 12px;
		text-align: start;
	}

	.tenant-deleted__passkeys:not(:empty) {
		margin-block-end: 16px;
	}

	.tenant-deleted__hint {
		margin-block: 0 12px;
		color: var(--text-secondary);
		font-size: 0.875rem;
		line-height: 1.6;
		text-align: start;
	}

	.tenant-deleted__hint--manual {
		margin-block: 16px 0;
	}
</style>
