<script lang="ts">
	import { createDialog, melt } from '@melt-ui/svelte';
	import { fade } from 'svelte/transition';
	import { LL } from '$i18n/i18n-svelte';

	const {
		elements: { trigger, overlay, content, title, description, close, portalled },
		states: { open }
	} = createDialog();
</script>

<button use:melt={$trigger} class="btn-primary">{$LL.button_openDialog()}</button>

{#if $open}
	<div use:melt={$portalled}>
		<div
			use:melt={$overlay}
			class="fixed inset-0 z-40 bg-gray-900/50 backdrop-blur-sm"
			transition:fade={{ duration: 150 }}
		></div>
		<div
			use:melt={$content}
			class="fixed left-1/2 top-1/2 z-50 max-w-md w-full max-h-[85vh] -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white dark:bg-gray-800 shadow-xl p-6"
			transition:fade={{ duration: 150 }}
		>
			<h2 use:melt={$title} class="text-xl font-semibold text-gray-900 dark:text-white mb-2">
				{$LL.dialog_title()}
			</h2>
			<p use:melt={$description} class="text-sm text-gray-600 dark:text-gray-400 mb-6">
				{$LL.dialog_description()}
			</p>

			<div class="flex gap-3 justify-end">
				<button use:melt={$close} class="btn-secondary">{$LL.dialog_cancel()}</button>
				<button use:melt={$close} class="btn-primary">{$LL.dialog_confirm()}</button>
			</div>

			<button
				use:melt={$close}
				class="absolute right-4 top-4 inline-flex h-8 w-8 appearance-none items-center justify-center rounded-full text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-primary-500"
			>
				<div class="i-heroicons-x-mark h-4 w-4"></div>
				<span class="sr-only">{$LL.dialog_close()}</span>
			</button>
		</div>
	</div>
{/if}
