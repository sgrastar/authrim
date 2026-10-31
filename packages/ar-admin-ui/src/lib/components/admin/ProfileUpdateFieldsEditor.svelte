<script lang="ts">
	import { onMount } from 'svelte';
	import { LL } from '$i18n/i18n-svelte';
	import { ToggleSwitch } from '$lib/components';
	import { adminSettingsAPI } from '$lib/api/admin-settings';
	import { settingsContext } from '$lib/stores/settings-context.svelte';

	/**
	 * The profile fields a login from one IdP updates: null follows the tenant's
	 * external_idp.jit_update_fields; a list (empty: none) is the IdP's own choice.
	 */
	interface Props {
		value?: string[] | null;
	}

	let { value = $bindable(null) }: Props = $props();

	// The tenant default (external_idp.jit_update_fields): which fields apply while it is followed,
	// and what turning it off starts from, so it is used only once read.
	type TenantDefault =
		| { status: 'loading' }
		| { status: 'loaded'; fields: string[] }
		| { status: 'failed' };
	let tenantDefault = $state<TenantDefault>({ status: 'loading' });
	onMount(async () => {
		try {
			const settings = await adminSettingsAPI.getSettings('external-idp', settingsContext.tenantId);
			const fields = settings.values['external_idp.jit_update_fields'];
			tenantDefault = {
				status: 'loaded',
				fields: Array.isArray(fields)
					? fields.filter((field): field is string => typeof field === 'string')
					: []
			};
		} catch {
			tenantDefault = { status: 'failed' };
		}
	});

	// The standard profile claims a login may update (not preferred_username, an identifier).
	const FIELDS = [
		'name',
		'given_name',
		'family_name',
		'middle_name',
		'nickname',
		'profile',
		'picture',
		'website',
		'gender',
		'birthdate',
		'zoneinfo',
		'locale'
	] as const;

	// Shown from value alone, so a parent reloading it is what the page shows and saves.
	const useTenantDefault = $derived(value === null);
	const chosen = $derived(value ?? []);
	// Turning the default off copies it, so not before it is read.
	const toggleDisabled = $derived(useTenantDefault && tenantDefault.status !== 'loaded');

	function followTenant(follow: boolean) {
		if (follow) {
			value = null;
		} else if (tenantDefault.status === 'loaded') {
			// Start from what applies now, so turning the default off changes nothing until edited.
			value = [...tenantDefault.fields];
		}
	}

	function toggle(field: string, on: boolean) {
		value = on
			? FIELDS.filter((f) => f === field || chosen.includes(f))
			: chosen.filter((f) => f !== field);
	}
</script>

<div class="profile-update-fields">
	<ToggleSwitch
		checked={useTenantDefault}
		disabled={toggleDisabled}
		label={$LL.admin_external_idp_profile_update_fields_tenant_default()}
		description={$LL.admin_external_idp_profile_update_fields_desc()}
		onchange={followTenant}
	/>
	{#if useTenantDefault}
		<p class="field-hint">
			{#if tenantDefault.status === 'loading'}
				{$LL.admin_external_idp_profile_update_fields_tenant_loading()}
			{:else if tenantDefault.status === 'failed'}
				{$LL.admin_external_idp_profile_update_fields_tenant_failed()}
			{:else if tenantDefault.fields.length === 0}
				{$LL.admin_external_idp_profile_update_fields_tenant_empty()}
			{:else}
				{$LL.admin_external_idp_profile_update_fields_tenant_current()}
				<code>{tenantDefault.fields.join(', ')}</code>
			{/if}
		</p>
	{:else}
		<fieldset class="field-grid">
			<legend>{$LL.admin_external_idp_profile_update_fields()}</legend>
			{#each FIELDS as field (field)}
				<label class="field-option">
					<input
						type="checkbox"
						checked={chosen.includes(field)}
						onchange={(event) => toggle(field, (event.currentTarget as HTMLInputElement).checked)}
					/>
					<code>{field}</code>
				</label>
			{/each}
		</fieldset>
		{#if chosen.length === 0}
			<p class="field-hint">{$LL.admin_external_idp_profile_update_fields_none()}</p>
		{/if}
	{/if}
</div>

<style>
	.profile-update-fields {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.field-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr));
		gap: 0.5rem 1rem;
		margin: 0;
		padding: 0;
		border: none;
	}

	.field-grid legend {
		margin-bottom: 0.5rem;
		font-weight: 600;
	}

	.field-option {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		cursor: pointer;
	}

	.field-hint {
		margin: 0;
		color: var(--text-secondary, inherit);
		font-size: 0.875rem;
	}
</style>
