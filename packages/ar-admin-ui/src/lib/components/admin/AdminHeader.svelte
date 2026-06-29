<script lang="ts">
	import { adminAuthAPI } from '$lib/api/admin-auth';
	import AdminBreadcrumbs from '$lib/components/admin/AdminBreadcrumbs.svelte';
	import ThemeSwitcher from '$lib/components/admin/ThemeSwitcher.svelte';
	import Avatar from '$lib/components/Avatar.svelte';
	import { getLocale, LL, setLocale } from '$i18n/i18n-svelte';
	import { LOCALE_LABELS, SUPPORTED_LOCALES } from '$i18n/locales';
	import type { Locales } from '$i18n/i18n-types';

	interface Breadcrumb {
		label: string;
		href?: string;
		icon?: string;
		level?: 'system' | 'tenant' | 'client';
	}

	interface Props {
		breadcrumbs?: Breadcrumb[];
		tenants?: { id: string; name: string }[];
		selectedTenantId?: string;
		onTenantChange?: (tenantId: string) => void;
		onMobileMenuClick?: () => void;
		userEmail?: string;
		userName?: string;
		userPicture?: string | null;
		userId?: string;
		hideTenantSelector?: boolean;
	}

	let {
		breadcrumbs = [],
		tenants = [],
		selectedTenantId,
		onTenantChange,
		onMobileMenuClick,
		userEmail,
		userName,
		userPicture,
		hideTenantSelector = false
	}: Props = $props();

	// User dropdown state
	let showUserMenu = $state(false);
	let userMenuRoot: HTMLDivElement | undefined = $state();
	let currentLanguage = $state<Locales>(getLocale());
	let languageSaving = $state(false);
	let languageError = $state('');

	function toggleUserMenu() {
		showUserMenu = !showUserMenu;
	}

	function closeUserMenu() {
		showUserMenu = false;
	}

	function handleWindowPointerDown(event: PointerEvent) {
		if (!showUserMenu) return;
		const target = event.target;
		if (target instanceof Node && userMenuRoot?.contains(target)) return;
		closeUserMenu();
	}

	function handleWindowKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') closeUserMenu();
	}

	async function handleLogout() {
		await adminAuthAPI.logout();
	}

	async function handleLanguageChange(event: Event) {
		const select = event.currentTarget as HTMLSelectElement;
		const nextLocale = select.value as Locales;
		const previousLocale = currentLanguage;
		languageError = '';
		languageSaving = true;

		try {
			const response = await fetch('/api/set-language', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ language: nextLocale })
			});
			if (!response.ok) {
				throw new Error('Failed to update language');
			}
			setLocale(nextLocale);
			currentLanguage = nextLocale;
			if (typeof window !== 'undefined') {
				window.location.reload();
			}
		} catch {
			select.value = previousLocale;
			languageError = $LL.language_switch_error();
		} finally {
			languageSaving = false;
		}
	}

	function handleTenantChange(event: Event) {
		const select = event.target as HTMLSelectElement;
		onTenantChange?.(select.value);
	}

	const userDisplayName = $derived(
		userName?.trim() || userEmail?.trim() || $LL.admin_header_admin_fallback()
	);
	const accountSettingsHref = '/admin/account-settings';
</script>

<svelte:window onpointerdown={handleWindowPointerDown} onkeydown={handleWindowKeydown} />

<header class="header">
	<div class="header-left">
		<button
			class="mobile-menu-btn"
			onclick={onMobileMenuClick}
			aria-label={$LL.admin_header_toggle_menu()}
		>
			<i class="i-ph-list"></i>
		</button>

		{#if breadcrumbs.length > 0}
			<AdminBreadcrumbs items={breadcrumbs} />
		{/if}
	</div>

	<div class="header-right">
		{#if tenants.length > 1 && !hideTenantSelector}
			<div class="header-tenant-selector">
				<span class="tenant-selector-label">{$LL.admin_header_tenant()}</span>
				<select
					class="tenant-selector-dropdown"
					value={selectedTenantId}
					onchange={handleTenantChange}
				>
					{#each tenants as tenant (tenant.id)}
						<option value={tenant.id}>{tenant.name}</option>
					{/each}
				</select>
			</div>
		{/if}

		<!-- User Info -->
		<div class="header-user" bind:this={userMenuRoot}>
			<button class="user-button" onclick={toggleUserMenu} aria-expanded={showUserMenu}>
				<Avatar email={userEmail} name={userName} picture={userPicture} size="sm" />
				<div class="user-info">
					<span class="user-email">{userDisplayName}</span>
				</div>
				<i class="i-ph-caret-down user-caret" class:open={showUserMenu}></i>
			</button>

			{#if showUserMenu}
				<div class="user-menu">
					<ThemeSwitcher variant="menu" />
					<div class="user-menu-divider"></div>
					<div class="user-menu-language">
						<label for="admin-header-language" class="user-menu-language__label">
							<i class="i-ph-translate"></i>
							<span>{$LL.admin_account_interface_language()}</span>
						</label>
						<select
							id="admin-header-language"
							class="user-menu-language__select"
							value={currentLanguage}
							aria-label={$LL.language_select_label()}
							aria-invalid={languageError ? 'true' : undefined}
							disabled={languageSaving}
							onchange={handleLanguageChange}
						>
							{#each SUPPORTED_LOCALES as locale (locale)}
								<option value={locale}>
									{LOCALE_LABELS[locale].nativeName} / {LOCALE_LABELS[locale].name}
								</option>
							{/each}
						</select>
						{#if languageError}
							<p class="user-menu-language__error" role="alert">{languageError}</p>
						{/if}
					</div>
					<div class="user-menu-divider"></div>
					<a href={accountSettingsHref} class="user-menu-item" onclick={closeUserMenu}>
						<i class="i-ph-user-circle"></i>
						{$LL.admin_header_account_settings()}
					</a>
					<button class="user-menu-item danger" onclick={handleLogout}>
						<i class="i-ph-sign-out"></i>
						{$LL.admin_header_logout()}
					</button>
				</div>
				<button
					class="user-menu-overlay"
					onclick={closeUserMenu}
					aria-label={$LL.admin_header_close_menu()}
				></button>
			{/if}
		</div>
	</div>
</header>

<style>
	.header {
		position: sticky;
		top: 0;
		z-index: var(--z-sticky);
		display: flex;
		align-items: center;
		justify-content: space-between;
		min-height: var(--header-height);
		padding: var(--header-padding, 14px 32px);
		background: var(--header-bg, var(--color-bg-page));
		backdrop-filter: var(--header-backdrop, none);
		-webkit-backdrop-filter: var(--header-backdrop, none);
		border-bottom: var(--header-border, 1px solid var(--color-border));
		border-radius: var(--header-radius, 0);
		box-shadow: var(--header-shadow, none);
		box-sizing: border-box;
	}

	.header-left {
		display: flex;
		align-items: center;
		gap: 20px;
	}

	.header-right {
		display: flex;
		align-items: center;
		gap: 16px;
	}

	/* Mobile menu button */
	.mobile-menu-btn {
		display: none;
		width: 40px;
		height: 40px;
		border: none;
		background: transparent;
		color: var(--color-text-muted);
		cursor: pointer;
		border-radius: var(--radius-md);
		align-items: center;
		justify-content: center;
	}

	.mobile-menu-btn :global(i) {
		width: 24px;
		height: 24px;
		font-size: 24px;
	}

	/* Tenant selector */
	.header-tenant-selector {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 12px;
		background: var(--color-surface-muted);
		border-radius: var(--radius-md);
		border: 1px solid var(--color-border);
	}

	.tenant-selector-label {
		font-size: 0.75rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--color-text-subtle);
		white-space: nowrap;
	}

	.tenant-selector-dropdown {
		padding: 6px 32px 6px 10px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		background-color: var(--color-surface);
		font-family: var(--font-body);
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--color-text);
		cursor: pointer;
		transition: all var(--transition-fast);
		outline: none;
		appearance: none;
		background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%239ca3af' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
		background-repeat: no-repeat;
		background-position: right 8px center;
		min-width: 160px;
		max-width: 250px;
	}

	.tenant-selector-dropdown:hover,
	.tenant-selector-dropdown:focus {
		border-color: var(--color-accent);
		box-shadow: var(--control-focus-shadow, 0 0 0 3px var(--color-accent-muted));
	}

	.tenant-selector-dropdown option {
		background-color: var(--color-surface);
		color: var(--color-text);
	}

	/* Header User */
	.header-user {
		position: relative;
	}

	.user-button {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 8px 12px;
		background: transparent;
		border: none;
		border-radius: var(--radius-md);
		cursor: pointer;
		transition: all var(--transition-fast);
	}

	.user-button:hover {
		background: var(--color-surface-muted);
	}

	.user-info {
		display: flex;
		align-items: center;
		min-width: 0;
	}

	.user-email {
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--color-text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.user-caret {
		width: 16px;
		height: 16px;
		color: var(--color-text-muted);
		transition: transform var(--transition-fast);
	}

	.user-caret.open {
		transform: rotate(180deg);
	}

	/* User Menu Dropdown */
	.user-menu {
		position: absolute;
		top: calc(100% + 8px);
		right: 0;
		width: 280px;
		background: var(--user-menu-bg, var(--color-surface));
		backdrop-filter: var(--user-menu-backdrop, var(--header-backdrop, none));
		-webkit-backdrop-filter: var(--user-menu-backdrop, var(--header-backdrop, none));
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-lg);
		z-index: 1000;
		overflow: hidden;
	}

	.user-menu-divider {
		height: 1px;
		background: var(--color-border);
	}

	.user-menu-language {
		display: grid;
		gap: 8px;
		padding: 12px 16px;
	}

	.user-menu-language__label {
		display: flex;
		align-items: center;
		gap: 12px;
		color: var(--color-text);
		font-size: 0.875rem;
	}

	.user-menu-language__label :global(i) {
		width: 18px;
		height: 18px;
		color: var(--color-text-muted);
	}

	.user-menu-language__select {
		width: 100%;
		padding: 8px 32px 8px 10px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		background-color: var(--color-surface);
		color: var(--color-text);
		font: inherit;
		cursor: pointer;
		outline: none;
	}

	.user-menu-language__select:hover,
	.user-menu-language__select:focus {
		border-color: var(--color-accent);
		box-shadow: var(--control-focus-shadow, 0 0 0 3px var(--color-accent-muted));
	}

	.user-menu-language__error {
		margin: 0;
		color: var(--color-danger);
		font-size: 0.78rem;
	}

	.user-menu-item {
		display: flex;
		align-items: center;
		gap: 12px;
		width: 100%;
		padding: 12px 16px;
		background: transparent;
		border: none;
		font-size: 0.875rem;
		color: var(--color-text);
		cursor: pointer;
		transition: background var(--transition-fast);
		text-decoration: none;
	}

	.user-menu-item:hover {
		background: var(--color-surface-muted);
	}

	.user-menu-item.danger {
		color: var(--color-danger);
	}

	.user-menu-item.danger:hover {
		background: color-mix(in srgb, var(--color-danger) 10%, transparent);
	}

	.user-menu-item :global(i) {
		width: 18px;
		height: 18px;
	}

	.user-menu-overlay {
		position: fixed;
		inset: 0;
		background: transparent;
		z-index: 999;
		border: none;
		cursor: default;
	}

	/* Responsive */
	@media (max-width: 768px) {
		.header {
			gap: 16px;
			align-items: center;
		}

		.mobile-menu-btn {
			display: flex;
		}

		:global(.admin-breadcrumbs) {
			display: none;
		}
	}

	@media (max-width: 640px) {
		.header-tenant-selector {
			display: none;
		}

		.header {
			padding: 10px 16px;
		}
	}
</style>
