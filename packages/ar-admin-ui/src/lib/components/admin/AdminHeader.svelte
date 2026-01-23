<script lang="ts">
	import { adminAuthAPI } from '$lib/api/admin-auth';

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
		lastLoginAt?: number | null;
	}

	let {
		breadcrumbs = [],
		tenants = [],
		selectedTenantId,
		onTenantChange,
		onMobileMenuClick,
		userEmail,
		userName,
		lastLoginAt
	}: Props = $props();

	// User dropdown state
	let showUserMenu = $state(false);

	function toggleUserMenu() {
		showUserMenu = !showUserMenu;
	}

	function closeUserMenu() {
		showUserMenu = false;
	}

	function getInitials(email: string | undefined, name: string | undefined): string {
		if (name) {
			return name
				.split(' ')
				.map((n) => n[0])
				.join('')
				.slice(0, 2)
				.toUpperCase();
		}
		if (email) {
			return email.charAt(0).toUpperCase();
		}
		return 'A';
	}

	function formatLastLogin(timestamp: number | null | undefined): string {
		if (!timestamp) return 'Never';
		const date = new Date(timestamp);
		const now = new Date();
		const diffMs = now.getTime() - date.getTime();
		const diffMins = Math.floor(diffMs / (1000 * 60));
		const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
		const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

		if (diffMins < 1) return 'Just now';
		if (diffMins < 60) return `${diffMins}m ago`;
		if (diffHours < 24) return `${diffHours}h ago`;
		if (diffDays < 7) return `${diffDays}d ago`;
		return date.toLocaleDateString();
	}

	async function handleLogout() {
		await adminAuthAPI.logout();
	}

	function handleTenantChange(event: Event) {
		const select = event.target as HTMLSelectElement;
		onTenantChange?.(select.value);
	}
</script>

<header class="header">
	<div class="header-left">
		<button class="mobile-menu-btn" onclick={onMobileMenuClick} aria-label="Toggle menu">
			<i class="i-ph-list"></i>
		</button>

		{#if breadcrumbs.length > 0}
			<div class="hierarchy-breadcrumb" role="navigation" aria-label="Breadcrumb">
				{#each breadcrumbs as crumb, i (crumb.label)}
					{#if i > 0}
						<span class="hierarchy-sep" aria-hidden="true">/</span>
					{/if}
					{#if crumb.href}
						<a href={crumb.href} class="hierarchy-item" data-level={crumb.level || 'tenant'}>
							{#if crumb.icon}
								<i class={crumb.icon}></i>
							{/if}
							{crumb.label}
						</a>
					{:else}
						<span class="hierarchy-item current" data-level={crumb.level || 'tenant'}>
							{#if crumb.icon}
								<i class={crumb.icon}></i>
							{/if}
							{crumb.label}
						</span>
					{/if}
				{/each}
			</div>
		{/if}
	</div>

	<div class="header-right">
		{#if tenants.length > 0}
			<div class="header-tenant-selector">
				<span class="tenant-selector-label">Tenant:</span>
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
		<div class="header-user">
			<button class="user-button" onclick={toggleUserMenu} aria-expanded={showUserMenu}>
				<div class="user-avatar">{getInitials(userEmail, userName)}</div>
				<div class="user-info">
					<span class="user-email">{userEmail || 'Admin'}</span>
					{#if lastLoginAt}
						<span class="user-last-login">Last login: {formatLastLogin(lastLoginAt)}</span>
					{/if}
				</div>
				<i class="i-ph-caret-down user-caret" class:open={showUserMenu}></i>
			</button>

			{#if showUserMenu}
				<div class="user-menu">
					<div class="user-menu-header">
						<div class="user-avatar-lg">{getInitials(userEmail, userName)}</div>
						<div class="user-menu-info">
							<span class="user-menu-email">{userEmail || 'Admin'}</span>
							{#if lastLoginAt}
								<span class="user-menu-last-login">
									Last login: {new Date(lastLoginAt).toLocaleString()}
								</span>
							{/if}
						</div>
					</div>
					<div class="user-menu-divider"></div>
					<a href="/admin/account-settings" class="user-menu-item" onclick={closeUserMenu}>
						<i class="i-ph-user-circle"></i>
						Account Settings
					</a>
					<button class="user-menu-item danger" onclick={handleLogout}>
						<i class="i-ph-sign-out"></i>
						Logout
					</button>
				</div>
				<button class="user-menu-overlay" onclick={closeUserMenu} aria-label="Close menu"></button>
			{/if}
		</div>
	</div>
</header>

<style>
	.header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 32px;
		padding: 16px 24px;
		background: var(--bg-glass);
		backdrop-filter: var(--blur-md);
		-webkit-backdrop-filter: var(--blur-md);
		border-radius: var(--radius-lg);
		border: 1px solid var(--border-glass);
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
		color: var(--text-secondary);
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

	/* Breadcrumb */
	.hierarchy-breadcrumb {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.hierarchy-item {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 6px 12px;
		border-radius: var(--radius-sm);
		font-size: 0.8125rem;
		font-weight: 500;
		text-decoration: none;
		transition: all var(--transition-fast);
	}

	.hierarchy-item :global(i) {
		width: 14px;
		height: 14px;
		font-size: 14px;
	}

	.hierarchy-item[data-level='system'] {
		background: var(--system-bg);
		color: var(--system-color);
	}

	.hierarchy-item[data-level='tenant'] {
		background: var(--tenant-bg);
		color: var(--tenant-color);
	}

	.hierarchy-item[data-level='client'] {
		background: var(--client-bg);
		color: var(--client-color);
	}

	.hierarchy-item:hover:not(.current) {
		filter: brightness(0.95);
	}

	.hierarchy-item.current {
		font-weight: 600;
	}

	.hierarchy-sep {
		color: var(--text-muted);
		font-size: 0.75rem;
	}

	/* Tenant selector */
	.header-tenant-selector {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 12px;
		background: var(--bg-subtle);
		border-radius: var(--radius-md);
		border: 1px solid var(--border);
	}

	.tenant-selector-label {
		font-size: 0.75rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-muted);
		white-space: nowrap;
	}

	.tenant-selector-dropdown {
		padding: 6px 32px 6px 10px;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background-color: var(--bg-card);
		font-family: var(--font-body);
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--text-primary);
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
		border-color: var(--primary);
		box-shadow: 0 0 0 3px var(--primary-light);
	}

	.tenant-selector-dropdown option {
		background-color: var(--bg-card);
		color: var(--text-primary);
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
		background: var(--bg-subtle);
	}

	.user-avatar {
		width: 36px;
		height: 36px;
		border-radius: var(--radius-full);
		background: var(--gradient-accent);
		display: flex;
		align-items: center;
		justify-content: center;
		color: white;
		font-family: var(--font-display);
		font-weight: 700;
		font-size: 0.875rem;
		flex-shrink: 0;
	}

	.user-info {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 2px;
	}

	.user-email {
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--text-primary);
	}

	.user-last-login {
		font-size: 0.75rem;
		color: var(--text-secondary);
	}

	.user-caret {
		width: 16px;
		height: 16px;
		color: var(--text-secondary);
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
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-lg);
		z-index: 100;
		overflow: hidden;
	}

	.user-menu-header {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 16px;
		background: var(--bg-subtle);
	}

	.user-avatar-lg {
		width: 48px;
		height: 48px;
		border-radius: var(--radius-full);
		background: var(--gradient-accent);
		display: flex;
		align-items: center;
		justify-content: center;
		color: white;
		font-family: var(--font-display);
		font-weight: 700;
		font-size: 1rem;
		flex-shrink: 0;
	}

	.user-menu-info {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 0;
	}

	.user-menu-email {
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--text-primary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.user-menu-last-login {
		font-size: 0.75rem;
		color: var(--text-secondary);
	}

	.user-menu-divider {
		height: 1px;
		background: var(--border);
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
		color: var(--text-primary);
		cursor: pointer;
		transition: background var(--transition-fast);
		text-decoration: none;
	}

	.user-menu-item:hover {
		background: var(--bg-subtle);
	}

	.user-menu-item.danger {
		color: var(--danger);
	}

	.user-menu-item.danger:hover {
		background: var(--danger-subtle);
	}

	.user-menu-item :global(i) {
		width: 18px;
		height: 18px;
	}

	.user-menu-overlay {
		position: fixed;
		inset: 0;
		background: transparent;
		z-index: 99;
		border: none;
		cursor: default;
	}

	/* Responsive */
	@media (max-width: 768px) {
		.header {
			flex-direction: column;
			gap: 16px;
			align-items: stretch;
		}

		.mobile-menu-btn {
			display: flex;
		}

		.hierarchy-breadcrumb {
			display: none;
		}
	}

	@media (max-width: 640px) {
		.header-tenant-selector {
			display: none;
		}

		.header {
			padding: 10px 16px;
			margin-bottom: 16px;
		}
	}
</style>
