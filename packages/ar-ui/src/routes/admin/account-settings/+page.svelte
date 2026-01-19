<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import {
		themeStore,
		LIGHT_VARIANTS,
		DARK_VARIANTS,
		type LightVariant,
		type DarkVariant
	} from '$lib/stores/theme.svelte';
	import { adminAuth } from '$lib/stores/admin-auth.svelte';
	import { adminAuthAPI } from '$lib/api/admin-auth';

	// Available languages (for future expansion)
	const LANGUAGES = [
		{ id: 'en', name: 'English' },
		{ id: 'ja', name: '日本語', disabled: true },
		{ id: 'ko', name: '한국어', disabled: true },
		{ id: 'zh', name: '中文', disabled: true }
	];

	// State
	let selectedLanguage = $state('en');

	function handleLightVariant(variant: LightVariant) {
		themeStore.setLightVariant(variant);
	}

	function handleDarkVariant(variant: DarkVariant) {
		themeStore.setDarkVariant(variant);
	}

	function handleLanguageChange(event: Event) {
		const target = event.target as HTMLSelectElement;
		selectedLanguage = target.value;
		// TODO: Implement language switching when translations are ready
	}

	async function handleLogout() {
		adminAuth.clearAuth();
		await adminAuthAPI.logout();
		goto('/admin/login');
	}

	onMount(() => {
		// Theme is already initialized in +layout.svelte
	});
</script>

<svelte:head>
	<title>Account Settings - Admin Dashboard - Authrim</title>
</svelte:head>

<div class="admin-page">
	<!-- Header -->
	<div class="page-header">
		<div>
			<h1 class="page-title">Account Settings</h1>
			<p class="page-description">Customize your admin dashboard experience</p>
		</div>
	</div>

	<!-- Settings Sections -->
	<div class="settings-container">
		<!-- Appearance Section -->
		<section class="settings-section">
			<h2 class="section-title">
				<i class="i-ph-paint-brush"></i>
				Appearance
			</h2>

			<div class="settings-card">
				<!-- Theme Mode -->
				<div class="setting-row">
					<div class="setting-info">
						<h3 class="setting-label">Theme Mode</h3>
						<p class="setting-description">Choose between light and dark mode</p>
					</div>
					<div class="theme-mode-toggle">
						<button
							class="mode-btn"
							class:active={themeStore.isLight}
							onclick={() => themeStore.setMode('light')}
						>
							<i class="i-ph-sun"></i>
							<span>Light</span>
							{#if themeStore.isLight}
								<i class="i-ph-check-circle-fill mode-check"></i>
							{/if}
						</button>
						<button
							class="mode-btn"
							class:active={themeStore.isDark}
							onclick={() => themeStore.setMode('dark')}
						>
							<i class="i-ph-moon"></i>
							<span>Dark</span>
							{#if themeStore.isDark}
								<i class="i-ph-check-circle-fill mode-check"></i>
							{/if}
						</button>
					</div>
				</div>

				<!-- Theme Color Variants (shows only relevant variants based on current mode) -->
				<div class="setting-row setting-row-vertical">
					<div class="setting-info">
						<h3 class="setting-label">Theme Color</h3>
						<p class="setting-description">
							{#if themeStore.isLight}
								Select your preferred light theme color
							{:else}
								Select your preferred dark theme color
							{/if}
						</p>
					</div>
					<div class="color-variant-options">
						{#if themeStore.isLight}
							{#each LIGHT_VARIANTS as variant (variant.id)}
								<button
									class="color-variant-btn"
									class:active={themeStore.lightVariant === variant.id}
									onclick={() => handleLightVariant(variant.id)}
									title={variant.name}
								>
									<span class="color-swatch" style="background: {variant.color}"></span>
									<span class="color-name">{variant.name}</span>
									{#if themeStore.lightVariant === variant.id}
										<i class="i-ph-check color-check"></i>
									{/if}
								</button>
							{/each}
						{:else}
							{#each DARK_VARIANTS as variant (variant.id)}
								<button
									class="color-variant-btn"
									class:active={themeStore.darkVariant === variant.id}
									onclick={() => handleDarkVariant(variant.id)}
									title={variant.name}
								>
									<span class="color-swatch" style="background: {variant.color}"></span>
									<span class="color-name">{variant.name}</span>
									{#if themeStore.darkVariant === variant.id}
										<i class="i-ph-check color-check"></i>
									{/if}
								</button>
							{/each}
						{/if}
					</div>
				</div>
			</div>
		</section>

		<!-- Language Section -->
		<section class="settings-section">
			<h2 class="section-title">
				<i class="i-ph-translate"></i>
				Language & Region
			</h2>

			<div class="settings-card">
				<div class="setting-row">
					<div class="setting-info">
						<h3 class="setting-label">Interface Language</h3>
						<p class="setting-description">Select your preferred language for the admin interface</p>
					</div>
					<select class="language-select" value={selectedLanguage} onchange={handleLanguageChange}>
						{#each LANGUAGES as lang (lang.id)}
							<option value={lang.id} disabled={lang.disabled}>
								{lang.name}
								{#if lang.disabled}(Coming soon){/if}
							</option>
						{/each}
					</select>
				</div>
			</div>
		</section>

		<!-- Account Section -->
		<section class="settings-section">
			<h2 class="section-title">
				<i class="i-ph-user-circle"></i>
				Account
			</h2>

			<div class="settings-card">
				<div class="setting-row">
					<div class="setting-info">
						<h3 class="setting-label">Logged in as</h3>
						<p class="setting-description">{adminAuth.user?.email || 'Unknown'}</p>
					</div>
					<button class="logout-btn" onclick={handleLogout}>
						<i class="i-ph-sign-out"></i>
						Logout
					</button>
				</div>
			</div>
		</section>
	</div>
</div>

<style>
	.settings-container {
		display: flex;
		flex-direction: column;
		gap: 32px;
	}

	.settings-section {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.section-title {
		display: flex;
		align-items: center;
		gap: 10px;
		font-size: 1.125rem;
		font-weight: 600;
		color: var(--text-primary);
		margin: 0;
	}

	.section-title :global(i) {
		width: 22px;
		height: 22px;
		color: var(--primary);
	}

	.settings-card {
		background: var(--bg-card);
		border-radius: var(--radius-lg);
		border: 1px solid var(--border-light);
		overflow: hidden;
	}

	.setting-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 20px 24px;
		border-bottom: 1px solid var(--border-light);
		gap: 24px;
	}

	.setting-row:last-child {
		border-bottom: none;
	}

	.setting-row-vertical {
		flex-direction: column;
		align-items: flex-start;
		gap: 16px;
	}

	.setting-info {
		flex: 1;
		min-width: 0;
	}

	.setting-label {
		font-size: 0.9375rem;
		font-weight: 600;
		color: var(--text-primary);
		margin: 0 0 4px 0;
	}

	.setting-description {
		font-size: 0.8125rem;
		color: var(--text-secondary);
		margin: 0;
	}

	/* Theme Mode Toggle */
	.theme-mode-toggle {
		display: flex;
		gap: 8px;
		background: var(--bg-tertiary);
		padding: 4px;
		border-radius: var(--radius-md);
	}

	.mode-btn {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 16px;
		border: none;
		background: transparent;
		border-radius: var(--radius-sm);
		color: var(--text-secondary);
		font-size: 0.875rem;
		font-weight: 500;
		cursor: pointer;
		transition: all var(--transition-fast);
	}

	.mode-btn:hover {
		color: var(--text-primary);
	}

	.mode-btn.active {
		background: var(--bg-card);
		color: var(--primary);
		box-shadow: var(--shadow-sm);
	}

	.mode-btn :global(i) {
		width: 18px;
		height: 18px;
	}

	.mode-btn :global(.mode-check) {
		color: var(--success);
		margin-left: 4px;
	}

	/* Color Variant Options - unique class names to avoid conflicts with themes.css */
	.color-variant-options {
		display: flex;
		gap: 12px;
		flex-wrap: wrap;
	}

	.color-variant-btn {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		padding: 16px 20px;
		border: 2px solid var(--border-light);
		background: var(--bg-tertiary);
		border-radius: var(--radius-md);
		cursor: pointer;
		transition: all var(--transition-fast);
		min-width: 100px;
		position: relative;
	}

	.color-variant-btn:hover {
		border-color: var(--primary-light);
		background: var(--bg-card);
	}

	.color-variant-btn.active {
		border-color: var(--primary);
		background: var(--bg-card);
	}

	.color-swatch {
		display: block;
		width: 40px;
		height: 40px;
		border-radius: var(--radius-md);
		border: 1px solid rgba(0, 0, 0, 0.1);
		flex-shrink: 0;
	}

	.color-name {
		font-size: 0.8125rem;
		color: var(--text-secondary);
		text-align: center;
		white-space: nowrap;
	}

	.color-variant-btn.active .color-name {
		color: var(--primary);
		font-weight: 600;
	}

	.color-variant-btn :global(.color-check) {
		position: absolute;
		top: 8px;
		right: 8px;
		width: 18px;
		height: 18px;
		color: var(--primary);
	}

	/* Language Select */
	.language-select {
		padding: 10px 40px 10px 16px;
		border: 1px solid var(--border-light);
		border-radius: var(--radius-md);
		background: var(--bg-card);
		color: var(--text-primary);
		font-size: 0.875rem;
		cursor: pointer;
		appearance: none;
		background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23666' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
		background-repeat: no-repeat;
		background-position: right 12px center;
		min-width: 180px;
	}

	.language-select:focus {
		outline: none;
		border-color: var(--primary);
	}

	.language-select option:disabled {
		color: var(--text-muted);
	}

	/* Logout Button */
	.logout-btn {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 20px;
		border: 1px solid var(--danger);
		background: transparent;
		border-radius: var(--radius-md);
		color: var(--danger);
		font-size: 0.875rem;
		font-weight: 500;
		cursor: pointer;
		transition: all var(--transition-fast);
	}

	.logout-btn:hover {
		background: var(--danger);
		color: white;
	}

	.logout-btn :global(i) {
		width: 18px;
		height: 18px;
	}

	/* Responsive */
	@media (max-width: 640px) {
		.setting-row {
			flex-direction: column;
			align-items: flex-start;
			gap: 16px;
		}

		.theme-mode-toggle,
		.color-variant-options {
			width: 100%;
		}

		.mode-btn {
			flex: 1;
			justify-content: center;
		}

		.color-variant-btn {
			flex: 1;
			min-width: 80px;
			padding: 12px 16px;
		}

		.color-swatch {
			width: 32px;
			height: 32px;
		}

		.language-select {
			width: 100%;
		}

		.logout-btn {
			width: 100%;
			justify-content: center;
		}
	}
</style>
