<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminConsentPoliciesAPI,
		type ClientTrustPolicy,
		type ClientTrustPolicyTargetType,
		type ConsentPolicy,
		type ConsentPolicyAssignment,
		type ConsentPolicyAssignmentType
	} from '$lib/api/admin-consent-policies';
	import { ToggleSwitch } from '$lib/components';

	type TargetType = Extract<ConsentPolicyAssignmentType, 'oidc_client' | 'saml_sp'>;

	interface Props {
		targetType: TargetType;
		targetId: string;
		title?: string;
	}

	let { targetType, targetId, title = 'Consent policy' }: Props = $props();

	let policies = $state<ConsentPolicy[]>([]);
	let selectedPolicyId = $state('');
	let firstParty = $state(false);
	let trusted = $state(false);
	let skipAuthorizationConsent = $state(false);
	let trustPolicyActive = $state(true);
	let loading = $state(true);
	let saving = $state(false);
	let message = $state('');
	let error = $state('');

	function findAssignment(assignments: ConsentPolicyAssignment[]) {
		return assignments.find(
			(item) => item.assignment_type === targetType && item.target_id === targetId
		);
	}

	function findTrustPolicy(items: ClientTrustPolicy[]) {
		return items.find((item) => item.target_type === targetType && item.target_id === targetId);
	}

	async function loadSettings() {
		if (!targetId) return;
		loading = true;
		error = '';
		message = '';
		try {
			const [policyResult, assignmentResult, trustResult] = await Promise.all([
				adminConsentPoliciesAPI.listPolicies(),
				adminConsentPoliciesAPI.listAssignments(),
				adminConsentPoliciesAPI.listClientTrustPolicies()
			]);
			policies = policyResult.policies;

			const assignment = findAssignment(assignmentResult.assignments);
			selectedPolicyId = assignment?.policy_id ?? '';

			const trustPolicy = findTrustPolicy(trustResult.policies);
			firstParty = trustPolicy?.first_party === 1;
			trusted = trustPolicy?.trusted === 1;
			skipAuthorizationConsent = trustPolicy?.skip_authorization_consent === 1;
			trustPolicyActive = trustPolicy ? trustPolicy.is_active === 1 : true;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load consent policy settings';
		} finally {
			loading = false;
		}
	}

	async function saveSettings() {
		if (!targetId) return;
		if (!selectedPolicyId) {
			error = 'Select a consent policy before saving.';
			return;
		}
		saving = true;
		error = '';
		message = '';
		try {
			await adminConsentPoliciesAPI.upsertAssignment({
				assignment_type: targetType,
				target_id: targetId,
				policy_id: selectedPolicyId
			});

			await adminConsentPoliciesAPI.upsertClientTrustPolicy({
				target_type: targetType as ClientTrustPolicyTargetType,
				target_id: targetId,
				first_party: firstParty,
				trusted,
				skip_authorization_consent: skipAuthorizationConsent,
				is_active: trustPolicyActive
			});

			message = 'Consent policy settings saved.';
			await loadSettings();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to save consent policy settings';
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
			<h3>{title}</h3>
			<p>Assign the consent set and trust behavior used when this application requests access.</p>
		</div>
		<button type="button" class="btn btn-secondary btn-sm" onclick={() => void loadSettings()}>
			Refresh
		</button>
	</div>

	{#if loading}
		<p class="field-hint">Loading consent policy settings...</p>
	{:else}
		{#if error}
			<div class="alert alert-error">{error}</div>
		{/if}
		{#if message}
			<div class="alert alert-success">{message}</div>
		{/if}

		<div class="form-grid consent-policy-target__grid">
			<div class="admin-field admin-field--full">
				<label class="admin-field__label" for={`consent-policy-${targetType}-${targetId}`}>
					Consent set
				</label>
				<select
					id={`consent-policy-${targetType}-${targetId}`}
					class="admin-select"
					bind:value={selectedPolicyId}
				>
					<option value="">Select consent policy</option>
					{#each policies as policy (policy.id)}
						<option value={policy.id}>{policy.display_name || policy.name}</option>
					{/each}
				</select>
				<p class="field-hint">A target-specific consent policy is required.</p>
			</div>
		</div>

		<div class="behavior-settings-list">
			<ToggleSwitch
				bind:checked={firstParty}
				label="First-party application"
				description="Marks the application as operated by the same service owner."
			/>
			<ToggleSwitch
				bind:checked={trusted}
				label="Trusted application"
				description="Allows authorization consent to be skipped unless prompt=consent is requested."
			/>
			<ToggleSwitch
				bind:checked={skipAuthorizationConsent}
				label="Skip authorization consent"
				description="Skips the OAuth/SAML authorization consent screen for this target."
			/>
			<ToggleSwitch
				bind:checked={trustPolicyActive}
				label="Trust policy active"
				description="Disabling this leaves the record saved but ignored at runtime."
			/>
		</div>

		<div class="form-actions">
			<button type="button" class="btn btn-primary" onclick={saveSettings} disabled={saving}>
				{saving ? 'Saving...' : 'Save consent policy settings'}
			</button>
			<a class="btn btn-secondary" href="/admin/consent-policies">Manage consent sets</a>
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
