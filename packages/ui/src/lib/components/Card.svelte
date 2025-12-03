<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';

	interface Props extends HTMLAttributes<HTMLDivElement> {
		children: Snippet;
		header?: Snippet;
		footer?: Snippet;
	}

	let { children, header, footer, class: className = '', ...restProps }: Props = $props();
</script>

<div class={`card ${className}`} {...restProps}>
	{#if header}
		<div class="border-b border-gray-200 dark:border-gray-700 pb-4 mb-4">
			{@render header()}
		</div>
	{/if}

	<div>
		{@render children()}
	</div>

	{#if footer}
		<div class="border-t border-gray-200 dark:border-gray-700 pt-4 mt-4">
			{@render footer()}
		</div>
	{/if}
</div>
