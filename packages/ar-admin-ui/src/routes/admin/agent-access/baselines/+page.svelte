<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { adminAgentAccessAPI, type AgentBaselineRecord } from '$lib/api/admin-agent-access';
	import {
		AdminDataTable,
		AdminPageHeader,
		AdminPageShell,
		AdminSection,
		AgentAccessNav
	} from '$lib/components/admin';
	import { LL } from '$i18n/i18n-svelte';
	let items: AgentBaselineRecord[] = $state([]);
	let loading = $state(true);
	let error = $state('');
	onMount(async () => {
		try {
			items = await adminAgentAccessAPI.listBaselines();
		} catch (caught) {
			error = caught instanceof Error ? caught.message : $LL.admin_agent_access_load_error();
		} finally {
			loading = false;
		}
	});
</script>

<svelte:head><title>{$LL.admin_agent_access_baselines_title()}</title></svelte:head>
<AdminPageShell
	><AdminPageHeader
		title={$LL.admin_agent_access_baselines_title()}
		description={$LL.admin_agent_access_baselines_description()}
	/><AgentAccessNav />
	<div class="toolbar">
		<a class="btn btn-primary" href="/admin/agent-access/baselines/new"
			>{$LL.admin_agent_access_baseline_new()}</a
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
						><th>{$LL.admin_agent_access_baseline_name()}</th><th
							>{$LL.admin_agent_access_baseline_mode()}</th
						><th>{$LL.admin_agent_access_baseline_enforcement()}</th><th
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
									`/admin/agent-access/baselines/${encodeURIComponent(item.id)}/${item.version}`
								)}
							onkeydown={(event) =>
								event.key === 'Enter' &&
								goto(
									`/admin/agent-access/baselines/${encodeURIComponent(item.id)}/${item.version}`
								)}
							><td><strong>{item.name}</strong><small>{item.id} · v{item.version}</small></td><td
								>{item.mode}</td
							><td>{item.enforcement}</td><td>{item.status}</td></tr
						>{:else}<tr
							><td colspan="4" class="state">{$LL.admin_agent_access_baselines_empty()}</td></tr
						>{/each}</tbody
				></AdminDataTable
			></AdminSection
		>{/if}</AdminPageShell
>

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
