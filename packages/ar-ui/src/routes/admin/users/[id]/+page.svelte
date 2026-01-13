<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { adminUsersAPI, type User, type UpdateUserInput } from '$lib/api/admin-users';
	import { adminSessionsAPI } from '$lib/api/admin-sessions';

	let user: User | null = $state(null);
	let loading = $state(true);
	let error = $state('');
	let isEditing = $state(false);
	let saving = $state(false);
	let actionError = $state('');

	// Edit form state
	let editForm = $state<UpdateUserInput>({});

	// Confirmation dialog state
	let showConfirmDialog = $state(false);
	let confirmAction = $state<'suspend' | 'lock' | 'delete' | 'activate' | 'revoke-sessions' | null>(null);
	let confirmLoading = $state(false);
	let revokedSessionsCount = $state<number | null>(null);

	const userId = $derived($page.params.id ?? '');

	async function loadUser() {
		loading = true;
		error = '';

		try {
			user = await adminUsersAPI.get(userId);
			resetEditForm();
		} catch (err) {
			console.error('Failed to load user:', err);
			error = err instanceof Error ? err.message : 'Failed to load user';
		} finally {
			loading = false;
		}
	}

	function resetEditForm() {
		if (user) {
			editForm = {
				email: user.email || '',
				name: user.name || '',
				given_name: user.given_name || '',
				family_name: user.family_name || '',
				nickname: user.nickname || '',
				preferred_username: user.preferred_username || '',
				phone_number: user.phone_number || '',
				email_verified: user.email_verified,
				phone_number_verified: user.phone_number_verified
			};
		}
	}

	onMount(() => {
		loadUser();
	});

	function startEditing() {
		resetEditForm();
		isEditing = true;
		actionError = '';
	}

	function cancelEditing() {
		isEditing = false;
		resetEditForm();
		actionError = '';
	}

	async function saveChanges() {
		if (!user) return;

		saving = true;
		actionError = '';

		try {
			user = await adminUsersAPI.update(userId, editForm);
			isEditing = false;
		} catch (err) {
			console.error('Failed to update user:', err);
			actionError = err instanceof Error ? err.message : 'Failed to update user';
		} finally {
			saving = false;
		}
	}

	function openConfirmDialog(action: 'suspend' | 'lock' | 'delete' | 'activate' | 'revoke-sessions') {
		confirmAction = action;
		showConfirmDialog = true;
		actionError = '';
		revokedSessionsCount = null;
	}

	function closeConfirmDialog() {
		showConfirmDialog = false;
		confirmAction = null;
		revokedSessionsCount = null;
	}

	async function executeAction() {
		if (!confirmAction) return;

		confirmLoading = true;
		actionError = '';

		try {
			switch (confirmAction) {
				case 'suspend':
					await adminUsersAPI.suspend(userId);
					break;
				case 'lock':
					await adminUsersAPI.lock(userId);
					break;
				case 'activate':
					await adminUsersAPI.activate(userId);
					break;
				case 'revoke-sessions': {
					const result = await adminSessionsAPI.revokeAllForUser(userId);
					revokedSessionsCount = result.revokedCount ?? 0;
					// Don't close dialog immediately - show success message
					confirmLoading = false;
					return;
				}
				case 'delete':
					await adminUsersAPI.delete(userId);
					goto('/admin/users');
					return;
			}
			await loadUser();
			closeConfirmDialog();
		} catch (err) {
			console.error(`Failed to ${confirmAction} user:`, err);
			actionError = err instanceof Error ? err.message : `Failed to ${confirmAction} user`;
		} finally {
			confirmLoading = false;
		}
	}

	function formatTimestamp(timestamp: number | null): string {
		if (!timestamp) return '-';
		return new Date(timestamp).toLocaleString();
	}

	function getStatusBadgeStyle(status: string): string {
		switch (status) {
			case 'active':
				return 'background-color: #d1fae5; color: #065f46;';
			case 'suspended':
				return 'background-color: #fef3c7; color: #92400e;';
			case 'locked':
				return 'background-color: #fee2e2; color: #991b1b;';
			default:
				return 'background-color: #e5e7eb; color: #374151;';
		}
	}

	function getConfirmDialogContent() {
		switch (confirmAction) {
			case 'suspend':
				return {
					title: 'Suspend User',
					description:
						"This will temporarily suspend the user's account. The user will not be able to log in until unsuspended.",
					buttonText: 'Suspend',
					buttonColor: '#f59e0b'
				};
			case 'lock':
				return {
					title: 'Lock User Account',
					description:
						"This will lock the user's account due to security concerns. Use this for suspicious activity or compromised accounts.",
					buttonText: 'Lock',
					buttonColor: '#ef4444'
				};
			case 'activate':
				return {
					title: 'Activate User',
					description:
						"This will restore the user's account to active status. The user will be able to log in again.",
					buttonText: 'Activate',
					buttonColor: '#10b981'
				};
			case 'revoke-sessions':
				return {
					title: 'Revoke All Sessions',
					description:
						'This will immediately log out the user from all devices. The user will need to log in again.',
					buttonText: 'Revoke All',
					buttonColor: '#dc2626'
				};
			case 'delete':
				return {
					title: 'Delete User',
					description: 'This will delete the user. The user will be removed from the list.',
					buttonText: 'Delete',
					buttonColor: '#dc2626'
				};
			default:
				return { title: '', description: '', buttonText: '', buttonColor: '' };
		}
	}
</script>

<svelte:head>
	<title>{user?.email || 'User'} - Admin Dashboard - Authrim</title>
</svelte:head>

<div>
	<!-- Header -->
	<div style="margin-bottom: 24px;">
		<a href="/admin/users" style="color: #3b82f6; text-decoration: none; font-size: 14px;">
			← Back to Users
		</a>
	</div>

	{#if loading}
		<p style="color: #6b7280; text-align: center; padding: 40px;">Loading user...</p>
	{:else if error}
		<div
			style="background-color: #fee2e2; border: 1px solid #ef4444; color: #b91c1c; padding: 12px; border-radius: 6px;"
		>
			{error}
		</div>
	{:else if user}
		<!-- User Header -->
		<div
			style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 24px;"
		>
			<div>
				<h1 style="font-size: 24px; font-weight: bold; color: #1f2937; margin: 0 0 8px 0;">
					{user.name || user.email || 'Unknown User'}
				</h1>
				<p style="color: #6b7280; font-size: 14px; margin: 0;">{user.email}</p>
			</div>
			<span
				style="
				display: inline-block;
				padding: 4px 12px;
				border-radius: 16px;
				font-size: 14px;
				font-weight: 500;
				{getStatusBadgeStyle(user.status)}
			"
			>
				{user.status}
			</span>
		</div>

		{#if actionError}
			<div
				style="background-color: #fee2e2; border: 1px solid #ef4444; color: #b91c1c; padding: 12px; border-radius: 6px; margin-bottom: 16px;"
			>
				{actionError}
			</div>
		{/if}

		<!-- User Details -->
		<div
			style="background-color: white; border-radius: 8px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 16px;"
		>
			<div
				style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;"
			>
				<h2 style="font-size: 18px; font-weight: 600; color: #1f2937; margin: 0;">
					User Information
				</h2>
				{#if !isEditing}
					<button
						onclick={startEditing}
						style="
							padding: 8px 16px;
							background-color: #3b82f6;
							color: white;
							border: none;
							border-radius: 4px;
							cursor: pointer;
							font-size: 14px;
						"
					>
						Edit
					</button>
				{/if}
			</div>

			{#if isEditing}
				<!-- Edit Form -->
				<form
					onsubmit={(e) => {
						e.preventDefault();
						saveChanges();
					}}
				>
					<div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px;">
						<div>
							<label
								for="email"
								style="display: block; font-size: 12px; color: #6b7280; margin-bottom: 4px;"
								>Email</label
							>
							<input
								id="email"
								type="email"
								bind:value={editForm.email}
								style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 14px; box-sizing: border-box;"
							/>
						</div>
						<div>
							<label
								for="name"
								style="display: block; font-size: 12px; color: #6b7280; margin-bottom: 4px;"
								>Name</label
							>
							<input
								id="name"
								type="text"
								bind:value={editForm.name}
								style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 14px; box-sizing: border-box;"
							/>
						</div>
						<div>
							<label
								for="given_name"
								style="display: block; font-size: 12px; color: #6b7280; margin-bottom: 4px;"
								>Given Name</label
							>
							<input
								id="given_name"
								type="text"
								bind:value={editForm.given_name}
								style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 14px; box-sizing: border-box;"
							/>
						</div>
						<div>
							<label
								for="family_name"
								style="display: block; font-size: 12px; color: #6b7280; margin-bottom: 4px;"
								>Family Name</label
							>
							<input
								id="family_name"
								type="text"
								bind:value={editForm.family_name}
								style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 14px; box-sizing: border-box;"
							/>
						</div>
						<div>
							<label
								for="nickname"
								style="display: block; font-size: 12px; color: #6b7280; margin-bottom: 4px;"
								>Nickname</label
							>
							<input
								id="nickname"
								type="text"
								bind:value={editForm.nickname}
								style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 14px; box-sizing: border-box;"
							/>
						</div>
						<div>
							<label
								for="preferred_username"
								style="display: block; font-size: 12px; color: #6b7280; margin-bottom: 4px;"
								>Preferred Username</label
							>
							<input
								id="preferred_username"
								type="text"
								bind:value={editForm.preferred_username}
								style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 14px; box-sizing: border-box;"
							/>
						</div>
						<div>
							<label
								for="phone_number"
								style="display: block; font-size: 12px; color: #6b7280; margin-bottom: 4px;"
								>Phone Number</label
							>
							<input
								id="phone_number"
								type="tel"
								bind:value={editForm.phone_number}
								style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 14px; box-sizing: border-box;"
							/>
						</div>
						<div style="display: flex; align-items: center; gap: 24px; padding-top: 20px;">
							<label
								style="display: flex; align-items: center; gap: 8px; font-size: 14px; color: #374151;"
							>
								<input type="checkbox" bind:checked={editForm.email_verified} />
								Email Verified
							</label>
							<label
								style="display: flex; align-items: center; gap: 8px; font-size: 14px; color: #374151;"
							>
								<input type="checkbox" bind:checked={editForm.phone_number_verified} />
								Phone Verified
							</label>
						</div>
					</div>
					<div style="display: flex; gap: 12px; margin-top: 20px;">
						<button
							type="submit"
							disabled={saving}
							style="
								padding: 10px 20px;
								background-color: {saving ? '#9ca3af' : '#3b82f6'};
								color: white;
								border: none;
								border-radius: 4px;
								cursor: {saving ? 'not-allowed' : 'pointer'};
								font-size: 14px;
							"
						>
							{saving ? 'Saving...' : 'Save Changes'}
						</button>
						<button
							type="button"
							onclick={cancelEditing}
							disabled={saving}
							style="
								padding: 10px 20px;
								background-color: white;
								color: #374151;
								border: 1px solid #d1d5db;
								border-radius: 4px;
								cursor: pointer;
								font-size: 14px;
							"
						>
							Cancel
						</button>
					</div>
				</form>
			{:else}
				<!-- Display Mode -->
				<dl style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; margin: 0;">
					<div>
						<dt style="font-size: 12px; color: #6b7280; margin-bottom: 4px;">ID</dt>
						<dd style="color: #1f2937; margin: 0; font-family: monospace; font-size: 12px;">
							{user.id}
						</dd>
					</div>
					<div>
						<dt style="font-size: 12px; color: #6b7280; margin-bottom: 4px;">Email</dt>
						<dd style="font-size: 14px; color: #1f2937; margin: 0;">{user.email || '-'}</dd>
					</div>
					<div>
						<dt style="font-size: 12px; color: #6b7280; margin-bottom: 4px;">Name</dt>
						<dd style="font-size: 14px; color: #1f2937; margin: 0;">{user.name || '-'}</dd>
					</div>
					<div>
						<dt style="font-size: 12px; color: #6b7280; margin-bottom: 4px;">Given Name</dt>
						<dd style="font-size: 14px; color: #1f2937; margin: 0;">{user.given_name || '-'}</dd>
					</div>
					<div>
						<dt style="font-size: 12px; color: #6b7280; margin-bottom: 4px;">Family Name</dt>
						<dd style="font-size: 14px; color: #1f2937; margin: 0;">{user.family_name || '-'}</dd>
					</div>
					<div>
						<dt style="font-size: 12px; color: #6b7280; margin-bottom: 4px;">Nickname</dt>
						<dd style="font-size: 14px; color: #1f2937; margin: 0;">{user.nickname || '-'}</dd>
					</div>
					<div>
						<dt style="font-size: 12px; color: #6b7280; margin-bottom: 4px;">Preferred Username</dt>
						<dd style="font-size: 14px; color: #1f2937; margin: 0;">
							{user.preferred_username || '-'}
						</dd>
					</div>
					<div>
						<dt style="font-size: 12px; color: #6b7280; margin-bottom: 4px;">Phone Number</dt>
						<dd style="font-size: 14px; color: #1f2937; margin: 0;">{user.phone_number || '-'}</dd>
					</div>
					<div>
						<dt style="font-size: 12px; color: #6b7280; margin-bottom: 4px;">User Type</dt>
						<dd style="font-size: 14px; color: #1f2937; margin: 0;">{user.user_type}</dd>
					</div>
					<div>
						<dt style="font-size: 12px; color: #6b7280; margin-bottom: 4px;">Email Verified</dt>
						<dd style="font-size: 14px; color: #1f2937; margin: 0;">
							{#if user.email_verified}
								<span style="color: #059669;">✓ Yes</span>
							{:else}
								<span style="color: #9ca3af;">✗ No</span>
							{/if}
						</dd>
					</div>
					<div>
						<dt style="font-size: 12px; color: #6b7280; margin-bottom: 4px;">Phone Verified</dt>
						<dd style="font-size: 14px; color: #1f2937; margin: 0;">
							{#if user.phone_number_verified}
								<span style="color: #059669;">✓ Yes</span>
							{:else}
								<span style="color: #9ca3af;">✗ No</span>
							{/if}
						</dd>
					</div>
				</dl>
			{/if}
		</div>

		<!-- Timestamps -->
		<div
			style="background-color: white; border-radius: 8px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 16px;"
		>
			<h2 style="font-size: 18px; font-weight: 600; color: #1f2937; margin: 0 0 16px 0;">
				Timestamps
			</h2>
			<dl style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; margin: 0;">
				<div>
					<dt style="font-size: 12px; color: #6b7280; margin-bottom: 4px;">Created At</dt>
					<dd style="font-size: 14px; color: #1f2937; margin: 0;">
						{formatTimestamp(user.created_at)}
					</dd>
				</div>
				<div>
					<dt style="font-size: 12px; color: #6b7280; margin-bottom: 4px;">Updated At</dt>
					<dd style="font-size: 14px; color: #1f2937; margin: 0;">
						{formatTimestamp(user.updated_at)}
					</dd>
				</div>
				<div>
					<dt style="font-size: 12px; color: #6b7280; margin-bottom: 4px;">Last Login At</dt>
					<dd style="font-size: 14px; color: #1f2937; margin: 0;">
						{formatTimestamp(user.last_login_at)}
					</dd>
				</div>
				{#if user.suspended_at}
					<div>
						<dt style="font-size: 12px; color: #6b7280; margin-bottom: 4px;">Suspended At</dt>
						<dd style="font-size: 14px; color: #f59e0b; margin: 0;">
							{formatTimestamp(user.suspended_at)}
						</dd>
					</div>
				{/if}
				{#if user.locked_at}
					<div>
						<dt style="font-size: 12px; color: #6b7280; margin-bottom: 4px;">Locked At</dt>
						<dd style="font-size: 14px; color: #ef4444; margin: 0;">
							{formatTimestamp(user.locked_at)}
						</dd>
					</div>
				{/if}
			</dl>
		</div>

		<!-- Passkeys -->
		<div
			style="background-color: white; border-radius: 8px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 16px;"
		>
			<h2 style="font-size: 18px; font-weight: 600; color: #1f2937; margin: 0 0 16px 0;">
				Passkeys
			</h2>
			{#if user.passkeys && user.passkeys.length > 0}
				<ul style="list-style: none; padding: 0; margin: 0;">
					{#each user.passkeys as passkey (passkey.id)}
						<li
							style="padding: 12px; border: 1px solid #e5e7eb; border-radius: 6px; margin-bottom: 8px;"
						>
							<div style="display: flex; justify-content: space-between; align-items: center;">
								<div>
									<p style="font-size: 14px; color: #1f2937; margin: 0 0 4px 0; font-weight: 500;">
										{passkey.device_name || 'Unnamed Device'}
									</p>
									<p style="font-size: 12px; color: #6b7280; margin: 0;">
										Created: {formatTimestamp(passkey.created_at)}
									</p>
								</div>
								<p style="font-size: 12px; color: #6b7280; margin: 0;">
									Last used: {formatTimestamp(passkey.last_used_at)}
								</p>
							</div>
						</li>
					{/each}
				</ul>
			{:else}
				<p style="color: #9ca3af; text-align: center; padding: 20px; margin: 0;">
					No passkeys registered
				</p>
			{/if}
		</div>

		<!-- Actions -->
		<div
			style="background-color: white; border-radius: 8px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);"
		>
			<h2 style="font-size: 18px; font-weight: 600; color: #1f2937; margin: 0 0 16px 0;">
				Actions
			</h2>
			<div style="display: flex; gap: 12px; flex-wrap: wrap;">
				{#if user.status === 'active'}
					<button
						onclick={() => openConfirmDialog('suspend')}
						style="
							padding: 10px 20px;
							background-color: #f59e0b;
							color: white;
							border: none;
							border-radius: 4px;
							cursor: pointer;
							font-size: 14px;
						"
					>
						Suspend User
					</button>
					<button
						onclick={() => openConfirmDialog('lock')}
						style="
							padding: 10px 20px;
							background-color: #ef4444;
							color: white;
							border: none;
							border-radius: 4px;
							cursor: pointer;
							font-size: 14px;
						"
					>
						Lock Account
					</button>
				{:else if user.status === 'suspended' || user.status === 'locked'}
					<button
						onclick={() => openConfirmDialog('activate')}
						style="
							padding: 10px 20px;
							background-color: #10b981;
							color: white;
							border: none;
							border-radius: 4px;
							cursor: pointer;
							font-size: 14px;
						"
					>
						Activate User
					</button>
				{/if}
				<button
					onclick={() => openConfirmDialog('revoke-sessions')}
					style="
						padding: 10px 20px;
						background-color: #6366f1;
						color: white;
						border: none;
						border-radius: 4px;
						cursor: pointer;
						font-size: 14px;
					"
				>
					Revoke All Sessions
				</button>
				<button
					onclick={() => openConfirmDialog('delete')}
					style="
						padding: 10px 20px;
						background-color: #dc2626;
						color: white;
						border: none;
						border-radius: 4px;
						cursor: pointer;
						font-size: 14px;
					"
				>
					Delete User
				</button>
			</div>
		</div>
	{/if}
</div>

<!-- Confirmation Dialog -->
{#if showConfirmDialog}
	{@const dialogContent = getConfirmDialogContent()}
	<div
		style="
			position: fixed;
			top: 0;
			left: 0;
			right: 0;
			bottom: 0;
			background-color: rgba(0, 0, 0, 0.5);
			display: flex;
			justify-content: center;
			align-items: center;
			z-index: 1000;
		"
		onclick={closeConfirmDialog}
		onkeydown={(e) => e.key === 'Escape' && closeConfirmDialog()}
		role="dialog"
		aria-modal="true"
		tabindex="-1"
	>
		<div
			style="
				background-color: white;
				border-radius: 8px;
				padding: 24px;
				max-width: 400px;
				width: 90%;
				box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1);
			"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="document"
		>
			<h3 style="font-size: 18px; font-weight: 600; color: #1f2937; margin: 0 0 12px 0;">
				{revokedSessionsCount !== null ? 'Sessions Revoked' : dialogContent.title}
			</h3>
			{#if revokedSessionsCount !== null}
				<!-- Success message for revoke-sessions -->
				<div
					style="background-color: #d1fae5; border: 1px solid #10b981; color: #065f46; padding: 12px; border-radius: 6px; margin-bottom: 16px;"
				>
					Successfully revoked {revokedSessionsCount} session{revokedSessionsCount === 1 ? '' : 's'}.
					{#if revokedSessionsCount > 0}
						Active sessions in memory will expire naturally.
					{/if}
				</div>
				<div style="display: flex; justify-content: flex-end;">
					<button
						onclick={closeConfirmDialog}
						style="
							padding: 10px 20px;
							background-color: #3b82f6;
							color: white;
							border: none;
							border-radius: 4px;
							cursor: pointer;
							font-size: 14px;
						"
					>
						Close
					</button>
				</div>
			{:else}
				<p style="color: #6b7280; font-size: 14px; margin: 0 0 20px 0; line-height: 1.5;">
					{dialogContent.description}
				</p>
				<div style="display: flex; gap: 12px; justify-content: flex-end;">
					<button
						onclick={closeConfirmDialog}
						disabled={confirmLoading}
						style="
							padding: 10px 20px;
							background-color: white;
							color: #374151;
							border: 1px solid #d1d5db;
							border-radius: 4px;
							cursor: pointer;
							font-size: 14px;
						"
					>
						Cancel
					</button>
					<button
						onclick={executeAction}
						disabled={confirmLoading}
						style="
							padding: 10px 20px;
							background-color: {confirmLoading ? '#9ca3af' : dialogContent.buttonColor};
							color: white;
							border: none;
							border-radius: 4px;
							cursor: {confirmLoading ? 'not-allowed' : 'pointer'};
							font-size: 14px;
						"
					>
						{confirmLoading ? 'Processing...' : dialogContent.buttonText}
					</button>
				</div>
			{/if}
		</div>
	</div>
{/if}
