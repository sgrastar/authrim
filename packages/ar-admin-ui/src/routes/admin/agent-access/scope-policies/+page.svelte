<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { adminAgentAccessAPI, type AgentScopePolicy } from '$lib/api/admin-agent-access';
	import {
		AdminDataTable,
		AdminPageHeader,
		AdminPageShell,
		AdminSection,
		AgentAccessNav
	} from '$lib/components/admin';
	import { adminAuth } from '$lib/stores/admin-auth.svelte';
	import { LL } from '$i18n/i18n-svelte';
	let items: AgentScopePolicy[] = $state([]);
	let loading = $state(true);
	let error = $state('');
	const canCreate = $derived(adminAuth.hasPermission('admin:agent_scope_policies:write'));
	onMount(async () => {
		try {
			items = await adminAgentAccessAPI.listScopePolicies();
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
		title={$LL.admin_agent_access_scope_policies_title()}
		description={$LL.admin_agent_access_scope_policies_description()}
		>{#snippet actions()}{#if canCreate}<a
					class="btn btn-primary"
					href="/admin/agent-access/scope-policies/new"
					>{$LL.admin_agent_access_scope_policy_new()}</a
				>{/if}{/snippet}</AdminPageHeader
	><AgentAccessNav />
	{#if loading}<div class="state">{$LL.admin_agent_access_loading()}</div>{:else if error}<div
			class="alert alert-error"
		>
			{error}
		</div>{:else}<AdminSection
			><AdminDataTable
				><thead
					><tr
						><th>{$LL.admin_agent_access_task_set_name()}</th><th
							>{$LL.admin_agent_access_task_set_version()}</th
						><th>{$LL.admin_agent_access_scope_policy_domain_column()}</th><th
							>{$LL.admin_agent_access_scope_policy_pii()}</th
						></tr
					></thead
				><tbody
					>{#each items as item (item.id)}<tr
							data-clickable="true"
							role="button"
							tabindex="0"
							onclick={() =>
								goto(`/admin/agent-access/scope-policies/${encodeURIComponent(item.id)}`)}
							onkeydown={(event) =>
								event.key === 'Enter' &&
								goto(`/admin/agent-access/scope-policies/${encodeURIComponent(item.id)}`)}
							><td><strong>{item.name}</strong><small>{item.description || item.id}</small></td><td
								>v{item.current_version}</td
							><td>{item.definition.domains.join(', ') || '—'}</td><td>{item.definition.piiMode}</td
							></tr
						>{:else}<tr
							><td colspan="4" class="state">{$LL.admin_agent_access_scope_policy_empty()}</td></tr
						>{/each}</tbody
				></AdminDataTable
			></AdminSection
		>{/if}
</AdminPageShell>

<style>
	.state {
		padding: 32px;
		text-align: center;
		color: var(--color-text-muted);
	}
	small {
		display: block;
		color: var(--color-text-muted);
		margin-top: 3px;
	}
</style>
