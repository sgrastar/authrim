<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { adminAuth } from '$lib/stores/admin-auth.svelte';
	import { themeStore } from '$lib/stores/theme.svelte';
	import { adminBrandStore } from '$lib/stores/admin-brand.svelte';
	import { releaseRolloutStore } from '$lib/stores/release-rollout.svelte';
	import FloatingNav from '$lib/components/admin/FloatingNav.svelte';
	import NavSection from '$lib/components/admin/NavSection.svelte';
	import NavItem from '$lib/components/admin/NavItem.svelte';
	import NavItemGroup from '$lib/components/admin/NavItemGroup.svelte';
	import NavGroupLabel from '$lib/components/admin/NavGroupLabel.svelte';
	import AdminHeader from '$lib/components/admin/AdminHeader.svelte';
	import AdminToastHost from '$lib/components/admin/AdminToastHost.svelte';
	import type { Snippet } from 'svelte';
	import { tenantStore } from '$lib/stores/tenants.svelte';
	import { settingsContext } from '$lib/stores/settings-context.svelte';
	import { adminLoggingControlAPI } from '$lib/api/admin-logging-control';
	import { LL } from '$i18n/i18n-svelte';
	import adminUiPackage from '../../../package.json';

	let { children }: { children: Snippet } = $props();

	// Tenant selector state — derived from shared store
	let selectedTenantId = $state('');

	// Login and invitation enrollment are public Admin surfaces without dashboard chrome.
	const isPublicAdminPage = $derived(
		$page.url.pathname === '/admin/login' || $page.url.pathname === '/admin/join'
	);

	// Mobile menu state
	let mobileMenuOpen = $state(false);
	let adminContextReady = $state(false);
	let adminContextPromise: Promise<void> | null = null;
	let loggingAlertCount = $state(0);
	let notificationAlertCount = $state(0);
	let controlPlaneDriftAlertCount = $state(0);
	const adminUiVersion = `v${adminUiPackage.version}`;
	const runtimeEnvironment = import.meta.env.PUBLIC_AUTHRIM_ENVIRONMENT_NAME || 'unknown';

	const hiddenDashboardRoutes = $derived([
		{
			path: '/admin/resolution-center',
			label: $LL.admin_nav_resolution_center(),
			icon: 'i-ph-check-circle',
			showInSidebar: false
		}
	]);

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
			{
				path: '/admin/organizations',
				label: $LL.admin_nav_organizations(),
				icon: 'i-ph-buildings'
			},
			{ path: '/admin/sessions', label: $LL.admin_nav_user_sessions(), icon: 'i-ph-clock' }
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
		loginExperience: [
			{
				path: '/admin/authentication-methods',
				label: $LL.admin_nav_login_methods(),
				icon: 'i-ph-sign-in'
			},
			{ path: '/admin/themes', label: $LL.admin_header_theme(), icon: 'i-ph-palette' },
			{ path: '/admin/login-ui', label: $LL.admin_nav_login_ui(), icon: 'i-ph-paint-brush' },
			{
				path: '/admin/account-page',
				label: $LL.admin_nav_account_page(),
				icon: 'i-ph-layout'
			},
			{
				path: '/admin/launchers',
				label: $LL.admin_nav_launchers(),
				icon: 'i-ph-rocket-launch'
			},
			{
				path: '/admin/tenant-discovery',
				label: $LL.admin_nav_tenant_discovery(),
				icon: 'i-ph-signpost'
			},
			{ path: '/admin/flows', label: $LL.admin_nav_flows(), icon: 'i-ph-flow-arrow' },
			{ path: '/admin/screens', label: $LL.admin_nav_screens(), icon: 'i-ph-textbox' },
			{
				path: '/admin/consent-policies',
				label: $LL.admin_consent_policies_nav(),
				icon: 'i-ph-clipboard-text'
			},
			{
				path: '/admin/consent-statements',
				label: $LL.admin_nav_consent_statements(),
				icon: 'i-ph-list-checks'
			}
		],
		federationDirectory: [
			{ path: '/admin/external-idp', label: $LL.admin_nav_external_idp(), icon: 'i-ph-globe' },
			{ path: '/admin/saml', label: $LL.admin_nav_saml(), icon: 'i-ph-arrows-left-right' },
			{
				path: '/admin/directory-authentication',
				label: $LL.admin_nav_directory_authentication(),
				icon: 'i-ph-tree-structure'
			},
			{
				path: '/admin/external-token-refresh',
				label: $LL.admin_nav_token_refresh(),
				icon: 'i-ph-arrows-clockwise'
			}
		],
		identitySchema: [
			{ path: '/admin/custom-claims', label: $LL.admin_nav_custom_claims(), icon: 'i-ph-tag' },
			{
				path: '/admin/scim-tokens',
				label: $LL.admin_nav_scim_tokens(),
				icon: 'i-ph-identification-card'
			}
		],
		identityMapping: {
			parent: {
				href: '/admin/field-mapping',
				icon: 'i-ph-graph',
				label: $LL.admin_nav_identity_mapping()
			},
			children: [
				{ href: '/admin/field-mapping/profiles', label: $LL.admin_nav_source_destination() },
				{
					href: '/admin/field-mapping/persistent-identifiers',
					label: $LL.admin_nav_persistent_identifiers()
				},
				{
					href: '/admin/field-mapping/field-mapping-sets',
					label: $LL.admin_nav_mapping_policies(),
					activePaths: ['/admin/field-mapping/edit']
				}
			]
		},
		settings: [
			{ path: '/admin/info', label: $LL.admin_nav_info(), icon: 'i-ph-info' },
			{ path: '/admin/settings', label: $LL.admin_nav_settings(), icon: 'i-ph-gear' },
			{
				path: '/admin/email-settings',
				label: $LL.admin_nav_email_settings(),
				icon: 'i-ph-envelope-simple'
			},
			{
				path: '/admin/email-deliveries',
				label: $LL.admin_nav_email_deliveries(),
				icon: 'i-ph-envelope-open'
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
				path: '/admin/control-plane',
				label: $LL.admin_nav_control_plane(),
				icon: 'i-ph-git-diff'
			},
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
				path: '/admin/agent-access',
				label: $LL.admin_agent_access_nav(),
				icon: 'i-ph-robot'
			},
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
		// Dashboard-adjacent hidden routes
		...hiddenDashboardRoutes,
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
		{
			path: '/admin/account-settings',
			label: $LL.admin_header_account_settings(),
			icon: 'i-ph-user'
		},
		{
			path: '/admin/role-rules',
			label: $LL.admin_access_control_role_rules(),
			icon: 'i-ph-git-branch'
		},
		// Tenant
		...navTenant.loginExperience,
		...navTenant.federationDirectory,
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
		{
			path: '/admin/field-mapping/edit',
			label: $LL.admin_nav_mapping_policies(),
			icon: 'i-ph-arrow-right'
		},
		...navTenant.settings,
		// Platform
		...navPlatform.tenantManagement,
		...navPlatform.security,
		...navPlatform.operations,
		{
			path: '/admin/platform/tenant-domain-mappings',
			label: $LL.admin_admin_rbac_perm_category_tenant_domains(),
			icon: 'i-ph-globe'
		},
		navPlatform.adminUsers,
		{
			path: '/admin/admin-roles',
			label: $LL.admin_admin_rbac_perm_category_admin_roles(),
			icon: 'i-ph-identification-badge'
		},
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

		// Find the most specific matching nav item.
		const match = allNavItems
			.filter((item) => path === item.path || path.startsWith(`${item.path}/`))
			.sort((a, b) => b.path.length - a.path.length)[0];
		if (match) {
			return [
				{
					label: $LL.admin_nav_dashboard(),
					href: '/admin',
					icon: 'i-ph-squares-four',
					level: 'tenant' as const
				},
				{ label: match.label, icon: match.icon, level: 'tenant' as const }
			];
		}

		return [
			{
				label: $LL.admin_nav_dashboard(),
				href: '/admin',
				icon: 'i-ph-squares-four',
				level: 'tenant' as const
			},
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
		adminBrandStore.init();

		// Capture current path at mount time to avoid race conditions with navigation
		const currentPath = $page.url.pathname;
		const isOnPublicAdminPage = currentPath === '/admin/login' || currentPath === '/admin/join';

		// Skip auth checks while logging in or accepting an invitation.
		if (isOnPublicAdminPage) {
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
		await releaseRolloutStore.refresh();
	});

	onMount(() => {
		const timer = window.setInterval(() => {
			if (adminAuth.isAuthenticated && releaseRolloutStore.shouldPoll) {
				void releaseRolloutStore.refresh();
			}
		}, 5000);
		return () => window.clearInterval(timer);
	});

	function releaseRolloutMessage(): string {
		if (!releaseRolloutStore.available) return $LL.admin_release_rollout_blocked();
		const status = releaseRolloutStore.status;
		if (status.phase === 'blocked') return $LL.admin_release_rollout_blocked();
		if (status.phase === 'awaiting_setup') return $LL.admin_release_rollout_waiting_setup();
		if (status.phase === 'verifying') return $LL.admin_release_rollout_verifying();
		if (status.totalTargets > 0) {
			return $LL.admin_release_rollout_progress({
				completed: status.completedTargets,
				total: status.totalTargets
			});
		}
		return '';
	}

	function releaseRolloutUpdatedAt(): string {
		const value = releaseRolloutStore.status.updatedAt;
		if (!value) return '—';
		const date = new Date(value * 1000);
		return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
	}

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
		const isOnPublicAdminPage =
			$page.url.pathname === '/admin/login' || $page.url.pathname === '/admin/join';
		const isAuthenticated = adminAuth.isAuthenticated;

		if (isOnPublicAdminPage) {
			adminContextReady = false;
			return;
		}

		if (isAuthenticated && !adminContextReady) {
			void ensureAdminContextReady();
		}
	});

	const selectedTenantLabel = $derived(
		tenantStore.activeTenants.find((tenant) => tenant.id === selectedTenantId)?.name ??
			selectedTenantId ??
			tenantStore.defaultTenantId ??
			'default'
	);

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
		try {
			const response = await adminLoggingControlAPI.listNotificationCenter({
				category: 'control_plane_drift',
				status: 'unresolved',
				limit: 1
			});
			controlPlaneDriftAlertCount = response.total;
		} catch {
			controlPlaneDriftAlertCount = 0;
		}
	}
</script>

<AdminToastHost />

{#if isPublicAdminPage}
	<!-- Public Admin page - no layout chrome -->
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
		<FloatingNav
			mobileOpen={mobileMenuOpen}
			onMobileClose={() => (mobileMenuOpen = false)}
			productName={adminBrandStore.name}
			adminLabel={adminBrandStore.adminLabel}
			productLogoUrl={adminBrandStore.logoUrl}
			productLogoAlt={adminBrandStore.logoAlt}
			versionLabel={adminUiVersion}
			environmentLabel={$LL.admin_nav_footer_environment({ env: runtimeEnvironment })}
			tenantLabel={$LL.admin_nav_footer_tenant({ tenant: selectedTenantLabel })}
		>
			<!-- Dashboard (above all sections) -->
			<NavItem
				href="/admin"
				icon="i-ph-squares-four"
				label={$LL.admin_nav_dashboard()}
				active={isActive('/admin', true)}
			/>
			{#each hiddenDashboardRoutes.filter((item) => item.showInSidebar) as item (item.path)}
				<NavItem
					href={item.path}
					icon={item.icon}
					label={item.label}
					active={isActive(item.path)}
				/>
			{/each}

			<!-- END USER Section -->
			<NavSection level="enduser">
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
			<NavSection level="client">
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
			<NavSection level="tenant">
				<NavGroupLabel label={$LL.admin_nav_group_login_experience()} />
				{#each navTenant.loginExperience as item (item.path)}
					<NavItem
						href={item.path}
						icon={item.icon}
						label={item.label}
						active={isActive(item.path)}
					/>
				{/each}

				<NavGroupLabel label={$LL.admin_nav_group_federation_directory()} />
				{#each navTenant.federationDirectory as item (item.path)}
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

				<NavGroupLabel label={$LL.admin_nav_group_tenant_settings()} />
				{#each navTenant.settings as item (item.path)}
					<NavItem
						href={item.path}
						icon={item.icon}
						label={item.label}
						active={isActive(item.path)}
					/>
				{/each}
			</NavSection>

			<!-- PLATFORM Section -->
			<NavSection level="platform">
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
				userId={adminAuth.user?.userId}
			/>

			<div class="page-content">
				{#if releaseRolloutStore.active}
					<div
						class:release-rollout-blocked={releaseRolloutStore.status.phase === 'blocked'}
						class="release-rollout-banner"
						role="status"
					>
						<i class="i-ph-arrows-clockwise" aria-hidden="true"></i>
						<div>
							<strong>
								{$LL.admin_release_rollout_banner({
									version: releaseRolloutStore.status.targetVersion ?? '—'
								})}
							</strong>
							<span>
								{$LL.admin_release_rollout_versions({
									source: releaseRolloutStore.status.sourceVersion ?? '—',
									target: releaseRolloutStore.status.targetVersion ?? '—'
								})}
							</span>
							{#if releaseRolloutMessage()}
								<span>{releaseRolloutMessage()}</span>
							{/if}
							<span>
								{$LL.admin_release_rollout_updated({ time: releaseRolloutUpdatedAt() })}
							</span>
							{#if releaseRolloutStore.status.phase === 'blocked' && releaseRolloutStore.status.lastErrorCode}
								<span class="code-value">
									{$LL.admin_release_rollout_failure({
										code: releaseRolloutStore.status.lastErrorCode
									})}
								</span>
							{/if}
							{#if releaseRolloutStore.readOnly}
								<span>{$LL.admin_release_rollout_read_only()}</span>
							{/if}
						</div>
						<a
							href={`/admin/control-plane${
								releaseRolloutStore.status.operationId
									? `?operation=${encodeURIComponent(releaseRolloutStore.status.operationId)}`
									: ''
							}`}
						>
							{$LL.admin_release_rollout_view_details()}
						</a>
					</div>
				{/if}
				{#if controlPlaneDriftAlertCount > 0}
					<div class="control-drift-warning" role="status">
						<i class="i-ph-warning-circle" aria-hidden="true"></i>
						<span>
							{$LL.admin_notifications_control_plane_drift_banner({
								count: controlPlaneDriftAlertCount
							})}
						</span>
						<a href="/admin/notifications">
							{$LL.admin_notifications_review_control_plane_drift()}
						</a>
					</div>
				{/if}
				<fieldset
					class="release-mutation-fence"
					disabled={releaseRolloutStore.readOnly &&
						!$page.url.pathname.startsWith('/admin/control-plane')}
				>
					{@render children()}
				</fieldset>
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
		margin-left: var(--layout-nav-offset, var(--nav-width-expanded));
		width: calc(100% - var(--layout-nav-offset, var(--nav-width-expanded)));
		min-height: 100vh;
		display: flex;
		flex-direction: column;
		padding: var(--main-shell-padding, 0);
		box-sizing: border-box;
	}

	.page-content {
		flex: 1;
		width: 100%;
		max-width: var(--content-max-width, 1440px);
		padding: var(--content-padding, 26px 32px 60px);
		box-sizing: border-box;
	}

	.control-drift-warning {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-bottom: 18px;
		padding: 10px 12px;
		border: 1px solid var(--color-warning-border, #d59b27);
		border-left-width: 4px;
		background: var(--color-warning-subtle, #fff8e6);
		color: var(--color-text, #20242a);
		font-size: 14px;
	}

	.release-rollout-banner {
		--release-rollout-accent: var(--color-warning, #9a6400);
		--release-rollout-background: color-mix(
			in srgb,
			var(--release-rollout-accent) 12%,
			var(--color-surface, #fffdf8)
		);
		--release-rollout-border: color-mix(
			in srgb,
			var(--release-rollout-accent) 72%,
			var(--color-border, transparent)
		);
		--release-rollout-emphasis: color-mix(
			in srgb,
			var(--release-rollout-accent) 72%,
			var(--color-text, #20242a)
		);
		display: flex;
		align-items: flex-start;
		gap: 12px;
		margin-bottom: 18px;
		padding: 12px 14px;
		border: 1px solid var(--release-rollout-border);
		border-left-width: 4px;
		background: var(--release-rollout-background);
		color: var(--color-text, #20242a);
	}

	.release-rollout-banner.release-rollout-blocked {
		--release-rollout-accent: var(--color-danger, #b42318);
	}

	.release-rollout-banner > i {
		font-size: 22px;
		color: var(--release-rollout-emphasis);
	}

	.release-rollout-banner > div {
		display: flex;
		min-width: 0;
		flex: 1;
		flex-direction: column;
		gap: 2px;
	}

	.release-rollout-banner span {
		font-size: 13px;
		color: var(--color-text-muted, #5f6670);
	}

	.release-rollout-banner a {
		flex: 0 0 auto;
		color: var(--release-rollout-emphasis);
		font-weight: 600;
		text-underline-offset: 3px;
	}

	.release-rollout-banner a:hover {
		color: var(--color-text, #20242a);
	}

	.release-rollout-banner a:focus-visible {
		outline: 2px solid var(--release-rollout-emphasis);
		outline-offset: 3px;
	}

	.release-mutation-fence {
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}

	.release-mutation-fence:disabled :global(button),
	.release-mutation-fence:disabled :global(input),
	.release-mutation-fence:disabled :global(select),
	.release-mutation-fence:disabled :global(textarea) {
		opacity: 0.58;
		cursor: not-allowed;
	}

	.control-drift-warning i {
		flex: 0 0 auto;
		font-size: 20px;
		color: var(--color-warning, #9a6400);
	}

	.control-drift-warning span {
		min-width: 0;
		flex: 1;
	}

	.control-drift-warning a {
		flex: 0 0 auto;
		color: var(--color-link, #075ea8);
		font-weight: 600;
	}

	/* Loading State */
	.loading-container {
		display: flex;
		flex-direction: column;
		justify-content: center;
		align-items: center;
		height: 100vh;
		gap: 16px;
		color: var(--color-text-muted);
	}

	.loading-spinner {
		color: var(--color-accent);
	}

	/* Responsive */
	@media (max-width: 1024px) {
		.main-content {
			margin-left: var(--layout-nav-offset, var(--nav-width-expanded));
		}
	}

	@media (max-width: 768px) {
		.main-content {
			margin-left: 0;
			width: 100%;
		}

		.page-content {
			padding: 20px 16px 48px;
		}

		.control-drift-warning {
			align-items: flex-start;
			flex-wrap: wrap;
		}

		.control-drift-warning a {
			width: 100%;
			padding-left: 30px;
		}
	}
</style>
