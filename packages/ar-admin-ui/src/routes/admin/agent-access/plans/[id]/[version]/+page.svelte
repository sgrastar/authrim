<script lang="ts">
	import { page } from '$app/stores';
	import { onMount } from 'svelte';
	import {
		adminAgentAccessAPI,
		type AgentConfigurationPlanRecord
	} from '$lib/api/admin-agent-access';
	import {
		AdminPageHeader,
		AdminPageShell,
		AdminSection,
		AgentAccessNav
	} from '$lib/components/admin';
	import { LL } from '$i18n/i18n-svelte';

	let item: AgentConfigurationPlanRecord | null = $state(null);
	let loading = $state(true);
	let error = $state('');

	onMount(async () => {
		try {
			item = await adminAgentAccessAPI.getConfigurationPlan(
				$page.params.id ?? '',
				Number($page.params.version)
			);
		} catch (caught) {
			error = caught instanceof Error ? caught.message : $LL.admin_agent_access_load_error();
		} finally {
			loading = false;
		}
	});
</script>

<svelte:head><title>{$LL.admin_agent_access_plan_detail()}</title></svelte:head>

<AdminPageShell>
	<AdminPageHeader
		title={$LL.admin_agent_access_plan_detail()}
		description={$LL.admin_agent_access_plans_description()}
	/>
	<AgentAccessNav />
	{#if loading}
		<div class="state">{$LL.admin_agent_access_loading()}</div>
	{:else if error}
		<div class="alert alert-error">{error}</div>
	{:else if item}
		<AdminSection>
			<div class="summary">
				<div><span>{$LL.admin_agent_access_plan_status()}</span><strong>{item.status}</strong></div>
				<div><span>{$LL.admin_agent_access_plan_stage()}</span><strong>{item.stage}</strong></div>
				<div>
					<span>{$LL.admin_agent_access_plan_applied_steps()}</span><strong
						>{item.appliedStepCount}</strong
					>
				</div>
				<div>
					<span>{$LL.admin_agent_access_task_set_version()}</span><strong>v{item.version}</strong>
				</div>
			</div>
		</AdminSection>
		<AdminSection title={$LL.admin_agent_access_plan_snapshot()}>
			<dl>
				<div>
					<dt>{$LL.admin_agent_access_grant_id()}</dt>
					<dd>{item.grantId}</dd>
				</div>
				<div>
					<dt>{$LL.admin_agent_access_plan_actor()}</dt>
					<dd>{item.actorSub}</dd>
				</div>
				<div>
					<dt>{$LL.admin_agent_access_digest()}</dt>
					<dd class="mono">{item.definitionDigest}</dd>
				</div>
			</dl>
			<pre>{JSON.stringify(
					{
						definition: item.definition,
						snapshot: item.snapshot,
						diff: item.diff,
						validation: item.validation,
						result: item.result
					},
					null,
					2
				)}</pre>
		</AdminSection>
	{/if}
</AdminPageShell>

<style>
	.state {
		padding: 32px;
		text-align: center;
		color: var(--color-text-muted);
	}
	.summary {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 12px;
	}
	.summary div {
		padding: 14px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-card);
	}
	.summary span {
		display: block;
		color: var(--color-text-muted);
		font-size: 0.76rem;
	}
	.summary strong {
		display: block;
		margin-top: 5px;
	}
	dl {
		display: grid;
		gap: 10px;
	}
	dl div {
		display: grid;
		grid-template-columns: 150px 1fr;
		gap: 12px;
	}
	dt {
		color: var(--color-text-muted);
	}
	dd {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.mono,
	pre {
		font-family: var(--font-mono);
		font-size: 0.76rem;
	}
	pre {
		overflow: auto;
		padding: 14px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-card);
		background: var(--color-surface-subtle);
	}
	@media (max-width: 700px) {
		.summary {
			grid-template-columns: 1fr 1fr;
		}
	}
</style>
