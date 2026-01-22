<script lang="ts">
	import { LL } from '$i18n/i18n-svelte';
	import { Card, Button } from '$lib/components';
	import { onMount } from 'svelte';
	import { page } from '$app/stores';

	let loading = true;
	let error = '';
	let successMessage = '';
	let pendingRequests: Array<{
		auth_req_id: string;
		client_id: string;
		client_name: string;
		client_logo_uri: string | null;
		scope: string;
		binding_message?: string;
		user_code?: string;
		created_at: number;
		expires_at: number;
	}> = [];

	onMount(async () => {
		await loadPendingRequests();
	});

	async function loadPendingRequests() {
		loading = true;
		error = '';

		try {
			// TODO: Get user info from session
			const userId = 'test_user';
			const loginHint = $page.url.searchParams.get('login_hint') || `sub:${userId}`;

			const response = await fetch(`/api/ciba/pending?login_hint=${encodeURIComponent(loginHint)}`);
			const data = await response.json();

			if (!response.ok) {
				error = data.error_description || 'Failed to load pending requests';
			} else {
				pendingRequests = data.requests || [];
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'An error occurred';
			console.error('Error loading pending requests:', err);
		} finally {
			loading = false;
		}
	}

	async function handleApprove(authReqId: string) {
		try {
			const response = await fetch('/api/ciba/approve', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					auth_req_id: authReqId,
					user_id: 'test_user',
					sub: 'test@example.com'
				})
			});

			const data = await response.json();

			if (!response.ok) {
				error = data.error_description || 'Failed to approve request';
			} else {
				successMessage = 'Authentication request approved successfully';
				// Remove approved request from list
				pendingRequests = pendingRequests.filter((r) => r.auth_req_id !== authReqId);

				// Clear success message after 3 seconds
				setTimeout(() => {
					successMessage = '';
				}, 3000);
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'An error occurred';
			console.error('Error approving request:', err);
		}
	}

	async function handleDeny(authReqId: string) {
		try {
			const response = await fetch('/api/ciba/deny', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					auth_req_id: authReqId,
					reason: 'User rejected'
				})
			});

			const data = await response.json();

			if (!response.ok) {
				error = data.error_description || 'Failed to deny request';
			} else {
				successMessage = 'Authentication request denied successfully';
				// Remove denied request from list
				pendingRequests = pendingRequests.filter((r) => r.auth_req_id !== authReqId);

				// Clear success message after 3 seconds
				setTimeout(() => {
					successMessage = '';
				}, 3000);
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'An error occurred';
			console.error('Error denying request:', err);
		}
	}

	function formatTimeRemaining(expiresAt: number): string {
		const now = Math.floor(Date.now() / 1000);
		const remaining = Math.max(0, expiresAt - now);
		const minutes = Math.floor(remaining / 60);
		const seconds = remaining % 60;
		return `${minutes}:${seconds.toString().padStart(2, '0')}`;
	}
</script>

<svelte:head>
	<title>CIBA Authentication Requests - {$LL.app_title()}</title>
</svelte:head>

<div class="container mx-auto max-w-4xl px-4 py-8">
	<div class="space-y-6">
		<!-- Page header -->
		<div class="text-center">
			<h1 class="text-3xl font-bold text-gray-900 dark:text-white">Authentication Requests</h1>
			<p class="mt-2 text-gray-600 dark:text-gray-400">
				Review and approve pending authentication requests
			</p>
		</div>

		<!-- Error Message -->
		{#if error}
			<div class="rounded-lg bg-red-50 p-4 dark:bg-red-900/20">
				<div class="flex items-center gap-3">
					<div class="i-heroicons-exclamation-circle h-5 w-5 text-red-600 dark:text-red-400"></div>
					<p class="text-sm text-red-800 dark:text-red-200">{error}</p>
				</div>
			</div>
		{/if}

		<!-- Success Message -->
		{#if successMessage}
			<div class="rounded-lg bg-green-50 p-4 dark:bg-green-900/20">
				<div class="flex items-center gap-3">
					<div class="i-heroicons-check-circle h-5 w-5 text-green-600 dark:text-green-400"></div>
					<p class="text-sm text-green-800 dark:text-green-200">{successMessage}</p>
				</div>
			</div>
		{/if}

		<!-- Loading State -->
		{#if loading}
			<Card>
				<div class="flex items-center justify-center py-12">
					<div class="i-heroicons-arrow-path h-8 w-8 animate-spin text-primary-600"></div>
				</div>
			</Card>
		{:else if pendingRequests.length === 0}
			<!-- No Pending Requests -->
			<Card>
				<div class="py-12 text-center">
					<div
						class="i-heroicons-check-badge mx-auto h-16 w-16 text-gray-400 dark:text-gray-600"
					></div>
					<h3 class="mt-4 text-lg font-medium text-gray-900 dark:text-white">
						No Pending Requests
					</h3>
					<p class="mt-2 text-gray-600 dark:text-gray-400">
						You don't have any pending authentication requests at the moment.
					</p>
				</div>
			</Card>
		{:else}
			<!-- Pending Requests List -->
			{#each pendingRequests as request (request.auth_req_id)}
				<Card>
					<div class="space-y-4">
						<!-- Client Info -->
						<div class="flex items-center gap-4">
							{#if request.client_logo_uri}
								<img
									src={request.client_logo_uri}
									alt={request.client_name}
									class="h-12 w-12 rounded-lg object-cover"
								/>
							{:else}
								<div
									class="flex h-12 w-12 items-center justify-center rounded-lg bg-primary-100 dark:bg-primary-900"
								>
									<div
										class="i-heroicons-device-phone-mobile h-6 w-6 text-primary-600 dark:text-primary-400"
									></div>
								</div>
							{/if}
							<div class="flex-1">
								<h3 class="text-lg font-semibold text-gray-900 dark:text-white">
									{request.client_name}
								</h3>
								<p class="text-sm text-gray-600 dark:text-gray-400">Authentication Request</p>
							</div>
							<div class="text-right">
								<p class="text-xs text-gray-500 dark:text-gray-400">Expires in</p>
								<p class="text-sm font-medium text-gray-900 dark:text-white">
									{formatTimeRemaining(request.expires_at)}
								</p>
							</div>
						</div>

						<!-- Binding Message -->
						{#if request.binding_message}
							<div class="rounded-lg bg-blue-50 p-4 dark:bg-blue-900/20">
								<div class="flex gap-3">
									<div
										class="i-heroicons-information-circle h-5 w-5 text-blue-600 dark:text-blue-400"
									></div>
									<div>
										<p class="text-sm font-medium text-blue-900 dark:text-blue-200">
											Binding Message
										</p>
										<p class="mt-1 text-sm text-blue-800 dark:text-blue-300">
											{request.binding_message}
										</p>
									</div>
								</div>
							</div>
						{/if}

						<!-- User Code -->
						{#if request.user_code}
							<div>
								<p class="text-sm font-medium text-gray-700 dark:text-gray-300">
									Verification Code
								</p>
								<div class="mt-1 font-mono text-2xl font-bold text-gray-900 dark:text-white">
									{request.user_code}
								</div>
							</div>
						{/if}

						<!-- Requested Scopes -->
						<div>
							<p class="text-sm font-medium text-gray-700 dark:text-gray-300">Requested Access</p>
							<div class="mt-2 flex flex-wrap gap-2">
								{#each request.scope.split(' ') as scope (scope)}
									<span
										class="rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-800 dark:bg-gray-700 dark:text-gray-200"
									>
										{scope}
									</span>
								{/each}
							</div>
						</div>

						<!-- Action Buttons -->
						<div class="flex gap-3 pt-2">
							<Button
								variant="primary"
								class="flex-1"
								onclick={() => handleApprove(request.auth_req_id)}
							>
								<div class="i-heroicons-check h-5 w-5"></div>
								Approve
							</Button>
							<Button
								variant="secondary"
								class="flex-1"
								onclick={() => handleDeny(request.auth_req_id)}
							>
								<div class="i-heroicons-x-mark h-5 w-5"></div>
								Deny
							</Button>
						</div>
					</div>
				</Card>
			{/each}
		{/if}

		<!-- Refresh Button -->
		{#if !loading}
			<div class="text-center">
				<Button variant="secondary" onclick={loadPendingRequests}>
					<div class="i-heroicons-arrow-path h-4 w-4"></div>
					Refresh
				</Button>
			</div>
		{/if}
	</div>
</div>
