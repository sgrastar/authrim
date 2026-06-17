<script lang="ts">
	import { LL } from '$i18n/i18n-svelte';
	import { onMount } from 'svelte';
	import type { Snippet } from 'svelte';

	interface Props {
		/** Whether the modal is open */
		open: boolean;
		/** Callback when modal should close */
		onClose: () => void;
		/** Modal title for accessibility */
		title: string;
		/** Maximum width variant */
		size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
		/** Whether clicking outside closes the modal */
		closeOnOutsideClick?: boolean;
		/** Whether pressing Escape closes the modal */
		closeOnEscape?: boolean;
		/** Header content (optional, uses title if not provided) */
		header?: Snippet;
		/** Body content */
		children: Snippet;
		/** Footer content (optional) */
		footer?: Snippet;
	}

	let {
		open,
		onClose,
		title,
		size = 'md',
		closeOnOutsideClick = true,
		closeOnEscape = true,
		header,
		children,
		footer
	}: Props = $props();

	let dialogEl: HTMLDivElement | null = $state(null);
	const dialogId = `modal-${Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('')}`;
	const titleId = `${dialogId}-title`;

	const sizeStyles: Record<string, string> = {
		sm: 'max-width: 400px;',
		md: 'max-width: 500px;',
		lg: 'max-width: 700px;',
		xl: 'max-width: 900px;',
		full: 'max-width: calc(100vw - 48px); max-height: calc(100vh - 48px);'
	};

	function handleKeyDown(e: KeyboardEvent) {
		if (closeOnEscape && e.key === 'Escape') {
			e.preventDefault();
			onClose();
		}
	}

	function handleOverlayClick() {
		if (closeOnOutsideClick) {
			onClose();
		}
	}

	function handleContentClick(e: MouseEvent) {
		e.stopPropagation();
	}

	function handleContentKeyDown(e: KeyboardEvent) {
		e.stopPropagation();
	}

	// Focus the dialog when opened
	$effect(() => {
		if (open && dialogEl) {
			dialogEl.focus();
		}
	});

	// Prevent body scroll when modal is open
	onMount(() => {
		return () => {
			// Cleanup if component unmounts while open
		};
	});

	$effect(() => {
		if (typeof document !== 'undefined') {
			if (open) {
				document.body.style.overflow = 'hidden';
			} else {
				document.body.style.overflow = '';
			}
		}
	});
</script>

{#if open}
	<div
		bind:this={dialogEl}
		class="modal-overlay"
		role="dialog"
		aria-modal="true"
		aria-labelledby={titleId}
		tabindex="-1"
		onclick={handleOverlayClick}
		onkeydown={handleKeyDown}
	>
		<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
		<div
			class="modal-content"
			style={sizeStyles[size]}
			onclick={handleContentClick}
			onkeydown={handleContentKeyDown}
			role="document"
		>
			<div class="modal-header">
				{#if header}
					{@render header()}
				{:else}
					<h2 id={titleId} class="modal-title">{title}</h2>
					<button
						type="button"
						class="modal-close-btn"
						onclick={onClose}
						aria-label={$LL.common_close()}
					>
						<svg
							width="20"
							height="20"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
						>
							<line x1="18" y1="6" x2="6" y2="18"></line>
							<line x1="6" y1="6" x2="18" y2="18"></line>
						</svg>
					</button>
				{/if}
			</div>

			<div class="modal-body">
				{@render children()}
			</div>

			{#if footer}
				<div class="modal-footer">
					{@render footer()}
				</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	/* Close button in header */
	.modal-close-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: var(--modal-close-size, 32px);
		height: var(--modal-close-size, 32px);
		padding: 0;
		border: none;
		border-radius: var(--modal-close-radius, var(--radius-control, var(--radius-md, 6px)));
		background: var(--modal-close-bg, transparent);
		color: var(--modal-close-color, var(--color-text-muted));
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.modal-close-btn:hover {
		background: var(--modal-close-hover-bg, var(--color-surface-muted));
		color: var(--modal-close-hover-color, var(--color-text));
	}

	.modal-close-btn:focus-visible {
		outline: none;
		box-shadow: var(--control-focus-shadow, 0 0 0 3px var(--color-accent-muted));
	}

	/* Ensure header has space-between for title and close button */
	.modal-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}
</style>
