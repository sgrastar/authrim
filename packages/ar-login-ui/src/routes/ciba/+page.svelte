<script lang="ts">
	import { LL } from '$i18n/i18n-svelte';
	import { useLoginUIStores } from '$lib/stores/login-ui-context';
	import { Card, Button } from '$lib/components';
	import AuthPageShell from '$lib/components/AuthPageShell.svelte';
	import { cibaAPI } from '$lib/api/client';
	import { messageForCaughtError } from '$lib/errors/display-error';
	import { onMount } from 'svelte';

	const { brandingStore } = useLoginUIStores();

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
			const { data, error: apiError } = await cibaAPI.getPending();
			if (apiError) {
				error = $LL.ciba_errorLoadPending();
			} else {
				pendingRequests = (data as typeof pendingRequests) || [];
			}
		} catch (err) {
			error = messageForCaughtError(err, $LL.ciba_errorGeneric());
		} finally {
			loading = false;
		}
	}

	async function handleApprove(authReqId: string) {
		if (processingId !== null) return;
		const request = pendingRequests.find((r) => r.auth_req_id === authReqId);
		if (!request || isExpired(request.expires_at)) {
			error = $LL.ciba_expired();
			return;
		}
		processingId = authReqId;
		try {
			const { error: apiError } = await cibaAPI.approve(authReqId);

			if (apiError) {
				error = $LL.ciba_errorApproveFailed();
			} else {
				successMessage = $LL.ciba_approvedSuccess();
				pendingRequests = pendingRequests.filter((r) => r.auth_req_id !== authReqId);

				setTimeout(() => {
					successMessage = '';
				}, 3000);
			}
		} catch (err) {
			error = messageForCaughtError(err, $LL.ciba_errorGeneric());
		} finally {
			processingId = null;
		}
	}

	async function handleDeny(authReqId: string) {
		if (processingId !== null) return;
		const request = pendingRequests.find((r) => r.auth_req_id === authReqId);
		if (!request || isExpired(request.expires_at)) {
			error = $LL.ciba_expired();
			return;
		}
		processingId = authReqId;
		try {
			const { error: apiError } = await cibaAPI.reject(authReqId);

			if (apiError) {
				error = $LL.ciba_errorDenyFailed();
			} else {
				successMessage = $LL.ciba_rejectedSuccess();
				pendingRequests = pendingRequests.filter((r) => r.auth_req_id !== authReqId);

				setTimeout(() => {
					successMessage = '';
				}, 3000);
			}
		} catch (err) {
			error = messageForCaughtError(err, $LL.ciba_errorGeneric());
		} finally {
			processingId = null;
		}
	}

	let processingId: string | null = null;

	function isExpired(expiresAt: number): boolean {
		return Math.floor(Date.now() / 1000) >= expiresAt;
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
	<title>{$LL.ciba_title()} - {brandingStore.brandName || $LL.app_title()}</title>
</svelte:head>

<AuthPageShell wide>
	<div class="container mx-auto max-w-4xl px-4 py-8">
		<div class="space-y-6">
			<!-- Page header -->
			<div class="text-center">
				<h1 class="text-3xl font-bold text-gray-900 dark:text-white">{$LL.ciba_title()}</h1>
				<p class="mt-2 text-gray-600 dark:text-gray-400">
					{$LL.ciba_subtitle()}
				</p>
			</div>

			<!-- Error Message -->
			{#if error}
				<div class="rounded-lg bg-red-50 p-4 dark:bg-red-900/20">
					<div class="flex items-center gap-3">
						<div
							class="i-heroicons-exclamation-circle h-5 w-5 text-red-600 dark:text-red-400"
						></div>
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
							{$LL.ciba_noPendingRequests()}
						</h3>
						<p class="mt-2 text-gray-600 dark:text-gray-400">
							{$LL.ciba_noPendingDescription()}
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
									<p class="text-sm text-gray-600 dark:text-gray-400">
										{$LL.ciba_authenticationRequest()}
									</p>
								</div>
								<div class="text-right">
									<p class="text-xs text-gray-500 dark:text-gray-400">{$LL.ciba_expiresIn()}</p>
									<p class="text-sm font-medium text-gray-900 dark:text-white">
										{isExpired(request.expires_at)
											? $LL.ciba_expired()
											: formatTimeRemaining(request.expires_at)}
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
												{$LL.ciba_bindingMessage()}
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
										{$LL.ciba_verificationCode()}
									</p>
									<div class="mt-1 font-mono text-2xl font-bold text-gray-900 dark:text-white">
										{request.user_code}
									</div>
								</div>
							{/if}

							<!-- Requested Scopes -->
							<div>
								<p class="text-sm font-medium text-gray-700 dark:text-gray-300">
									{$LL.ciba_requestedAccess()}
								</p>
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
									loading={processingId === request.auth_req_id}
									disabled={isExpired(request.expires_at) ||
										(processingId !== null && processingId !== request.auth_req_id)}
									onclick={() => handleApprove(request.auth_req_id)}
								>
									<div class="i-heroicons-check h-5 w-5"></div>
									{$LL.ciba_approveButton()}
								</Button>
								<Button
									variant="secondary"
									class="flex-1"
									disabled={isExpired(request.expires_at) || processingId !== null}
									onclick={() => handleDeny(request.auth_req_id)}
								>
									<div class="i-heroicons-x-mark h-5 w-5"></div>
									{$LL.ciba_rejectButton()}
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
						{$LL.ciba_refresh()}
					</Button>
				</div>
			{/if}
		</div>
	</div></AuthPageShell
>
