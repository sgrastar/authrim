<script lang="ts">
	type Props = {
		sanitizedHtml: string;
		tag?: 'span' | 'div';
		class?: string;
	};

	let { sanitizedHtml, tag = 'span', class: className = '' }: Props = $props();
</script>

<!-- eslint-disable svelte/no-at-html-tags -->
<svelte:element this={tag} class={className}>
	{@html sanitizedHtml}
</svelte:element>
<!-- eslint-enable svelte/no-at-html-tags -->
