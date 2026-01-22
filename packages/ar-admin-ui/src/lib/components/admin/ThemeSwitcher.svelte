<script lang="ts">
	import { themeStore, LIGHT_VARIANTS, DARK_VARIANTS } from '$lib/stores/theme.svelte';

	function handleThemeToggle() {
		themeStore.toggleMode();
	}

	function handleLightVariant(variant: (typeof LIGHT_VARIANTS)[number]['id']) {
		themeStore.setLightVariant(variant);
	}

	function handleDarkVariant(variant: (typeof DARK_VARIANTS)[number]['id']) {
		themeStore.setDarkVariant(variant);
	}
</script>

<div class="theme-switcher">
	<!-- Light variant selector -->
	{#if themeStore.isLight}
		<div class="variant-selector" id="light-variant-selector">
			{#each LIGHT_VARIANTS as variant (variant.id)}
				<button
					class="header-icon-btn variant-btn"
					class:active={themeStore.lightVariant === variant.id}
					onclick={() => handleLightVariant(variant.id)}
					title={variant.name}
					aria-label={variant.name}
				>
					<span class="variant-dot" style="background: {variant.color}"></span>
				</button>
			{/each}
		</div>
	{/if}

	<!-- Dark variant selector -->
	{#if themeStore.isDark}
		<div class="variant-selector" id="dark-variant-selector">
			{#each DARK_VARIANTS as variant (variant.id)}
				<button
					class="header-icon-btn variant-btn"
					class:active={themeStore.darkVariant === variant.id}
					onclick={() => handleDarkVariant(variant.id)}
					title={variant.name}
					aria-label={variant.name}
				>
					<span class="variant-dot" style="background: {variant.color}"></span>
				</button>
			{/each}
		</div>
	{/if}

	<!-- Theme toggle button -->
	<button
		class="header-icon-btn theme-toggle"
		onclick={handleThemeToggle}
		title={themeStore.isDark ? 'Switch to light mode' : 'Switch to dark mode'}
		aria-label={themeStore.isDark ? 'Switch to light mode' : 'Switch to dark mode'}
	>
		{#if themeStore.isDark}
			<i class="i-ph-sun"></i>
		{:else}
			<i class="i-ph-moon"></i>
		{/if}
	</button>
</div>

<style>
	.theme-switcher {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.variant-selector {
		display: flex;
		gap: 4px;
		align-items: center;
		padding: 4px;
		background: rgba(255, 255, 255, 0.05);
		border-radius: 8px;
	}

	.header-icon-btn {
		width: 44px;
		height: 44px;
		border: none;
		background: transparent;
		border-radius: var(--radius-md);
		color: var(--text-secondary);
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all var(--transition-fast);
		position: relative;
		cursor: pointer;
	}

	.header-icon-btn:hover {
		background: var(--primary-light);
		color: var(--primary);
		transform: translateY(-2px);
	}

	.header-icon-btn :global(i) {
		width: 22px;
		height: 22px;
		font-size: 22px;
	}

	.variant-btn {
		padding: 6px !important;
		min-width: unset !important;
		width: 32px !important;
		height: 32px !important;
		opacity: 0.5;
	}

	.variant-btn:hover {
		opacity: 0.8;
		transform: scale(1.1);
	}

	.variant-btn.active {
		opacity: 1;
		background: rgba(255, 255, 255, 0.1) !important;
		box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.2);
	}

	.variant-dot {
		width: 16px;
		height: 16px;
		border-radius: 4px;
		display: block;
		border: 1px solid rgba(0, 0, 0, 0.1);
	}

	.theme-toggle {
		transition: transform 0.3s ease;
	}

	.theme-toggle:active {
		transform: rotate(360deg);
	}

	/* Responsive */
	@media (max-width: 900px) {
		.variant-selector {
			gap: 2px;
			padding: 2px;
		}

		.variant-btn {
			width: 28px !important;
			height: 28px !important;
			padding: 4px !important;
		}
	}

	@media (max-width: 640px) {
		.variant-selector {
			display: none !important;
		}
	}
</style>
