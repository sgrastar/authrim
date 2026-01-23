<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { adminAuth } from '$lib/stores/admin-auth.svelte';
	import { themeStore } from '$lib/stores/theme.svelte';
	import FloatingNav from '$lib/components/admin/FloatingNav.svelte';
	import NavSection from '$lib/components/admin/NavSection.svelte';
	import NavItem from '$lib/components/admin/NavItem.svelte';
	import NavItemGroup from '$lib/components/admin/NavItemGroup.svelte';
	import NavGroupLabel from '$lib/components/admin/NavGroupLabel.svelte';
	import AdminHeader from '$lib/components/admin/AdminHeader.svelte';
	import type { Snippet } from 'svelte';

	let { children }: { children: Snippet } = $props();

	// Check if current page is login page
	const isLoginPage = $derived($page.url.pathname === '/admin/login');

	// Mobile menu state
	let mobileMenuOpen = $state(false);

	// Close mobile menu on navigation
	$effect(() => {
		// Track pathname changes - assign to unused variable to satisfy linter
		const _currentPath = $page.url.pathname;
		void _currentPath;
		// Close menu when path changes
		mobileMenuOpen = false;
	});

	// Navigation structure - Tenant scope (managed by tenant admins)
	// Note: "End Users" refers to application users (not admin operators)
	const tenantNavItems = {
		// End Users - Identity Management
		endUsers: [
			{ path: '/admin/users', label: 'End Users', icon: 'i-ph-users' },
			{ path: '/admin/sessions', label: 'User Sessions', icon: 'i-ph-clock' },
			{ path: '/admin/organizations', label: 'Organizations', icon: 'i-ph-buildings' }
		],
		// End User Access Control (RBAC/ABAC/ReBAC)
		endUserAccessControl: {
			parent: {
				href: '/admin/access-control',
				icon: 'i-ph-shield-star',
				label: 'Access Control'
			},
			children: [
				{ href: '/admin/roles', label: 'RBAC (Roles)' },
				{ href: '/admin/attributes', label: 'ABAC (Attributes)' },
				{ href: '/admin/rebac', label: 'ReBAC' },
				{ href: '/admin/policies', label: 'Policies' }
			]
		},
		// End User Monitoring
		endUserMonitoring: [
			{ path: '/admin/audit-logs', label: 'User Audit Logs', icon: 'i-ph-file-text' },
			{ path: '/admin/access-trace', label: 'Access Trace', icon: 'i-ph-path' }
		],
		// Applications
		applications: [
			{ path: '/admin/clients', label: 'Clients', icon: 'i-ph-monitor' },
			{ path: '/admin/iat-tokens', label: 'IAT Tokens', icon: 'i-ph-key' },
			{ path: '/admin/webhooks', label: 'Webhooks', icon: 'i-ph-webhooks-logo' }
		],
		// Authentication
		authentication: [
			{ path: '/admin/flows', label: 'Flows', icon: 'i-ph-flow-arrow' },
			{ path: '/admin/external-idp', label: 'External IdP', icon: 'i-ph-globe' }
		],
		// Configuration
		configuration: [
			{ path: '/admin/settings', label: 'Settings', icon: 'i-ph-gear' },
			{ path: '/admin/plugins', label: 'Plugins', icon: 'i-ph-puzzle-piece' }
		]
	};

	// Navigation structure - Platform scope (managed by system admins)
	// Note: Admin management is for admin operators (not end users)
	const platformNavItems = {
		// Identity Schema (SCIM only)
		identitySchema: [
			{ path: '/admin/scim-tokens', label: 'SCIM Tokens', icon: 'i-ph-identification-card' }
		],
		// Security & Compliance
		securityCompliance: [
			{ path: '/admin/security', label: 'Security', icon: 'i-ph-lock-key' },
			{ path: '/admin/compliance', label: 'Compliance', icon: 'i-ph-certificate' }
		],
		// System Operations
		operations: [{ path: '/admin/jobs', label: 'Jobs', icon: 'i-ph-queue' }],
		// Admin Management (Admin operators, not end users)
		adminManagement: [
			{ path: '/admin/admins', label: 'Admin Users', icon: 'i-ph-user-gear' },
			{ path: '/admin/admin-roles', label: 'Admin Roles', icon: 'i-ph-crown' },
			{ path: '/admin/ip-allowlist', label: 'IP Allowlist', icon: 'i-ph-shield-check' },
			{ path: '/admin/admin-audit', label: 'Admin Audit Log', icon: 'i-ph-clipboard-text' }
		]
	};

	// All nav items flattened for breadcrumb lookup
	const allNavItems = [
		// End Users section
		...tenantNavItems.endUsers,
		// End User Access Control Hub parent and children
		{
			path: tenantNavItems.endUserAccessControl.parent.href,
			label: tenantNavItems.endUserAccessControl.parent.label,
			icon: tenantNavItems.endUserAccessControl.parent.icon
		},
		...tenantNavItems.endUserAccessControl.children.map((c) => ({
			path: c.href,
			label: c.label,
			icon: 'i-ph-arrow-right'
		})),
		...tenantNavItems.endUserMonitoring,
		...tenantNavItems.applications,
		...tenantNavItems.authentication,
		...tenantNavItems.configuration,
		// Platform section
		...platformNavItems.identitySchema,
		...platformNavItems.securityCompliance,
		...platformNavItems.operations,
		...platformNavItems.adminManagement
	];

	// Check if nav item is active
	function isActive(path: string, exact: boolean = false): boolean {
		if (exact) {
			return $page.url.pathname === path;
		}
		return $page.url.pathname.startsWith(path);
	}

	// Get current page breadcrumb
	const currentBreadcrumb = $derived(() => {
		const path = $page.url.pathname;
		if (path === '/admin') {
			return [{ label: 'Dashboard', icon: 'i-ph-squares-four', level: 'tenant' as const }];
		}

		// Find matching nav item
		const match = allNavItems.find((item) => path.startsWith(item.path));
		if (match) {
			return [{ label: match.label, icon: match.icon, level: 'tenant' as const }];
		}

		return [{ label: 'Admin', icon: 'i-ph-squares-four', level: 'tenant' as const }];
	});

	onMount(async () => {
		// Initialize theme
		themeStore.init();

		// Capture current path at mount time to avoid race conditions with navigation
		const currentPath = $page.url.pathname;
		const isOnLoginPage = currentPath === '/admin/login';

		// Skip auth check on login page
		if (isOnLoginPage) {
			adminAuth.setLoading(false);
			return;
		}

		// Check authentication status
		await adminAuth.checkAuth();

		// Redirect to login if not authenticated and still on the same page
		if (!adminAuth.isAuthenticated && $page.url.pathname === currentPath) {
			goto('/admin/login');
		}
	});

	function toggleMobileMenu() {
		mobileMenuOpen = !mobileMenuOpen;
	}
</script>

{#if isLoginPage}
	<!-- Login page - no layout chrome -->
	{@render children()}
{:else if adminAuth.isLoading}
	<!-- Loading state -->
	<div class="loading-container">
		<div class="loading-spinner">
			<i class="i-ph-circle-notch animate-spin w-8 h-8"></i>
		</div>
		<p>Loading...</p>
	</div>
{:else if adminAuth.isAuthenticated}
	<!-- Authenticated - layout with floating sidebar -->
	<div class="app-layout">
		<FloatingNav
			userName={adminAuth.user?.email?.split('@')[0] || 'Admin'}
			userRole="Super Admin"
			mobileOpen={mobileMenuOpen}
			onMobileClose={() => (mobileMenuOpen = false)}
		>
			<!-- Tenant Section -->
			<NavSection level="tenant" tenantName="Default">
				<!-- Dashboard -->
				<NavItem
					href="/admin"
					icon="i-ph-squares-four"
					label="Dashboard"
					active={isActive('/admin', true)}
				/>

				<!-- End Users (Application Users) -->
				<NavGroupLabel label="End Users" />
				{#each tenantNavItems.endUsers as item (item.path)}
					<NavItem
						href={item.path}
						icon={item.icon}
						label={item.label}
						active={isActive(item.path)}
					/>
				{/each}

				<!-- End User Access Control (RBAC/ABAC/ReBAC) -->
				<NavItemGroup
					parent={tenantNavItems.endUserAccessControl.parent}
					children={tenantNavItems.endUserAccessControl.children}
				/>

				<!-- End User Monitoring -->
				<NavGroupLabel label="User Monitoring" />
				{#each tenantNavItems.endUserMonitoring as item (item.path)}
					<NavItem
						href={item.path}
						icon={item.icon}
						label={item.label}
						active={isActive(item.path)}
					/>
				{/each}

				<!-- Applications -->
				<NavGroupLabel label="Applications" />
				{#each tenantNavItems.applications as item (item.path)}
					<NavItem
						href={item.path}
						icon={item.icon}
						label={item.label}
						active={isActive(item.path)}
					/>
				{/each}

				<!-- Authentication -->
				<NavGroupLabel label="Authentication" />
				{#each tenantNavItems.authentication as item (item.path)}
					<NavItem
						href={item.path}
						icon={item.icon}
						label={item.label}
						active={isActive(item.path)}
					/>
				{/each}

				<!-- Configuration -->
				<NavGroupLabel label="Configuration" />
				{#each tenantNavItems.configuration as item (item.path)}
					<NavItem
						href={item.path}
						icon={item.icon}
						label={item.label}
						active={isActive(item.path)}
					/>
				{/each}
			</NavSection>

			<!-- Platform Section -->
			<NavSection level="system" label="Platform">
				<!-- Identity Schema -->
				<NavGroupLabel label="Identity Schema" />
				{#each platformNavItems.identitySchema as item (item.path)}
					<NavItem
						href={item.path}
						icon={item.icon}
						label={item.label}
						active={isActive(item.path)}
					/>
				{/each}

				<!-- Security & Compliance -->
				<NavGroupLabel label="Security" />
				{#each platformNavItems.securityCompliance as item (item.path)}
					<NavItem
						href={item.path}
						icon={item.icon}
						label={item.label}
						active={isActive(item.path)}
					/>
				{/each}

				<!-- Operations -->
				<NavGroupLabel label="Operations" />
				{#each platformNavItems.operations as item (item.path)}
					<NavItem
						href={item.path}
						icon={item.icon}
						label={item.label}
						active={isActive(item.path)}
					/>
				{/each}

				<!-- Admin Management (Admin Operators) -->
				<NavGroupLabel label="Admin Operators" />
				{#each platformNavItems.adminManagement as item (item.path)}
					<NavItem
						href={item.path}
						icon={item.icon}
						label={item.label}
						active={isActive(item.path)}
					/>
				{/each}
			</NavSection>

			{#snippet footer()}
				<a href="/admin/account-settings" class="nav-user nav-user-link">
					<div class="nav-user-avatar">
						{(adminAuth.user?.email?.charAt(0) || 'A').toUpperCase()}
					</div>
					<div class="nav-user-info">
						<div class="nav-user-name">{adminAuth.user?.email?.split('@')[0] || 'Admin'}</div>
						<span class="nav-user-role">Preferences</span>
					</div>
				</a>
			{/snippet}
		</FloatingNav>

		<!-- Main Content -->
		<main class="main-content">
			<AdminHeader
				breadcrumbs={currentBreadcrumb()}
				onMobileMenuClick={toggleMobileMenu}
				userEmail={adminAuth.user?.email}
				userName={adminAuth.user?.name}
				lastLoginAt={adminAuth.user?.lastLoginAt}
			/>

			<div class="page-content">
				{@render children()}
			</div>
		</main>
	</div>
{:else}
	<!-- Not authenticated - redirect happens in onMount -->
	<div class="loading-container">
		<p>Redirecting to login...</p>
	</div>
{/if}

<style>
	/* App Layout */
	.app-layout {
		display: flex;
		min-height: 100vh;
	}

	/* Main Content */
	.main-content {
		flex: 1;
		margin-left: calc(var(--nav-width-collapsed) + 48px);
		min-height: 100vh;
		display: flex;
		flex-direction: column;
		padding: 24px 48px 24px 24px;
	}

	.page-content {
		flex: 1;
	}

	/* Loading State */
	.loading-container {
		display: flex;
		flex-direction: column;
		justify-content: center;
		align-items: center;
		height: 100vh;
		gap: 16px;
		color: var(--text-secondary);
	}

	.loading-spinner {
		color: var(--primary);
	}

	/* Nav User Footer Override */
	:global(.nav-user) {
		display: flex;
		align-items: center;
		gap: 12px;
	}

	:global(.nav-user-avatar) {
		width: 40px;
		height: 40px;
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

	:global(.nav-user-info) {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	:global(.nav-user-name) {
		color: var(--text-inverse);
		font-weight: 600;
		font-size: 0.875rem;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	:global(.nav-user-role) {
		color: var(--text-muted);
		font-size: 0.75rem;
	}

	:global(.nav-user-link) {
		text-decoration: none;
		border-radius: var(--radius-md);
		padding: 8px;
		margin: -8px;
		transition: background var(--transition-fast);
	}

	:global(.nav-user-link:hover) {
		background: rgba(255, 255, 255, 0.08);
	}

	/* Responsive */
	@media (max-width: 1024px) {
		.main-content {
			margin-left: calc(var(--nav-width-collapsed) + 32px);
			padding: 20px;
		}
	}

	@media (max-width: 768px) {
		.main-content {
			margin-left: 0;
			padding: 16px;
		}
	}
</style>
