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
	import { adminLoggingControlAPI } from '$lib/api/admin-logging-control';
	import { LL } from '$i18n/i18n-svelte';

	let { children }: { children: Snippet } = $props();

	// Tenant selector state — derived from shared store
	let selectedTenantId = $state('');

	// Check if current page is login page
	const isLoginPage = $derived($page.url.pathname === '/admin/login');

	// Mobile menu state
	let mobileMenuOpen = $state(false);
	let adminContextReady = $state(false);
	let adminContextPromise: Promise<void> | null = null;
	let loggingAlertCount = $state(0);
	let notificationAlertCount = $state(0);

	// Close mobile menu on navigation
	$effect(() => {
		// Track pathname changes - assign to unused variable to satisfy linter
		const _currentPath = $page.url.pathname;
		void _currentPath;
		// Close menu when path changes
		mobileMenuOpen = false;
	});

	// END USER section - identity management for application users
	const navEndUser = $derived({
		identity: [
			{ path: '/admin/users', label: $LL.admin_nav_end_users(), icon: 'i-ph-users' },
			{ path: '/admin/sessions', label: $LL.admin_nav_user_sessions(), icon: 'i-ph-clock' },
			{ path: '/admin/organizations', label: $LL.admin_nav_organizations(), icon: 'i-ph-buildings' }
		],
		accessControl: {
			parent: {
				href: '/admin/access-control',
				icon: 'i-ph-shield-star',
				label: $LL.admin_nav_access_control()
			},
			children: [
				{ href: '/admin/roles', label: $LL.admin_nav_rbac_roles() },
				{ href: '/admin/attributes', label: $LL.admin_nav_abac_attributes() },
				{ href: '/admin/rebac', label: $LL.admin_nav_rebac() },
				{ href: '/admin/policies', label: $LL.admin_nav_policies() }
			]
		},
		monitoring: [
			{ path: '/admin/audit-logs', label: $LL.admin_nav_user_audit_logs(), icon: 'i-ph-file-text' },
			{ path: '/admin/access-trace', label: $LL.admin_nav_access_trace(), icon: 'i-ph-path' },
			{ path: '/admin/support-ops', label: $LL.admin_nav_support_ops(), icon: 'i-ph-lifebuoy' },
			{
				path: '/admin/diagnostic-logging',
				label: $LL.admin_nav_diagnostic_logging(),
				icon: 'i-ph-bug'
			}
		]
	});

	// CLIENT section - application/client management
	const navClient = $derived({
		applications: [
			{ path: '/admin/clients', label: $LL.admin_nav_clients(), icon: 'i-ph-monitor' },
			{ path: '/admin/webhooks', label: $LL.admin_nav_webhooks(), icon: 'i-ph-webhooks-logo' },
			{ path: '/admin/iat-tokens', label: $LL.admin_nav_iat_tokens(), icon: 'i-ph-key' }
		]
	});

	// TENANT section - tenant-level configuration
	const navTenant = $derived({
		authentication: [
			{ path: '/admin/external-idp', label: $LL.admin_nav_external_idp(), icon: 'i-ph-globe' },
			{
				path: '/admin/external-token-refresh',
				label: $LL.admin_nav_token_refresh(),
				icon: 'i-ph-arrows-clockwise'
			},
			{ path: '/admin/saml', label: $LL.admin_nav_saml(), icon: 'i-ph-arrows-left-right' },
			{ path: '/admin/consents', label: $LL.admin_nav_consents(), icon: 'i-ph-handshake' },
			{
				path: '/admin/consent-statements',
				label: $LL.admin_nav_consent_statements(),
				icon: 'i-ph-list-checks'
			}
		],
		identitySchema: [
			{ path: '/admin/custom-claims', label: $LL.admin_nav_schema_settings(), icon: 'i-ph-tag' },
			{
				path: '/admin/scim-tokens',
				label: $LL.admin_nav_scim_tokens(),
				icon: 'i-ph-identification-card'
			}
		],
		identityMapping: {
			parent: {
				href: '/admin/identity-mapping',
				icon: 'i-ph-graph',
				label: $LL.admin_nav_identity_mapping()
			},
			children: [
				{ href: '/admin/identity-mapping/profiles', label: $LL.admin_nav_source_destination() },
				{
					href: '/admin/identity-mapping/mapping-policies',
					label: $LL.admin_nav_mapping_policies()
				},
				{
					href: '/admin/identity-mapping/resolution-center',
					label: $LL.admin_nav_resolution_center()
				}
			]
		},
		branding: [
			{ path: '/admin/login-methods', label: $LL.admin_nav_login_methods(), icon: 'i-ph-sign-in' },
			{ path: '/admin/login-ui', label: $LL.admin_nav_login_ui(), icon: 'i-ph-paint-brush' },
			{
				path: '/admin/tenant-discovery',
				label: $LL.admin_nav_tenant_discovery(),
				icon: 'i-ph-signpost'
			}
		],
		configuration: [
			{ path: '/admin/info', label: $LL.admin_nav_info(), icon: 'i-ph-info' },
			{ path: '/admin/settings', label: $LL.admin_nav_settings(), icon: 'i-ph-gear' },
			{
				path: '/admin/email-settings',
				label: $LL.admin_nav_email_settings(),
				icon: 'i-ph-envelope-simple'
			},
			{ path: '/admin/plugins', label: $LL.admin_nav_plugins(), icon: 'i-ph-puzzle-piece' }
		]
	});

	// PLATFORM section - system administration
	const navPlatform = $derived({
		tenantManagement: [
			{ path: '/admin/tenants', label: $LL.admin_nav_tenants(), icon: 'i-ph-buildings' },
			{
				path: '/admin/tenant-vanity-domains',
				label: $LL.admin_nav_vanity_domains(),
				icon: 'i-ph-globe'
			}
		],
		security: [
			{ path: '/admin/security', label: $LL.admin_nav_security(), icon: 'i-ph-lock-key' },
			{ path: '/admin/compliance', label: $LL.admin_nav_compliance(), icon: 'i-ph-certificate' }
		],
		operations: [
			{ path: '/admin/scale', label: $LL.admin_nav_scale(), icon: 'i-ph-chart-bar' },
			{
				path: '/admin/storage-destinations',
				label: $LL.admin_nav_storage_destinations(),
				icon: 'i-ph-archive'
			},
			{
				path: '/admin/logging-policies',
				label: $LL.admin_nav_logging_policies(),
				icon: 'i-ph-list-magnifying-glass'
			},
			{
				path: '/admin/notifications',
				label: $LL.admin_nav_notification_center(),
				icon: 'i-ph-bell'
			},
			{
				path: '/admin/database-connections',
				label: $LL.admin_nav_database_connections(),
				icon: 'i-ph-database'
			},
			{ path: '/admin/dr-backup', label: $LL.admin_nav_dr_backup(), icon: 'i-ph-cloud-arrow-up' },
			{ path: '/admin/jobs', label: $LL.admin_nav_jobs(), icon: 'i-ph-queue' },
			{ path: '/admin/approvals', label: $LL.admin_nav_approvals(), icon: 'i-ph-checks' }
		],
		adminUsers: {
			path: '/admin/admins',
			label: $LL.admin_nav_admin_users(),
			icon: 'i-ph-user-gear'
		},
		adminAccessControl: {
			parent: {
				href: '/admin/admin-access-control',
				icon: 'i-ph-shield-star',
				label: $LL.admin_nav_admin_access_control()
			},
			children: [
				{ href: '/admin/admin-rbac', label: $LL.admin_nav_rbac_roles() },
				{ href: '/admin/admin-abac', label: $LL.admin_nav_abac_attributes() },
				{ href: '/admin/admin-rebac', label: $LL.admin_nav_rebac() },
				{ href: '/admin/admin-policies', label: $LL.admin_nav_policies() }
			]
		},
		adminOthers: [
			{ path: '/admin/machine-access', label: $LL.admin_nav_machine_access(), icon: 'i-ph-robot' },
			{
				path: '/admin/ip-allowlist',
				label: $LL.admin_nav_ip_allowlist(),
				icon: 'i-ph-shield-check'
			},
			{ path: '/admin/admin-logging', label: $LL.admin_nav_admin_logging(), icon: 'i-ph-activity' },
			{
				path: '/admin/admin-audit',
				label: $LL.admin_nav_admin_audit_log(),
				icon: 'i-ph-clipboard-text'
			},
			{
				path: '/admin/operational-logs',
				label: $LL.admin_nav_operational_logs(),
				icon: 'i-ph-scroll'
			}
		]
	});

	// All nav items flattened for breadcrumb lookup
	const allNavItems = $derived([
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
		{
			path: navTenant.identityMapping.parent.href,
			label: navTenant.identityMapping.parent.label,
			icon: navTenant.identityMapping.parent.icon
		},
		...navTenant.identityMapping.children.map((c) => ({
			path: c.href,
			label: c.label,
			icon: 'i-ph-arrow-right'
		})),
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
	]);

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
			return [
				{ label: $LL.admin_nav_dashboard(), icon: 'i-ph-squares-four', level: 'tenant' as const }
			];
		}

		// Find matching nav item
		const match = allNavItems.find((item) => path.startsWith(item.path));
		if (match) {
			return [{ label: match.label, icon: match.icon, level: 'tenant' as const }];
		}

		return [
			{
				label: $LL.admin_header_admin_fallback(),
				icon: 'i-ph-squares-four',
				level: 'tenant' as const
			}
		];
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

		await ensureAdminContextReady();
		await loadLoggingAlertBadge();
	});

	$effect(() => {
		const tenantId = settingsContext.tenantId;
		if (tenantId && tenantId !== selectedTenantId) {
			selectedTenantId = tenantId;
		}
	});

	async function ensureAdminContextReady() {
		if (adminContextReady) {
			return;
		}

		if (adminContextPromise) {
			await adminContextPromise;
			return;
		}

		adminContextPromise = (async () => {
			adminContextReady = false;
			try {
				// Load tenant list and settings context before rendering child pages.
				// This avoids first-render requests being sent without X-Tenant-Id.
				await tenantStore.load();
				await settingsContext.initialize();
				selectedTenantId = settingsContext.tenantId || tenantStore.defaultTenantId;
			} finally {
				adminContextReady = true;
				adminContextPromise = null;
			}
		})();

		await adminContextPromise;
	}

	$effect(() => {
		const isOnLoginPage = $page.url.pathname === '/admin/login';
		const isAuthenticated = adminAuth.isAuthenticated;

		if (isOnLoginPage) {
			adminContextReady = false;
			return;
		}

		if (isAuthenticated && !adminContextReady) {
			void ensureAdminContextReady();
		}
	});

	// Paths that belong to the PLATFORM section (tenant selector should be hidden)
	const PLATFORM_PATHS = [
		'/admin/tenants',
		'/admin/security',
		'/admin/compliance',
		'/admin/scale',
		'/admin/storage-destinations',
		'/admin/logging-policies',
		'/admin/notifications',
		'/admin/admin-logging',
		'/admin/database-connections',
		'/admin/jobs',
		'/admin/admins',
		'/admin/admin-access-control',
		'/admin/admin-rbac',
		'/admin/admin-abac',
		'/admin/admin-rebac',
		'/admin/admin-policies',
		'/admin/machine-access',
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

	function navBadgeFor(path: string): string | number | undefined {
		const count =
			path === '/admin/logging-policies'
				? loggingAlertCount
				: path === '/admin/notifications'
					? notificationAlertCount
					: 0;
		if (count <= 0) {
			return undefined;
		}
		return count > 99 ? '99+' : count;
	}

	async function loadLoggingAlertBadge() {
		try {
			const response = await adminLoggingControlAPI.listNotifications({ limit: 1 });
			loggingAlertCount = response.total;
		} catch {
			loggingAlertCount = 0;
		}
		try {
			const response = await adminLoggingControlAPI.listNotificationCenter({
				status: 'unresolved',
				limit: 1
			});
			notificationAlertCount = response.total;
		} catch {
			notificationAlertCount = 0;
		}
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
		<p>{$LL.admin_layout_loading()}</p>
	</div>
{:else if adminAuth.isAuthenticated && !adminContextReady}
	<div class="loading-container">
		<div class="loading-spinner">
			<i class="i-ph-circle-notch animate-spin w-8 h-8"></i>
		</div>
		<p>{$LL.admin_layout_loading_tenant_context()}</p>
	</div>
{:else if adminAuth.isAuthenticated}
	<!-- Authenticated - layout with floating sidebar -->
	<div class="app-layout">
		<FloatingNav mobileOpen={mobileMenuOpen} onMobileClose={() => (mobileMenuOpen = false)}>
			<!-- Dashboard (above all sections) -->
			<NavItem
				href="/admin"
				icon="i-ph-squares-four"
				label={$LL.admin_nav_dashboard()}
				active={isActive('/admin', true)}
			/>

			<!-- END USER Section -->
			<NavSection level="enduser" label={$LL.admin_nav_section_end_user()}>
				<NavGroupLabel label={$LL.admin_nav_group_identity()} />
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

				<NavGroupLabel label={$LL.admin_nav_group_monitoring()} />
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
			<NavSection level="client" label={$LL.admin_nav_section_client()}>
				<NavGroupLabel label={$LL.admin_nav_group_applications()} />
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
			<NavSection level="tenant" label={$LL.admin_nav_section_tenant()}>
				<NavGroupLabel label={$LL.admin_nav_group_authentication()} />
				{#each navTenant.authentication as item (item.path)}
					<NavItem
						href={item.path}
						icon={item.icon}
						label={item.label}
						active={isActive(item.path)}
					/>
				{/each}

				<NavGroupLabel label={$LL.admin_nav_group_schema_settings()} />
				{#each navTenant.identitySchema as item (item.path)}
					<NavItem
						href={item.path}
						icon={item.icon}
						label={item.label}
						active={isActive(item.path)}
					/>
				{/each}
				<NavItemGroup
					parent={navTenant.identityMapping.parent}
					children={navTenant.identityMapping.children}
				/>

				<NavGroupLabel label={$LL.admin_nav_group_branding()} />
				{#each navTenant.branding as item (item.path)}
					<NavItem
						href={item.path}
						icon={item.icon}
						label={item.label}
						active={isActive(item.path)}
					/>
				{/each}

				<NavGroupLabel label={$LL.admin_nav_group_configuration()} />
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
			<NavSection level="platform" label={$LL.admin_nav_section_platform()}>
				<NavGroupLabel label={$LL.admin_nav_group_tenant_management()} />
				{#each navPlatform.tenantManagement as item (item.path)}
					<NavItem
						href={item.path}
						icon={item.icon}
						label={item.label}
						active={isActive(item.path)}
					/>
				{/each}

				<NavGroupLabel label={$LL.admin_nav_group_security_compliance()} />
				{#each navPlatform.security as item (item.path)}
					<NavItem
						href={item.path}
						icon={item.icon}
						label={item.label}
						active={isActive(item.path)}
					/>
				{/each}

				<NavGroupLabel label={$LL.admin_nav_group_operations()} />
				{#each navPlatform.operations as item (item.path)}
					<NavItem
						href={item.path}
						icon={item.icon}
						label={item.label}
						active={isActive(item.path)}
						badge={navBadgeFor(item.path)}
					/>
				{/each}

				<NavGroupLabel label={$LL.admin_nav_group_admin_operators()} />
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
		<p>{$LL.admin_layout_redirecting_to_login()}</p>
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
