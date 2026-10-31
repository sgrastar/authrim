<script lang="ts">
	import { t } from '$lib/i18n/i18n.svelte';
	import Badge from '$lib/ui/primitives/Badge.svelte';

	/**
	 * Whether a sign-up or sign-in flow can be used. One that is still being set up is not in
	 * effect, so it says so first ("Disabled"), then why ("Being set up"): "being set up" alone
	 * reads as settings that are in effect right now.
	 */
	interface Props {
		ready: boolean;
	}

	let { ready }: Props = $props();
</script>

{#if ready}
	<Badge tone="success" dot>{t('af.status.ready')}</Badge>
{:else}
	<span class="status">
		<Badge tone="neutral" dot>{t('af.status.disabled')}</Badge>
		<Badge tone="warning">{t('af.status.notReady')}</Badge>
	</span>
{/if}

<style>
	/* The badges stay whole; when the cell is narrow (a longer language) the second goes under. */
	.status {
		display: inline-flex;
		flex-wrap: wrap;
		gap: var(--space-related);
		align-items: center;
	}

	.status :global(.badge) {
		white-space: nowrap;
	}
</style>
