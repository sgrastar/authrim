<script lang="ts">
	import { page } from '$app/stores';
	import { LL } from '$i18n/i18n-svelte';

	// Navigation items
	const navItems = [
		{
			path: '/admin',
			label: () => $LL.admin_sidebar_dashboard(),
			icon: 'i-heroicons-home'
		},
		{
			path: '/admin/users',
			label: () => $LL.admin_sidebar_users(),
			icon: 'i-heroicons-users'
		},
		{
			path: '/admin/clients',
			label: () => $LL.admin_sidebar_clients(),
			icon: 'i-heroicons-cube'
		},
		{
			path: '/admin/sessions',
			label: () => $LL.admin_sidebar_sessions(),
			icon: 'i-heroicons-clock'
		},
		{
			path: '/admin/scim-tokens',
			label: () => $LL.admin_sidebar_scim_tokens?.() || 'SCIM Tokens',
			icon: 'i-heroicons-key'
		},
		{
			path: '/admin/audit-log',
			label: () => $LL.admin_sidebar_audit_log(),
			icon: 'i-heroicons-document-text'
		},
		{
			path: '/admin/policy',
			label: () => $LL.admin_sidebar_policy?.() || 'Policy',
			icon: 'i-heroicons-shield-check'
		},
		{
			path: '/admin/settings',
			label: () => $LL.admin_sidebar_settings(),
			icon: 'i-heroicons-cog-6-tooth'
		}
	];

	let sidebarOpen = true;

	function toggleSidebar() {
		sidebarOpen = !sidebarOpen;
	}

	// Check if the current path matches the nav item
	function isActive(path: string): boolean {
		if (path === '/admin') {
			return $page.url.pathname === '/admin';
		}
		return $page.url.pathname.startsWith(path);
	}
</script>

<div class="min-h-screen bg-gray-50 dark:bg-gray-900">
	<!-- Sidebar -->
	<aside
		class="fixed left-0 top-0 z-40 h-screen w-64 border-r border-gray-200 bg-white transition-transform dark:border-gray-700 dark:bg-gray-800 {!sidebarOpen
			? '-translate-x-full'
			: ''}"
	>
		<!-- Logo -->
		<div class="flex h-16 items-center border-b border-gray-200 px-6 dark:border-gray-700">
			<a href="/admin" class="flex items-center gap-2">
				<div class="h-8 w-8 rounded bg-primary-500 flex items-center justify-center">
					<span class="text-white font-bold text-lg">E</span>
				</div>
				<span class="text-xl font-bold text-gray-900 dark:text-white">{$LL.app_title()}</span>
			</a>
		</div>

		<!-- Navigation -->
		<nav class="flex-1 overflow-y-auto p-4">
			<ul class="space-y-1">
				{#each navItems as item (item.path)}
					<li>
						<a
							href={item.path}
							class={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
								isActive(item.path)
									? 'bg-primary-50 text-primary-700 dark:bg-primary-900 dark:text-primary-300'
									: 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
							}`}
						>
							<div class={`${item.icon} h-5 w-5`}></div>
							<span>{item.label()}</span>
						</a>
					</li>
				{/each}
			</ul>
		</nav>

		<!-- User menu at bottom -->
		<div class="border-t border-gray-200 p-4 dark:border-gray-700">
			<div class="flex items-center gap-3">
				<div class="h-8 w-8 rounded-full bg-gray-300 dark:bg-gray-600"></div>
				<div class="flex-1">
					<p class="text-sm font-medium text-gray-900 dark:text-white">Admin</p>
					<p class="text-xs text-gray-500 dark:text-gray-400">admin@authrim.local</p>
				</div>
			</div>
		</div>
	</aside>

	<!-- Main content -->
	<div class="lg:pl-64">
		<!-- Top bar -->
		<header
			class="sticky top-0 z-30 border-b border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800"
		>
			<div class="flex h-16 items-center justify-between px-6">
				<!-- Mobile menu button -->
				<button
					aria-label="Toggle sidebar menu"
					class="lg:hidden inline-flex items-center justify-center rounded-lg p-2 text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
					onclick={toggleSidebar}
				>
					<div class="i-heroicons-bars-3 h-6 w-6"></div>
				</button>

				<div class="flex-1"></div>

				<!-- Right side actions -->
				<div class="flex items-center gap-4">
					<!-- Language switcher -->
					<div class="hidden sm:block">
						<!-- Language switcher component would go here -->
					</div>

					<!-- Notifications -->
					<button
						aria-label="Notifications"
						class="relative rounded-lg p-2 text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
					>
						<div class="i-heroicons-bell h-5 w-5"></div>
						<span
							class="absolute right-1 top-1 h-2 w-2 rounded-full bg-red-500 ring-2 ring-white dark:ring-gray-800"
						></span>
					</button>
				</div>
			</div>
		</header>

		<!-- Page content -->
		<main class="p-6">
			<slot />
		</main>
	</div>
</div>

<!-- Mobile sidebar overlay -->
{#if sidebarOpen}
	<div
		class="fixed inset-0 z-30 bg-gray-900/50 lg:hidden"
		onclick={toggleSidebar}
		onkeydown={(e) => e.key === 'Escape' && toggleSidebar()}
		role="button"
		tabindex="0"
		aria-label="Close sidebar"
	></div>
{/if}
