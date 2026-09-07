<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import {
		adminAgentAccessAPI,
		type AgentConfigurationTemplateRecord
	} from '$lib/api/admin-agent-access';
	import {
		AdminDataTable,
		AdminPageHeader,
		AdminPageShell,
		AdminSection,
		AgentAccessNav
	} from '$lib/components/admin';
	import { LL } from '$i18n/i18n-svelte';
	let items: AgentConfigurationTemplateRecord[] = $state([]);
	let loading = $state(true);
	let error = $state('');
	onMount(async () => {
		try {
			items = await adminAgentAccessAPI.listTemplates();
		} catch (caught) {
			error = caught instanceof Error ? caught.message : $LL.admin_agent_access_load_error();
		} finally {
			loading = false;
		}
	});
</script>

<svelte:head><title>{$LL.admin_agent_access_templates_title()}</title></svelte:head>
<AdminPageShell
	><AdminPageHeader
		title={$LL.admin_agent_access_templates_title()}
		description={$LL.admin_agent_access_templates_description()}
	/><AgentAccessNav />
	<div class="toolbar">
		<a class="btn btn-primary" href="/admin/agent-access/templates/new"
			>{$LL.admin_agent_access_template_new()}</a
		>
	</div>
	{#if loading}<div class="state">{$LL.admin_agent_access_loading()}</div>{:else if error}<div
			class="alert alert-error"
		>
			{error}
		</div>{:else}<AdminSection
			><AdminDataTable
				><thead
					><tr
						><th>{$LL.admin_agent_access_template_source_type()}</th><th
							>{$LL.admin_agent_access_template_source_id()}</th
						><th>{$LL.admin_agent_access_task_set_version()}</th><th
							>{$LL.admin_agent_access_plan_status()}</th
						></tr
					></thead
				><tbody
					>{#each items as item (`${item.id}:${item.version}`)}<tr
							data-clickable="true"
							role="button"
							tabindex="0"
							onclick={() =>
								goto(
									`/admin/agent-access/templates/${encodeURIComponent(item.id)}/${item.version}`
								)}
							onkeydown={(event) =>
								event.key === 'Enter' &&
								goto(
									`/admin/agent-access/templates/${encodeURIComponent(item.id)}/${item.version}`
								)}
							><td>{item.templateType}</td><td
								><strong>{item.sourceObjectId}</strong><small>{item.id}</small></td
							><td>v{item.sourceObjectVersion}</td><td>{item.status}</td></tr
						>{:else}<tr
							><td colspan="4" class="state">{$LL.admin_agent_access_templates_empty()}</td></tr
						>{/each}</tbody
				></AdminDataTable
			></AdminSection
		>{/if}
</AdminPageShell>

<style>
	.toolbar {
		display: flex;
		justify-content: flex-end;
		margin-bottom: 16px;
	}
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
