<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { adminUsersAPI, type CreateUserInput } from '$lib/api/admin-users';
	import { ToggleSwitch } from '$lib/components';
	import { adminAuth } from '$lib/stores/admin-auth.svelte';
	import { settingsContext } from '$lib/stores/settings-context.svelte';
	import { LL } from '$i18n/i18n-svelte';

	let saving = $state(false);
	let error = $state('');

	// Form state
	let form = $state<CreateUserInput>({
		email: '',
		name: '',
		given_name: '',
		family_name: '',
		email_verified: false
	});
	const canCreateUsers = $derived(adminAuth.hasPermission('admin:users:write'));

	async function handleSubmit() {
		if (!canCreateUsers) return;
		if (!form.email?.trim()) {
			error = $LL.admin_users_email_required();
			return;
		}

		saving = true;
		error = '';

		try {
			const user = await adminUsersAPI.create({
				email: form.email.trim(),
				name: form.name?.trim() || undefined,
				given_name: form.given_name?.trim() || undefined,
				family_name: form.family_name?.trim() || undefined,
				email_verified: form.email_verified
			});
			goto(`/admin/users/${user.id}`);
		} catch (err) {
			console.error('Failed to create user:', err);
			error = err instanceof Error ? err.message : $LL.admin_users_error_create();
		} finally {
			saving = false;
		}
	}

	onMount(async () => {
		await settingsContext.initialize();
	});
</script>

<svelte:head>
	<title>{$LL.admin_users_create_page_title()}</title>
</svelte:head>

<div>
	<!-- Header -->
	<div style="margin-bottom: 24px;">
		<a href="/admin/users" style="color: #3b82f6; text-decoration: none; font-size: 14px;">
			← {$LL.admin_users_back_to_users()}
		</a>
	</div>

	<h1 style="font-size: 24px; font-weight: bold; color: #1f2937; margin: 0 0 24px 0;">
		{$LL.admin_users_create()}
	</h1>

	{#if error}
		<div
			style="background-color: #fee2e2; border: 1px solid #ef4444; color: #b91c1c; padding: 12px; border-radius: 6px; margin-bottom: 16px;"
		>
			{error}
		</div>
	{/if}

	<div
		style="background-color: white; border-radius: 8px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); max-width: 600px;"
	>
		<form
			onsubmit={(e) => {
				e.preventDefault();
				handleSubmit();
			}}
		>
			<div style="display: flex; flex-direction: column; gap: 16px;">
				<!-- Email (required) -->
				<div>
					<label
						for="email"
						style="display: block; font-size: 14px; font-weight: 500; color: #374151; margin-bottom: 4px;"
					>
						{$LL.admin_users_email()} <span style="color: #ef4444;">*</span>
					</label>
					<input
						id="email"
						type="email"
						bind:value={form.email}
						required
						placeholder="user@example.com"
						style="
							width: 100%;
							padding: 10px 12px;
							border: 1px solid #d1d5db;
							border-radius: 6px;
							font-size: 14px;
							box-sizing: border-box;
						"
					/>
				</div>

				<!-- Name -->
				<div>
					<label
						for="name"
						style="display: block; font-size: 14px; font-weight: 500; color: #374151; margin-bottom: 4px;"
					>
						{$LL.admin_users_name()}
					</label>
					<input
						id="name"
						type="text"
						bind:value={form.name}
						placeholder={$LL.common_namePlaceholder()}
						style="
							width: 100%;
							padding: 10px 12px;
							border: 1px solid #d1d5db;
							border-radius: 6px;
							font-size: 14px;
							box-sizing: border-box;
						"
					/>
				</div>

				<!-- Given Name -->
				<div>
					<label
						for="given_name"
						style="display: block; font-size: 14px; font-weight: 500; color: #374151; margin-bottom: 4px;"
					>
						{$LL.admin_users_given_name()}
					</label>
					<input
						id="given_name"
						type="text"
						bind:value={form.given_name}
						placeholder={$LL.admin_users_given_name_placeholder()}
						style="
							width: 100%;
							padding: 10px 12px;
							border: 1px solid #d1d5db;
							border-radius: 6px;
							font-size: 14px;
							box-sizing: border-box;
						"
					/>
				</div>

				<!-- Family Name -->
				<div>
					<label
						for="family_name"
						style="display: block; font-size: 14px; font-weight: 500; color: #374151; margin-bottom: 4px;"
					>
						{$LL.admin_users_family_name()}
					</label>
					<input
						id="family_name"
						type="text"
						bind:value={form.family_name}
						placeholder={$LL.admin_users_family_name_placeholder()}
						style="
							width: 100%;
							padding: 10px 12px;
							border: 1px solid #d1d5db;
							border-radius: 6px;
							font-size: 14px;
							box-sizing: border-box;
						"
					/>
				</div>

				<!-- Email Verified -->
				<div>
					<ToggleSwitch
						bind:checked={form.email_verified}
						label={$LL.admin_users_verified_label()}
						description={$LL.admin_users_verified_description()}
					/>
				</div>
			</div>

			<!-- Buttons -->
			<div style="display: flex; gap: 12px; margin-top: 24px;">
				<button
					type="submit"
					disabled={saving || !canCreateUsers}
					style="
						padding: 10px 24px;
						background-color: {saving || !canCreateUsers ? '#9ca3af' : '#3b82f6'};
						color: white;
						border: none;
						border-radius: 6px;
						cursor: {saving || !canCreateUsers ? 'not-allowed' : 'pointer'};
						font-size: 14px;
						font-weight: 500;
					"
				>
					{saving ? $LL.admin_users_creating() : $LL.admin_users_create()}
				</button>
				<a
					href="/admin/users"
					style="
						padding: 10px 24px;
						background-color: white;
						color: #374151;
						border: 1px solid #d1d5db;
						border-radius: 6px;
						text-decoration: none;
						font-size: 14px;
						font-weight: 500;
					"
				>
					{$LL.common_cancel()}
				</a>
			</div>
		</form>
	</div>
</div>
