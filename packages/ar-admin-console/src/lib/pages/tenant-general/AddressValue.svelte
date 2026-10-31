<script lang="ts">
	import { isWebUrl } from '$lib/api/tenant-info';
	import Link from '$lib/ui/primitives/Link.svelte';

	/**
	 * An address as a value: monospace, at the size of the text beside it (it is an identifier to
	 * copy as it is). One a person can open in the browser is a link that opens in a new tab, marked
	 * as such; only http and https addresses are ever linked.
	 */
	interface Props {
		url: string;
		/** The address shows something when opened as it is. */
		openable?: boolean;
	}

	let { url, openable = false }: Props = $props();
</script>

{#if openable && isWebUrl(url)}
	<Link href={url} newTab><code>{url}</code></Link>
{:else}
	<code>{url}</code>
{/if}

<style>
	code {
		font-family: var(--font-mono);
		font-size: var(--fs-body);
		overflow-wrap: anywhere;
	}
</style>
