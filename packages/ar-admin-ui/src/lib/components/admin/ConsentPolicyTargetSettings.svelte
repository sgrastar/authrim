<script lang="ts">
	import { LL } from '$i18n/i18n-svelte';
	import { onMount } from 'svelte';
	import {
		adminConsentPoliciesAPI,
		type ClientTrustPolicy,
		type ClientTrustPolicyTargetType
	} from '$lib/api/admin-consent-policies';
	import { ToggleSwitch } from '$lib/components';

	type TargetType = ClientTrustPolicyTargetType;

	interface Props {
		targetType: TargetType;
		targetId: string;
		title?: string;
	}

	let { targetType, targetId, title = '' }: Props = $props();

	let firstParty = $state(false);
	let trusted = $state(false);
	let skipAuthorizationConsent = $state(false);
	let trustPolicyActive = $state(true);
	let loading = $state(true);
	let saving = $state(false);
	let message = $state('');
	let error = $state('');

	function findTrustPolicy(items: ClientTrustPolicy[]) {
		return items.find((item) => item.target_type === targetType && item.target_id === targetId);
	}

	async function loadSettings() {
		if (!targetId) return;
		loading = true;
		error = '';
		message = '';
		try {
			const trustResult = await adminConsentPoliciesAPI.listClientTrustPolicies();
			const trustPolicy = findTrustPolicy(trustResult.policies);
			firstParty = trustPolicy?.first_party === 1;
			trusted = trustPolicy?.trusted === 1;
			skipAuthorizationConsent = trustPolicy?.skip_authorization_consent === 1;
			trustPolicyActive = trustPolicy ? trustPolicy.is_active === 1 : true;
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_flows_trust_policy_load_failed();
		} finally {
			loading = false;
		}
	}

	async function saveSettings() {
		if (!targetId) return;
		saving = true;
		error = '';
		message = '';
		try {
			await adminConsentPoliciesAPI.upsertClientTrustPolicy({
				target_type: targetType as ClientTrustPolicyTargetType,
				target_id: targetId,
				first_party: firstParty,
				trusted,
				skip_authorization_consent: skipAuthorizationConsent,
				is_active: trustPolicyActive
			});

			message = $LL.admin_flows_trust_policy_saved();
			await loadSettings();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_flows_trust_policy_save_failed();
		} finally {
			saving = false;
		}
	}

	onMount(() => {
		void loadSettings();
	});
</script>

<div class="consent-policy-target">
	<div class="consent-policy-target__header">
		<div>
			<h3>{title || $LL.admin_flows_trust_policy_title()}</h3>
			<p>{$LL.admin_flows_trust_policy_description()}</p>
		</div>
		<button type="button" class="btn btn-secondary btn-sm" onclick={() => void loadSettings()}>
			{$LL.admin_flows_refresh()}
		</button>
	</div>

	{#if loading}
		<p class="field-hint">{$LL.admin_flows_trust_policy_loading()}</p>
	{:else}
		{#if error}
			<div class="alert alert-error">{error}</div>
		{/if}
		{#if message}
			<div class="alert alert-success">{message}</div>
		{/if}

		<div class="form-grid consent-policy-target__grid">
			<div class="admin-field admin-field--full">
				<p class="field-hint">
					{$LL.admin_flows_trust_policy_flow_hint()}
				</p>
				<a class="btn btn-secondary btn-sm" href="/admin/flows">
					{$LL.admin_flows_open_flow_settings()}
				</a>
			</div>
		</div>

		<div class="behavior-settings-list">
			<ToggleSwitch
				bind:checked={firstParty}
				label={$LL.admin_flows_trust_policy_first_party_label()}
				description={$LL.admin_flows_trust_policy_first_party_description()}
			/>
			<ToggleSwitch
				bind:checked={trusted}
				label={$LL.admin_flows_trust_policy_trusted_label()}
				description={$LL.admin_flows_trust_policy_trusted_description()}
			/>
			<ToggleSwitch
				bind:checked={skipAuthorizationConsent}
				label={$LL.admin_flows_trust_policy_skip_consent_label()}
				description={$LL.admin_flows_trust_policy_skip_consent_description()}
			/>
			<ToggleSwitch
				bind:checked={trustPolicyActive}
				label={$LL.admin_flows_trust_policy_active_label()}
				description={$LL.admin_flows_trust_policy_active_description()}
			/>
		</div>

		<div class="form-actions">
			<button type="button" class="btn btn-primary" onclick={saveSettings} disabled={saving}>
				{saving ? $LL.admin_flows_trust_policy_saving() : $LL.admin_flows_trust_policy_save()}
			</button>
			<a class="btn btn-secondary" href="/admin/flows">{$LL.admin_flows_manage_flows()}</a>
		</div>
	{/if}
</div>

<style>
	.consent-policy-target {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.consent-policy-target__header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
	}

	.consent-policy-target__header h3 {
		margin: 0 0 0.25rem;
		font-size: 1rem;
		font-weight: 650;
		color: var(--text-primary);
	}

	.consent-policy-target__header p {
		margin: 0;
		color: var(--text-secondary);
		font-size: 0.875rem;
	}

	.consent-policy-target__grid {
		margin: 0;
	}

	.form-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
	}
</style>
