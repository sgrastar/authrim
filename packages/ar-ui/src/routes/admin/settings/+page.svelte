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
		oauth: { icon: '🔐', color: '#3b82f6' },
		session: { icon: '⏱️', color: '#10b981' },
		security: { icon: '🛡️', color: '#ef4444' },
		'rate-limit': { icon: '⚡', color: '#f59e0b' },
		tokens: { icon: '🎫', color: '#8b5cf6' },
		federation: { icon: '🔗', color: '#06b6d4' },
		credentials: { icon: '🔑', color: '#ec4899' },
		consent: { icon: '✅', color: '#22c55e' },
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
		'feature-flags': { icon: '🚩', color: '#dc2626' },
		limits: { icon: '📊', color: '#ea580c' },
		tenant: { icon: '🏢', color: '#4f46e5' },
		vc: { icon: '📜', color: '#059669' },
		assurance: { icon: '🔰', color: '#7c3aed' },
		'check-api-audit': { icon: '📋', color: '#6366f1' }
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
		return categoryStyles[category] || { icon: '⚙️', color: '#6b7280' };
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

<div>
	<!-- Header -->
	<div style="margin-bottom: 24px;">
		<h1 style="font-size: 24px; font-weight: bold; color: #111827; margin: 0 0 8px 0;">Settings</h1>
		<p style="color: #6b7280; margin: 0;">
			Configure system settings, security policies, and feature flags
		</p>
	</div>

	<!-- Scope Selector -->
	<div style="margin-bottom: 24px;">
		<SettingsScopeSelector />
	</div>

	{#if error}
		<div
			style="background-color: #fee2e2; border: 1px solid #ef4444; color: #b91c1c; padding: 12px; border-radius: 6px; margin-bottom: 16px;"
		>
			{error}
		</div>
	{/if}

	{#if loading}
		<div style="display: flex; justify-content: center; padding: 48px;">
			<p style="color: #6b7280;">Loading categories...</p>
		</div>
	{:else}
		<!-- Category Grid -->
		<div
			style="display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px;"
		>
			<!-- Signing Keys (special card) - Tenant scope only -->
			{#if showSigningKeys}
				<a
					href="/admin/settings/signing-keys"
					style="
					background-color: white;
					border: 1px solid #e5e7eb;
					border-radius: 8px;
					padding: 20px;
					text-decoration: none;
					transition: box-shadow 0.2s, border-color 0.2s;
					display: block;
				"
					onmouseenter={(e) => {
						e.currentTarget.style.boxShadow = '0 4px 6px -1px rgba(0, 0, 0, 0.1)';
						e.currentTarget.style.borderColor = '#d1d5db';
					}}
					onmouseleave={(e) => {
						e.currentTarget.style.boxShadow = 'none';
						e.currentTarget.style.borderColor = '#e5e7eb';
					}}
				>
					<div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
						<span style="font-size: 24px;">🔏</span>
						<div>
							<h2 style="font-size: 16px; font-weight: 600; color: #111827; margin: 0;">
								Signing Keys
							</h2>
							<span
								style="font-size: 12px; background-color: #fef3c7; color: #92400e; padding: 2px 6px; border-radius: 4px;"
							>
								Special
							</span>
						</div>
					</div>
					<p style="font-size: 14px; color: #6b7280; margin: 0;">
						Manage JWT signing keys for token issuance and rotation
					</p>
				</a>
			{/if}

			<!-- Sharding Configuration (special card) - Platform scope only -->
			{#if showSharding}
				<a
					href="/admin/settings/sharding"
					style="
					background-color: white;
					border: 1px solid #e5e7eb;
					border-radius: 8px;
					padding: 20px;
					text-decoration: none;
					transition: box-shadow 0.2s, border-color 0.2s;
					display: block;
				"
					onmouseenter={(e) => {
						e.currentTarget.style.boxShadow = '0 4px 6px -1px rgba(0, 0, 0, 0.1)';
						e.currentTarget.style.borderColor = '#d1d5db';
					}}
					onmouseleave={(e) => {
						e.currentTarget.style.boxShadow = 'none';
						e.currentTarget.style.borderColor = '#e5e7eb';
					}}
				>
					<div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
						<span style="font-size: 24px;">🗂️</span>
						<div>
							<h2 style="font-size: 16px; font-weight: 600; color: #111827; margin: 0;">
								Sharding
							</h2>
							<span
								style="font-size: 12px; background-color: #fef3c7; color: #92400e; padding: 2px 6px; border-radius: 4px;"
							>
								Special
							</span>
						</div>
					</div>
					<p style="font-size: 14px; color: #6b7280; margin: 0;">
						Configure shard counts for load distribution
					</p>
				</a>
			{/if}

			<!-- Category Cards (filtered by scope) -->
			{#each filteredCategories as category (category.category)}
				{@const style = getStyle(category.category)}
				{@const isReadOnly = isPlatformCategory(category.category)}
				<a
					href="/admin/settings/{category.category}"
					style="
						background-color: white;
						border: 1px solid #e5e7eb;
						border-radius: 8px;
						padding: 20px;
						text-decoration: none;
						transition: box-shadow 0.2s, border-color 0.2s;
						display: block;
					"
					onmouseenter={(e) => {
						e.currentTarget.style.boxShadow = '0 4px 6px -1px rgba(0, 0, 0, 0.1)';
						e.currentTarget.style.borderColor = '#d1d5db';
					}}
					onmouseleave={(e) => {
						e.currentTarget.style.boxShadow = 'none';
						e.currentTarget.style.borderColor = '#e5e7eb';
					}}
				>
					<div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
						<span style="font-size: 24px;">{style.icon}</span>
						<div>
							<h2 style="font-size: 16px; font-weight: 600; color: #111827; margin: 0;">
								{category.label}
							</h2>
							{#if isReadOnly}
								<span
									style="font-size: 12px; background-color: #f3f4f6; color: #6b7280; padding: 2px 6px; border-radius: 4px;"
								>
									Read-only
								</span>
							{:else}
								<span style="font-size: 12px; color: #6b7280;">
									{category.settingsCount} setting{category.settingsCount !== 1 ? 's' : ''}
								</span>
							{/if}
						</div>
					</div>
					<p style="font-size: 14px; color: #6b7280; margin: 0;">
						{category.description}
					</p>
				</a>
			{/each}
		</div>
	{/if}
</div>
