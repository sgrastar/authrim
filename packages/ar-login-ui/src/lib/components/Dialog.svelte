<script lang="ts">
	import { createDialog, melt } from '@melt-ui/svelte';
	import { fade } from 'svelte/transition';

	export let open = false;
	export let title = '';

	const {
		elements: { overlay, content, portalled, close },
		states: { open: dialogOpen }
	} = createDialog({
		defaultOpen: open,
		forceVisible: true
	});

	// Sync external open prop with internal state
	$: dialogOpen.set(open);

	// Sync internal state changes back to external prop
	$: open = $dialogOpen;
</script>

{#if $dialogOpen}
	<div use:melt={$portalled}>
		<div
			use:melt={$overlay}
			class="fixed inset-0 z-40 bg-gray-900/50 backdrop-blur-sm"
			transition:fade={{ duration: 150 }}
		></div>
		<div
			use:melt={$content}
			class="fixed left-1/2 top-1/2 z-50 max-w-md w-full max-h-[85vh] -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white dark:bg-gray-800 shadow-xl"
			transition:fade={{ duration: 150 }}
		>
			<!-- Header -->
			<div class="border-b border-gray-200 dark:border-gray-700 px-6 py-4">
				<h2 class="text-xl font-semibold text-gray-900 dark:text-white">
					{title}
				</h2>
			</div>

			<!-- Content -->
			<div class="px-6 py-4 max-h-[60vh] overflow-y-auto">
				<slot />
			</div>

			<!-- Footer -->
			{#if $$slots.footer}
				<div class="border-t border-gray-200 dark:border-gray-700 px-6 py-4">
					<slot name="footer" />
				</div>
			{/if}

			<!-- Close Button -->
			<button
				use:melt={$close}
				class="absolute right-4 top-4 inline-flex h-8 w-8 appearance-none items-center justify-center rounded-full text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-primary-500"
			>
				<div class="i-heroicons-x-mark h-4 w-4"></div>
				<span class="sr-only">Close</span>
			</button>
		</div>
	</div>
{/if}
