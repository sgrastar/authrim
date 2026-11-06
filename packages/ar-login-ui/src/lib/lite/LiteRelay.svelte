<script lang="ts">
	import { isRelayUrl, LITE_RELAY_SUBMIT_SCRIPT, type LiteRelayTarget } from '#lib/lite/relay.js';

	/** The relay to another site (relay.ts). The caller sets the CSP for a POST relay. */
	let { target, continueLabel }: { target: LiteRelayTarget; continueLabel: string } = $props();
	// A constant script, never data: its exact text is what the relay's CSP allows by hash.
	const scriptTag = '<scr' + `ipt>${LITE_RELAY_SUBMIT_SCRIPT}</scr` + 'ipt>';
	const valid = $derived(
		target.method === 'get' ? isRelayUrl(target.url) : isRelayUrl(target.action)
	);
</script>

<svelte:head>
	{#if valid && target.method === 'get'}
		<meta http-equiv="refresh" content={`0;url=${target.url}`} />
	{/if}
</svelte:head>

{#if valid}
	{#if target.method === 'get'}
		<p><a href={target.url}>{continueLabel}</a></p>
	{:else}
		<form method="post" action={target.action}>
			{#each target.fields as [name, value] (name)}
				<input type="hidden" {name} {value} />
			{/each}
			<button type="submit">{continueLabel}</button>
		</form>
		<!-- eslint-disable-next-line svelte/no-at-html-tags -- a constant, allowed by its CSP hash -->
		{@html scriptTag}
	{/if}
{/if}
