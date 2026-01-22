<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminSettingsAPI,
		type CategoryMeta,
		PLATFORM_CATEGORIES
	} from '$lib/api/admin-settings';
	import { SettingsScopeSelector } from '$lib/components/admin';
	import { settingsContext, type SettingScopeLevel } from '$lib/stores/settings-context.svelte';

	// Category scope configuration (which categories are available at which scope)
	const CATEGORY_SCOPES: Record<string, SettingScopeLevel[]> = {
		// Platform-only categories
		infrastructure: ['platform'],
		encryption: ['platform'],
		cache: ['platform'],
		// Platform + Tenant
		'rate-limit': ['platform', 'tenant'],
		'feature-flags': ['platform', 'tenant'],
		limits: ['platform', 'tenant'],
		'check-api-audit': ['platform', 'tenant'],
		// Tenant + Client (can be overridden at client level)
		oauth: ['tenant', 'client'],
		security: ['tenant', 'client'],
		consent: ['tenant', 'client'],
		'device-flow': ['tenant', 'client'],
		// Tenant-only
		session: ['tenant'],
		ciba: ['tenant'],
		tokens: ['tenant'],
		'external-idp': ['tenant'],
		credentials: ['tenant'],
		federation: ['tenant'],
		tenant: ['tenant'],
		vc: ['tenant'],
		discovery: ['tenant'],
		plugin: ['tenant'],
		assurance: ['tenant'],
		dcr: ['tenant'], // Dynamic Client Registration (RFC 7591)
		// Client-only
		client: ['client']
	};

	// State
	let categories = $state<CategoryMeta[]>([]);
	let loading = $state(true);
	let error = $state('');

	// Get current scope from context
	let currentScope = $derived(settingsContext.currentLevel);

	// Category icons and colors for visual distinction
	const categoryStyles: Record<string, { icon: string; color: string }> = {
		oauth: { icon: '🔐', color: 'var(--primary)' },
		session: { icon: '⏱️', color: 'var(--success)' },
		security: { icon: '🛡️', color: 'var(--danger)' },
		'rate-limit': { icon: '⚡', color: 'var(--warning)' },
		tokens: { icon: '🎫', color: '#8b5cf6' },
		federation: { icon: '🔗', color: '#06b6d4' },
		credentials: { icon: '🔑', color: '#ec4899' },
		consent: { icon: '✅', color: 'var(--success)' },
		ciba: { icon: '📱', color: '#6366f1' },
		'device-flow': { icon: '📺', color: '#14b8a6' },
		'external-idp': { icon: '🌐', color: '#0ea5e9' },
		client: { icon: '📦', color: '#a855f7' },
		infrastructure: { icon: '🏗️', color: '#64748b' },
		encryption: { icon: '🔒', color: '#71717a' },
		discovery: { icon: '🔍', color: '#0891b2' },
		plugin: { icon: '🧩', color: '#7c3aed' },
		// Additional categories
		cache: { icon: '💾', color: '#0d9488' },
		'feature-flags': { icon: '🚩', color: 'var(--danger)' },
		limits: { icon: '📊', color: '#ea580c' },
		tenant: { icon: '🏢', color: '#4f46e5' },
		vc: { icon: '📜', color: 'var(--success)' },
		assurance: { icon: '🔰', color: '#7c3aed' },
		'check-api-audit': { icon: '📋', color: '#6366f1' },
		// Dynamic Client Registration (RFC 7591)
		dcr: { icon: '📝', color: '#059669' }
	};

	// Check if category is platform-level (read-only)
	function isPlatformCategory(category: string): boolean {
		return PLATFORM_CATEGORIES.includes(category as (typeof PLATFORM_CATEGORIES)[number]);
	}

	// Check if a category is available at the current scope
	function isCategoryAvailableAtScope(category: string, scope: SettingScopeLevel): boolean {
		const allowedScopes = CATEGORY_SCOPES[category];
		if (!allowedScopes) return true; // If not defined, show by default
		return allowedScopes.includes(scope);
	}

	// Filter categories based on current scope
	let filteredCategories = $derived(
		categories.filter((cat) => isCategoryAvailableAtScope(cat.category, currentScope))
	);

	// Check if special cards should be shown
	let showSigningKeys = $derived(currentScope === 'tenant');
	let showSharding = $derived(currentScope === 'platform');

	// Get style for category
	function getStyle(category: string) {
		return categoryStyles[category] || { icon: '⚙️', color: 'var(--text-secondary)' };
	}

	onMount(async () => {
		try {
			// Initialize settings context (for scope)
			await settingsContext.initialize();

			const result = await adminSettingsAPI.getCategories();
			categories = result.categories;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load categories';
		} finally {
			loading = false;
		}
	});
</script>

<svelte:head>
	<title>Settings - Admin Dashboard - Authrim</title>
</svelte:head>

<div class="admin-page">
	<!-- Header -->
	<div class="page-header">
		<div>
			<h1 class="page-title">Settings</h1>
			<p class="page-description">
				Configure system settings, security policies, and feature flags
			</p>
		</div>
	</div>

	<!-- Scope Selector -->
	<div style="margin-bottom: 24px;">
		<SettingsScopeSelector />
	</div>

	{#if error}
		<div class="alert alert-error">{error}</div>
	{/if}

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>Loading categories...</p>
		</div>
	{:else}
		<!-- Category Grid -->
		<div class="icon-grid">
			<!-- Signing Keys (special card) - Tenant scope only -->
			{#if showSigningKeys}
				<a href="/admin/settings/signing-keys" class="icon-card">
					<div class="icon-card-header">
						<span class="icon-card-icon">🔏</span>
						<div>
							<h2 class="icon-card-title">Signing Keys</h2>
							<span
								class="icon-card-badge"
								style="background: var(--warning-light); color: var(--warning);"
							>
								Special
							</span>
						</div>
					</div>
					<p class="icon-card-description">
						Manage JWT signing keys for token issuance and rotation
					</p>
				</a>
			{/if}

			<!-- Sharding Configuration (special card) - Platform scope only -->
			{#if showSharding}
				<a href="/admin/settings/sharding" class="icon-card">
					<div class="icon-card-header">
						<span class="icon-card-icon">🗂️</span>
						<div>
							<h2 class="icon-card-title">Sharding</h2>
							<span
								class="icon-card-badge"
								style="background: var(--warning-light); color: var(--warning);"
							>
								Special
							</span>
						</div>
					</div>
					<p class="icon-card-description">Configure shard counts for load distribution</p>
				</a>
			{/if}

			<!-- Category Cards (filtered by scope) -->
			{#each filteredCategories as category (category.category)}
				{@const style = getStyle(category.category)}
				{@const isReadOnly = isPlatformCategory(category.category)}
				<a href="/admin/settings/{category.category}" class="icon-card">
					<div class="icon-card-header">
						<span class="icon-card-icon">{style.icon}</span>
						<div>
							<h2 class="icon-card-title">{category.label}</h2>
							{#if isReadOnly}
								<span class="icon-card-badge">Read-only</span>
							{:else}
								<span
									class="icon-card-badge"
									style="background: transparent; color: var(--text-muted);"
								>
									{category.settingsCount} setting{category.settingsCount !== 1 ? 's' : ''}
								</span>
							{/if}
						</div>
					</div>
					<p class="icon-card-description">{category.description}</p>
				</a>
			{/each}
		</div>
	{/if}
</div>
