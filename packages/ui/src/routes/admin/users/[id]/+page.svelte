<script lang="ts">
	import * as m from '$lib/paraglide/messages';
	import { Card, Button, Input } from '$lib/components';
	import { onMount } from 'svelte';
	import { page } from '$app/stores';

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

	$: userId = $page.params.id as string;

	onMount(async () => {
		await loadUser();
	});

	async function loadUser() {
		loading = true;
		// Simulate API call - would call GET /admin/users/:id in real implementation
		await new Promise((resolve) => setTimeout(resolve, 500));

		// Mock data
		user = {
			id: userId,
			email: 'john.doe@example.com',
			email_verified: true,
			name: 'John Doe',
			given_name: 'John',
			family_name: 'Doe',
			phone_number: '+1234567890',
			phone_number_verified: false,
			created_at: Date.now() - 86400000 * 30,
			updated_at: Date.now() - 86400000 * 5,
			last_login_at: Date.now() - 3600000 * 2
		};

		passkeys = [
			{
				id: 'passkey-1',
				device_name: 'MacBook Pro',
				created_at: Date.now() - 86400000 * 15,
				last_used_at: Date.now() - 3600000 * 2
			},
			{
				id: 'passkey-2',
				device_name: 'iPhone 15 Pro',
				created_at: Date.now() - 86400000 * 10,
				last_used_at: Date.now() - 86400000 * 3
			}
		];

		sessions = [
			{
				id: 'session-1',
				created_at: Date.now() - 3600000 * 2,
				expires_at: Date.now() + 86400000
			}
		];

		loading = false;
	}

	async function handleSave() {
		if (!user) return;

		saving = true;
		// Simulate API call - would call PUT /admin/users/:id in real implementation
		await new Promise((resolve) => setTimeout(resolve, 1000));
		saving = false;

		alert('User updated successfully');
	}

	async function handleDelete() {
		if (!confirm(m.admin_user_detail_deleteConfirm())) return;

		// Simulate API call - would call DELETE /admin/users/:id in real implementation
		await new Promise((resolve) => setTimeout(resolve, 500));

		window.location.href = '/admin/users';
	}

	function formatDate(timestamp: number | null): string {
		if (!timestamp) return 'Never';
		return new Date(timestamp).toLocaleString();
	}

	function handleDeletePasskey(passkeyId: string) {
		if (confirm('Are you sure you want to delete this passkey?')) {
			passkeys = passkeys.filter((p) => p.id !== passkeyId);
		}
	}

	function handleRevokeSession(sessionId: string) {
		if (confirm('Are you sure you want to revoke this session?')) {
			sessions = sessions.filter((s) => s.id !== sessionId);
		}
	}
</script>

<svelte:head>
	<title>{m.admin_user_detail_title()} - {m.app_title()}</title>
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
				{m.admin_user_detail_title()}
			</h1>
		</div>
		<div class="flex gap-2">
			<Button variant="primary" onclick={handleSave} disabled={saving || loading}>
				{#if saving}
					<div class="i-heroicons-arrow-path h-4 w-4 animate-spin"></div>
				{/if}
				{m.admin_user_detail_save()}
			</Button>
			<Button variant="secondary" onclick={handleDelete} disabled={loading}>
				{m.admin_user_detail_deleteUser()}
			</Button>
		</div>
	</div>

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
				{m.admin_user_detail_basicInfo()}
			</h2>
			<div class="grid gap-4 sm:grid-cols-2">
				<div>
					<label for="email" class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
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
					<label for="given_name" class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
						Given Name
					</label>
					<Input id="given_name" type="text" bind:value={user.given_name} />
				</div>
				<div>
					<label for="family_name" class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
						Family Name
					</label>
					<Input id="family_name" type="text" bind:value={user.family_name} />
				</div>
				<div>
					<label for="phone_number" class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
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
				{m.admin_user_detail_passkeys()}
			</h2>
			{#if passkeys.length === 0}
				<p class="text-sm text-gray-500 dark:text-gray-400">No passkeys registered</p>
			{:else}
				<div class="space-y-3">
					{#each passkeys as passkey (passkey.id)}
						<div class="flex items-center justify-between rounded-lg border border-gray-200 p-3 dark:border-gray-700">
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
				{m.admin_user_detail_sessions()}
			</h2>
			{#if sessions.length === 0}
				<p class="text-sm text-gray-500 dark:text-gray-400">No active sessions</p>
			{:else}
				<div class="space-y-3">
					{#each sessions as session (session.id)}
						<div class="flex items-center justify-between rounded-lg border border-gray-200 p-3 dark:border-gray-700">
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
