<script lang="ts">
	import { page } from '$app/stores';
	import { onMount } from 'svelte';
	import { adminAgentAccessAPI, type AgentScopePolicy } from '$lib/api/admin-agent-access';
	import {
		AdminPageHeader,
		AdminPageShell,
		AdminSection,
		AgentAccessNav
	} from '$lib/components/admin';
	import { LL } from '$i18n/i18n-svelte';
	let item: AgentScopePolicy | null = $state(null);
	let loading = $state(true);
	let error = $state('');
	onMount(async () => {
		try {
			item = await adminAgentAccessAPI.getScopePolicy($page.params.id ?? '');
		} catch (caught) {
			error = caught instanceof Error ? caught.message : $LL.admin_agent_access_load_error();
		} finally {
			loading = false;
		}
	});
</script>

<svelte:head><title>{$LL.admin_agent_access_scope_policies_title()}</title></svelte:head>
<AdminPageShell
	><AdminPageHeader
		title={item?.name || $LL.admin_agent_access_scope_policies_title()}
		description={item?.description || $LL.admin_agent_access_scope_policies_description()}
	/><AgentAccessNav />{#if loading}<div class="state">
			{$LL.admin_agent_access_loading()}
		</div>{:else if error}<div class="alert alert-error">{error}</div>{:else if item}<AdminSection
			><div class="grid">
				<div>
					<span>{$LL.admin_agent_access_task_set_version()}</span><strong
						>v{item.current_version}</strong
					>
				</div>
				<div><span>PII</span><strong>{item.definition.piiMode}</strong></div>
				<div>
					<span>{$LL.admin_agent_access_scope_policy_per_call()}</span><strong
						>{item.definition.maxPerCall}</strong
					>
				</div>
				<div>
					<span>{$LL.admin_agent_access_scope_policy_per_plan()}</span><strong
						>{item.definition.maxPlanOperations}</strong
					>
				</div>
			</div></AdminSection
		><AdminSection
			><dl>
				<div>
					<dt>{$LL.admin_agent_access_scope_policy_tenant()}</dt>
					<dd>{item.definition.tenantIds.join(', ')}</dd>
				</div>
				<div>
					<dt>{$LL.admin_agent_access_scope_policy_domain_column()}</dt>
					<dd>{item.definition.domains.join(', ') || '—'}</dd>
				</div>
				<div>
					<dt>{$LL.admin_agent_access_scope_policy_resource_column()}</dt>
					<dd>{item.definition.resourceIds.join(', ') || '—'}</dd>
				</div>
				<div>
					<dt>{$LL.admin_agent_access_scope_policy_field_column()}</dt>
					<dd>{item.definition.allowedFields.join(', ') || '—'}</dd>
				</div>
				<div>
					<dt>{$LL.admin_agent_access_digest()}</dt>
					<dd class="mono">{item.digest}</dd>
				</div>
			</dl></AdminSection
		>{/if}</AdminPageShell
>

<style>
	.state {
		padding: 32px;
		text-align: center;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 12px;
	}
	.grid div {
		padding: 14px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-card);
	}
	.grid span {
		display: block;
		color: var(--color-text-muted);
		font-size: 0.76rem;
	}
	.grid strong {
		display: block;
		margin-top: 5px;
	}
	dl {
		display: grid;
		gap: 12px;
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
	.mono {
		font-family: var(--font-mono);
		font-size: 0.76rem;
	}
	@media (max-width: 700px) {
		.grid {
			grid-template-columns: 1fr 1fr;
		}
	}
</style>
