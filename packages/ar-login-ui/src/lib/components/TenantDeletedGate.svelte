<script lang="ts">
	import { onDestroy, type Snippet } from 'svelte';
	import TenantDeletedNotice from '#lib/components/TenantDeletedNotice.svelte';
	import {
		canSignalPasskeyRemoval,
		isTenantOfThisHostDeleted,
		signalChosenPasskeyRemoved,
		signalRememberedPasskeysRemoved
	} from '#lib/webauthn/deleted-tenant.js';

	interface Props {
		/**
		 * How many times the page has failed to load what it needs from the tenant; 0 while it has
		 * not. Each new failure asks the platform once whether the tenant was deleted, so a working
		 * tenant costs no extra request and a page left open learns of a later deletion.
		 */
		failures: number;
		children: Snippet;
	}

	let { failures, children }: Props = $props();

	let deleted = $state(false);
	let removedAutomatically = $state(false);
	let askedFor = 0;
	let asking = false;
	let disposed = false;

	$effect(() => {
		if (failures > askedFor) void askAboutNewFailures();
	});

	onDestroy(() => {
		disposed = true;
	});

	/** One check at a time; a failure that arrives meanwhile is asked about when it ends. */
	async function askAboutNewFailures() {
		if (asking) return;
		asking = true;
		try {
			while (!deleted && !disposed && failures > askedFor) {
				const failure = failures;
				const isDeleted = await isTenantOfThisHostDeleted();
				askedFor = failure;
				// The page was left meanwhile: its successor decides for itself.
				if (disposed || !isDeleted) continue;
				deleted = true;
				removedAutomatically = (await signalRememberedPasskeysRemoved()) > 0;
			}
		} finally {
			asking = false;
		}
	}
</script>

{#if deleted}
	<TenantDeletedNotice
		canRemove={canSignalPasskeyRemoval()}
		{removedAutomatically}
		onRemoveChosen={signalChosenPasskeyRemoved}
	/>
{:else}
	{@render children()}
{/if}
