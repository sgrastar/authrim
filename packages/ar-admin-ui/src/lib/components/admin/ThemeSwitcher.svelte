<script lang="ts">
	import { formatAdminSkinName, getAdminSkinSwatch } from '$lib/admin/admin-skins-i18n';
	import { ADMIN_SKINS, themeStore } from '$lib/stores/theme.svelte';
	import { LL } from '$i18n/i18n-svelte';

	interface Props {
		variant?: 'toolbar' | 'menu';
	}

	let { variant = 'toolbar' }: Props = $props();

	function handleThemeToggle() {
		themeStore.toggleMode();
	}

	function handleSkin(skin: (typeof ADMIN_SKINS)[number]['id']) {
		themeStore.setSkin(skin);
	}
</script>

<div class="theme-switcher" data-switcher-variant={variant}>
	{#if variant === 'menu'}
		<div class="theme-switcher__mode-row">
			<span class="theme-switcher__mode-label">
				<i class={themeStore.isLight ? 'i-ph-sun' : 'i-ph-moon'}></i>
				{$LL.admin_header_theme()}
			</span>
			<div class="theme-switcher__mode-buttons">
				<button
					class="theme-switcher__mode-btn"
					class:active={themeStore.isLight}
					data-mode="light"
					aria-pressed={themeStore.isLight}
					onclick={() => themeStore.setMode('light')}
					title={$LL.admin_header_light_mode()}
					aria-label={$LL.admin_header_light_mode()}
				>
					<i class="i-ph-sun"></i>
				</button>
				<button
					class="theme-switcher__mode-btn"
					class:active={themeStore.isDark}
					data-mode="dark"
					aria-pressed={themeStore.isDark}
					onclick={() => themeStore.setMode('dark')}
					title={$LL.admin_header_dark_mode()}
					aria-label={$LL.admin_header_dark_mode()}
				>
					<i class="i-ph-moon"></i>
				</button>
			</div>
		</div>
		<div class="theme-switcher__skin-grid" aria-label={$LL.admin_header_theme()}>
			{#each ADMIN_SKINS as skin (skin.id)}
				<button
					class="theme-switcher__skin-option"
					class:active={themeStore.skin === skin.id}
					data-skin={skin.id}
					aria-pressed={themeStore.skin === skin.id}
					onclick={() => handleSkin(skin.id)}
					title={formatAdminSkinName(skin.id, $LL)}
				>
					<span
						class="theme-switcher__skin-swatch"
						style:--skin-swatch-bg={getAdminSkinSwatch(skin.id)}
					></span>
					<span>{formatAdminSkinName(skin.id, $LL)}</span>
				</button>
			{/each}
		</div>
	{:else}
		<div class="skin-selector" id="admin-skin-selector">
			{#each ADMIN_SKINS as skin (skin.id)}
				<button
					class="header-icon-btn skin-btn"
					class:active={themeStore.skin === skin.id}
					data-skin={skin.id}
					aria-pressed={themeStore.skin === skin.id}
					onclick={() => handleSkin(skin.id)}
					title={formatAdminSkinName(skin.id, $LL)}
					aria-label={formatAdminSkinName(skin.id, $LL)}
				>
					<span class="skin-dot" style:--skin-swatch-bg={getAdminSkinSwatch(skin.id)}></span>
					<span class="skin-label">{formatAdminSkinName(skin.id, $LL)}</span>
				</button>
			{/each}
		</div>

		<button
			class="header-icon-btn theme-toggle"
			onclick={handleThemeToggle}
			data-mode={themeStore.mode}
			aria-pressed={themeStore.isDark}
			title={themeStore.isDark ? $LL.admin_header_light_mode() : $LL.admin_header_dark_mode()}
			aria-label={themeStore.isDark ? $LL.admin_header_light_mode() : $LL.admin_header_dark_mode()}
		>
			{#if themeStore.isDark}
				<i class="i-ph-sun"></i>
			{:else}
				<i class="i-ph-moon"></i>
			{/if}
		</button>
	{/if}
</div>

<style>
	.theme-switcher {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.skin-selector {
		display: flex;
		gap: 4px;
		align-items: center;
		padding: 4px;
		background: var(--color-surface-muted);
		border: 1px solid var(--color-border-subtle, transparent);
		border-radius: var(--radius-control, 8px);
	}

	.header-icon-btn {
		width: 44px;
		height: 44px;
		border: none;
		background: transparent;
		border-radius: var(--radius-md);
		color: var(--color-text-muted);
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all var(--transition-fast);
		position: relative;
		cursor: pointer;
	}

	.header-icon-btn:hover {
		background: var(--color-accent-muted);
		color: var(--color-accent);
		transform: translateY(-2px);
	}

	.header-icon-btn :global(i) {
		width: 22px;
		height: 22px;
		font-size: 22px;
	}

	.skin-btn {
		gap: 6px;
		width: auto !important;
		height: 32px !important;
		padding: 4px 8px !important;
		opacity: 0.5;
	}

	.skin-btn:hover {
		opacity: 0.8;
		transform: none;
	}

	.skin-btn.active {
		opacity: 1;
		background: var(--color-surface) !important;
		box-shadow: inset 0 0 0 1px var(--color-accent);
	}

	.skin-dot {
		width: 16px;
		height: 16px;
		border-radius: var(--radius-xs, 4px);
		display: block;
		border: 1px solid var(--color-border-strong, var(--color-border));
		background: var(--skin-swatch-bg);
	}

	.skin-label {
		max-width: 72px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 0.72rem;
		font-weight: 700;
	}

	.theme-toggle {
		transition: transform 0.3s ease;
	}

	.theme-toggle:active {
		transform: rotate(360deg);
	}

	.theme-switcher[data-switcher-variant='menu'] {
		display: block;
	}

	.theme-switcher__mode-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 10px 16px;
	}

	.theme-switcher__mode-label {
		display: flex;
		align-items: center;
		gap: 12px;
		font-size: 0.875rem;
		color: var(--color-text);
	}

	.theme-switcher__mode-label :global(i) {
		width: 18px;
		height: 18px;
	}

	.theme-switcher__mode-buttons {
		display: flex;
		gap: 4px;
		background: var(--color-surface-muted);
		padding: 3px;
		border-radius: var(--radius-md);
	}

	.theme-switcher__mode-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 28px;
		border: none;
		background: transparent;
		border-radius: var(--radius-sm);
		color: var(--color-text-muted);
		cursor: pointer;
		transition: all var(--transition-fast);
	}

	.theme-switcher__mode-btn:hover {
		color: var(--color-text);
	}

	.theme-switcher__mode-btn.active {
		background: var(--color-surface);
		color: var(--color-accent);
		box-shadow: var(--shadow-sm);
	}

	.theme-switcher__mode-btn :global(i) {
		width: 16px;
		height: 16px;
	}

	.theme-switcher__skin-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(118px, 1fr));
		gap: 8px;
		padding: 12px 16px 16px;
	}

	.theme-switcher__skin-option {
		display: flex;
		align-items: center;
		gap: 7px;
		min-width: 0;
		padding: 8px 9px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control, var(--radius-sm));
		background: var(--color-surface);
		color: var(--color-text-muted);
		font-size: 0.72rem;
		font-weight: 700;
		text-align: left;
		white-space: nowrap;
		cursor: pointer;
	}

	.theme-switcher__skin-option:hover,
	.theme-switcher__skin-option.active {
		border-color: var(--color-accent);
		color: var(--color-text);
	}

	.theme-switcher__skin-option.active {
		box-shadow: inset 0 0 0 1px var(--color-accent);
	}

	.theme-switcher__skin-swatch {
		width: 16px;
		height: 16px;
		border: 1px solid var(--color-border-strong);
		border-radius: var(--radius-xs, 4px);
		flex: none;
		background: var(--skin-swatch-bg);
	}

	/* Responsive */
	@media (max-width: 900px) {
		.skin-selector {
			gap: 2px;
			padding: 2px;
		}

		.skin-btn {
			width: 28px !important;
			height: 28px !important;
			padding: 4px !important;
		}

		.skin-label {
			display: none;
		}
	}

	@media (max-width: 640px) {
		.skin-selector {
			display: none !important;
		}
	}
</style>
