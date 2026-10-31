<script lang="ts">
	import GuestLifecycleStatus from '$lib/components/admin/GuestLifecycleStatus.svelte';
	import GuestRetentionPreview from '$lib/components/admin/GuestRetentionPreview.svelte';
	import { onMount } from 'svelte';
	import { LL } from '$i18n/i18n-svelte';
	import { adminSettingsAPI, type CategorySettings } from '$lib/api/admin-settings';
	import { settingsContext } from '$lib/stores/settings-context.svelte';
	import { ToggleSwitch } from '$lib/components';
	import { AdminPageHeader, AdminPageShell, AdminSection } from '$lib/components/admin';

	let ready = $state(false);
	let loading = $state(true);
	let saving = $state(false);
	let error = $state('');
	let success = $state('');
	let settings = $state<CategorySettings | null>(null);
	let loadedTenant = $state('');
	let deletionEnabled = $state(false);
	let days = $state<number | undefined>(30);
	let upgradeEnabled = $state(true);
	let holdMinutes = $state<number | undefined>(10);
	let initial = $state('');
	const tenantId = $derived(settingsContext.tenantId);
	const canEdit = $derived(settingsContext.canEditAtCurrentScope());
	const values = $derived({
		'account-lifecycle.guest.deletion_enabled': deletionEnabled,
		'account-lifecycle.guest.deletion_after_days': days,
		'account-lifecycle.guest.upgrade_enabled': upgradeEnabled,
		'account-lifecycle.guest.upgrade_hold_minutes': holdMinutes
	});
	const dirty = $derived(JSON.stringify(values) !== initial);
	let requestId = 0;

	onMount(async () => {
		await settingsContext.initialize();
		ready = true;
	});
	$effect(() => {
		if (ready && tenantId) void load(tenantId);
	});

	async function load(targetTenant: string) {
		const request = ++requestId;
		loading = true;
		settings = null;
		error = '';
		success = '';
		try {
			const result = await adminSettingsAPI.getSettings('account-lifecycle', targetTenant);
			if (request !== requestId || tenantId !== targetTenant) return;
			settings = result;
			loadedTenant = targetTenant;
			deletionEnabled = result.values['account-lifecycle.guest.deletion_enabled'] === true;
			days = Number(result.values['account-lifecycle.guest.deletion_after_days'] ?? 30);
			upgradeEnabled = result.values['account-lifecycle.guest.upgrade_enabled'] === true;
			holdMinutes = Number(result.values['account-lifecycle.guest.upgrade_hold_minutes'] ?? 10);
			initial = JSON.stringify({
				'account-lifecycle.guest.deletion_enabled': deletionEnabled,
				'account-lifecycle.guest.deletion_after_days': days,
				'account-lifecycle.guest.upgrade_enabled': upgradeEnabled,
				'account-lifecycle.guest.upgrade_hold_minutes': holdMinutes
			});
		} catch (err) {
			if (request === requestId)
				error = err instanceof Error ? err.message : $LL.admin_authentication_methods_error_load();
		} finally {
			if (request === requestId) loading = false;
		}
	}

	async function save() {
		if (!settings || !canEdit || loading || saving || loadedTenant !== tenantId) return;
		if (
			!Number.isSafeInteger(days) ||
			days! < 1 ||
			days! > 3650 ||
			!Number.isSafeInteger(holdMinutes) ||
			holdMinutes! < 1 ||
			holdMinutes! > 60
		) {
			error = $LL.admin_lifecycle_invalid();
			return;
		}
		const targetTenant = loadedTenant;
		const submitted = { ...values };
		const version = settings.version;
		saving = true;
		error = '';
		success = '';
		try {
			const result = await adminSettingsAPI.updateSettings(
				'account-lifecycle',
				{ ifMatch: version, set: submitted },
				targetTenant
			);
			if (tenantId !== targetTenant || loadedTenant !== targetTenant) return;
			settings = { ...settings!, version: result.version };
			initial = JSON.stringify(submitted);
			success = $LL.admin_account_lifecycle_saved();
		} catch (err) {
			if (tenantId === targetTenant)
				error = err instanceof Error ? err.message : $LL.admin_authentication_methods_error_save();
		} finally {
			saving = false;
		}
	}
</script>

<AdminPageShell>
	<AdminPageHeader
		title={$LL.admin_lifecycle_title()}
		description={$LL.admin_lifecycle_description()}
	/>
	{#if error}<p role="alert">{error}</p>{/if}
	{#if success}<p role="status">{success}</p>{/if}
	{#if loading}
		<p>{$LL.admin_authentication_methods_loading()}</p>
	{:else if settings}
		<form
			onsubmit={(event) => {
				event.preventDefault();
				void save();
			}}
		>
			<AdminSection
				title={$LL.admin_guest_login_title()}
				description={$LL.admin_lifecycle_new_only()}
			>
				<div class="fields">
					<ToggleSwitch
						bind:checked={deletionEnabled}
						disabled={!canEdit || saving}
						label={$LL.admin_lifecycle_delete()}
						description={$LL.admin_lifecycle_delete_help()}
					/>
					{#if deletionEnabled}
						<label for="retention-days">{$LL.admin_lifecycle_days()}</label>
						<input
							id="retention-days"
							type="number"
							min="1"
							max="3650"
							step="1"
							required
							bind:value={days}
							list="retention-presets"
							disabled={!canEdit || saving}
						/>
						<datalist id="retention-presets"
							>{#each [1, 7, 14, 30, 90, 180, 365] as preset (preset)}<option value={preset}
								></option>{/each}</datalist
						>
					{/if}
				</div>
			</AdminSection>
			<AdminSection title={$LL.admin_lifecycle_upgrade()}>
				<div class="fields">
					<ToggleSwitch
						bind:checked={upgradeEnabled}
						disabled={!canEdit || saving}
						label={$LL.admin_lifecycle_upgrade()}
					/>
					<label for="upgrade-hold">{$LL.admin_lifecycle_hold()}</label>
					<input
						id="upgrade-hold"
						type="number"
						min="1"
						max="60"
						step="1"
						required
						bind:value={holdMinutes}
						disabled={!canEdit || saving}
						aria-describedby="hold-help"
					/>
					<p id="hold-help">{$LL.admin_lifecycle_hold_help()}</p>
					<a class="settings-link" href="/admin/authentication-methods"
						>{$LL.admin_guest_upgrade_methods()}</a
					>
				</div>
			</AdminSection>
			<p>{$LL.admin_lifecycle_other()}</p>
			<button
				class="btn btn-primary"
				type="submit"
				disabled={!canEdit || saving || !dirty || loadedTenant !== tenantId}
				>{saving
					? $LL.admin_authentication_methods_saving()
					: $LL.admin_authentication_methods_save()}</button
			>
		</form>
		{#key tenantId}<GuestLifecycleStatus {tenantId} />{/key}
		<GuestRetentionPreview
			{tenantId}
			policyVersion={settings.version}
			disabled={!canEdit || saving || dirty || loadedTenant !== tenantId}
		/>
	{/if}
</AdminPageShell>

<style>
	.settings-link {
		color: var(--text-primary);
		text-decoration: underline;
	}
	.fields {
		display: grid;
		gap: 12px;
	}
	input {
		max-width: 14rem;
		padding: 8px 12px;
	}
	p {
		color: var(--color-text-secondary);
	}
	[role='alert'] {
		color: var(--color-error);
	}
</style>
