<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { adminAuth } from '$lib/stores/admin-auth.svelte';
	import { adminAuthAPI } from '$lib/api/admin-auth';
	import type { Snippet } from 'svelte';

	let { children }: { children: Snippet } = $props();

	// Check if current page is login page
	const isLoginPage = $derived($page.url.pathname === '/admin/login');

	// Navigation items
	const navItems = [
		{ path: '/admin', label: 'Dashboard', exact: true },
		{ path: '/admin/users', label: 'Users', exact: false },
		{ path: '/admin/clients', label: 'Clients', exact: false },
		{ path: '/admin/sessions', label: 'Sessions', exact: false },
		{ path: '/admin/audit-logs', label: 'Audit Logs', exact: false }
	];

	// Check if nav item is active
	function isActive(path: string, exact: boolean): boolean {
		if (exact) {
			return $page.url.pathname === path;
		}
		return $page.url.pathname.startsWith(path);
	}

	onMount(async () => {
		// Skip auth check on login page
		if (isLoginPage) {
			adminAuth.setLoading(false);
			return;
		}

		// Check authentication status
		await adminAuth.checkAuth();

		// Redirect to login if not authenticated
		if (!adminAuth.isAuthenticated) {
			goto('/admin/login');
		}
	});

	async function handleLogout() {
		adminAuth.clearAuth();
		await adminAuthAPI.logout();
	}
</script>

{#if isLoginPage}
	<!-- Login page - no layout chrome -->
	{@render children()}
{:else if adminAuth.isLoading}
	<!-- Loading state -->
	<div style="display: flex; justify-content: center; align-items: center; height: 100vh;">
		<p>Loading...</p>
	</div>
{:else if adminAuth.isAuthenticated}
	<!-- Authenticated - layout with sidebar -->
	<div style="min-height: 100vh; background-color: #f9fafb; display: flex; flex-direction: column;">
		<!-- Header -->
		<header
			style="background-color: #1f2937; color: white; padding: 16px 24px; display: flex; justify-content: space-between; align-items: center; flex-shrink: 0;"
		>
			<h1 style="font-size: 20px; font-weight: bold; margin: 0;">Authrim Admin</h1>
			<div style="display: flex; align-items: center; gap: 16px;">
				<span style="font-size: 14px; color: #9ca3af;">{adminAuth.user?.email || 'Admin'}</span>
				<button
					onclick={handleLogout}
					style="
						padding: 8px 16px;
						background-color: #374151;
						color: #d1d5db;
						border: none;
						border-radius: 4px;
						cursor: pointer;
						font-size: 14px;
					"
				>
					Logout
				</button>
			</div>
		</header>

		<!-- Body with sidebar and main content -->
		<div style="display: flex; flex: 1;">
			<!-- Sidebar -->
			<aside style="width: 200px; background-color: #1f2937; padding: 16px 0; flex-shrink: 0;">
				<nav>
					<ul style="list-style: none; padding: 0; margin: 0;">
						{#each navItems as item (item.path)}
							<li>
								<a
									href={item.path}
									style="
										display: block;
										padding: 12px 24px;
										color: {isActive(item.path, item.exact) ? '#ffffff' : '#9ca3af'};
										background-color: {isActive(item.path, item.exact) ? '#374151' : 'transparent'};
										text-decoration: none;
										font-size: 14px;
										border-left: 3px solid {isActive(item.path, item.exact) ? '#3b82f6' : 'transparent'};
									"
								>
									{item.label}
								</a>
							</li>
						{/each}
					</ul>
				</nav>
			</aside>

			<!-- Main content -->
			<main style="flex: 1; padding: 24px; overflow-y: auto;">
				{@render children()}
			</main>
		</div>
	</div>
{:else}
	<!-- Not authenticated - redirect happens in onMount -->
	<div style="display: flex; justify-content: center; align-items: center; height: 100vh;">
		<p>Redirecting to login...</p>
	</div>
{/if}
