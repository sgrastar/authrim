<script lang="ts">
	import { goto } from '$app/navigation';
	import {
		adminAgentAccessAPI,
		type AgentConfigurationPlanDefinition
	} from '$lib/api/admin-agent-access';
	import {
		AdminPageHeader,
		AdminPageShell,
		AdminSection,
		AgentAccessNav
	} from '$lib/components/admin';
	import { LL } from '$i18n/i18n-svelte';

	let grantId = $state('');
	let credentialId = $state('');
	let targets = $state('');
	let canaries = $state('');
	let planJson = $state(
		JSON.stringify({ schemaVersion: 'authrim-agent-plan-v1', steps: [] }, null, 2)
	);
	let saving = $state(false);
	let error = $state('');
	const lines = (value: string) => [
		...new Set(
			value
				.split(/\r?\n|,/)
				.map((entry) => entry.trim())
				.filter(Boolean)
		)
	];

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		saving = true;
		error = '';
		try {
			const plan = JSON.parse(planJson) as AgentConfigurationPlanDefinition;
			const result = await adminAgentAccessAPI.createBulkPlan({
				grant_id: grantId.trim(),
				machine_credential_id: credentialId.trim(),
				definition: {
					schemaVersion: 'authrim-agent-bulk-plan-v1',
					targetTenantIds: lines(targets),
					canaryTenantIds: lines(canaries),
					plan
				}
			});
			await goto(
				`/admin/agent-access/bulk-plans/${encodeURIComponent(result.id)}/${result.version}`
			);
		} catch (caught) {
			error = caught instanceof Error ? caught.message : $LL.admin_agent_access_load_error();
		} finally {
			saving = false;
		}
	}
</script>

<svelte:head><title>{$LL.admin_agent_access_bulk_new()}</title></svelte:head>
<AdminPageShell width="narrow">
	<AdminPageHeader
		title={$LL.admin_agent_access_bulk_new()}
		description={$LL.admin_agent_access_bulk_description()}
	/>
	<AgentAccessNav />
	{#if error}<div class="alert alert-error">{error}</div>{/if}
	<form onsubmit={submit}>
		<AdminSection>
			<label
				><span>{$LL.admin_agent_access_bulk_grant()}</span><input
					required
					bind:value={grantId}
				/></label
			>
			<label
				><span>{$LL.admin_agent_access_bulk_credential()}</span><input
					required
					bind:value={credentialId}
				/></label
			>
			<label
				><span>{$LL.admin_agent_access_bulk_targets()}</span><textarea required bind:value={targets}
				></textarea></label
			>
			<label
				><span>{$LL.admin_agent_access_bulk_canaries()}</span><textarea
					required
					bind:value={canaries}
				></textarea></label
			>
			<label
				><span>{$LL.admin_agent_access_bulk_plan_json()}</span><textarea
					class="json"
					required
					bind:value={planJson}
				></textarea></label
			>
		</AdminSection>
		<div class="actions">
			<a class="btn" href="/admin/agent-access/bulk-plans">{$LL.admin_agent_access_cancel()}</a
			><button class="btn btn-primary" disabled={saving}
				>{$LL.admin_agent_access_bulk_create()}</button
			>
		</div>
	</form>
</AdminPageShell>

<style>
	form,
	label {
		display: grid;
		gap: 14px;
	}
	label {
		gap: 6px;
		font-weight: 600;
	}
	textarea {
		min-height: 90px;
	}
	textarea.json {
		min-height: 280px;
		font-family: var(--font-mono);
		font-size: 0.78rem;
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 16px;
	}
</style>
