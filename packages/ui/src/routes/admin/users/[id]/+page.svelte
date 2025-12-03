<script lang="ts">
	import { LL } from '$i18n/i18n-svelte';
	import { Card, Button, Input } from '$lib/components';
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { adminUsersAPI, adminSessionsAPI } from '$lib/api/client';

	interface User {
		id: string;
		email: string;
		email_verified: boolean;
		name: string | null;
		given_name: string | null;
		family_name: string | null;
		phone_number: string | null;
		phone_number_verified: boolean;
		created_at: number;
		updated_at: number;
		last_login_at: number | null;
	}

	interface Passkey {
		id: string;
		device_name: string | null;
		created_at: number;
		last_used_at: number | null;
	}

	interface Session {
		id: string;
		created_at: number;
		expires_at: number;
	}

	let userId: string;
	let user: User | null = null;
	let passkeys: Passkey[] = [];
	let sessions: Session[] = [];
	let loading = true;
	let saving = false;
	let error = '';

	$: userId = $page.params.id as string;

	onMount(async () => {
		await loadUser();
	});

	async function loadUser() {
		loading = true;
		error = '';

		try {
			const { data, error: apiError } = await adminUsersAPI.get(userId);

			if (apiError) {
				error = apiError.error_description || 'Failed to load user';
				console.error('Failed to load user:', apiError);
			} else if (data) {
				user = {
					id: data.user.id,
					email: data.user.email,
					email_verified: data.user.email_verified,
					name: data.user.name || null,
					given_name: data.user.given_name || null,
					family_name: data.user.family_name || null,
					phone_number: data.user.phone_number || null,
					phone_number_verified: data.user.phone_number_verified || false,
					created_at: data.user.created_at,
					updated_at: data.user.updated_at,
					last_login_at: data.user.last_login_at || null
				};

				passkeys = data.passkeys.map((p) => ({
					id: p.id,
					device_name: p.device_name || null,
					created_at: p.created_at,
					last_used_at: p.last_used_at || null
				}));

				// Load sessions for this user
				await loadUserSessions();
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'An error occurred';
			console.error('Error loading user:', err);
		} finally {
			loading = false;
		}
	}

	async function loadUserSessions() {
		try {
			const { data } = await adminSessionsAPI.list({
				userId: userId,
				active: 'true'
			});

			if (data) {
				sessions = data.sessions.map((s) => ({
					id: s.id,
					created_at: Math.floor(new Date(s.created_at).getTime() / 1000),
					expires_at: Math.floor(new Date(s.expires_at).getTime() / 1000)
				}));
			}
		} catch (err) {
			console.error('Error loading sessions:', err);
		}
	}

	async function handleSave() {
		if (!user) return;

		saving = true;
		error = '';

		try {
			const { error: apiError } = await adminUsersAPI.update(userId, {
				name: user.name || undefined,
				email_verified: user.email_verified,
				phone_number: user.phone_number || undefined,
				phone_number_verified: user.phone_number_verified
			});

			if (apiError) {
				error = apiError.error_description || 'Failed to update user';
			} else {
				alert('User updated successfully');
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'An error occurred';
		} finally {
			saving = false;
		}
	}

	async function handleDelete() {
		if (!confirm($LL.admin_user_detail_deleteConfirm())) return;

		try {
			const { error: apiError } = await adminUsersAPI.delete(userId);

			if (apiError) {
				alert('Failed to delete user: ' + (apiError.error_description || 'Unknown error'));
			} else {
				window.location.href = '/admin/users';
			}
		} catch (err) {
			console.error('Error deleting user:', err);
			alert('Failed to delete user');
		}
	}

	function formatDate(timestamp: number | null): string {
		if (!timestamp) return 'Never';
		// Timestamps are stored in milliseconds
		return new Date(timestamp).toLocaleString();
	}

	function handleDeletePasskey(passkeyId: string) {
		if (confirm('Are you sure you want to delete this passkey?')) {
			// TODO: Implement passkey deletion API
			passkeys = passkeys.filter((p) => p.id !== passkeyId);
		}
	}

	async function handleRevokeSession(sessionId: string) {
		if (!confirm('Are you sure you want to revoke this session?')) return;

		try {
			const { error: apiError } = await adminSessionsAPI.revoke(sessionId);

			if (apiError) {
				alert('Failed to revoke session: ' + (apiError.error_description || 'Unknown error'));
			} else {
				sessions = sessions.filter((s) => s.id !== sessionId);
			}
		} catch (err) {
			console.error('Error revoking session:', err);
			alert('Failed to revoke session');
		}
	}
</script>

<svelte:head>
	<title>{$LL.admin_user_detail_title()} - {$LL.app_title()}</title>
</svelte:head>

<div class="space-y-6">
	<!-- Page header -->
	<div class="flex items-center justify-between">
		<div>
			<a
				href="/admin/users"
				class="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300"
			>
				<div class="i-heroicons-arrow-left h-4 w-4"></div>
				Back to users
			</a>
			<h1 class="mt-2 text-3xl font-bold text-gray-900 dark:text-white">
				{$LL.admin_user_detail_title()}
			</h1>
		</div>
		<div class="flex gap-2">
			<Button variant="primary" onclick={handleSave} disabled={saving || loading}>
				{#if saving}
					<div class="i-heroicons-arrow-path h-4 w-4 animate-spin"></div>
				{/if}
				{$LL.admin_user_detail_save()}
			</Button>
			<Button variant="secondary" onclick={handleDelete} disabled={loading}>
				{$LL.admin_user_detail_deleteUser()}
			</Button>
		</div>
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

	{#if loading}
		<Card>
			<div class="space-y-4">
				<div class="h-6 w-32 animate-pulse rounded bg-gray-300 dark:bg-gray-700"></div>
				<!-- eslint-disable-next-line @typescript-eslint/no-unused-vars -->
				{#each Array(5) as _, i (i)}
					<div class="space-y-2">
						<div class="h-4 w-24 animate-pulse rounded bg-gray-300 dark:bg-gray-700"></div>
						<div class="h-10 w-full animate-pulse rounded bg-gray-300 dark:bg-gray-700"></div>
					</div>
				{/each}
			</div>
		</Card>
	{:else if user}
		<!-- Basic Information -->
		<Card>
			<h2 class="mb-4 text-lg font-semibold text-gray-900 dark:text-white">
				{$LL.admin_user_detail_basicInfo()}
			</h2>
			<div class="grid gap-4 sm:grid-cols-2">
				<div>
					<label
						for="email"
						class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
					>
						Email
					</label>
					<Input id="email" type="email" bind:value={user.email} disabled />
				</div>
				<div>
					<label for="name" class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
						Full Name
					</label>
					<Input id="name" type="text" bind:value={user.name} />
				</div>
				<div>
					<label
						for="given_name"
						class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
					>
						Given Name
					</label>
					<Input id="given_name" type="text" bind:value={user.given_name} />
				</div>
				<div>
					<label
						for="family_name"
						class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
					>
						Family Name
					</label>
					<Input id="family_name" type="text" bind:value={user.family_name} />
				</div>
				<div>
					<label
						for="phone_number"
						class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
					>
						Phone Number
					</label>
					<Input id="phone_number" type="tel" bind:value={user.phone_number} />
				</div>
				<div class="flex flex-col justify-end">
					<label class="inline-flex items-center gap-2">
						<input
							type="checkbox"
							bind:checked={user.email_verified}
							class="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
						/>
						<span class="text-sm text-gray-700 dark:text-gray-300">Email Verified</span>
					</label>
				</div>
			</div>

			<div class="mt-4 grid gap-2 text-sm text-gray-500 dark:text-gray-400">
				<p>Created: {formatDate(user.created_at)}</p>
				<p>Last Updated: {formatDate(user.updated_at)}</p>
				<p>Last Login: {formatDate(user.last_login_at)}</p>
			</div>
		</Card>

		<!-- Registered Passkeys -->
		<Card>
			<h2 class="mb-4 text-lg font-semibold text-gray-900 dark:text-white">
				{$LL.admin_user_detail_passkeys()}
			</h2>
			{#if passkeys.length === 0}
				<p class="text-sm text-gray-500 dark:text-gray-400">No passkeys registered</p>
			{:else}
				<div class="space-y-3">
					{#each passkeys as passkey (passkey.id)}
						<div
							class="flex items-center justify-between rounded-lg border border-gray-200 p-3 dark:border-gray-700"
						>
							<div class="flex items-center gap-3">
								<div class="rounded-lg bg-primary-100 p-2 dark:bg-primary-900">
									<div class="i-heroicons-key h-5 w-5 text-primary-600 dark:text-primary-400"></div>
								</div>
								<div>
									<p class="text-sm font-medium text-gray-900 dark:text-white">
										{passkey.device_name || 'Unnamed Device'}
									</p>
									<p class="text-xs text-gray-500 dark:text-gray-400">
										Created: {formatDate(passkey.created_at)}
									</p>
									<p class="text-xs text-gray-500 dark:text-gray-400">
										Last used: {formatDate(passkey.last_used_at)}
									</p>
								</div>
							</div>
							<button
								class="rounded bg-red-500 px-3 py-1 text-xs font-medium text-white hover:bg-red-600 transition-colors"
								onclick={() => handleDeletePasskey(passkey.id)}
							>
								Delete
							</button>
						</div>
					{/each}
				</div>
			{/if}
		</Card>

		<!-- Active Sessions -->
		<Card>
			<h2 class="mb-4 text-lg font-semibold text-gray-900 dark:text-white">
				{$LL.admin_user_detail_sessions()}
			</h2>
			{#if sessions.length === 0}
				<p class="text-sm text-gray-500 dark:text-gray-400">No active sessions</p>
			{:else}
				<div class="space-y-3">
					{#each sessions as session (session.id)}
						<div
							class="flex items-center justify-between rounded-lg border border-gray-200 p-3 dark:border-gray-700"
						>
							<div>
								<p class="text-sm font-medium text-gray-900 dark:text-white">
									Session ID: {session.id}
								</p>
								<p class="text-xs text-gray-500 dark:text-gray-400">
									Created: {formatDate(session.created_at)}
								</p>
								<p class="text-xs text-gray-500 dark:text-gray-400">
									Expires: {formatDate(session.expires_at)}
								</p>
							</div>
							<button
								class="rounded bg-red-500 px-3 py-1 text-xs font-medium text-white hover:bg-red-600 transition-colors"
								onclick={() => handleRevokeSession(session.id)}
							>
								Revoke
							</button>
						</div>
					{/each}
				</div>
			{/if}
		</Card>
	{:else}
		<Card>
			<p class="text-center text-gray-500 dark:text-gray-400">User not found</p>
		</Card>
	{/if}
</div>
