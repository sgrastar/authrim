<script lang="ts">
	import SanitizedHtml from '$lib/components/SanitizedHtml.svelte';
	import { sanitizeFooterHtml } from '$lib/footer/footer-html';

	type Props = {
		value: string | null | undefined;
		class?: string;
	};

	let { value, class: className = '' }: Props = $props();
	let sanitizedHtml = $derived(sanitizeFooterHtml(value));
</script>

{#if sanitizedHtml}
	<p class={className}>
		<SanitizedHtml {sanitizedHtml} />
	</p>
{/if}
