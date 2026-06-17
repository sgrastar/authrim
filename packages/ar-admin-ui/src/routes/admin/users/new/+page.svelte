<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { adminUsersAPI, type CreateUserInput } from '$lib/api/admin-users';
	import { ToggleSwitch } from '$lib/components';
	import { adminAuth } from '$lib/stores/admin-auth.svelte';
	import { settingsContext } from '$lib/stores/settings-context.svelte';
	import { LL } from '$i18n/i18n-svelte';
	import AdminPageHeader from '$lib/components/admin/AdminPageHeader.svelte';
	import AdminPageShell from '$lib/components/admin/AdminPageShell.svelte';
	import AdminSection from '$lib/components/admin/AdminSection.svelte';

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

{#snippet headerActions()}
	<a href="/admin/users" class="btn btn-secondary">
		<i class="i-ph-arrow-left"></i>
		{$LL.admin_users_back_to_users()}
	</a>
{/snippet}

<AdminPageShell width="narrow">
	<AdminPageHeader title={$LL.admin_users_create()} actions={headerActions} />

	{#if error}
		<div class="alert alert-error">{error}</div>
	{/if}

	<AdminSection>
		<form
			class="admin-user-form"
			onsubmit={(e) => {
				e.preventDefault();
				handleSubmit();
			}}
		>
			<div class="admin-user-form__fields">
				<div class="form-group">
					<label for="email" class="form-label">
						{$LL.admin_users_email()} <span class="required-marker">*</span>
					</label>
					<input
						id="email"
						type="email"
						class="form-input"
						bind:value={form.email}
						required
						placeholder="user@example.com"
					/>
				</div>

				<div class="form-group">
					<label for="name" class="form-label">
						{$LL.admin_users_name()}
					</label>
					<input
						id="name"
						type="text"
						class="form-input"
						bind:value={form.name}
						placeholder={$LL.common_namePlaceholder()}
					/>
				</div>

				<div class="form-group">
					<label for="given_name" class="form-label">
						{$LL.admin_users_given_name()}
					</label>
					<input
						id="given_name"
						type="text"
						class="form-input"
						bind:value={form.given_name}
						placeholder={$LL.admin_users_given_name_placeholder()}
					/>
				</div>

				<div class="form-group">
					<label for="family_name" class="form-label">
						{$LL.admin_users_family_name()}
					</label>
					<input
						id="family_name"
						type="text"
						class="form-input"
						bind:value={form.family_name}
						placeholder={$LL.admin_users_family_name_placeholder()}
					/>
				</div>

				<ToggleSwitch
					bind:checked={form.email_verified}
					label={$LL.admin_users_verified_label()}
					description={$LL.admin_users_verified_description()}
				/>
			</div>

			<div class="admin-user-form__actions">
				<button type="submit" class="btn btn-primary" disabled={saving || !canCreateUsers}>
					{saving ? $LL.admin_users_creating() : $LL.admin_users_create()}
				</button>
				<a href="/admin/users" class="btn btn-secondary">
					{$LL.common_cancel()}
				</a>
			</div>
		</form>
	</AdminSection>
</AdminPageShell>

<style>
	.admin-user-form {
		max-width: 640px;
	}

	.admin-user-form__fields {
		display: grid;
		gap: 16px;
	}

	.admin-user-form__actions {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
		margin-top: 24px;
	}

	.required-marker {
		color: var(--color-danger);
	}
</style>
