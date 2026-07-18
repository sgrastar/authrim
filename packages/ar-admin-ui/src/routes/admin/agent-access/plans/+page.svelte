<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import {
		adminAgentAccessAPI,
		type AgentConfigurationPlanSummary
	} from '$lib/api/admin-agent-access';
	import {
		AdminDataTable,
		AdminPageHeader,
		AdminPageShell,
		AdminSection,
		AgentAccessNav
	} from '$lib/components/admin';
	import { LL } from '$i18n/i18n-svelte';

	let items: AgentConfigurationPlanSummary[] = $state([]);
	let loading = $state(true);
	let error = $state('');

	onMount(async () => {
		try {
			items = await adminAgentAccessAPI.listConfigurationPlans();
		} catch (caught) {
			error = caught instanceof Error ? caught.message : $LL.admin_agent_access_load_error();
		} finally {
			loading = false;
		}
	});
</script>

<svelte:head><title>{$LL.admin_agent_access_plans_title()}</title></svelte:head>

<AdminPageShell>
	<AdminPageHeader
		title={$LL.admin_agent_access_plans_title()}
		description={$LL.admin_agent_access_plans_description()}
	/>
	<AgentAccessNav />
	{#if loading}
		<div class="state">{$LL.admin_agent_access_loading()}</div>
	{:else if error}
		<div class="alert alert-error">{error}</div>
	{:else}
		<AdminSection>
			<AdminDataTable>
				<thead>
					<tr>
						<th>{$LL.admin_agent_access_plan_status()}</th>
						<th>{$LL.admin_agent_access_plan_stage()}</th>
						<th>{$LL.admin_agent_access_plan_actor()}</th>
						<th>{$LL.admin_agent_access_col_updated()}</th>
					</tr>
				</thead>
				<tbody>
					{#each items as item (`${item.id}:${item.version}`)}
						<tr
							data-clickable="true"
							role="button"
							tabindex="0"
							onclick={() =>
								goto(`/admin/agent-access/plans/${encodeURIComponent(item.id)}/${item.version}`)}
							onkeydown={(event) =>
								event.key === 'Enter' &&
								goto(`/admin/agent-access/plans/${encodeURIComponent(item.id)}/${item.version}`)}
						>
							<td><strong>{item.status}</strong><small>{item.id} · v{item.version}</small></td>
							<td>{item.stage}</td>
							<td>{item.actor_sub}</td>
							<td>{new Date(item.updated_at).toLocaleString()}</td>
						</tr>
					{:else}
						<tr><td colspan="4" class="state">{$LL.admin_agent_access_plans_empty()}</td></tr>
					{/each}
				</tbody>
			</AdminDataTable>
		</AdminSection>
	{/if}
</AdminPageShell>

<style>
	.state {
		padding: 32px;
		text-align: center;
		color: var(--color-text-muted);
	}
	small {
		display: block;
		margin-top: 3px;
		color: var(--color-text-muted);
	}
</style>
