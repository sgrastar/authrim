<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminConsentPoliciesAPI,
		type SignInConfirmationMode,
		type SignInConfirmationPolicy
	} from '#lib/api/admin-consent-policies.js';
	import {
		AdminDataTable,
		AdminPageHeader,
		AdminPageShell,
		AdminSection
	} from '#lib/components/admin/index.js';
	import { ToggleSwitch } from '#lib/components/index.js';
	import { adminAuth } from '#lib/stores/admin-auth.svelte.js';
	import { LL } from '$i18n/i18n-svelte';

	let loading = $state(true);
	let saving = $state(false);
	let error = $state('');
	let successMessage = $state('');
	let signInPolicies = $state<SignInConfirmationPolicy[]>([]);
	let signInForm = $state<{
		mode: SignInConfirmationMode;
		remember_duration_days: number;
		show_application_context: boolean;
		show_tenant_context: boolean;
		is_active: boolean;
	}>({
		mode: 'disabled',
		remember_duration_days: 30,
		show_application_context: true,
		show_tenant_context: true,
		is_active: true
	});

	const canWriteSettings = $derived(adminAuth.hasPermission('admin:settings:write'));
	const writeDisabled = $derived(!canWriteSettings || saving);

	onMount(() => {
		void load();
	});

	async function load() {
		loading = true;
		error = '';
		try {
			const result = await adminConsentPoliciesAPI.listSignInConfirmationPolicies();
			signInPolicies = result.policies || [];
			const loginPolicy = signInPolicies.find((candidate) => candidate.trigger_type === 'login');
			if (loginPolicy) {
				signInForm = {
					mode: loginPolicy.mode,
					remember_duration_days: loginPolicy.remember_duration_days,
					show_application_context: Boolean(loginPolicy.show_application_context),
					show_tenant_context: Boolean(loginPolicy.show_tenant_context),
					is_active: Boolean(loginPolicy.is_active)
				};
			}
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_signin_confirmation_load_error();
		} finally {
			loading = false;
		}
	}

	async function saveSignInPolicy() {
		if (!canWriteSettings) {
			error = $LL.admin_signin_confirmation_permission();
			return;
		}
		saving = true;
		error = '';
		successMessage = '';
		try {
			const result = await adminConsentPoliciesAPI.upsertSignInConfirmationPolicy(signInForm);
			signInPolicies = result.policies || [];
			successMessage = $LL.admin_signin_confirmation_saved();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_signin_confirmation_save_error();
		} finally {
			saving = false;
		}
	}

	function formatBool(value: number | boolean) {
		return value
			? $LL.admin_signin_confirmation_enabled()
			: $LL.admin_signin_confirmation_disabled();
	}

	function formatSignInMode(mode: SignInConfirmationMode) {
		if (mode === 'first_time') return $LL.admin_signin_confirmation_mode_first_time();
		if (mode === 'every_time') return $LL.admin_signin_confirmation_mode_every_time();
		return $LL.admin_signin_confirmation_mode_disabled();
	}
</script>

<svelte:head>
	<title>{$LL.admin_signin_confirmation_page_title()}</title>
</svelte:head>

<AdminPageShell>
	<AdminPageHeader
		title={$LL.admin_signin_confirmation_title()}
		description={$LL.admin_signin_confirmation_description()}
	/>

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner" aria-hidden="true"></i>
			<p>{$LL.admin_signin_confirmation_loading()}</p>
		</div>
	{:else}
		{#if error}
			<div class="alert alert-error">{error}</div>
		{/if}
		{#if successMessage}
			<div class="alert alert-success">{successMessage}</div>
		{/if}
		<AdminSection>
			<div class="form-grid">
				<div class="admin-field">
					<label for="sign-in-mode" class="admin-field__label">
						{$LL.admin_signin_confirmation_mode()}
					</label>
					<select
						id="sign-in-mode"
						class="admin-select"
						bind:value={signInForm.mode}
						disabled={!canWriteSettings}
					>
						<option value="disabled">{$LL.admin_signin_confirmation_mode_disabled()}</option>
						<option value="first_time">{$LL.admin_signin_confirmation_mode_first_time()}</option>
						<option value="every_time">{$LL.admin_signin_confirmation_mode_every_time()}</option>
					</select>
				</div>
				<div class="admin-field">
					<label for="remember-days" class="admin-field__label">
						{$LL.admin_signin_confirmation_remember_days()}
					</label>
					<input
						id="remember-days"
						class="admin-input"
						type="number"
						min="0"
						max="3650"
						bind:value={signInForm.remember_duration_days}
						disabled={!canWriteSettings}
					/>
				</div>
			</div>
			<div class="behavior-settings-list">
				<ToggleSwitch
					bind:checked={signInForm.show_application_context}
					disabled={!canWriteSettings}
					label={$LL.admin_signin_confirmation_show_application_context()}
				/>
				<ToggleSwitch
					bind:checked={signInForm.show_tenant_context}
					disabled={!canWriteSettings}
					label={$LL.admin_signin_confirmation_show_tenant_context()}
				/>
				<ToggleSwitch
					bind:checked={signInForm.is_active}
					disabled={!canWriteSettings}
					label={$LL.admin_signin_confirmation_active()}
				/>
			</div>
			<div class="section-actions">
				<button
					class="btn btn-primary"
					type="button"
					onclick={saveSignInPolicy}
					disabled={writeDisabled}
				>
					<i class="i-ph-floppy-disk" aria-hidden="true"></i>
					{$LL.admin_signin_confirmation_save()}
				</button>
			</div>

			<AdminDataTable>
				<thead>
					<tr>
						<th>{$LL.admin_signin_confirmation_name()}</th>
						<th>{$LL.admin_signin_confirmation_mode()}</th>
						<th>{$LL.admin_signin_confirmation_remember_days()}</th>
						<th>{$LL.admin_signin_confirmation_context()}</th>
						<th>{$LL.admin_signin_confirmation_status()}</th>
					</tr>
				</thead>
				<tbody>
					{#each signInPolicies as signInPolicy (signInPolicy.id)}
						<tr>
							<td>{signInPolicy.display_name}</td>
							<td>{formatSignInMode(signInPolicy.mode)}</td>
							<td>
								{$LL.admin_signin_confirmation_remember_days_value({
									days: signInPolicy.remember_duration_days
								})}
							</td>
							<td>
								{$LL.admin_signin_confirmation_context_summary({
									app: formatBool(signInPolicy.show_application_context),
									tenant: formatBool(signInPolicy.show_tenant_context)
								})}
							</td>
							<td>{formatBool(signInPolicy.is_active)}</td>
						</tr>
					{:else}
						<tr>
							<td colspan="5" class="empty-cell">
								{$LL.admin_signin_confirmation_none()}
							</td>
						</tr>
					{/each}
				</tbody>
			</AdminDataTable>
		</AdminSection>
	{/if}
</AdminPageShell>

<style>
	.form-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 16px;
		max-width: 980px;
	}

	.empty-cell {
		padding: 18px;
		text-align: center;
		color: var(--color-text-muted);
		font-size: 0.84rem;
	}

	.behavior-settings-list {
		display: grid;
		gap: 14px;
		margin-top: 16px;
	}

	.section-actions {
		display: flex;
		justify-content: flex-end;
		margin: 16px 0;
	}

	@media (max-width: 760px) {
		.form-grid {
			grid-template-columns: 1fr;
		}

		.section-actions {
			justify-content: stretch;
		}
	}
</style>
