<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		mobileOpen?: boolean;
		onMobileClose?: () => void;
		children: Snippet;
	}

	let { mobileOpen = false, onMobileClose, children }: Props = $props();
</script>

<!-- Mobile overlay -->
{#if mobileOpen}
	<button class="mobile-overlay" onclick={onMobileClose} aria-label="Close menu"></button>
{/if}

<nav
	class="nav-floating expanded"
	class:open={mobileOpen}
	aria-label="Main navigation"
>
	<!-- Header with logo -->
	<div class="nav-header">
		<div class="nav-logo">
			<i class="i-ph-stack w-5 h-5 text-white"></i>
		</div>
		<span class="nav-logo-text">Authrim</span>
		{#if mobileOpen}
			<button class="mobile-close-btn" onclick={onMobileClose} aria-label="Close menu">
				<i class="i-ph-x"></i>
			</button>
		{/if}
	</div>

	<!-- Navigation body -->
	<div class="nav-body">
		{@render children()}
	</div>

	<!-- Footer removed - user info is now in the header -->
</nav>

<style>
	/* === Floating Navigation === */
	.nav-floating {
		position: fixed;
		top: 24px;
		left: 24px;
		bottom: 24px;
		width: var(--nav-width-expanded);
		background: var(--bg-nav);
		border-radius: var(--radius-xl);
		display: flex;
		flex-direction: column;
		z-index: var(--z-nav);
		overflow: hidden;
		box-shadow: var(--shadow-lg);
	}

	/* === Nav Header === */
	.nav-header {
		padding: 20px;
		display: flex;
		align-items: center;
		gap: 14px;
		border-bottom: 1px solid var(--nav-border);
	}

	.nav-logo {
		width: 36px;
		height: 36px;
		background: var(--gradient-primary);
		border-radius: var(--radius-md);
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}

	.nav-logo-text {
		font-family: var(--font-display);
		font-weight: 800;
		font-size: 1.25rem;
		color: #ffffff;
		white-space: nowrap;
		opacity: 0;
		transition: opacity var(--transition-base);
	}

	.nav-floating.expanded .nav-logo-text {
		opacity: 1;
	}

	/* === Nav Body === */
	.nav-body {
		flex: 1;
		padding: 16px 12px;
		overflow-y: auto;
		overflow-x: hidden;
		scrollbar-width: none;
		-ms-overflow-style: none;
	}

	.nav-body::-webkit-scrollbar {
		display: none;
	}

	/* Custom scrollbar for expanded state */
	.nav-floating.expanded .nav-body {
		scrollbar-width: thin;
		scrollbar-color: rgba(255, 255, 255, 0.2) transparent;
	}

	.nav-floating.expanded .nav-body::-webkit-scrollbar {
		display: block;
		width: 6px;
	}

	.nav-floating.expanded .nav-body::-webkit-scrollbar-track {
		background: transparent;
	}

	.nav-floating.expanded .nav-body::-webkit-scrollbar-thumb {
		background: rgba(255, 255, 255, 0.2);
		border-radius: 10px;
		transition: background var(--transition-fast);
	}

	.nav-floating.expanded .nav-body::-webkit-scrollbar-thumb:hover {
		background: rgba(255, 255, 255, 0.3);
	}

	/* === Mobile Overlay === */
	.mobile-overlay {
		display: none;
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.5);
		z-index: calc(var(--z-nav) - 1);
		border: none;
		cursor: pointer;
	}

	/* === Mobile Close Button === */
	.mobile-close-btn {
		display: none;
		width: 32px;
		height: 32px;
		border: none;
		background: rgba(255, 255, 255, 0.1);
		border-radius: var(--radius-sm);
		color: var(--text-inverse);
		cursor: pointer;
		align-items: center;
		justify-content: center;
		margin-left: auto;
		transition: background var(--transition-fast);
	}

	.mobile-close-btn:hover {
		background: rgba(255, 255, 255, 0.2);
	}

	.mobile-close-btn :global(i) {
		width: 20px;
		height: 20px;
	}

	/* === Responsive === */
	@media (max-width: 1024px) {
		.nav-floating {
			left: 16px;
			top: 16px;
			bottom: 16px;
		}
	}

	@media (max-width: 768px) {
		.mobile-overlay {
			display: block;
		}

		.mobile-close-btn {
			display: flex;
		}

		.nav-floating {
			transform: translateX(-100%);
			width: var(--nav-width-expanded);
			transition: transform var(--transition-base);
		}

		.nav-floating.open {
			transform: translateX(0);
		}

		.nav-floating.open .nav-logo-text {
			opacity: 1;
		}
	}

	@media (max-width: 480px) {
		.nav-floating {
			left: 0;
			top: 0;
			bottom: 0;
			border-radius: 0;
		}
	}
</style>
