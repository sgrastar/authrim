<script lang="ts">
	import { page } from '$app/stores';
	import { onMount } from 'svelte';
	import { adminAgentAccessAPI, type AgentTaskSet } from '$lib/api/admin-agent-access';
	import {
		AdminDataTable,
		AdminPageHeader,
		AdminPageShell,
		AdminSection,
		AgentAccessNav
	} from '$lib/components/admin';
	import { LL } from '$i18n/i18n-svelte';
	let item: AgentTaskSet | null = $state(null);
	let error = $state('');
	let loading = $state(true);
	onMount(async () => {
		try {
			item = await adminAgentAccessAPI.getTaskSet($page.params.id ?? '');
		} catch (caught) {
			error = caught instanceof Error ? caught.message : $LL.admin_agent_access_load_error();
		} finally {
			loading = false;
		}
	});
</script>

<svelte:head><title>{$LL.admin_agent_access_task_sets_title()}</title></svelte:head>
<AdminPageShell
	><AdminPageHeader
		title={item?.name || $LL.admin_agent_access_task_sets_title()}
		description={item?.description || $LL.admin_agent_access_task_sets_description()}
	/><AgentAccessNav />
	{#if loading}<div class="state">{$LL.admin_agent_access_loading()}</div>{:else if error}<div
			class="alert alert-error"
		>
			{error}
		</div>{:else if item}<AdminSection
			><dl>
				<div>
					<dt>ID</dt>
					<dd>{item.id}</dd>
				</div>
				<div>
					<dt>{$LL.admin_agent_access_task_set_version()}</dt>
					<dd>v{item.current_version}</dd>
				</div>
				<div>
					<dt>{$LL.admin_agent_access_digest()}</dt>
					<dd class="mono">{item.digest}</dd>
				</div>
			</dl></AdminSection
		><AdminSection
			><AdminDataTable
				><thead
					><tr
						><th>{$LL.admin_agent_access_task_set_tools()}</th><th
							>{$LL.admin_agent_access_tool_contract()}</th
						><th>{$LL.admin_agent_access_tool_risk()}</th><th
							>{$LL.admin_agent_access_permissions()}</th
						></tr
					></thead
				><tbody
					>{#each item.tools as tool (tool.toolId)}<tr
							><td><strong>{tool.toolName}</strong><small>{tool.toolId}</small></td><td
								>v{tool.contractVersion}</td
							><td>{tool.riskLevel}</td><td>{tool.permissions.join(', ')}</td></tr
						>{/each}</tbody
				></AdminDataTable
			></AdminSection
		>{/if}
</AdminPageShell>

<style>
	.state {
		padding: 32px;
		text-align: center;
	}
	dl {
		display: grid;
		gap: 12px;
	}
	dl div {
		display: grid;
		grid-template-columns: 160px 1fr;
		gap: 12px;
	}
	dt {
		color: var(--color-text-muted);
	}
	dd {
		margin: 0;
	}
	.mono,
	small {
		font-family: var(--font-mono);
		font-size: 0.76rem;
		overflow-wrap: anywhere;
	}
	small {
		display: block;
		color: var(--color-text-muted);
	}
</style>
