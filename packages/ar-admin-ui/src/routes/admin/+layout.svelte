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
	import { tenantStore } from '$lib/stores/tenants.svelte';
	import { settingsContext } from '$lib/stores/settings-context.svelte';

	let { children }: { children: Snippet } = $props();

	// Tenant selector state — derived from shared store
	let selectedTenantId = $state('');

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

	// END USER section - identity management for application users
	const navEndUser = {
		identity: [
			{ path: '/admin/users', label: 'End Users', icon: 'i-ph-users' },
			{ path: '/admin/sessions', label: 'User Sessions', icon: 'i-ph-clock' },
			{ path: '/admin/organizations', label: 'Organizations', icon: 'i-ph-buildings' }
		],
		accessControl: {
			parent: { href: '/admin/access-control', icon: 'i-ph-shield-star', label: 'Access Control' },
			children: [
				{ href: '/admin/roles', label: 'RBAC (Roles)' },
				{ href: '/admin/attributes', label: 'ABAC (Attributes)' },
				{ href: '/admin/rebac', label: 'ReBAC' },
				{ href: '/admin/policies', label: 'Policies' }
			]
		},
		monitoring: [
			{ path: '/admin/audit-logs', label: 'User Audit Logs', icon: 'i-ph-file-text' },
			{ path: '/admin/access-trace', label: 'Access Trace', icon: 'i-ph-path' },
			{ path: '/admin/diagnostic-logging', label: 'Diagnostic Logging', icon: 'i-ph-bug' }
		]
	};

	// CLIENT section - application/client management
	const navClient = {
		applications: [
			{ path: '/admin/clients', label: 'Clients', icon: 'i-ph-monitor' },
			{ path: '/admin/webhooks', label: 'Webhooks', icon: 'i-ph-webhooks-logo' },
			{ path: '/admin/iat-tokens', label: 'IAT Tokens', icon: 'i-ph-key' }
		]
	};

	// TENANT section - tenant-level configuration
	const navTenant = {
		authentication: [
			{ path: '/admin/external-idp', label: 'External IdP', icon: 'i-ph-globe' },
			{ path: '/admin/consents', label: 'Consents', icon: 'i-ph-handshake' },
			{ path: '/admin/consent-statements', label: 'Consent Statements', icon: 'i-ph-list-checks' },
			{ path: '/admin/flows', label: 'Flows', icon: 'i-ph-flow-arrow' }
		],
		identitySchema: [
			{ path: '/admin/custom-claims', label: 'Schema Settings', icon: 'i-ph-tag' },
			{ path: '/admin/scim-tokens', label: 'SCIM Tokens', icon: 'i-ph-identification-card' }
		],
		branding: [
			{ path: '/admin/login-ui', label: 'Login UI', icon: 'i-ph-paint-brush' },
			{ path: '/admin/tenant-discovery', label: 'Tenant Discovery', icon: 'i-ph-signpost' }
		],
		configuration: [
			{ path: '/admin/info', label: 'Info', icon: 'i-ph-info' },
			{ path: '/admin/settings', label: 'Settings', icon: 'i-ph-gear' },
			{ path: '/admin/plugins', label: 'Plugins', icon: 'i-ph-puzzle-piece' }
		]
	};

	// PLATFORM section - system administration
	const navPlatform = {
		tenantManagement: [{ path: '/admin/tenants', label: 'Tenants', icon: 'i-ph-buildings' }],
		security: [
			{ path: '/admin/security', label: 'Security', icon: 'i-ph-lock-key' },
			{ path: '/admin/compliance', label: 'Compliance', icon: 'i-ph-certificate' }
		],
		operations: [
			{ path: '/admin/scale', label: 'Scale', icon: 'i-ph-chart-bar' },
			{ path: '/admin/jobs', label: 'Jobs', icon: 'i-ph-queue' }
		],
		adminUsers: { path: '/admin/admins', label: 'Admin Users', icon: 'i-ph-user-gear' },
		adminAccessControl: {
			parent: {
				href: '/admin/admin-access-control',
				icon: 'i-ph-shield-star',
				label: 'Admin Access Control'
			},
			children: [
				{ href: '/admin/admin-rbac', label: 'RBAC (Roles)' },
				{ href: '/admin/admin-abac', label: 'ABAC (Attributes)' },
				{ href: '/admin/admin-rebac', label: 'ReBAC' },
				{ href: '/admin/admin-policies', label: 'Policies' }
			]
		},
		adminOthers: [
			{ path: '/admin/ip-allowlist', label: 'IP Allowlist', icon: 'i-ph-shield-check' },
			{ path: '/admin/admin-audit', label: 'Admin Audit Log', icon: 'i-ph-clipboard-text' }
		]
	};

	// All nav items flattened for breadcrumb lookup
	const allNavItems = [
		// End User
		...navEndUser.identity,
		{
			path: navEndUser.accessControl.parent.href,
			label: navEndUser.accessControl.parent.label,
			icon: navEndUser.accessControl.parent.icon
		},
		...navEndUser.accessControl.children.map((c) => ({
			path: c.href,
			label: c.label,
			icon: 'i-ph-arrow-right'
		})),
		...navEndUser.monitoring,
		// Client
		...navClient.applications,
		// Tenant
		...navTenant.authentication,
		...navTenant.identitySchema,
		...navTenant.branding,
		...navTenant.configuration,
		// Platform
		...navPlatform.tenantManagement,
		...navPlatform.security,
		...navPlatform.operations,
		navPlatform.adminUsers,
		{
			path: navPlatform.adminAccessControl.parent.href,
			label: navPlatform.adminAccessControl.parent.label,
			icon: navPlatform.adminAccessControl.parent.icon
		},
		...navPlatform.adminAccessControl.children.map((c) => ({
			path: c.href,
			label: c.label,
			icon: 'i-ph-arrow-right'
		})),
		...navPlatform.adminOthers
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
			return;
		}

		// Load tenant list into the shared store for the header selector
		await tenantStore.load();
		await settingsContext.initialize();
		selectedTenantId = settingsContext.tenantId || tenantStore.defaultTenantId;
	});

	$effect(() => {
		const tenantId = settingsContext.tenantId;
		if (tenantId && tenantId !== selectedTenantId) {
			selectedTenantId = tenantId;
		}
	});

	// Paths that belong to the PLATFORM section (tenant selector should be hidden)
	const PLATFORM_PATHS = [
		'/admin/tenants',
		'/admin/security',
		'/admin/compliance',
		'/admin/scale',
		'/admin/jobs',
		'/admin/admins',
		'/admin/admin-access-control',
		'/admin/admin-rbac',
		'/admin/admin-abac',
		'/admin/admin-rebac',
		'/admin/admin-policies',
		'/admin/ip-allowlist',
		'/admin/admin-audit'
	];

	const isPlatformPage = $derived(PLATFORM_PATHS.some((p) => $page.url.pathname.startsWith(p)));

	async function handleTenantChange(tenantId: string) {
		selectedTenantId = tenantId;
		await settingsContext.setTenantId(tenantId);
	}

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
		<FloatingNav mobileOpen={mobileMenuOpen} onMobileClose={() => (mobileMenuOpen = false)}>
			<!-- Dashboard (above all sections) -->
			<NavItem
				href="/admin"
				icon="i-ph-squares-four"
				label="Dashboard"
				active={isActive('/admin', true)}
			/>

			<!-- END USER Section -->
			<NavSection level="enduser" label="End User">
				<NavGroupLabel label="Identity" />
				{#each navEndUser.identity as item (item.path)}
					<NavItem
						href={item.path}
						icon={item.icon}
						label={item.label}
						active={isActive(item.path)}
					/>
				{/each}

				<NavItemGroup
					parent={navEndUser.accessControl.parent}
					children={navEndUser.accessControl.children}
				/>

				<NavGroupLabel label="Monitoring" />
				{#each navEndUser.monitoring as item (item.path)}
					<NavItem
						href={item.path}
						icon={item.icon}
						label={item.label}
						active={isActive(item.path)}
					/>
				{/each}
			</NavSection>

			<!-- CLIENT Section -->
			<NavSection level="client" label="Client">
				<NavGroupLabel label="Applications" />
				{#each navClient.applications as item (item.path)}
					<NavItem
						href={item.path}
						icon={item.icon}
						label={item.label}
						active={isActive(item.path)}
					/>
				{/each}
			</NavSection>

			<!-- TENANT Section -->
			<NavSection level="tenant" label="Tenant">
				<NavGroupLabel label="Authentication" />
				{#each navTenant.authentication as item (item.path)}
					<NavItem
						href={item.path}
						icon={item.icon}
						label={item.label}
						active={isActive(item.path)}
					/>
				{/each}

				<NavGroupLabel label="Schema Settings" />
				{#each navTenant.identitySchema as item (item.path)}
					<NavItem
						href={item.path}
						icon={item.icon}
						label={item.label}
						active={isActive(item.path)}
					/>
				{/each}

				<NavGroupLabel label="Branding" />
				{#each navTenant.branding as item (item.path)}
					<NavItem
						href={item.path}
						icon={item.icon}
						label={item.label}
						active={isActive(item.path)}
					/>
				{/each}

				<NavGroupLabel label="Configuration" />
				{#each navTenant.configuration as item (item.path)}
					<NavItem
						href={item.path}
						icon={item.icon}
						label={item.label}
						active={isActive(item.path)}
					/>
				{/each}
			</NavSection>

			<!-- PLATFORM Section -->
			<NavSection level="platform" label="Platform">
				<NavGroupLabel label="Tenant Management" />
				{#each navPlatform.tenantManagement as item (item.path)}
					<NavItem
						href={item.path}
						icon={item.icon}
						label={item.label}
						active={isActive(item.path)}
					/>
				{/each}

				<NavGroupLabel label="Security & Compliance" />
				{#each navPlatform.security as item (item.path)}
					<NavItem
						href={item.path}
						icon={item.icon}
						label={item.label}
						active={isActive(item.path)}
					/>
				{/each}

				<NavGroupLabel label="Operations" />
				{#each navPlatform.operations as item (item.path)}
					<NavItem
						href={item.path}
						icon={item.icon}
						label={item.label}
						active={isActive(item.path)}
					/>
				{/each}

				<NavGroupLabel label="Admin Operators" />
				<NavItem
					href={navPlatform.adminUsers.path}
					icon={navPlatform.adminUsers.icon}
					label={navPlatform.adminUsers.label}
					active={isActive(navPlatform.adminUsers.path)}
				/>
				<NavItemGroup
					parent={navPlatform.adminAccessControl.parent}
					children={navPlatform.adminAccessControl.children}
				/>
				{#each navPlatform.adminOthers as item (item.path)}
					<NavItem
						href={item.path}
						icon={item.icon}
						label={item.label}
						active={isActive(item.path)}
					/>
				{/each}
			</NavSection>
		</FloatingNav>

		<!-- Main Content -->
		<main class="main-content">
			<AdminHeader
				breadcrumbs={currentBreadcrumb()}
				tenants={tenantStore.activeTenants}
				{selectedTenantId}
				onTenantChange={handleTenantChange}
				onMobileMenuClick={toggleMobileMenu}
				userEmail={adminAuth.user?.email}
				userName={adminAuth.user?.name}
				lastLoginAt={adminAuth.user?.lastLoginAt}
				hideTenantSelector={isPlatformPage}
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
