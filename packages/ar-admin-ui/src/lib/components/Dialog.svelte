<script lang="ts">
	import { LL } from '$i18n/i18n-svelte';
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
		<div use:melt={$overlay} class="dialog-overlay" transition:fade={{ duration: 150 }}></div>
		<div use:melt={$content} class="dialog-content" transition:fade={{ duration: 150 }}>
			<!-- Header -->
			<div class="dialog-header">
				<h2 class="dialog-title">{title}</h2>
			</div>

			<!-- Content -->
			<div class="dialog-body">
				<slot />
			</div>

			<!-- Footer -->
			{#if $$slots.footer}
				<div class="dialog-footer">
					<slot name="footer" />
				</div>
			{/if}

			<!-- Close Button -->
			<button use:melt={$close} class="dialog-close">
				<div class="i-heroicons-x-mark dialog-close-icon"></div>
				<span class="sr-only">{$LL.common_close()}</span>
			</button>
		</div>
	</div>
{/if}

<style>
	.dialog-overlay {
		position: fixed;
		inset: 0;
		z-index: var(--z-modal-backdrop, 40);
		background: var(--modal-overlay-bg, var(--color-overlay-scrim));
		backdrop-filter: var(--modal-overlay-backdrop, blur(var(--overlay-blur, 6px)));
	}

	.dialog-content {
		position: fixed;
		left: 50%;
		top: 50%;
		z-index: var(--z-modal, 50);
		width: min(calc(100vw - 32px), 480px);
		max-height: 85vh;
		overflow: hidden;
		transform: translate(-50%, -50%);
		border: var(--modal-border, 1px solid var(--color-border));
		border-radius: var(--radius-panel, var(--radius-lg, 8px));
		background: var(--modal-bg, var(--color-surface));
		color: var(--color-text);
		box-shadow: var(--modal-shadow, var(--shadow-panel, var(--shadow-xl)));
	}

	.dialog-header {
		padding: var(--modal-dialog-header-padding, 18px 24px 16px);
		border-bottom: var(--modal-header-border-bottom, 1px solid var(--color-border));
	}

	.dialog-title {
		margin: 0;
		padding-right: 36px;
		color: var(--color-heading, var(--color-text));
		font-family: var(--modal-title-font, var(--section-title-font, var(--font-sans, inherit)));
		font-size: var(--modal-title-size, 18px);
		font-weight: var(--modal-title-weight, var(--section-title-weight, 600));
		letter-spacing: var(--modal-title-letter-spacing, var(--section-title-letter-spacing, 0));
		line-height: var(--modal-title-line-height, 1.3);
	}

	.dialog-body {
		max-height: 60vh;
		overflow-y: auto;
		padding: var(--modal-dialog-body-padding, 20px 24px);
	}

	.dialog-footer {
		display: flex;
		justify-content: flex-end;
		gap: var(--modal-footer-gap, 12px);
		padding: var(--modal-dialog-footer-padding, 16px 24px 20px);
		border-top: var(--modal-footer-border-top, 1px solid var(--color-border));
	}

	.dialog-close {
		position: absolute;
		right: 14px;
		top: 14px;
		display: inline-flex;
		width: var(--modal-close-size, 32px);
		height: var(--modal-close-size, 32px);
		align-items: center;
		justify-content: center;
		appearance: none;
		border: 1px solid transparent;
		border-radius: var(--modal-close-radius, var(--radius-control, 6px));
		background: var(--modal-close-bg, transparent);
		color: var(--modal-close-color, var(--color-text-muted));
		cursor: pointer;
		transition:
			background 0.16s ease,
			border-color 0.16s ease,
			color 0.16s ease;
	}

	.dialog-close:hover {
		border-color: var(--color-border);
		background: var(--modal-close-hover-bg, var(--color-surface-muted));
		color: var(--modal-close-hover-color, var(--color-text));
	}

	.dialog-close:focus-visible {
		outline: none;
		border-color: var(--control-focus-border, var(--color-accent));
		box-shadow: var(--control-focus-shadow, 0 0 0 3px var(--color-accent-muted));
	}

	.dialog-close-icon {
		width: 16px;
		height: 16px;
	}
</style>
